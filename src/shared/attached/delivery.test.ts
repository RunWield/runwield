import { writeFile, readFile, chmod, stat } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { attachedValidationFixture } from "./validation-test-fixture.ts";
import { approveSemantic, prepareIndexRuntime, toDelivery } from "./delivery-test-fixture.ts";
import { listWorkRecords } from "../work-records/store.js";
import { git } from "../git-test-fixture.ts";
import { loadPlan } from "../../plan-store.js";
import {
    type CliRun,
    CLI_PATH,
    DENO_CONFIG_PATH,
    EVIDENCE,
    readRecordBytes,
    spawnAttachedCli,
} from "./attached-test-fixture.ts";
import { captureForegroundProcess } from "../captured-process.ts";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { resolveProjectRuntimeLayout } from "../project-runtime-layout.ts";
import { findById } from "../worktree-registry.js";
import { loadAttachedWorkflowRecord, locateAttachedWorkflows } from "./record-store.ts";
import process from "node:process";
import type { AttachedNextAction, AttachedOperationResult } from "./operations.ts";
import { compactResult } from "./presentation.ts";

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

test("Attached FEATURE records Claude sections and proves publication before delivered closure", async () => {
    const fixture = await attachedValidationFixture({ attrs: { workKind: "FEATURE", humanReviewMode: "none" } });
    try {
        const result = await toDelivery(fixture);
        assert(
            result.workflow.nextAction.kind === "recorder",
            JSON.stringify({ result, plan: await loadPlan(fixture.root, "p") }),
        );
        assertStringIncludes(result.instructions?.text || "", "Attached Recorder");
        const action = result.workflow.nextAction;
        const completed = await fixture.call("work_record_completed", result.workflow, {
            actionId: action.actionId,
            title: "Value implemented",
            summary: "The implementation exports the new value.",
        });
        assert(completed.ok, JSON.stringify(completed));
        assertEquals(completed.workflow.closure?.reason, "delivered");
        const plan = await loadPlan(fixture.root, "p");
        assertEquals(plan?.attrs.status, "verified");
        const records = await listWorkRecords(fixture.root);
        assertEquals(records.length, 1);
        assertEquals(records[0].attrs.status, "approved");
        assert(plan?.attrs.publicationReceipt?.publishedCommit);
        assertEquals(
            await git(fixture.root, [
                "merge-base",
                "--is-ancestor",
                plan.attrs.publicationReceipt.publishedCommit,
                "main",
            ]),
            "",
        );
        assertEquals((await fixture.status()).nextAction.kind, "delivered");
    } finally {
        await fixture.close();
    }
});

test("Attached code review rejects an approval after the worktree changes", async () => {
    const fixture = await attachedValidationFixture();
    try {
        const result = await toDelivery(fixture);
        assert(result.workflow.nextAction.kind === "code_review", JSON.stringify(result));
        const action = result.workflow.nextAction;
        await writeFile(join(fixture.cwd, "implementation.ts"), "export const value = 9;\n");
        const rejected = await fixture.call("validation_decision", result.workflow, {
            actionId: action.actionId,
            answer: { outcome: "approved" },
        });
        assert(!rejected.ok, JSON.stringify(rejected));
        assertEquals((await loadPlan(fixture.root, "p"))?.attrs.publicationReceipt ?? null, null);
        const refreshed = await fixture.call("start_validation", await fixture.status());
        assert(refreshed.ok && refreshed.workflow.nextAction.kind === "code_review", JSON.stringify(refreshed));
        assert(refreshed.workflow.nextAction.actionId !== action.actionId);
        assertStringIncludes(String(refreshed.workflow.nextAction.request.interaction._meta?.diffText), "value = 9");
    } finally {
        await fixture.close();
    }
});

test("two invalid Recorder submissions are rejected and recording failure does not block delivery", async () => {
    const fixture = await attachedValidationFixture({ attrs: { humanReviewMode: "none" } });
    try {
        const started = await toDelivery(fixture);
        assert(started.workflow.nextAction.kind === "recorder");
        const first = await fixture.call(
            "work_record_completed",
            started.workflow,
            {
                actionId: started.workflow.nextAction.actionId,
                title: "",
                summary: "",
            },
            "invalid-first",
        );
        assert(!first.ok && first.workflow?.nextAction.kind === "recorder", JSON.stringify(first));
        assertStringIncludes(first.rejection.message, "non-empty title");
        assert(first.workflow.nextAction.actionId !== started.workflow.nextAction.actionId);
        const replay = await fixture.call(
            "work_record_completed",
            started.workflow,
            {
                actionId: started.workflow.nextAction.actionId,
                title: "",
                summary: "",
            },
            "invalid-first",
        );
        assertEquals(replay, first);
        const second = await fixture.call("work_record_completed", first.workflow, {
            actionId: first.workflow.nextAction.actionId,
            title: "",
            summary: "",
        });
        assert(!second.ok && second.workflow?.nextAction.kind === "delivered", JSON.stringify(second));
        const plan = await loadPlan(fixture.root, "p");
        assertEquals(plan?.attrs.workRecord?.status, "failed");
        assertEquals(plan?.attrs.status, "verified");
        assertEquals((await listWorkRecords(fixture.root)).length, 0);
    } finally {
        await fixture.close();
    }
});

test("a missing supersession record is rejected before accepting Recorder sections", async () => {
    const fixture = await attachedValidationFixture({ attrs: { humanReviewMode: "none" } });
    try {
        const started = await toDelivery(fixture);
        assert(started.workflow.nextAction.kind === "recorder");
        const first = await fixture.call("work_record_completed", started.workflow, {
            actionId: started.workflow.nextAction.actionId,
            title: "Value",
            summary: "Implemented.",
            supersessionProposals: [{ recordId: "de174442-62e4-4c14-980c-783531bdb457", reason: "Replaces old value" }],
        });
        assert(!first.ok && first.workflow?.nextAction.kind === "recorder", JSON.stringify(first));
        assertStringIncludes(first.rejection.message, "not found");
        const retry = await fixture.call("work_record_completed", first.workflow, {
            actionId: first.workflow.nextAction.actionId,
            title: "Value",
            summary: "Implemented.",
        });
        assert(retry.ok && retry.workflow.nextAction.kind === "delivered", JSON.stringify(retry));
    } finally {
        await fixture.close();
    }
});

test("human feedback runs in a Claude repair action and re-verifies before a new code review", async () => {
    const fixture = await attachedValidationFixture();
    try {
        const started = await toDelivery(fixture);
        assert(started.workflow.nextAction.kind === "code_review");
        const feedback = await fixture.call("validation_decision", started.workflow, {
            actionId: started.workflow.nextAction.actionId,
            answer: { outcome: "feedback", message: "Export value 3." },
        });
        assert(feedback.ok && feedback.workflow.nextAction.kind === "validation", JSON.stringify(feedback));
        const repair = feedback.workflow.nextAction;
        assert(repair.request.kind === "repair");
        assertStringIncludes(repair.request.prompt, "Export value 3.");
        assertEquals((await fixture.plan()).attrs.validationCheckpoint?.repairKind, "human_feedback");
        await writeFile(join(fixture.cwd, "implementation.ts"), "export const value = 3;\n");
        const completion = await fixture.call("task_completed", feedback.workflow, {
            actionId: repair.actionId,
            message: "- Exported value 3 as requested.",
        });
        assert(completion.ok, JSON.stringify(completion));
        const reviewed = completion;
        assertEquals(reviewed.workflow.nextAction.kind, "code_review");
        assertEquals(await fixture.ciCount(), 2);
        assert(
            reviewed.workflow.nextAction.kind === "code_review" &&
                reviewed.workflow.nextAction.actionId !== started.workflow.nextAction.actionId,
        );
    } finally {
        await fixture.close();
    }
});

test("canceled code review supports Retry and Stop without losing the pending approval", async () => {
    const fixture = await attachedValidationFixture();
    try {
        const started = await toDelivery(fixture);
        assert(started.workflow.nextAction.kind === "code_review");
        const canceled = await fixture.call("validation_decision", started.workflow, {
            actionId: started.workflow.nextAction.actionId,
            answer: { outcome: "canceled" },
        });
        assert(
            canceled.ok &&
                canceled.workflow.nextAction.kind === "validation" &&
                canceled.workflow.nextAction.request.kind === "decision",
        );
        const retry = await fixture.call("validation_decision", canceled.workflow, {
            actionId: canceled.workflow.nextAction.actionId,
            answer: { outcome: "selected", value: "retry" },
        });
        assert(retry.ok && retry.workflow.nextAction.kind === "code_review", JSON.stringify(retry));
        const canceledAgain = await fixture.call("validation_decision", retry.workflow, {
            actionId: retry.workflow.nextAction.actionId,
            answer: { outcome: "canceled" },
        });
        assert(
            canceledAgain.ok && canceledAgain.workflow.nextAction.kind === "validation",
            JSON.stringify(canceledAgain),
        );
        const stop = await fixture.call("validation_decision", canceledAgain.workflow, {
            actionId: canceledAgain.workflow.nextAction.actionId,
            answer: { outcome: "selected", value: "stop" },
        });
        assert(stop.ok && stop.workflow.nextAction.kind === "validation_recovery", JSON.stringify(stop));
        const resumed = await fixture.call("start_validation", stop.workflow);
        assert(resumed.ok && resumed.workflow.nextAction.kind === "code_review", JSON.stringify(resumed));
    } finally {
        await fixture.close();
    }
});

test("consented non-Git completion records through Claude before Core establishes Verified", async () => {
    await prepareIndexRuntime();
    const fixture = await attachedValidationFixture({ nonGit: true, attrs: { humanReviewMode: "none" } });
    try {
        await writeFile(join(fixture.cwd, "marker"), "pass");
        const started = await fixture.call("start_validation", await fixture.status());
        assert(started.ok && started.workflow.nextAction.kind === "recorder", JSON.stringify(started));
        assertEquals((await fixture.plan()).attrs.status, "reviewed");
        const result = await fixture.call("work_record_completed", started.workflow, {
            actionId: started.workflow.nextAction.actionId,
            title: "In-place result",
            summary: "Changed the current files with consent.",
        });
        assert(result.ok && result.workflow.nextAction.kind === "delivered", JSON.stringify(result));
        assertEquals(result.workflow.nextAction.completionMode, "in_place");
        assertStringIncludes(result.workflow.nextAction.guidance, "no Git publication is claimed");
        assertEquals((await listWorkRecords(fixture.root))[0].attrs.status, "approved");
    } finally {
        await fixture.close();
    }
});

for (const committed of [false, true]) {
    test(`${committed ? "committed" : "uncommitted"} implementation edits during Recorder wait require fresh CI, semantic review and human approval`, async () => {
        const fixture = await attachedValidationFixture();
        try {
            const started = await toDelivery(fixture);
            assert(started.workflow.nextAction.kind === "code_review");
            const approved = await fixture.call("validation_decision", started.workflow, {
                actionId: started.workflow.nextAction.actionId,
                answer: { outcome: "approved" },
            });
            assert(approved.ok && approved.workflow.nextAction.kind === "recorder");
            await writeFile(join(fixture.cwd, "implementation.ts"), "export const value = 4;\n");
            if (committed) {
                await git(fixture.cwd, ["add", "implementation.ts"]);
                await git(fixture.cwd, ["commit", "-m", "Edit during Recorder wait"]);
            }
            const resumed = await fixture.call("work_record_completed", approved.workflow, {
                actionId: approved.workflow.nextAction.actionId,
                title: "Value outcome",
                summary: "The implementation exports the new value.",
            });
            assert(resumed.ok && resumed.workflow.nextAction.kind === "validation", JSON.stringify(resumed));
            assertEquals(resumed.workflow.nextAction.request.kind, "reviewer");
            assertEquals(await fixture.ciCount(), 2);
            assertEquals((await loadPlan(fixture.root, "p"))?.attrs.publicationReceipt ?? null, null);
            const reviewed = await approveSemantic(fixture, resumed.workflow);
            assertEquals(reviewed.workflow.nextAction.kind, "code_review");
        } finally {
            await fixture.close();
        }
    });
}

for (const invalid of [false, true]) {
    test(`delivery to another branch retains the ${invalid ? "failed" : "generated"} recording outcome`, async () => {
        const fixture = await attachedValidationFixture({
            attrs: { humanReviewMode: "none", deliveryBranch: "landing" },
        });
        try {
            await git(fixture.root, ["branch", "landing"]);
            const primaryPlan = await readFile(join(fixture.root, "docs/plans/p.md"), "utf8");
            let started = await toDelivery(fixture);
            assert(started.workflow.nextAction.kind === "recorder");
            const sections = {
                title: "Value outcome",
                summary: "Implemented.",
                supersessionProposals: invalid
                    ? [{ recordId: "de174442-62e4-4c14-980c-783531bdb457", reason: "Replaces old value" }]
                    : [],
            };
            if (invalid) {
                const first = await fixture.call("work_record_completed", started.workflow, {
                    actionId: started.workflow.nextAction.actionId,
                    ...sections,
                });
                assert(!first.ok && first.workflow?.nextAction.kind === "recorder");
                started = { ...started, workflow: first.workflow };
            }
            assert(started.workflow.nextAction.kind === "recorder");
            const completed = await fixture.call("work_record_completed", started.workflow, {
                actionId: started.workflow.nextAction.actionId,
                ...sections,
            });
            assertEquals(completed.ok, !invalid, JSON.stringify(completed));
            assert(completed.workflow?.nextAction.kind === "delivered", JSON.stringify(completed));
            assertEquals(completed.workflow.nextAction.workRecord?.status, invalid ? "failed" : "generated");
            assertEquals(await readFile(join(fixture.root, "docs/plans/p.md"), "utf8"), primaryPlan);
            const replayedCore = await fixture.turn();
            assert(replayedCore.kind === "verified", JSON.stringify(replayedCore));
            assertEquals(replayedCore.workRecord, completed.workflow.nextAction.workRecord);
            const restored = await fixture.status();
            assert(restored.nextAction.kind === "delivered");
            assertEquals(restored.nextAction.workRecord, completed.workflow.nextAction.workRecord);
        } finally {
            await fixture.close();
        }
    });
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
        const which = await captureForegroundProcess("sh", { cwd: fixture.root, args: ["-c", "command -v git"] });
        assert(which.success);
        const realGit = new TextDecoder().decode(which.stdout).trim();
        const registry = resolveProjectRuntimeLayout(fixture.root).primary.worktreeRegistryPath;
        // Gate only the child process's external Git read after real cleanup prunes the registry.
        // The first such Plan read builds the verified delivery result, before Attached accepts it.
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        const wrapper = join(fixture.bin, "git");
        await writeFile(
            wrapper,
            `#!/bin/sh
if [ "$1" = show ] && [ "\${2#*:}" = docs/plans/p.md ] && ! grep -q '"id": "wt-host"' ${quote(registry)}; then
    printf '%s\\n' "$*" > ${quote(entered)}
    while ! test -f ${quote(release)}; do sleep 0.01; done
fi
exec ${quote(realGit)} "$@"
`,
        );
        await chmod(wrapper, 0o755);
        pending = captureForegroundProcess(process.execPath, {
            args: runtimeSourceArgs([
                "run",
                "-A",
                "--quiet",
                "--no-check",
                "--config",
                DENO_CONFIG_PATH,
                CLI_PATH,
                "attached",
                "work_record_completed",
            ]),
            cwd: fixture.root,
            env: { PATH: `${fixture.bin}:${process.env.PATH || ""}` },
            stdinText: JSON.stringify(input),
            timeoutMs: 60_000,
        });
        const deadline = Date.now() + 30_000;
        while (
            !(await stat(entered).then(
                () => true,
                () => false,
            ))
        ) {
            assert(Date.now() < deadline, "The post-cleanup Git read did not reach the gate.");
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assertEquals(await findById(fixture.root, fixture.id, { migrate: false }), null);
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
        assertEquals(JSON.parse(new TextDecoder().decode(output.stdout)), compactResult(completed));
        assertEquals(saved.record.acceptedOperations[input.operationId].evidence, claim.record.validation.evidence);
    } finally {
        await writeFile(release, "continue\n");
        await pending?.catch(() => {});
        await fixture.close();
    }
});
