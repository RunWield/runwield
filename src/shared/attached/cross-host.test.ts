import { test } from "node:test";
import { ok as assert, strictEqual as equal } from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
    activateInput,
    EVIDENCE,
    pendingTriage,
    planWrittenInput,
    readRecordBytes,
    runOperation,
    triageReportInput,
    withProject,
} from "./attached-test-fixture.ts";
import { applyAttachedReviewDecision, openAttachedReviewRound } from "./coordinator.ts";
import { ATTACHED_HOSTS } from "./hosts.ts";
import {
    loadAttachedWorkflowRecord,
    locateAttachedWorkflows,
    writeAttachedWorkflowRecord,
    type AttachedWorkflowRecord,
} from "./record-store.ts";
import { compactStatus } from "./presentation.ts";
import { attachedValidationFixture } from "./validation-test-fixture.ts";
import { setCustomSetting } from "../settings.js";

test("inspection identifies reviewed work without starting validation or changing durable state", async () => {
    const fixture = await attachedValidationFixture({ attrs: { status: "reviewed" } });
    try {
        const location = locateAttachedWorkflows(fixture.root);
        const loaded = await loadAttachedWorkflowRecord(location, fixture.workflowId);
        assert(loaded.status === "found");
        equal(
            (
                await writeAttachedWorkflowRecord(
                    location,
                    { ...loaded.record, state: "reviewed", revision: loaded.record.revision + 1 },
                    loaded.record.revision,
                )
            ).status,
            "written",
        );
        const before = await readRecordBytes(fixture.root, fixture.workflowId);
        const count = await fixture.ciCount();
        const status = await runOperation("status", fixture.root, {
            evidence: { ...EVIDENCE, host: "codex", hostVersion: "0.164.0-alpha.11.1" },
            inspectOnly: true,
        });
        assert(status.ok);
        equal(status.workflow.originHost, "claude-code");
        equal(status.workflow.plan?.planName, "p");
        equal(status.workflow.nextAction.kind, "validation_recovery");
        equal(await fixture.ciCount(), count);
        equal(await readRecordBytes(fixture.root, fixture.workflowId), before);
        const invalid = await runOperation("status", fixture.root, { inspectOnly: "true" });
        assert(!invalid.ok);
        equal(invalid.rejection.code, "invalid_input");
    } finally {
        await fixture.close();
    }
});

test("inspection bounds the explicit request preview before a Plan exists", async () => {
    await withProject(async (root) => {
        const requestText = "🧭 Describe the requested feature. ".repeat(40);
        const activated = await runOperation("activate", root, {
            ...activateInput(),
            payload: { requestText, hostRequestId: "bounded-request" },
        });
        assert(activated.ok);
        const status = await runOperation("status", root, { inspectOnly: true });
        assert(status.ok && status.workflow.requestSummary);
        equal(status.workflow.plan, null);
        equal(Array.from(status.workflow.requestSummary).length, 160);
        assert(status.workflow.requestSummary.endsWith("..."));
        equal(JSON.stringify(compactStatus(status, null)).includes(requestText), false);
    });
});

for (const [origin, caller] of [
    ["claude-code", "codex"],
    ["codex", "claude-code"],
] as const) {
    test(`${caller} continues ${origin}'s workflow with current instructions and preserved origin`, async () => {
        await withProject(async (root) => {
            await setCustomSetting(
                "connect",
                { codex: { roles: { planner: { model: "native-planner", thinkingLevel: "max" } } } },
                "project",
                root,
            );
            const evidence = {
                ...EVIDENCE,
                host: origin,
                hostVersion: origin === "codex" ? "0.164.0-alpha.11.1" : EVIDENCE.hostVersion,
            };
            const callerEvidence = {
                ...EVIDENCE,
                host: caller,
                hostVersion: caller === "codex" ? "0.164.0-alpha.11.1" : EVIDENCE.hostVersion,
            };
            const activated = await runOperation("activate", root, { ...activateInput(), evidence });
            const triage = pendingTriage(activated);
            const triageInput = { ...triageReportInput(triage), evidence };
            const planned = await runOperation("triage_report", root, triageInput);
            assert(planned.ok && planned.workflow.nextAction.kind === "plan");
            // Older receipts predate the origin projection. Resume must not migrate or rewrite them.
            const legacy: AttachedWorkflowRecord = JSON.parse(await readRecordBytes(root, triage.workflowId));
            for (const receipt of Object.values(legacy.acceptedOperations)) {
                if (receipt.result.workflow) {
                    delete receipt.result.workflow.originHost;
                    delete receipt.result.workflow.requestSummary;
                }
            }
            await writeFile(
                join(locateAttachedWorkflows(root).workflowsDir, `${triage.workflowId}.json`),
                JSON.stringify(legacy),
            );
            const before = await readRecordBytes(root, triage.workflowId);

            const status = await runOperation("status", root, { evidence: callerEvidence });
            assert(status.ok && status.workflow.nextAction.kind === "plan");
            equal(status.workflow.workflowId, triage.workflowId);
            equal(status.workflow.originHost, origin);
            equal(status.workflow.requestSummary, "Add a dark mode toggle");
            equal(status.workflow.nextAction.actionId, planned.workflow.nextAction.actionId);
            equal(status.workflow.revision, planned.workflow.revision);
            equal(compactStatus(status, null).workflow?.originHost, origin);
            const dispatch = status.workflow.nextAction.dispatch;
            equal(dispatch?.host, caller === "codex" ? "codex" : undefined);
            if (caller === "codex") {
                assert(dispatch?.status === "ready");
                equal(dispatch.model, "native-planner");
                equal(dispatch.thinkingLevel, "max");
            }
            equal(JSON.stringify(compactStatus(status, null).workflow?.nextAction.dispatch), JSON.stringify(dispatch));

            const fetched = await runOperation("get_instructions", root, {
                workflowId: triage.workflowId,
                actionId: status.workflow.nextAction.actionId,
                evidence: callerEvidence,
            });
            assert(fetched.ok && "instructions" in fetched);
            equal(JSON.stringify(fetched.instructions.dispatch), JSON.stringify(dispatch));
            assert(fetched.instructions.text.includes(`RunWield in ${ATTACHED_HOSTS[caller].displayName}`));
            equal(fetched.instructions.text.includes(`RunWield in ${ATTACHED_HOSTS[origin].displayName}`), false);

            const replay = await runOperation("triage_report", root, { ...triageInput, evidence: callerEvidence });
            assert(replay.ok && replay.instructions);
            equal(JSON.stringify(replay.workflow.nextAction.dispatch), JSON.stringify(dispatch));
            equal(JSON.stringify(replay.instructions.dispatch), JSON.stringify(dispatch));
            assert(replay.instructions.text.includes(`RunWield in ${ATTACHED_HOSTS[caller].displayName}`));
            equal(replay.workflow.originHost, origin);
            equal(replay.workflow.revision, status.workflow.revision);
            equal(await readRecordBytes(root, triage.workflowId), before);

            const staleRead = await runOperation("get_instructions", root, { ...triage, evidence: callerEvidence });
            assert(!staleRead.ok);
            equal(staleRead.rejection.code, "action_superseded");
            const staleWrite = await runOperation("triage_report", root, {
                ...triageInput,
                evidence: callerEvidence,
                operationId: "stale-new-host",
            });
            assert(!staleWrite.ok);
            equal(staleWrite.rejection.code, "revision_conflict");
            equal(await readRecordBytes(root, triage.workflowId), before);

            await mkdir(join(root, "docs/plans"), { recursive: true });
            await writeFile(join(root, "docs/plans/dark-mode-toggle.md"), "# Toggle\n\nAdd a toggle.\n");
            const submitted = await runOperation("plan_written", root, {
                ...planWrittenInput({
                    workflowId: triage.workflowId,
                    actionId: status.workflow.nextAction.actionId,
                    expectedRevision: status.workflow.revision,
                }),
                evidence: callerEvidence,
            });
            assert(submitted.ok);
            const record: AttachedWorkflowRecord = JSON.parse(await readRecordBytes(root, triage.workflowId));
            equal(record.evidence.host, origin);
            const receipt = Object.values(record.acceptedOperations).find(
                (entry) => entry.result.operation === "plan_written",
            );
            equal(receipt?.evidence.host, caller);

            const opened = await openAttachedReviewRound(root, triage.workflowId);
            assert(opened.kind === "opened");
            await applyAttachedReviewDecision(root, triage.workflowId, opened.basis, {
                approved: true,
                approvalAction: "later",
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
            });
            const saved = await runOperation("status", root, {
                workflowId: triage.workflowId,
                evidence: callerEvidence,
            });
            assert(saved.ok && saved.workflow.nextAction.kind === "plan_saved");
            equal(saved.workflow.plan?.planName, "dark-mode-toggle");
            equal(saved.workflow.originHost, origin);
            assert(saved.workflow.nextAction.guidance.includes(ATTACHED_HOSTS[caller].implementEntrypoint));
        });
    });
}
