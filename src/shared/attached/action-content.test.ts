import {
    activateInput,
    EVIDENCE,
    pendingTriage,
    runOperation,
    withProject,
    spawnAttachedCli,
    triageReportInput,
    readRecordBytes,
} from "./attached-test-fixture.ts";
import type { AttachedJsonObject } from "./operations.ts";
import { test } from "node:test";
import { ok as assert, deepStrictEqual, strictEqual as equal } from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readAttachedAction, runAttachedOperation } from "./coordinator.ts";
import { attachedValidationFixture } from "./validation-test-fixture.ts";
import { inspectSemantic } from "./delivery-test-fixture.ts";

test("action instruction reads preserve complete Core instructions and workflow revision", async () => {
    const fixture = await attachedValidationFixture();
    try {
        await writeFile(join(fixture.cwd, "marker"), "pass");
        const started = await fixture.call("start_validation", await fixture.status());
        assert(started.ok && started.workflow.nextAction.kind === "validation" && started.instructions);
        const envelope = {
            evidence: EVIDENCE,
            projectRoot: fixture.root,
            workflowId: fixture.workflowId,
            actionId: started.workflow.nextAction.actionId,
            content: "instructions" as const,
        };
        const first = await readAttachedAction(envelope);
        const restored = await readAttachedAction(envelope);
        assert(first.ok && "instructions" in first);
        deepStrictEqual(first.instructions, started.instructions);
        deepStrictEqual(restored, first);
        equal(first.revision, started.workflow.revision);
        equal((await fixture.status()).revision, started.workflow.revision);
        equal(await fixture.ciCount(), 1);
    } finally {
        await fixture.close();
    }
});

test("action reads reject absent workflows and stale action IDs without returning content", async () => {
    const fixture = await attachedValidationFixture();
    try {
        const missing = await readAttachedAction({
            evidence: EVIDENCE,
            projectRoot: fixture.root,
            workflowId: "missing-workflow",
            actionId: "missing-action",
            content: "instructions",
        });
        assert(!missing.ok);
        equal(missing.rejection.code, "workflow_not_found");
        const stale = await readAttachedAction({
            evidence: EVIDENCE,
            projectRoot: fixture.root,
            workflowId: fixture.workflowId,
            actionId: "stale-action",
            content: "instructions",
        });
        assert(!stale.ok);
        equal(stale.rejection.code, "action_superseded");
        equal("instructions" in stale, false);
        equal(await fixture.ciCount(), 0);
    } finally {
        await fixture.close();
    }
});

test("a completed reviewer action cannot fetch instructions for the next browser decision", async () => {
    const fixture = await attachedValidationFixture();
    try {
        await writeFile(join(fixture.cwd, "marker"), "pass");
        const started = await fixture.call("start_validation", await fixture.status());
        assert(started.ok && started.workflow.nextAction.kind === "validation");
        const reviewerId = started.workflow.nextAction.actionId;
        const inspected = await inspectSemantic(fixture, started.workflow);
        const reviewed = await fixture.call("review_complete", inspected.workflow, {
            actionId: inspected.actionId,
            approved: true,
            findings: [],
        });
        assert(reviewed.ok && reviewed.workflow.nextAction.kind === "code_review");
        const stale = await readAttachedAction({
            evidence: EVIDENCE,
            projectRoot: fixture.root,
            workflowId: fixture.workflowId,
            actionId: reviewerId,
            content: "instructions",
        });
        assert(!stale.ok);
        equal(stale.rejection.code, "action_superseded");
        const decision = await readAttachedAction({
            evidence: EVIDENCE,
            projectRoot: fixture.root,
            workflowId: fixture.workflowId,
            actionId: reviewed.workflow.nextAction.actionId,
            content: "instructions",
        });
        assert(decision.ok && "request" in decision);
        deepStrictEqual(decision.request, reviewed.workflow.nextAction.request);
        const chat = await readAttachedAction({
            evidence: EVIDENCE,
            projectRoot: fixture.root,
            workflowId: fixture.workflowId,
            actionId: reviewed.workflow.nextAction.actionId,
            content: "chat",
        });
        assert(!chat.ok);
        equal(chat.rejection.code, "invalid_input");
    } finally {
        await fixture.close();
    }
});

test("bounded artifact pages restore the complete UTF-8 execution report and action prompt", async () => {
    const report = "- Verified café 🛠.\n".repeat(10000);
    const fixture = await attachedValidationFixture({ attrs: { executionReport: report } });
    try {
        await writeFile(join(fixture.cwd, "marker"), "pass");
        const started = await fixture.call("start_validation", await fixture.status());
        assert(started.ok && started.workflow.nextAction.kind === "validation");
        const action = started.workflow.nextAction;
        assert(action.request.kind === "reviewer");
        for (const [artifact, expected] of [
            ["execution_report", report],
            ["prompt", action.request.prompt],
        ] as const) {
            let offsetBytes = 0;
            let restored = "";
            while (true) {
                const page = await readAttachedAction({
                    evidence: EVIDENCE,
                    projectRoot: fixture.root,
                    workflowId: fixture.workflowId,
                    actionId: action.actionId,
                    content: artifact,
                    offsetBytes,
                    maxBytes: 4096,
                });
                assert(page.ok && "content" in page);
                assert(new TextEncoder().encode(page.content).length <= 4096);
                equal(page.offsetBytes, offsetBytes);
                restored += page.content;
                if (!page.truncated) break;
                assert(page.nextOffsetBytes > offsetBytes);
                offsetBytes = page.nextOffsetBytes;
            }
            equal(restored, expected);
        }
        equal(await fixture.ciCount(), 1);
    } finally {
        await fixture.close();
    }
});

test("artifact reads reject invalid page limits, unavailable reports, and superseded actions", async () => {
    const fixture = await attachedValidationFixture();
    try {
        await writeFile(join(fixture.cwd, "marker"), "pass");
        const started = await fixture.call("start_validation", await fixture.status());
        assert(started.ok && started.workflow.nextAction.kind === "validation");
        const envelope = {
            evidence: EVIDENCE,
            projectRoot: fixture.root,
            workflowId: fixture.workflowId,
            actionId: started.workflow.nextAction.actionId,
            content: "prompt" as const,
        };
        for (const page of [{ maxBytes: 65537 }, { maxBytes: 0 }, { maxBytes: 1.5 }, { offsetBytes: -1 }]) {
            const invalid = await readAttachedAction({ ...envelope, ...page });
            assert(!invalid.ok);
            equal(invalid.rejection.code, "invalid_input");
        }
        const absent = await readAttachedAction({ ...envelope, content: "repair_report" });
        assert(!absent.ok);
        equal(absent.rejection.code, "invalid_input");
        const stale = await readAttachedAction({ ...envelope, actionId: "old-action" });
        assert(!stale.ok);
        equal(stale.rejection.code, "action_superseded");
        const end = await readAttachedAction({ ...envelope, offsetBytes: 100000000 });
        assert(end.ok && "content" in end);
        equal(end.content, "");
        equal(end.truncated, false);
        equal(end.remainingBytes, 0);
    } finally {
        await fixture.close();
    }
});

test("shared read operations reject malformed envelopes without changing the pending action", async () => {
    await withProject(async (root) => {
        const triage = pendingTriage(await runOperation("activate", root, activateInput()));
        const before = await runOperation("status", root, { workflowId: triage.workflowId });
        for (const name of ["get_instructions", "get_artifact", "get_pending_chat"] as const) {
            const input: AttachedJsonObject = {
                evidence: EVIDENCE,
                workflowId: triage.workflowId,
                actionId: triage.actionId,
                ...(name === "get_artifact" && { artifact: "prompt" }),
            };
            for (const invalid of [
                {},
                { ...input, evidence: undefined },
                { ...input, actionId: "" },
                { ...input, workflowId: "../escape" },
                { ...input, extra: true },
                { ...input, evidence: {} },
                ...(name === "get_artifact"
                    ? [
                          { ...input, artifact: "other" },
                          { ...input, offsetBytes: -1 },
                          { ...input, offsetBytes: 0.5 },
                          { ...input, maxBytes: "64" },
                          { ...input, maxBytes: 3 },
                          { ...input, maxBytes: 65537 },
                      ]
                    : [{ ...input, maxBytes: 64 }]),
            ]) {
                const result = await runAttachedOperation(name, root, JSON.stringify(invalid));
                assert(!result.ok, JSON.stringify(invalid));
                equal(result.operation, name);
                equal(result.rejection.code, "invalid_input", JSON.stringify(invalid));
            }
        }
        deepStrictEqual(await runOperation("status", root, { workflowId: triage.workflowId }), before);
    });
});

test("fresh processes restore the saved request for Triage and the Planner without copying it into status or receipts", async () => {
    await withProject(async (root) => {
        const triage = pendingTriage(await runOperation("activate", root, activateInput()));
        const restored = await spawnAttachedCli("get_instructions", root, { ...triage, evidence: EVIDENCE });
        assert(restored.result.ok && "context" in restored.result && restored.result.context);
        equal(restored.result.context.requestText, "Add a dark mode toggle");
        const planned = await runOperation("triage_report", root, triageReportInput(triage));
        assert(planned.ok && planned.workflow.nextAction.kind === "plan");
        const planner = await spawnAttachedCli("get_instructions", root, {
            workflowId: triage.workflowId,
            actionId: planned.workflow.nextAction.actionId,
            evidence: EVIDENCE,
        });
        assert(planner.result.ok && "context" in planner.result && planner.result.context);
        equal(planner.result.context.requestText, "Add a dark mode toggle");
        deepStrictEqual(planner.result.context.triageOutcome, planned.workflow.triageOutcome);
        const status = await spawnAttachedCli("status", root, { workflowId: triage.workflowId });
        assert(!JSON.stringify(status.result).includes("Add a dark mode toggle"));
        const record = JSON.parse(await readRecordBytes(root, triage.workflowId));
        assert(!JSON.stringify(record.acceptedOperations).includes("requestText"));
    });
});
