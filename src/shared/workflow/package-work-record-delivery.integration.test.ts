import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { recordingFixture } from "./testing/package-recording-fixture.ts";
import { read } from "../testing/plan-package-fixture.ts";
import { readPlanPackagePublication } from "../../plan-store/packages.ts";
import { listWorkRecords } from "../work-records/store.ts";
import { withWorkRecordOwner } from "../work-records/owner.ts";
import { parseWorkRecordMarkdown } from "../work-records/markdown.js";
import { git } from "../git-test-fixture.ts";

for (const policy of [
    undefined,
    { plans: false, workRecords: false },
    { plans: false, workRecords: true },
    { plans: true, workRecords: false },
    { plans: true, workRecords: true },
]) {
    test(`actual validation automatically prepares and publishes independent copies ${JSON.stringify(policy)}`, async () => {
        const f = await recordingFixture(policy);
        try {
            const delivered = await f.validate();
            equal(delivered.code, 0, delivered.text);
            equal(delivered.outcome?.kind, "verified", delivered.text);
            const receipt = (await read(f.identity)).metadata.workflow!.delivery!;
            const manifest = await readPlanPackagePublication(f.identity, receipt.source);
            equal(manifest.planCopies, policy?.plans ?? false);
            equal(manifest.workRecordCopies, policy?.workRecords ?? true);
            ok(manifest.preparedRecord);
            equal(
                manifest.copies.some((copy) => copy.kind === "work-record"),
                policy?.workRecords ?? true,
            );
            await withWorkRecordOwner(f.root, f.identity, async () => {
                const records = await listWorkRecords(f.root);
                equal(records.length, 1);
                equal(records[0].attrs.status, "approved");
                const frozen = parseWorkRecordMarkdown(manifest.preparedRecord!.text);
                equal(frozen.attrs.status, "pending_verification");
                equal(records[0].body, frozen.body);
            });
            const history = await git(f.remote, ["log", "--format=%B", "main"]);
            equal(history.split("RunWield-Publication-Attempt:").length - 1, manifest.copies.length ? 1 : 0);
            const paths = await git(f.remote, ["ls-tree", "-r", "--name-only", "main"]);
            ok(!paths.includes("plan.wld.json"));
            ok(!paths.includes("index.sqlite3"));
            for (const copy of manifest.copies)
                equal(await git(f.remote, ["show", `main:${copy.path}`]), copy.text.trim());
            equal(await f.turns(), 1);
        } finally {
            await f.cleanup();
        }
    });
}

test("ordinary Recorder shares retained preparation and canonical settlement", async () => {
    const { withRuntimeCommandFixture } = await import("../../cmd/testing/runtime-command-fixture.ts");
    await withRuntimeCommandFixture("package-ordinary-recorder-", async ({ setModelResponseFactories }) => {
        const { fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
        const { HostedSession } = await import("../session/hosted-session.js");
        const { runValidationAttempt } = await import("./validation-supervisor.ts");
        const { loadPackageWorkflowPlan } = await import("../../plan-store/workflows.ts");
        const { createGitPort } = await import("../git-port.ts");
        const { systemLocalCIPort } = await import("./validation-local-ci.ts");
        const { attachRecorder, makeUi } = await import("./validation-test-helpers.js");
        const { createWorkRecordMnemotecaFixture } = await import("../work-records/test-fixtures/mnemoteca-port.ts");
        const f = await recordingFixture({ plans: false, workRecords: false });
        try {
            const respond: import("@earendil-works/pi-ai").FauxResponseFactory = (context) =>
                JSON.stringify(context).includes("post-verification checklist")
                    ? fauxAssistantMessage(
                          fauxToolCall("manual_qa_completed", {
                              checklistMarkdown: "Manual verification steps\n- [ ] Exercise delivery.",
                          }),
                      )
                    : fauxAssistantMessage(
                          fauxToolCall("work_record_completed", {
                              title: "Ordinary delivery",
                              summary: "Recorded by ordinary Recorder.",
                          }),
                      );
            setModelResponseFactories([respond, respond, respond]);
            await f.scope(async () => {
                const plan = await loadPackageWorkflowPlan("one");
                const hosted = attachRecorder(new HostedSession({ id: "ordinary-package", cwd: f.root }), makeUi());
                const outcome = await runValidationAttempt({
                    projectRoot: f.root,
                    planName: "one",
                    runtime: {
                        kind: "core",
                        args: {
                            planName: "one",
                            planContent: plan.markdown,
                            triageMeta: plan.attrs,
                            hostedSession: hosted,
                            executionContext: f.workflow,
                            git: createGitPort(),
                            localCI: systemLocalCIPort,
                            workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
                        },
                    },
                });
                equal(outcome.kind, "verified", JSON.stringify(outcome));
                const records = await listWorkRecords(f.root);
                equal(records.length, 1);
                equal(records[0].attrs.status, "approved");
                ok(records[0].summary.includes("ordinary Recorder"));
            });
        } finally {
            await f.cleanup();
        }
    });
});

for (const mode of ["disabled", "intermediate", "terminal", "local"] as const) {
    test(`automatic package recording respects ${mode} eligibility and delivery`, async () => {
        const f = await recordingFixture(
            undefined,
            mode === "intermediate" || mode === "terminal" ? "last-child" : undefined,
            mode === "local",
        );
        try {
            const { setExactProjectCustomSetting } = await import("../settings.js");
            if (mode === "disabled")
                setExactProjectCustomSetting("workRecords", { autoGenerateOnPlanCompletion: false }, f.root);
            if (mode === "intermediate") {
                const { create } = await import("../testing/plan-package-fixture.ts");
                await create(f.identity, {
                    planId: "remaining",
                    name: "remaining",
                    parentPlanId: "parent",
                    definition: { classification: "PLANNED_CHANGE", status: "draft", targetBranch: "main" },
                });
            }
            const outcome = await f.validate();
            equal(outcome.code, 0, outcome.text);
            equal(outcome.outcome?.kind, "verified", outcome.text);
            await withWorkRecordOwner(f.root, f.identity, async () => {
                const records = await listWorkRecords(f.root);
                equal(records.length, mode === "disabled" || mode === "intermediate" ? 0 : 1);
                if (mode === "terminal") {
                    equal(records[0].attrs.scope, "epic");
                    equal(records[0].attrs.provenance?.sourcePlans?.[0], "parent");
                }
            });
        } finally {
            await f.cleanup();
        }
    });
}
