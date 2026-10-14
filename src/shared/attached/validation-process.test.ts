import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { collectProcessOutput } from "../../testing/subprocess-output.ts";
import { test } from "node:test";
import { spawnNativeProcess } from "../foreground-process.ts";
import { stat as fsStat, writeFile as fsWriteFile } from "node:fs/promises";
import { ok as assert } from "node:assert/strict";
import { assertEquals } from "../../testing/assertions.ts";
import { join } from "node:path";
import { makeValidationCheckpoint } from "../workflow/validation-checkpoint.ts";
import { createLedger } from "../workflow/review-ledger.ts";
import { attachedValidationFixture } from "./validation-test-fixture.ts";
import { CLI_PATH, DENO_CONFIG_PATH, EVIDENCE, spawnAttachedCli } from "./attached-test-fixture.ts";
import { loadAttachedWorkflowRecord, locateAttachedWorkflows } from "./record-store.ts";
import { type AttachedNextAction, type AttachedJsonObject } from "./operations.ts";
import process from "node:process";

test("fresh CLI processes restore the same validation handoff and replay completion", async () => {
    const fixture = await attachedValidationFixture();
    try {
        const workflow = await fixture.status();
        const start: AttachedJsonObject = {
            operationId: "start-validation",
            workflowId: workflow.workflowId,
            expectedRevision: workflow.revision,
            evidence: EVIDENCE,
            payload: {},
        };
        const first = await spawnAttachedCli("start_validation", fixture.root, start);
        assert(first.result.ok && first.result.workflow.nextAction.kind === "validation");
        const replay = await spawnAttachedCli("start_validation", fixture.root, start);
        assertEquals(replay.result, first.result);
        const status = await spawnAttachedCli("status", fixture.root, { workflowId: workflow.workflowId });
        assert(status.result.ok);
        assertEquals(status.result.workflow.nextAction, first.result.workflow.nextAction);
        assertEquals(await fixture.ciCount(), 1);
    } finally {
        await fixture.close();
    }
});

test("CI runs outside the Attached record lock; concurrent calls are bounded and dead callers recover", async () => {
    const fixture = await attachedValidationFixture({
        command: "sh -c 'touch ci-started; while ! test -f release-ci; do sleep 0.1; done'",
    });
    let child: import("../foreground-process.ts").NativeProcess | undefined;
    try {
        const workflow = await fixture.status();
        child = spawnNativeProcess(process.execPath, {
            args: runtimeSourceArgs([
                "run",
                "-A",
                "--quiet",
                "--no-check",
                "--config",
                DENO_CONFIG_PATH,
                CLI_PATH,
                "attached",
                "start_validation",
            ]),
            cwd: fixture.root,
            stdin: "piped",
            stdout: "piped",
            stderr: "piped",
        });
        const writer = child.stdin.getWriter();
        await writer.write(
            new TextEncoder().encode(
                JSON.stringify({
                    operationId: "interrupted-ci",
                    workflowId: workflow.workflowId,
                    expectedRevision: workflow.revision,
                    evidence: EVIDENCE,
                    payload: {},
                }),
            ),
        );
        await writer.close();
        const deadline = Date.now() + 30_000;
        while (
            !(await fsStat(join(fixture.cwd, "ci-started")).then(
                () => true,
                () => false,
            ))
        ) {
            assert(Date.now() < deadline, "CI did not start");
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const waiting = await fixture.status();
        assertEquals(waiting.state, "validating");
        const started = Date.now();
        const concurrent = await fixture.call("start_validation", waiting);
        assert(!concurrent.ok);
        assertEquals(concurrent.rejection.code, "workflow_busy");
        assert(Date.now() - started < 5_000, "The record lock must not span CI");
        child.kill("SIGKILL");
        await child.status;
        await collectProcessOutput(child);
        child = undefined;
        await fsWriteFile(join(fixture.cwd, "release-ci"), "continue");
        const recovered = await fixture.call("start_validation", await fixture.status());
        assert(recovered.ok && recovered.workflow.nextAction.kind === "validation", JSON.stringify(recovered));
        const record = await loadAttachedWorkflowRecord(locateAttachedWorkflows(fixture.root), workflow.workflowId);
        assert(record.status === "found");
        assertEquals(record.record.validation?.holder, undefined);
    } finally {
        if (child) {
            child.kill("SIGKILL");
            await collectProcessOutput(child);
        }
        await fsWriteFile(join(fixture.cwd, "release-ci"), "continue").catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 200));
        await fixture.close();
    }
});

test("fresh CLI workers complete CI repair, direct review, semantic repair, and verify-round approval", async () => {
    const fixture = await attachedValidationFixture({
        attrs: {
            validationCheckpoint: makeValidationCheckpoint({
                attemptId: "wt-host",
                generation: "multiprocess-validation",
                status: "implemented",
                phase: "mechanical",
                state: "ready",
                reviewState: { semanticRound: 1, reviewLedger: createLedger(), repairBaselineTree: "" },
            }),
        },
    });
    try {
        let workflow = await fixture.status();
        const call = async (name: import("./operations.ts").AttachedOperationName, payload: AttachedJsonObject) => {
            const response = await spawnAttachedCli(name, fixture.root, {
                workflowId: workflow.workflowId,
                expectedRevision: workflow.revision,
                operationId: crypto.randomUUID(),
                evidence: EVIDENCE,
                payload,
            });
            assert(response.result.ok, JSON.stringify(response.result));
            workflow = response.result.workflow;
            return response.result;
        };
        await call("start_validation", {});
        assert(workflow.nextAction.kind === "validation" && workflow.nextAction.request.kind === "repair");
        await fsWriteFile(join(fixture.cwd, "marker"), "fixed");
        await call("task_completed", { actionId: workflow.nextAction.actionId, message: "- Fixed CI marker." });
        let repaired = false;
        let verified = false;
        for (let round = 0; round < 6 && workflow.state === "validating"; round++) {
            const action: AttachedNextAction = workflow.nextAction;
            assert(action.kind === "validation" && action.request.kind === "reviewer");
            verified ||= action.request.reviewMode === "verify";
            const { parseDiffFiles } = await import("../workflow/review-diff.ts");
            for (const file of parseDiffFiles(
                action.request.requiredScope === "full" ? action.request.fullDiff : action.request.repairDiff,
            )) {
                let offset = 0;
                while (offset < file.byteLength) {
                    const read = await call("review_diff", {
                        actionId: action.actionId,
                        command: "show",
                        scope: action.request.requiredScope,
                        path: file.path,
                        offsetBytes: offset,
                        maxBytes: 65536,
                    });
                    assert(read.diff?.coverage);
                    offset = read.diff.coverage.end;
                }
            }
            await call("review_complete", {
                actionId: action.actionId,
                ...(repaired
                    ? { approved: true, findings: [{ id: "R2-1", title: "Value", status: "fix_confirmed" }] }
                    : {
                          approved: false,
                          findings: [
                              {
                                  title: "Value",
                                  status: "new",
                                  requirement: "Implement the value",
                                  evidence: "The value needs repair",
                              },
                          ],
                      }),
            });
            if (!repaired) {
                const repair: AttachedNextAction = workflow.nextAction;
                assert(repair.kind === "validation" && repair.request.kind === "repair");
                await fsWriteFile(join(fixture.cwd, "implementation.ts"), "export const value = 2; // repaired\n");
                await call("task_completed", {
                    actionId: repair.actionId,
                    message: "- R2-1 — fixed the value. Focused checks passed.",
                });
                repaired = true;
            }
        }
        assert(verified);
        assertEquals(workflow.state, "reviewed");
        assertEquals((await fixture.plan()).attrs.status, "reviewed");
        assertEquals(await fixture.ciCount(), 3);
    } finally {
        await fixture.close();
    }
});
