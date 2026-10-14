import { getHomeDir } from "../../constants.js";
import { findIndexedDocumentIdsByRecordId } from "../work-records/index-adapter.ts";
import { SYSTEM_WORK_RECORD_MNEMOTECA_PORT } from "../work-records/mnemoteca-port.ts";
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { attachedValidationFixture } from "./validation-test-fixture.ts";
import { inspectSemantic, prepareIndexRuntime, toDelivery } from "./delivery-test-fixture.ts";
import { DENO_CONFIG_PATH, EVIDENCE, spawnAttachedCli } from "./attached-test-fixture.ts";
import { listWorkRecords } from "../work-records/store.js";
import { loadPlan } from "../../plan-store.js";
import { git } from "../git-test-fixture.ts";
import type { AttachedJsonObject, AttachedOperationName } from "./operations.ts";

type Fixture = Awaited<ReturnType<typeof attachedValidationFixture>>;
async function crash(
    fixture: Fixture,
    operation: AttachedOperationName,
    input: AttachedJsonObject,
    point: string,
    timing: string,
) {
    const config = join(fixture.parent, "crash.json");
    await Deno.writeTextFile(
        config,
        JSON.stringify({ projectRoot: fixture.root, operation, input, crashPoint: point, timing }),
    );
    const output = await new Deno.Command(Deno.execPath(), {
        args: [
            "run",
            "-A",
            "--quiet",
            "--no-check",
            "--config",
            DENO_CONFIG_PATH,
            fromFileUrl(new URL("./testing/delivery-process.ts", import.meta.url)),
            config,
        ],
        env: { PATH: `${fixture.bin}:${Deno.env.get("PATH") || ""}` },
        stdout: "piped",
        stderr: "piped",
    }).output();
    assertEquals(output.code, 86, new TextDecoder().decode(output.stderr) + new TextDecoder().decode(output.stdout));
}
for (
    const point of [
        "code_review_wait",
        "recorder_wait",
        "recorder_sections",
        "artifacts_committed",
        "target_integrated",
        "target_published",
        "publication_verified",
        "cleanup_complete",
        "delivered_record",
    ]
) {
    for (const timing of ["before", "after"]) {
        Deno.test(`fresh Attached process recovers ${timing} ${point} without repeating accepted work`, async () => {
            await prepareIndexRuntime();
            const fixture = await attachedValidationFixture({ attrs: { workKind: "FEATURE" } });
            try {
                let workflow;
                let operation: AttachedOperationName;
                let payload: AttachedJsonObject;
                if (point === "code_review_wait") {
                    await Deno.writeTextFile(join(fixture.cwd, "marker"), "pass");
                    const started = await fixture.call("start_validation", await fixture.status());
                    assert(started.ok);
                    const inspected = await inspectSemantic(fixture, started.workflow);
                    workflow = inspected.workflow;
                    operation = "review_complete";
                    payload = { actionId: inspected.actionId, approved: true };
                } else {
                    const started = await toDelivery(fixture);
                    workflow = started.workflow;
                    assert(workflow.nextAction.kind === "code_review");
                    operation = "validation_decision";
                    payload = { actionId: workflow.nextAction.actionId, answer: { outcome: "approved" } };
                    if (point !== "recorder_wait") {
                        const approved = await fixture.call(operation, workflow, payload);
                        assert(
                            approved.ok && approved.workflow.nextAction.kind === "recorder",
                            JSON.stringify(approved),
                        );
                        workflow = approved.workflow;
                        operation = "work_record_completed";
                        payload = {
                            actionId: approved.workflow.nextAction.actionId,
                            title: "Delivered value",
                            summary: "The implementation exports the new value.",
                        };
                    }
                }
                await crash(
                    fixture,
                    operation,
                    {
                        workflowId: workflow.workflowId,
                        expectedRevision: workflow.revision,
                        operationId: "lost-outcome",
                        evidence: EVIDENCE,
                        payload,
                    },
                    point,
                    timing,
                );
                const status = await spawnAttachedCli("status", fixture.root, { workflowId: workflow.workflowId });
                assert(status.result.ok, JSON.stringify(status.result));
                workflow = status.result.workflow;
                const resumed = await spawnAttachedCli("start_validation", fixture.root, {
                    workflowId: workflow.workflowId,
                    expectedRevision: workflow.revision,
                    operationId: "recover-outcome",
                    evidence: EVIDENCE,
                    payload: {},
                });
                // A durable delivered status is already the conclusion; start_validation may reject it.
                if (workflow.nextAction.kind !== "delivered") {
                    assert(resumed.result.ok, JSON.stringify(resumed.result));
                    workflow = resumed.result.workflow;
                }
                if (workflow.nextAction.kind === "code_review") {
                    const approved = await fixture.call("validation_decision", workflow, {
                        actionId: workflow.nextAction.actionId,
                        answer: { outcome: "approved" },
                    });
                    assert(approved.ok);
                    workflow = approved.workflow;
                }
                if (workflow.nextAction.kind === "recorder") {
                    const recorded = await fixture.call("work_record_completed", workflow, {
                        actionId: workflow.nextAction.actionId,
                        title: "Delivered value",
                        summary: "The implementation exports the new value.",
                    });
                    assert(recorded.ok, JSON.stringify(recorded));
                    workflow = recorded.workflow;
                }
                assertEquals(workflow.nextAction.kind, "delivered", JSON.stringify(workflow));
                const records = await listWorkRecords(fixture.root);
                assertEquals(records.length, 1);
                assertEquals(
                    (await findIndexedDocumentIdsByRecordId(fixture.root, records[0].attrs.recordId, {
                        mnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
                    })).length,
                    1,
                );
                const plan = await loadPlan(fixture.root, "p");
                assert(plan?.attrs.publicationReceipt);
                await git(fixture.root, [
                    "merge-base",
                    "--is-ancestor",
                    plan.attrs.publicationReceipt.publishedCommit,
                    "main",
                ]);
                const evidence = await fixture.evidence();
                assertEquals(
                    evidence.filter((entry) => entry.kind === "human" && entry.outcome === "Approved").length,
                    1,
                );
                assertEquals(await Deno.stat(fixture.modelMarker).then(() => true, () => false), false);
                const logs = await git(fixture.root, ["log", "--format=%B", "main"]);
                assertEquals(logs.split("RunWield-Publication-Attempt: wt-host").length - 1, 1);
            } finally {
                await fixture.close();
            }
        });
    }
}

for (const timing of ["before", "after"]) {
    Deno.test(`an invalid Recorder submission gets exactly one retry after a crash ${timing} its receipt`, async () => {
        await prepareIndexRuntime();
        const fixture = await attachedValidationFixture({ attrs: { humanReviewMode: "none" } });
        try {
            const started = await toDelivery(fixture);
            const workflow = started.workflow;
            assert(workflow.nextAction.kind === "recorder");
            await crash(
                fixture,
                "work_record_completed",
                {
                    workflowId: workflow.workflowId,
                    expectedRevision: workflow.revision,
                    operationId: "lost-invalid-outcome",
                    evidence: EVIDENCE,
                    payload: { actionId: workflow.nextAction.actionId, title: "", summary: "" },
                },
                "recorder_rejected",
                timing,
            );
            const status = await spawnAttachedCli("status", fixture.root, { workflowId: workflow.workflowId });
            assert(status.result.ok);
            const recovered = await spawnAttachedCli("start_validation", fixture.root, {
                workflowId: workflow.workflowId,
                expectedRevision: status.result.workflow.revision,
                operationId: "recover-invalid",
                evidence: EVIDENCE,
                payload: {},
            });
            const current = recovered.result.workflow;
            assert(current?.nextAction.kind === "recorder", JSON.stringify(recovered.result));
            assertEquals((await fixture.plan()).attrs.validationCheckpoint?.hostRecorder?.invalidSubmissions, 1);
            const completed = await fixture.call("work_record_completed", current, {
                actionId: current.nextAction.actionId,
                title: "Value outcome",
                summary: "The value is implemented.",
            });
            assert(completed.ok && completed.workflow.nextAction.kind === "delivered", JSON.stringify(completed));
            assertEquals((await listWorkRecords(fixture.root)).length, 1);
        } finally {
            await fixture.close();
        }
    });
}

for (const outcome of ["approved", "feedback"]) {
    for (const timing of ["before", "after"] as const) {
        Deno.test(`a fresh process preserves code-review ${outcome} ${timing} its decision claim`, async () => {
            const fixture = await attachedValidationFixture();
            try {
                const started = await toDelivery(fixture);
                assert(started.workflow.nextAction.kind === "code_review");
                const input = {
                    workflowId: started.workflow.workflowId,
                    expectedRevision: started.workflow.revision,
                    operationId: "interrupted-browser-decision",
                    evidence: EVIDENCE,
                    payload: {
                        actionId: started.workflow.nextAction.actionId,
                        answer: { outcome, ...(outcome === "feedback" ? { message: "Export value 3." } : {}) },
                    },
                };
                await crash(fixture, "validation_decision", input, "code_review_decision", timing);
                const status = await spawnAttachedCli("status", fixture.root, { workflowId: fixture.workflowId });
                assert(status.result.ok);
                const continued = timing === "before"
                    ? await spawnAttachedCli("validation_decision", fixture.root, input)
                    : await spawnAttachedCli("start_validation", fixture.root, {
                        workflowId: fixture.workflowId,
                        expectedRevision: status.result.workflow.revision,
                        operationId: "resume-saved-decision",
                        evidence: EVIDENCE,
                        payload: {},
                    });
                assert(continued.result.ok, JSON.stringify(continued.result));
                const action = continued.result.workflow.nextAction;
                if (outcome === "approved") assert(action.kind === "recorder", JSON.stringify(action));
                else {
                    assert(action.kind === "validation" && action.request.kind === "repair", JSON.stringify(action));
                    assert(action.request.prompt.includes("Export value 3."));
                }
                assertEquals((await fixture.evidence()).filter((entry) => entry.kind === "human").length, 1);
            } finally {
                await fixture.close();
            }
        });
    }
}

for (const timing of ["before", "after"] as const) {
    Deno.test(`a fresh process reports in-place completion ${timing} Core verification without a Git claim`, async () => {
        await prepareIndexRuntime();
        const fixture = await attachedValidationFixture({ nonGit: true, attrs: { humanReviewMode: "none" } });
        try {
            await Deno.writeTextFile(join(fixture.cwd, "marker"), "pass");
            const started = await fixture.call("start_validation", await fixture.status());
            assert(started.ok && started.workflow.nextAction.kind === "recorder", JSON.stringify(started));
            await crash(
                fixture,
                "work_record_completed",
                {
                    workflowId: fixture.workflowId,
                    expectedRevision: started.workflow.revision,
                    operationId: "interrupted-in-place-record",
                    evidence: EVIDENCE,
                    payload: {
                        actionId: started.workflow.nextAction.actionId,
                        title: "In-place value",
                        summary: "Implemented in place with consent.",
                    },
                },
                "in_place_verified",
                timing,
            );
            const status = await spawnAttachedCli("status", fixture.root, { workflowId: fixture.workflowId });
            assert(status.result.ok);
            const resumed = await spawnAttachedCli("start_validation", fixture.root, {
                workflowId: fixture.workflowId,
                expectedRevision: status.result.workflow.revision,
                operationId: "resume-in-place",
                evidence: EVIDENCE,
                payload: {},
            });
            assert(
                resumed.result.ok && resumed.result.workflow.nextAction.kind === "delivered",
                JSON.stringify(resumed.result) + "\n" +
                    await Deno.readTextFile(join(getHomeDir(), ".wld/debug/validation-errors.jsonl")).catch(() => ""),
            );
            assertEquals(resumed.result.workflow.nextAction.completionMode, "in_place");
            assert(resumed.result.workflow.nextAction.guidance.includes("no Git publication is claimed"));
            const records = await listWorkRecords(fixture.root);
            assertEquals(records.length, 1);
            assertEquals(records[0].attrs.status, "approved");
            assertEquals(
                (await findIndexedDocumentIdsByRecordId(fixture.root, records[0].attrs.recordId, {
                    mnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
                })).length,
                1,
            );
        } finally {
            await fixture.close();
        }
    });
}
