import process from "node:process";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { collectProcessOutput } from "../../testing/subprocess-output.ts";
import { spawnNativeProcess } from "../foreground-process.ts";
import { writeFile, stat } from "node:fs/promises";
import { findIndexedDocumentIdsByRecordId } from "../work-records/index-adapter.ts";
import { SYSTEM_WORK_RECORD_MNEMOTECA_PORT } from "../work-records/mnemoteca-port.ts";
import { ok as assert } from "node:assert/strict";
import { assertEquals } from "../../testing/assertions.ts";
import { fileURLToPath as fromFileUrl } from "node:url";
import { join } from "node:path";
import { attachedValidationFixture } from "./validation-test-fixture.ts";
import { inspectSemantic, prepareIndexRuntime, toDelivery } from "./delivery-test-fixture.ts";
import { DENO_CONFIG_PATH, EVIDENCE, spawnAttachedCli } from "./attached-test-fixture.ts";
import { listWorkRecords } from "../work-records/store.js";
import { loadPlan } from "../../plan-store.js";
import { git } from "../git-test-fixture.ts";
import type { AttachedJsonObject, AttachedOperationName } from "./operations.ts";

type Fixture = Awaited<ReturnType<typeof attachedValidationFixture>>;
export async function crash(
    fixture: Fixture,
    operation: AttachedOperationName,
    input: AttachedJsonObject,
    point: string,
    timing: string,
) {
    const config = join(fixture.parent, "crash.json");
    await writeFile(config, JSON.stringify({ projectRoot: fixture.root, operation, input, crashPoint: point, timing }));
    const output = await collectProcessOutput(
        spawnNativeProcess(process.execPath, {
            args: runtimeSourceArgs([
                "run",
                "-A",
                "--quiet",
                "--no-check",
                "--config",
                DENO_CONFIG_PATH,
                fromFileUrl(new URL("./testing/delivery-process.ts", import.meta.url)),
                config,
            ]),
            cwd: fixture.root,
            stdin: "null",
            env: { PATH: `${fixture.bin}:${process.env.PATH || ""}` },
            stdout: "piped",
            stderr: "piped",
        }),
    );
    assertEquals(output.code, 86, new TextDecoder().decode(output.stderr) + new TextDecoder().decode(output.stdout));
}

export async function recoverDelivery(point: string, timing: string): Promise<void> {
    await prepareIndexRuntime();
    const fixture = await attachedValidationFixture({ attrs: { workKind: "FEATURE" } });
    try {
        let workflow;
        let operation: AttachedOperationName;
        let payload: AttachedJsonObject;
        if (point === "code_review_wait") {
            await writeFile(join(fixture.cwd, "marker"), "pass");
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
                assert(approved.ok && approved.workflow.nextAction.kind === "recorder", JSON.stringify(approved));
                workflow = approved.workflow;
                operation = "work_record_completed";
                payload = {
                    actionId: approved.workflow.nextAction.actionId,
                    title: "Delivered value",
                    summary: "The implementation exports the new value.",
                };
            }
        }
        const savedRecorder =
            point !== "code_review_wait" && point !== "recorder_wait"
                ? (await fixture.plan()).attrs.validationCheckpoint?.hostRecorder
                : undefined;
        if (point !== "code_review_wait" && point !== "recorder_wait") assert(savedRecorder);
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
        if (point === "record_saved") {
            const records = await listWorkRecords(fixture.cwd);
            assertEquals(records.length, 1);
            assertEquals(records[0].attrs.recordId, savedRecorder?.recordId);
            assertEquals((await fixture.plan()).attrs.workRecord, undefined);
            assert((await fixture.plan()).attrs.validationCheckpoint?.hostRecorder?.sections);
        }
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
        if (savedRecorder) {
            assertEquals(workflow.nextAction.kind, "delivered", "Recovery must not request accepted work again.");
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
        if (savedRecorder) assertEquals(records[0].attrs.recordId, savedRecorder.recordId);
        assert(records[0].body.includes("The implementation exports the new value."));
        assertEquals(
            (
                await findIndexedDocumentIdsByRecordId(fixture.root, records[0].attrs.recordId, {
                    mnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
                })
            ).length,
            1,
        );
        const plan = await loadPlan(fixture.root, "p");
        assert(plan?.attrs.publicationReceipt);
        await git(fixture.root, ["merge-base", "--is-ancestor", plan.attrs.publicationReceipt.publishedCommit, "main"]);
        const evidence = await fixture.evidence();
        assertEquals(evidence.filter((entry) => entry.kind === "human" && entry.outcome === "Approved").length, 1);
        assertEquals(
            await stat(fixture.modelMarker).then(
                () => true,
                () => false,
            ),
            false,
        );
        const logs = await git(fixture.root, ["log", "--format=%B", "main"]);
        assertEquals(logs.split("RunWield-Publication-Attempt: wt-host").length - 1, 1);
    } finally {
        await fixture.close();
    }
}
