import { writeFile, readFile, stat } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { attachedValidationFixture } from "./validation-test-fixture.ts";
import { toDelivery } from "./delivery-test-fixture.ts";
import { git } from "../git-test-fixture.ts";
import { loadPlan } from "../../plan-store/index.ts";
import { type CliRun, DENO_CONFIG_PATH, EVIDENCE, readRecordBytes, spawnAttachedCli } from "./attached-test-fixture.ts";
import { captureForegroundProcess } from "../captured-process.ts";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { resolveProjectRuntimeLayout } from "../project-runtime-layout.ts";
import { findById } from "../worktree-registry.js";
import { loadAttachedWorkflowRecord, locateAttachedWorkflows } from "./record-store.ts";
import process from "node:process";
import type { AttachedNextAction, AttachedOperationResult } from "./operations.ts";

for (const resolve of [true, false]) {
    test(
        resolve
            ? "Attached publication repairs a real delivery conflict in the host cwd without repeating validation"
            : "Attached publication stops requesting repairs after two unresolved host completions across processes",
        async () => {
            const fixture = await attachedValidationFixture({ attrs: { humanReviewMode: "none" } });
            try {
                const remote = join(fixture.parent, "publication.git");
                await git(fixture.root, ["clone", "--bare", fixture.root, remote]);
                await git(fixture.root, ["remote", "add", "origin", remote]);
                await git(fixture.root, ["push", "--set-upstream", "origin", "main"]);
                const ciCountPath = join(fixture.parent, "publication-ci-count");
                await writeFile(
                    join(fixture.cwd, "verify.sh"),
                    `#!/bin/sh\nprintf ci >> '${ciCountPath}'\ntest -f marker\n`,
                );
                const started = await toDelivery(fixture);
                assert(started.workflow.nextAction.kind === "recorder", JSON.stringify(started));
                const validated = await fixture.plan();
                const reviewState = validated.attrs.validationCheckpoint?.reviewState;
                await writeFile(join(fixture.root, "implementation.ts"), "export const value = 2; // target\n");
                await git(fixture.root, ["add", "implementation.ts"]);
                await git(fixture.root, ["commit", "-m", "Update target value"]);
                await git(fixture.root, ["push", "origin", "main"]);
                const targetCommit = await git(fixture.root, ["rev-parse", "HEAD"]);
                let result: AttachedOperationResult = await fixture.call("work_record_completed", started.workflow, {
                    actionId: started.workflow.nextAction.actionId,
                    title: "Value implemented",
                    summary: "The implementation exports the new value.",
                });
                assert(result.ok && result.workflow.nextAction.kind === "validation", JSON.stringify(result));
                const firstRepair = result.workflow.nextAction;
                assert(firstRepair.request.kind === "repair", JSON.stringify(firstRepair));
                assert(firstRepair.request.cwd !== fixture.cwd);
                assertStringIncludes(
                    await readFile(join(firstRepair.request.cwd, "implementation.ts"), "utf8"),
                    "<<<<<<<",
                );
                assertStringIncludes(firstRepair.request.prompt, firstRepair.request.cwd);
                const waiting = await fixture.plan();
                assertEquals(waiting.attrs.validationCheckpoint?.reviewState, reviewState);
                const recorder = waiting.attrs.validationCheckpoint?.hostRecorder;
                assert(recorder?.sections);
                for (let completion = 0; completion < (resolve ? 1 : 2); completion += 1) {
                    assert(result.ok && result.workflow.nextAction.kind === "validation", JSON.stringify(result));
                    const repair: AttachedNextAction = result.workflow.nextAction;
                    assert(repair.request.kind === "repair", JSON.stringify(repair));
                    if (resolve) {
                        await writeFile(
                            join(repair.request.cwd, "implementation.ts"),
                            "export const value = 3; // resolved\n",
                        );
                        await git(repair.request.cwd, ["add", "implementation.ts"]);
                    }
                    const child: CliRun = await spawnAttachedCli("task_completed", fixture.root, {
                        workflowId: result.workflow.workflowId,
                        expectedRevision: result.workflow.revision,
                        operationId: `publication-completion-${completion}`,
                        evidence: EVIDENCE,
                        payload: { actionId: repair.actionId, message: "Publication repair completed." },
                    });
                    assertEquals(child.code, 0, child.stderr);
                    assert(child.result.ok, JSON.stringify(child.result));
                    result = { ...child.result, workflow: await fixture.status() };
                }
                assertEquals(await readFile(ciCountPath, "utf8"), "ci");
                if (resolve) {
                    assert(result.ok && result.workflow.nextAction.kind === "delivered", JSON.stringify(result));
                    const plan = await loadPlan(fixture.root, "p");
                    const publishedCommit = plan?.attrs.publicationReceipt?.publishedCommit;
                    assert(publishedCommit);
                    assertEquals(await git(remote, ["merge-base", "--is-ancestor", publishedCommit, "main"]), "");
                    assertEquals(await git(remote, ["merge-base", "--is-ancestor", targetCommit, "main"]), "");
                    assertEquals(
                        await git(remote, ["show", "main:implementation.ts"]),
                        "export const value = 3; // resolved",
                    );
                    assertEquals(result.workflow.nextAction.workRecord?.status, "generated");
                    assertEquals(result.workflow.nextAction.workRecord?.recordId, recorder.recordId);
                } else {
                    assert(result.ok);
                    const next = result.workflow.nextAction;
                    assert(
                        next.kind === "validation_recovery" ||
                            (next.kind === "validation" && next.request.kind === "decision"),
                        JSON.stringify(result),
                    );
                    const plan = await fixture.plan();
                    assertEquals(plan.attrs.validationCheckpoint?.reviewState, reviewState);
                    assertEquals(plan.attrs.validationCheckpoint?.hostRecorder, recorder);
                    assertEquals(plan.attrs.publicationReceipt ?? null, null);
                    assertEquals(await git(remote, ["rev-parse", "main"]), targetCommit);
                }
            } finally {
                await fixture.close();
            }
        },
    );
}

test("status polling preserves the live Recorder claim after publication cleanup until completion is accepted", async () => {
    const fixture = await attachedValidationFixture({ attrs: { workKind: "FEATURE", humanReviewMode: "none" } });
    const release = join(fixture.parent, "release-git");
    const entered = join(fixture.parent, "git-entered");
    let pending: ReturnType<typeof captureForegroundProcess> | undefined;
    try {
        const started = await toDelivery(fixture);
        assert(started.workflow.nextAction.kind === "recorder");
        assertEquals(await fixture.ciCount(), 1);
        const payload = {
            actionId: started.workflow.nextAction.actionId,
            title: "Delivered value",
            summary: "The implementation exports the new value.",
        };
        const input = {
            workflowId: fixture.workflowId,
            expectedRevision: started.workflow.revision,
            operationId: "live-recorder-completion",
            evidence: EVIDENCE,
            payload,
        };
        const config = join(fixture.parent, "live-recorder.json");
        await writeFile(
            config,
            JSON.stringify({
                projectRoot: fixture.root,
                operation: "work_record_completed",
                input,
                cleanupGate: {
                    registryPath: resolveProjectRuntimeLayout(fixture.root).primary.worktreeRegistryPath,
                    attemptId: fixture.id,
                    entered,
                    release,
                },
            }),
        );
        pending = captureForegroundProcess(process.execPath, {
            args: runtimeSourceArgs([
                "run",
                "-A",
                "--quiet",
                "--no-check",
                "--config",
                DENO_CONFIG_PATH,
                new URL("./testing/delivery-process.ts", import.meta.url).pathname,
                config,
            ]),
            cwd: fixture.root,
            env: { PATH: `${fixture.bin}:${process.env.PATH || ""}` },
            stdinText: JSON.stringify(input),
            timeoutMs: 60_000,
        });
        // The child owns the 60-second operation deadline. Report an early exit immediately
        // instead of rejecting a live publication halfway through its allowed runtime.
        const exitedBeforeGate = pending.then((output) => {
            throw new Error(
                `Recorder completion exited before the persisted-cleanup filesystem gate (code ${output.code}): ` +
                    new TextDecoder().decode(output.stderr) +
                    new TextDecoder().decode(output.stdout),
            );
        });
        void exitedBeforeGate.catch(() => {});
        while (
            !(await stat(entered).then(
                () => true,
                () => false,
            ))
        ) {
            await Promise.race([exitedBeforeGate, new Promise((resolve) => setTimeout(resolve, 10))]);
        }
        assertEquals(await findById(fixture.root, fixture.id), null);
        const published = await loadPlan(fixture.root, "p");
        assert(published?.attrs.publicationReceipt?.publishedCommit);
        const location = locateAttachedWorkflows(fixture.root);
        const claim = await loadAttachedWorkflowRecord(location, fixture.workflowId);
        assert(claim.status === "found" && claim.record.validation?.holder?.token);
        assertEquals(claim.record.validation.operationId, input.operationId);
        const bytes = await readRecordBytes(fixture.root, fixture.workflowId);
        for (let poll = 0; poll < 3; poll++) {
            const status = await fixture.status();
            assertEquals(status.state, "validating");
            assertEquals(status.revision, claim.record.revision);
            assertEquals(status.nextAction.kind, "validation_recovery");
            assertEquals(await readRecordBytes(fixture.root, fixture.workflowId), bytes);
        }
        const concurrent = await fixture.call("start_validation", await fixture.status());
        assert(!concurrent.ok);
        assertEquals(concurrent.rejection.code, "workflow_busy");
        await writeFile(release, "continue\n");
        const output = await pending;
        assert(output.success, new TextDecoder().decode(output.stderr) + new TextDecoder().decode(output.stdout));
        const completed = await fixture.call("work_record_completed", started.workflow, payload, input.operationId);
        assert(completed.ok && completed.workflow.nextAction.kind === "delivered", JSON.stringify(completed));
        assertEquals(completed.operation, "work_record_completed");
        assertEquals(completed.workflow.nextAction.workRecord?.status, "generated");
        const replay = await fixture.call("work_record_completed", started.workflow, payload, input.operationId);
        assertEquals(replay, completed);
        assertEquals((await fixture.status()).nextAction, completed.workflow.nextAction);
        const saved = await loadAttachedWorkflowRecord(location, fixture.workflowId);
        assert(saved.status === "found");
        assertEquals(saved.record.acceptedOperations[input.operationId].result.workflow, completed.workflow);
        const outputText = new TextDecoder().decode(output.stdout);
        assertEquals(JSON.parse(outputText.slice(outputText.lastIndexOf("ATTACHED_RESULT=") + 16)), completed);
        assertEquals(saved.record.acceptedOperations[input.operationId].evidence, claim.record.validation.evidence);
    } finally {
        await writeFile(release, "continue\n");
        await pending?.catch(() => {});
        await fixture.close();
    }
});
