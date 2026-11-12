import { seedPlan } from "../testing/plan-state-fixture.ts";
import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { admitProjectIdentity } from "../project-identity.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import {
    EVIDENCE,
    activateInput,
    pendingTriage,
    planWrittenInput,
    runOperation,
    spawnAttachedCli,
    triageReportInput,
    projectFixture,
} from "./attached-test-fixture.ts";
import { locateAttachedWorkflows } from "./record-store.ts";
import { implementing, completionInput, executionInput } from "./execution-test-fixture.ts";
import { git } from "../git-test-fixture.ts";

import { applyAttachedReviewDecision, openAttachedReviewRound } from "./coordinator.ts";

test("a reused historical root cannot read or advance the moved Connect workflow", async () => {
    await withProcessGlobalTestLock(async () => {
        const home = await realpath(await mkdtemp(join(tmpdir(), "attached-reused-root-")));
        const root = await realpath(await projectFixture.checkout());
        const moved = `${root}-moved`;
        const previous = process.env.HOME;
        process.env.HOME = home;
        try {
            const pending = pendingTriage(await runOperation("activate", root, activateInput()));
            equal((await admitProjectIdentity(root)).kind, "existing");
            const file = join(locateAttachedWorkflows(root).workflowsDir, `${pending.workflowId}.json`);
            const before = await readFile(file, "utf8");
            await rename(root, moved);
            equal((await admitProjectIdentity(moved)).kind, "existing");
            await mkdir(root);
            const status = await spawnAttachedCli("status", root, {
                workflowId: pending.workflowId,
                inspectOnly: true,
            });
            ok(status.result.ok);
            equal(status.result.workflow.recovery?.case, "project_moved");
            for (const [operation, input] of [
                [
                    "get_instructions",
                    { workflowId: pending.workflowId, actionId: pending.actionId, evidence: EVIDENCE },
                ],
                ["triage_report", triageReportInput(pending)],
            ] as const) {
                const refused = await spawnAttachedCli(operation, root, input);
                ok(!refused.result.ok, JSON.stringify(refused.result));
                equal(refused.result.rejection.code, "project_moved");
            }
            const latest = await spawnAttachedCli("status", root, { inspectOnly: true });
            ok(!latest.result.ok);
            equal(latest.result.rejection.code, "workflow_not_found");
            const activation = await spawnAttachedCli("activate", root, activateInput("foreign-activate"));
            ok(!activation.result.ok);
            equal(activation.result.rejection.code, "project_moved");
            equal(await readFile(file, "utf8"), before);
            const continued = await spawnAttachedCli("triage_report", moved, triageReportInput(pending));
            ok(continued.result.ok, JSON.stringify(continued.result));
        } finally {
            if (previous === undefined) delete process.env.HOME;
            else process.env.HOME = previous;
            await rm(root, { recursive: true, force: true });
            await rm(moved, { recursive: true, force: true });
            await rm(home, { recursive: true, force: true });
        }
    });
});

test("Connect workflows created between successive moves retain their original storage and request evidence", async () => {
    await withProcessGlobalTestLock(async () => {
        const home = await realpath(await mkdtemp(join(tmpdir(), "attached-successive-moves-")));
        const root = await realpath(await projectFixture.checkout());
        const middle = `${root}-middle`,
            current = `${root}-current`;
        const previous = process.env.HOME;
        process.env.HOME = home;
        try {
            equal((await admitProjectIdentity(root)).kind, "existing");
            const original = locateAttachedWorkflows(root);
            await rename(root, middle);
            equal((await admitProjectIdentity(middle)).kind, "existing");
            const pending = pendingTriage(await runOperation("activate", middle, activateInput()));
            equal(locateAttachedWorkflows(middle).workflowsDir, original.workflowsDir);
            const file = join(original.workflowsDir, `${pending.workflowId}.json`);
            const before = await readFile(file, "utf8");
            await rename(middle, current);
            equal((await admitProjectIdentity(current)).kind, "existing");
            const status = await spawnAttachedCli("status", current, {
                workflowId: pending.workflowId,
                inspectOnly: true,
            });
            ok(status.result.ok, JSON.stringify(status.result));
            const latest = await spawnAttachedCli("status", current, { inspectOnly: true });
            ok(latest.result.ok, JSON.stringify(latest.result));
            equal(latest.result.workflow.workflowId, pending.workflowId);
            const instructions = await runOperation("get_instructions", current, {
                workflowId: pending.workflowId,
                actionId: pending.actionId,
                evidence: EVIDENCE,
            });
            ok(instructions.ok, JSON.stringify(instructions));
            equal(await readFile(file, "utf8"), before);
            const next = await spawnAttachedCli("triage_report", current, triageReportInput(pending));
            ok(next.result.ok, JSON.stringify(next.result));
            const saved = JSON.parse(await readFile(file, "utf8"));
            equal(saved.projectRoot, middle);
            deepEqual(saved.request, JSON.parse(before).request);
            deepEqual(saved.acceptedOperations["op-activate"], JSON.parse(before).acceptedOperations["op-activate"]);
        } finally {
            if (previous === undefined) delete process.env.HOME;
            else process.env.HOME = previous;
            for (const path of [root, middle, current, home]) await rm(path, { recursive: true, force: true });
        }
    });
});

test("fresh-process Connect restore and next action preserve original record, pending action, receipts, and replay", async () => {
    await withProcessGlobalTestLock(async () => {
        const home = await realpath(await mkdtemp(join(tmpdir(), "attached-continuity-")));
        const root = await realpath(await projectFixture.checkout());
        const moved = `${root}-moved`;
        const previous = process.env.HOME;
        process.env.HOME = home;
        try {
            const pending = pendingTriage(await runOperation("activate", root, activateInput()));
            equal((await admitProjectIdentity(root)).kind, "existing");
            const originalLocation = locateAttachedWorkflows(root);
            const file = join(originalLocation.workflowsDir, `${pending.workflowId}.json`);
            const before = await readFile(file, "utf8");
            const beforeStat = await stat(file);
            await rename(root, moved);
            // Passive restore follows the already committed binding before any new admission.
            equal(locateAttachedWorkflows(moved).workflowsDir, originalLocation.workflowsDir);
            const status = await spawnAttachedCli("status", moved, {
                workflowId: pending.workflowId,
                inspectOnly: true,
            });
            ok(status.result.ok, JSON.stringify(status.result));
            equal(status.result.workflow.workflowId, pending.workflowId);
            equal(status.result.workflow.revision, 1);
            ok(status.result.workflow.nextAction.kind === "triage");
            equal(status.result.workflow.nextAction.actionId, pending.actionId);
            const latest = await spawnAttachedCli("status", moved, { inspectOnly: true });
            ok(latest.result.ok);
            equal(latest.result.workflow.workflowId, pending.workflowId);
            const instructions = await runOperation("get_instructions", moved, {
                workflowId: pending.workflowId,
                actionId: pending.actionId,
                evidence: EVIDENCE,
            });
            ok(instructions.ok, JSON.stringify(instructions));
            equal(await readFile(file, "utf8"), before);
            equal((await stat(file)).mtimeMs, beforeStat.mtimeMs);
            const activationReplay = await spawnAttachedCli("activate", moved, activateInput());
            ok(activationReplay.result.ok);
            equal(activationReplay.result.workflow.workflowId, pending.workflowId);
            equal(await readFile(file, "utf8"), before);
            const input = triageReportInput(pending);
            const next = await spawnAttachedCli("triage_report", moved, input);
            ok(next.result.ok, JSON.stringify(next.result));
            equal(next.result.workflow.revision, 2);
            const committed = await readFile(file, "utf8");
            const replay = await spawnAttachedCli("triage_report", moved, input);
            deepEqual(replay.result, next.result);
            equal(await readFile(file, "utf8"), committed);
            const old = JSON.parse(before),
                saved = JSON.parse(committed);
            equal(saved.projectRoot, old.projectRoot);
            deepEqual(saved.request, old.request);
            deepEqual(saved.acceptedOperations["op-activate"], old.acceptedOperations["op-activate"]);
            equal(saved.currentProjectRoot, undefined);
            const foreign = join(home, "foreign");
            await mkdir(foreign);
            const refused = await runOperation("triage_report", foreign, input);
            ok(!refused.ok);
            equal(refused.rejection.code, "project_moved");
        } finally {
            if (previous === undefined) delete process.env.HOME;
            else process.env.HOME = previous;
            await rm(root, { recursive: true, force: true });
            await rm(moved, { recursive: true, force: true });
            await rm(home, { recursive: true, force: true });
        }
    });
});

test("accepted clone discovers bound workflows while a declined clone cannot restore them", async () => {
    await withProcessGlobalTestLock(async () => {
        const home = await realpath(await mkdtemp(join(tmpdir(), "attached-clones-")));
        const source = await projectFixture.checkout();
        const previous = process.env.HOME;
        process.env.HOME = home;
        try {
            const one = join(home, "one"),
                two = join(home, "two"),
                declined = join(home, "declined");
            for (const root of [one, two, declined]) await git(source, ["clone", source, root]);
            const workflow = pendingTriage(await runOperation("activate", one, activateInput()));
            const admitted = await admitProjectIdentity(one);
            ok(admitted.kind === "existing");
            const pending = await admitProjectIdentity(two);
            ok(pending.kind === "pending");
            equal(
                (await admitProjectIdentity(declined, { choice: { kind: "new", candidates: pending.candidates } }))
                    .kind,
                "existing",
            );
            const refreshed = await admitProjectIdentity(two);
            ok(refreshed.kind === "pending");
            equal(
                (
                    await admitProjectIdentity(two, {
                        choice: {
                            kind: "link",
                            candidates: refreshed.candidates,
                            projectId: admitted.identity.projectId,
                        },
                    })
                ).kind,
                "existing",
            );
            const status = await spawnAttachedCli("status", two, { inspectOnly: true });
            ok(status.result.ok, JSON.stringify(status.result));
            equal(status.result.workflow.workflowId, workflow.workflowId);
            const refused = await runOperation("status", declined, { inspectOnly: true });
            ok(!refused.ok);
            equal(refused.rejection.code, "workflow_not_found");
        } finally {
            if (previous === undefined) delete process.env.HOME;
            else process.env.HOME = previous;
            await rm(source, { recursive: true, force: true });
            await rm(home, { recursive: true, force: true });
        }
    });
});

test("linked-clone visibility cannot transfer a live execution attempt or its pending action", async () => {
    await withProcessGlobalTestLock(async () => {
        const home = await realpath(await mkdtemp(join(tmpdir(), "attached-execution-binding-")));
        const source = await projectFixture.checkout();
        const previous = process.env.HOME;
        process.env.HOME = home;
        try {
            const one = join(home, "one"),
                two = join(home, "two");
            for (const root of [one, two]) await git(source, ["clone", source, root]);
            const active = await implementing(one);
            ok(active.ok);
            const entered = await admitProjectIdentity(one);
            ok(entered.kind === "existing");
            const pending = await admitProjectIdentity(two);
            ok(pending.kind === "pending");
            equal(
                (
                    await admitProjectIdentity(two, {
                        choice: { kind: "link", candidates: pending.candidates, projectId: entered.identity.projectId },
                    })
                ).kind,
                "existing",
            );
            const file = join(locateAttachedWorkflows(one).workflowsDir, `${active.workflow.workflowId}.json`);
            const before = await readFile(file, "utf8");
            const status = await runOperation("status", two, {
                workflowId: active.workflow.workflowId,
                inspectOnly: true,
            });
            ok(status.ok);
            equal(status.workflow.workflowId, active.workflow.workflowId);
            const attempted = await runOperation("task_completed", two, completionInput(active.workflow));
            ok(!attempted.ok, JSON.stringify(attempted));
            equal(attempted.rejection.code, "project_moved");
            equal(await readFile(file, "utf8"), before);
        } finally {
            if (previous === undefined) delete process.env.HOME;
            else process.env.HOME = previous;
            await rm(source, { recursive: true, force: true });
            await rm(home, { recursive: true, force: true });
        }
    });
});

test("planning in a linked clone binds first execution there without transferring the request history", async () => {
    await withProcessGlobalTestLock(async () => {
        const home = await realpath(await mkdtemp(join(tmpdir(), "attached-planning-clone-")));
        const source = await projectFixture.checkout();
        const previous = process.env.HOME;
        process.env.HOME = home;
        try {
            const one = join(home, "one"),
                two = join(home, "two"),
                three = join(home, "three"),
                foreign = join(home, "foreign");
            for (const root of [one, two, three, foreign]) await git(source, ["clone", source, root]);
            const pending = pendingTriage(await runOperation("activate", one, activateInput()));
            const admitted = await admitProjectIdentity(one);
            ok(admitted.kind === "existing");
            for (const root of [two, three]) {
                const candidate = await admitProjectIdentity(root);
                ok(candidate.kind === "pending");
                equal(
                    (
                        await admitProjectIdentity(root, {
                            choice: {
                                kind: "link",
                                candidates: candidate.candidates,
                                projectId: admitted.identity.projectId,
                            },
                        })
                    ).kind,
                    "existing",
                );
            }
            const file = join(locateAttachedWorkflows(one).workflowsDir, `${pending.workflowId}.json`);
            const original = JSON.parse(await readFile(file, "utf8"));
            const planning = await runOperation("triage_report", two, triageReportInput(pending));
            ok(planning.ok && planning.workflow.nextAction.kind === "plan", JSON.stringify(planning));
            await seedPlan(two, "dark-mode-toggle", "# Toggle\n\nAdd a toggle.\n", {
                classification: "PLANNED_CHANGE",
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
            });
            const submitted = await runOperation(
                "plan_written",
                two,
                planWrittenInput({
                    workflowId: pending.workflowId,
                    actionId: planning.workflow.nextAction.actionId,
                    expectedRevision: planning.workflow.revision,
                }),
            );
            ok(submitted.ok, JSON.stringify(submitted));
            const round = await openAttachedReviewRound(two, pending.workflowId);
            ok(round.kind === "opened");
            await applyAttachedReviewDecision(two, pending.workflowId, round.basis, {
                approved: true,
                approvalAction: "run",
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
            });
            const ready = await runOperation("status", two, { workflowId: pending.workflowId });
            ok(ready.ok && ready.workflow.nextAction.kind === "plan_ready", JSON.stringify(ready));
            const startInput = executionInput(ready.workflow, "start-in-linked-clone");
            const started = await spawnAttachedCli("start_execution", two, startInput);
            ok(
                started.result.ok && started.result.workflow.nextAction.kind === "implementation",
                JSON.stringify(started.result),
            );
            const active = started.result.workflow;
            ok(active.nextAction.kind === "implementation");
            const actionInput = {
                workflowId: pending.workflowId,
                actionId: active.nextAction.actionId,
                evidence: EVIDENCE,
            };
            const instructions = await spawnAttachedCli("get_instructions", two, actionInput);
            ok(instructions.result.ok, JSON.stringify(instructions.result));
            const startedBytes = await readFile(file, "utf8");
            const replayStart = await spawnAttachedCli("start_execution", two, startInput);
            deepEqual(replayStart.result, started.result);
            equal(await readFile(file, "utf8"), startedBytes);
            const completeInput = completionInput(active);
            for (const root of [one, three, foreign]) {
                const status = await runOperation("status", root, {
                    workflowId: pending.workflowId,
                    inspectOnly: true,
                });
                ok(status.ok, JSON.stringify(status));
                equal(status.workflow.recovery?.case, "project_moved");
                for (const [operation, input] of [
                    ["get_instructions", actionInput],
                    ["start_execution", startInput],
                    ["task_completed", completeInput],
                ] as const) {
                    const refused = await runOperation(operation, root, input);
                    ok(!refused.ok, JSON.stringify(refused));
                    equal(refused.rejection.code, "project_moved");
                }
                equal(await readFile(file, "utf8"), startedBytes);
            }
            const completed = await spawnAttachedCli("task_completed", two, completeInput);
            ok(completed.result.ok, JSON.stringify(completed.result));
            equal(completed.result.workflow.state, "implemented");
            equal(completed.result.workflow.revision, active.revision + 1);
            const committed = await readFile(file, "utf8");
            const replayComplete = await spawnAttachedCli("task_completed", two, completeInput);
            deepEqual(replayComplete.result, completed.result);
            equal(await readFile(file, "utf8"), committed);
            const saved = JSON.parse(committed);
            equal(saved.projectRoot, original.projectRoot);
            deepEqual(saved.request, original.request);
            deepEqual(saved.acceptedOperations["op-activate"], original.acceptedOperations["op-activate"]);
            equal(saved.currentProjectRoot, undefined);
        } finally {
            if (previous === undefined) delete process.env.HOME;
            else process.env.HOME = previous;
            await rm(source, { recursive: true, force: true });
            await rm(home, { recursive: true, force: true });
        }
    });
});
