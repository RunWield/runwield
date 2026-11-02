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
    runOperation,
    spawnAttachedCli,
    triageReportInput,
    projectFixture,
} from "./attached-test-fixture.ts";
import { locateAttachedWorkflows } from "./record-store.ts";
import { implementing, completionInput } from "./execution-test-fixture.ts";
import { git } from "../git-test-fixture.ts";

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
