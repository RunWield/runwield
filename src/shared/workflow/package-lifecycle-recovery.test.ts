import { importPlanPackages } from "../../plan-store.js";
import { addEntry } from "../worktree-registry.js";
import { writeControllerState, readControllerRecord } from "./controller-registry.ts";
import { preparePlanWorkflow } from "./plan-preparation.ts";
import { LegacyPackageContinuation } from "./package-workflow.ts";
import type { ValidationCheckpoint } from "./validation-checkpoint.ts";
import { withPackageWorkflow } from "./package-workflow.ts";
import { recordPlanEvent } from "./plan-lifecycle.js";
import { inspectWorktreeRegistry } from "../worktree-registry.js";
import { git } from "../git-test-fixture.ts";
import { test } from "node:test";
import { equal, deepEqual, ok, rejects } from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { create, read, driver, packageFixture, startDriver } from "../testing/plan-package-fixture.ts";

for (const boundary of ["lifecycle-intent", "metadata"]) {
    test(`fresh-process recovery settles ${boundary} without replacing an editor's bytes`, async () => {
        const f = await packageFixture();
        try {
            const p = await create(f.identity);
            const stopped = await driver({ identity: f.identity, command: "lifecycle", boundary });
            equal(stopped.code, 86, stopped.output + stopped.errors);
            const edited = "# New editor work\n";
            await fs.writeFile(join(p.path, "context.md"), edited);
            const restarted = await driver({ identity: f.identity, command: "recover-lifecycle" });
            equal(restarted.code, 0, restarted.output + restarted.errors);
            equal((await read(f.identity)).metadata.definition.status, boundary === "metadata" ? "approved" : "draft");
            equal(await fs.readFile(join(p.path, "context.md"), "utf8"), edited);
            const journals = join(
                f.identity.executionAccountHome,
                ".wld/projects",
                f.identity.projectId,
                "internal/plan-packages/transitions",
            );
            equal((await fs.readdir(journals)).length, 0);
        } finally {
            await f.cleanup();
        }
    });
}

for (const boundary of ["attempt-reserved", "registry-reserved", "git-created", "attempt-started"]) {
    test(`execution restart after ${boundary} preserves one exact attempt`, async () => {
        const f = await packageFixture();
        try {
            const p = await create(f.identity, {
                definition: {
                    classification: "PLANNED_CHANGE",
                    status: "draft",
                    executionAgent: "engineer",
                    collaborationRecommendation: "autonomous",
                    targetBranch: "main",
                },
            });
            await withPackageWorkflow(
                f.root,
                { identity: f.identity, planId: p.metadata.planId, expectedRevision: 1 },
                async () => {
                    await recordPlanEvent({
                        cwd: f.root,
                        planName: "one",
                        event: "review_approved",
                        currentStatus: "draft",
                    });
                    await recordPlanEvent({
                        cwd: f.root,
                        planName: "one",
                        event: "readiness_passed",
                        currentStatus: "approved",
                    });
                },
            );
            const stopped = await driver({ identity: f.identity, command: "execution", boundary });
            equal(stopped.code, 86, stopped.output + stopped.errors);
            const reserved = (await read(f.identity)).metadata.workflow?.attempt;
            const restarted = await driver({ identity: f.identity, command: "execution" });
            equal(restarted.code, 0, restarted.output + restarted.errors);
            const current = await read(f.identity);
            equal(current.metadata.workflow?.attempt?.attemptId, reserved?.attemptId);
            equal(current.metadata.definition.status, "in_progress");
            const entries = (await inspectWorktreeRegistry(f.root)).entries;
            equal(entries.length, 1);
            equal(entries[0].id, reserved?.attemptId);
            await git(f.root, ["worktree", "remove", "--force", entries[0].path]);
        } finally {
            await f.cleanup();
        }
    });
}

test("a held native package lock makes lifecycle wait until its live owner releases it", async () => {
    const f = await packageFixture();
    let holder: ReturnType<typeof startDriver> | undefined;
    try {
        await create(f.identity);
        await create(f.identity, { planId: "other", name: "other" });
        holder = startDriver({ identity: f.identity, command: "hold" });
        await holder.ready();
        const contender = startDriver({ identity: f.identity, command: "lifecycle" });
        await contender.ready();
        let finished = false;
        contender.done.then(() => {
            finished = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        equal(finished, false);
        equal((await read(f.identity)).metadata.definition.status, "draft");
        equal((await read(f.identity, "other")).metadata.name, "other");
        holder.child.kill("SIGTERM");
        await holder.done;
        const result = await contender.done;
        equal(result.code, 0, result.output + result.errors);
        equal((await read(f.identity)).metadata.definition.status, "approved");
    } finally {
        holder?.child.kill("SIGTERM");
        await f.cleanup();
    }
});

test("an imported dirty unfinished attempt keeps its legacy controller, checkout and checkpoint", async () => {
    const f = await packageFixture();
    try {
        const source = join(f.root, "docs/plans/legacy.md");
        const markdown =
            "---\nplanId: legacy-id\nclassification: PLANNED_CHANGE\nstatus: implemented\n---\n# Legacy requirements\n";
        await fs.mkdir(join(f.root, "docs/plans"), { recursive: true });
        await fs.writeFile(source, markdown);
        await git(f.root, ["add", "docs"]);
        await git(f.root, ["commit", "-m", "legacy fixture"]);
        const commit = await git(f.root, ["rev-parse", "HEAD"]);
        const path = join(f.root, "legacy-worktree");
        await git(f.root, ["worktree", "add", "-b", "legacy", path]);
        await fs.writeFile(join(path, "dirty-code.txt"), "unfinished work\n");
        await addEntry(f.root, {
            id: "legacy-attempt",
            planName: "legacy",
            planId: "legacy-id",
            baseBranch: "main",
            baseRef: "main",
            baseCommit: commit,
            branch: "legacy",
            path,
            status: "validation_failed",
            createdAt: "2026-01-01",
            updatedAt: "2026-01-01",
        });
        const checkpoint: ValidationCheckpoint = {
            version: 1,
            attemptId: "legacy-attempt",
            generation: "generation-one",
            expectedStatus: "implemented",
            nextPhase: "mechanical",
            state: "awaiting_repair",
            updatedAt: "2026-01-01",
            repairGeneration: "repair-one",
            repairCompletedOperationId: "repair-receipt",
            hostReview: { semanticRound: 2, correctionCount: 1 },
        };
        await writeControllerState(
            f.root,
            { planId: "legacy-id", planName: "legacy" },
            { validationCheckpoint: checkpoint },
        );
        equal((await importPlanPackages(f.identity, source)).kind, "committed");
        const p = await read(f.identity, "legacy-id");
        const selection = { identity: f.identity, planId: "legacy-id", expectedRevision: p.metadata.revision };
        const prepared = await preparePlanWorkflow(f.root, "legacy", selection);
        ok("legacyContinuation" in prepared);
        equal(prepared.legacyContinuation?.attemptId, "legacy-attempt");
        equal(prepared.plan?.path, join(path, "docs/plans/legacy.md"));
        deepEqual(
            (await readControllerRecord(f.root, { planId: "legacy-id", planName: "legacy" }))?.state
                .validationCheckpoint,
            checkpoint,
        );
        await rejects(
            withPackageWorkflow(f.root, selection, () => Promise.reject(new Error("Must not enter package execution"))),
            LegacyPackageContinuation,
        );
        equal((await inspectWorktreeRegistry(f.root)).entries.length, 1);
        equal(await fs.readFile(join(path, "dirty-code.txt"), "utf8"), "unfinished work\n");
        equal((await read(f.identity, "legacy-id")).metadata.workflow?.attempt, undefined);
        await fs.writeFile(join(path, "docs/plans/legacy.md"), markdown + "Changed retained authority\n");
        await rejects(preparePlanWorkflow(f.root, "legacy", selection), /evidence changed/);
    } finally {
        await f.cleanup();
    }
});

test("complex package checkpoint retains repair receipts and review state through fresh-process reads", async () => {
    const f = await packageFixture();
    try {
        const p = await create(f.identity);
        const checkpoint: ValidationCheckpoint = {
            version: 1,
            attemptId: "attempt",
            generation: "generation",
            expectedStatus: "implemented",
            nextPhase: "semantic",
            state: "awaiting_repair",
            updatedAt: "2026-01-01",
            repairGeneration: "repair",
            repairCompletedOperationId: "operation",
            reviewState: {
                semanticRound: 2,
                reviewLedger: {
                    items: [
                        {
                            id: "R1-1",
                            openedInRound: 1,
                            resolvedInRound: null,
                            title: "Open issue",
                            requirement: "Preserve work",
                            evidence: "Unfinished repair",
                            status: "fix_claimed",
                        },
                    ],
                    sequence: 1,
                },
                repairBaselineTree: "baseline",
            },
            hostReview: { semanticRound: 2, correctionCount: 1 },
        };
        await withPackageWorkflow(
            f.root,
            { identity: f.identity, planId: p.metadata.planId, expectedRevision: 1 },
            async () => {
                await writeControllerState(
                    f.root,
                    { planId: p.metadata.planId, planName: "one" },
                    { validationCheckpoint: checkpoint },
                );
            },
        );
        const restarted = await driver({ identity: f.identity, command: "recover-lifecycle" });
        equal(restarted.code, 0, restarted.errors);
        const json = JSON.parse(restarted.output.trim().split("\n").at(-1)!);
        deepEqual(json.result.attrs.validationCheckpoint, checkpoint);
    } finally {
        await f.cleanup();
    }
});

test("interrupted Sequence metadata compensates without restoring old editor documents", async () => {
    const f = await packageFixture();
    try {
        const p = await create(f.identity, {
            planId: "sequence",
            name: "sequence",
            definition: { classification: "PROJECT", type: "sequence", status: "draft" },
        });
        await create(f.identity, {
            planId: "child",
            name: "child",
            parentPlanId: "sequence",
            definition: {
                classification: "PLANNED_CHANGE",
                status: "draft",
                order: 1,
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
            },
        });
        const stopped = await driver({
            identity: f.identity,
            command: "sequence",
            planId: "sequence",
            boundary: "metadata",
        });
        equal(stopped.code, 86, stopped.output + stopped.errors);
        await fs.writeFile(join(p.path, "context.md"), "# New Sequence editor work\n");
        const restarted = await driver({ identity: f.identity, command: "recover-lifecycle", planId: "sequence" });
        equal(restarted.code, 0, restarted.output + restarted.errors);
        equal((await read(f.identity, "sequence")).metadata.definition.status, "draft");
        equal((await read(f.identity, "child")).metadata.definition.status, "draft");
        equal(await fs.readFile(join(p.path, "context.md"), "utf8"), "# New Sequence editor work\n");
        equal((await driver({ identity: f.identity, command: "recover-lifecycle", planId: "sequence" })).code, 0);
    } finally {
        await f.cleanup();
    }
});

test("a newer metadata revision supersedes an interrupted metadata-only intent without replay", async () => {
    const f = await packageFixture();
    try {
        const p = await create(f.identity);
        const stopped = await driver({ identity: f.identity, command: "lifecycle", boundary: "metadata" });
        equal(stopped.code, 86, stopped.output + stopped.errors);
        const current = await read(f.identity);
        await withPackageWorkflow(
            f.root,
            { identity: f.identity, planId: p.metadata.planId, expectedRevision: current.metadata.revision },
            async () => {
                await writeControllerState(
                    f.root,
                    { planId: p.metadata.planId, planName: "one" },
                    { updatedAt: "2030-01-01T00:00:00Z" },
                );
            },
        );
        const revised = await read(f.identity);
        const restarted = await driver({ identity: f.identity, command: "recover-lifecycle" });
        equal(restarted.code, 0, restarted.output + restarted.errors);
        deepEqual((await read(f.identity)).metadata, revised.metadata);
    } finally {
        await f.cleanup();
    }
});
