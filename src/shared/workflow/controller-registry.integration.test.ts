import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { captureForegroundProcess } from "../captured-process.ts";
import { getCwd } from "../../constants.js";
import { test } from "node:test";
import {
    lstat as fsLstat,
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rename as fsRename,
    rm as fsRm,
    symlink as fsSymlink,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import nodeProcess from "node:process";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertExists, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { fileURLToPath as fromFileUrl } from "node:url";
import { join } from "node:path";
import {
    ensurePlanIdentity,
    injectFrontMatter,
    listPlanResources,
    loadPlan,
    mergeFrontMatterText,
    type PlanDocumentMetadata,
    savePlan,
    updatePlanFrontMatter,
} from "../../plan-store.js";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";
import { addEntry, getWorktreeRegistryPath, pruneEntry, updateEntry } from "../worktree-registry.js";
import { loadPlanActionEvidence } from "./plan-actions.ts";
import { makeValidationCheckpoint } from "./validation-checkpoint.ts";
import { PLAN_RUNTIME_FIELDS } from "./controller-state.ts";
import { controllerRecordPath, readControllerRecord, StaleControllerWriteError } from "./controller-registry.ts";
import { extractYaml } from "../front-matter.ts";
import { runValidationOutcomeTransition } from "./state-transition.ts";

const fixture = defineCommittedGitFixture({ ".gitignore": ".wld/\n", "app.ts": "export const ready = false;\n" });

for (const registryState of ["healthy", "unreadable", "ambiguous"]) {
    test(`legacy import never trusts stale primary metadata with ${registryState} registry`, async () => {
        const root = await fixture.checkout();
        const temporary = await fsMkdtemp(join(tmpdir(), "runwield-controller-alias-"));
        const tree = join(temporary, "tree");
        try {
            const baseCommit = await git(root, ["rev-parse", "HEAD"]);
            await git(root, ["worktree", "add", "-b", "worktree/legacy", tree]);
            await addEntry(root, {
                id: "legacy-attempt",
                planId: "legacy-plan",
                planName: "legacy",
                path: tree,
                branch: "worktree/legacy",
                baseBranch: "main",
                baseRef: "refs/heads/main",
                baseCommit,
                status: "completed",
                createdAt: "2026-08-25T00:00:00Z",
                updatedAt: "2026-08-25T00:00:00Z",
            });
            for (const cwd of [root, tree]) await fsMkdir(join(cwd, "docs/plans"), { recursive: true });
            await fsWriteFile(
                join(root, "docs/plans/legacy.md"),
                injectFrontMatter("# Legacy\n", {
                    planId: "legacy-plan",
                    status: "draft",
                    validationCiAttempts: 99,
                }),
            );
            await fsWriteFile(
                join(tree, "docs/plans/legacy.md"),
                injectFrontMatter("# Legacy\n", {
                    planId: "legacy-plan",
                    status: "implemented",
                    validationCiAttempts: 2,
                }),
            );
            const registryPath = getWorktreeRegistryPath(root);
            const originalRegistry = await fsReadFile(registryPath, "utf8");
            if (registryState === "unreadable") await fsWriteFile(registryPath, "{interrupted");
            if (registryState === "ambiguous") {
                const duplicate = JSON.parse(originalRegistry);
                duplicate.entries.push({ ...duplicate.entries[0], id: "competing-attempt" });
                await fsWriteFile(registryPath, JSON.stringify(duplicate));
            }
            await loadPlan(root, "legacy");
            assertEquals(await readControllerRecord(root, { planName: "legacy", planId: "legacy-plan" }), null);
            await fsWriteFile(registryPath, originalRegistry);
            const alias = join(temporary, "alias");
            await fsSymlink(tree, alias);
            const loaded = await loadPlan(alias, "legacy");
            assertEquals(loaded?.attrs.validationCiAttempts, 2);
            assertEquals(loaded?.attrs.worktreeId, "legacy-attempt");
            assertEquals((await loadPlan(root, "legacy"))?.attrs.validationCiAttempts, 2);
        } finally {
            await fsRm(temporary, { recursive: true });
            await fsRm(root, { recursive: true });
        }
    });
}

test("execution Plan and controller survive stale primary metadata, a fresh reader, and validation repair", async () => {
    const root = await fixture.checkout();
    const tree = await fsMkdtemp(join(tmpdir(), "runwield-controller-tree-"));
    try {
        await git(root, ["switch", "-c", "release/preview"]);
        await savePlan(root, "demo", "# Demo\n\n## Context\n\nMake the app ready.\n", {
            planId: "controller-demo",
            status: "ready_for_work",
            targetBranch: "release/preview",
        });
        await git(root, ["add", "docs/plans/demo.md"]);
        await git(root, ["commit", "-m", "Plan"]);
        const baseCommit = await git(root, ["rev-parse", "HEAD"]);
        const baseTree = await git(root, ["rev-parse", "HEAD^{tree}"]);
        await git(root, ["worktree", "add", "-b", "worktree/demo", tree]);
        await addEntry(root, {
            id: "attempt-demo",
            planId: "controller-demo",
            planName: "demo",
            branch: "worktree/demo",
            path: tree,
            baseBranch: "release/preview",
            baseRef: "refs/heads/release/preview",
            baseCommit,
            baseTree,
            executionBaselineTree: baseTree,
            status: "completed",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        });
        const plan = await loadPlan(tree, "demo");
        assertExists(plan);
        await updatePlanFrontMatter(
            tree,
            "demo",
            {
                status: "implemented",
                validationCiAttempts: 2,
                humanReviewMode: "always",
                validationCheckpoint: makeValidationCheckpoint({
                    attemptId: "attempt-demo",
                    generation: "generation-demo",
                    status: "implemented",
                    phase: "mechanical",
                    state: "awaiting_repair",
                    repairGeneration: "repair-demo",
                }),
            },
            {},
            { expectedRevision: plan.revision },
        );
        await fsWriteFile(join(tree, "app.ts"), "export const ready = true;\n");
        const primaryBefore = await fsReadFile(join(root, "docs/plans/demo.md"), "utf8");
        const cleanDocument = await fsReadFile(plan.path, "utf8");
        const raw = extractYaml<PlanDocumentMetadata>(cleanDocument).attrs;
        for (const field of PLAN_RUNTIME_FIELDS) assert(!Object.hasOwn(raw, field), `Plan leaked ${field}`);
        assert(!Object.hasOwn(raw, "summary"));
        assertEquals(raw.targetBranch, "release/preview");

        // An old binary/editor copied obsolete bookkeeping into the document.
        await fsWriteFile(
            plan.path,
            mergeFrontMatterText(cleanDocument, {
                worktreeId: "wrong",
                worktreePath: "/wrong",
                worktreeBranch: "wrong",
                worktreeStatus: "validation_failed",
                executionMode: "non_git_in_place",
                validationCiAttempts: 99,
                validationCheckpoint: null,
            }),
        );
        const reopened = await loadPlan(tree, "demo");
        assertExists(reopened);
        assertEquals(reopened.attrs.worktreeId, "attempt-demo");
        assertEquals(reopened.attrs.worktreeStatus, "completed");
        assertEquals(reopened.attrs.executionMode, "worktree");
        assertEquals(reopened.attrs.worktreeBaseBranch, "release/preview");
        assertEquals(reopened.attrs.validationCiAttempts, 2);
        assertEquals(reopened.attrs.validationCheckpoint?.repairGeneration, "repair-demo");
        assertEquals(reopened.attrs.humanReviewMode, "always");
        assertEquals(reopened.attrs.summary, "Make the app ready.");
        const listed = await listPlanResources(root);
        assertEquals(listed.find((item) => item.planId === "controller-demo")?.attrs.status, "implemented");
        const process = await captureForegroundProcess(nodeProcess.execPath, {
            args: runtimeSourceArgs([
                "run",
                "-A",
                fromFileUrl(new URL("./testing/controller-process-reader.ts", import.meta.url)),
                root,
                "demo",
            ]),
            cwd: getCwd(),
        });
        assert(process.success, new TextDecoder().decode(process.stderr));
        const fresh = JSON.parse(new TextDecoder().decode(process.stdout));
        assertEquals(fresh.status, "implemented");
        assertEquals(fresh.primaryStatus, "ready_for_work");
        assertEquals(fresh.worktreeId, "attempt-demo");
        assertEquals(fresh.checkpoint.repairGeneration, "repair-demo");
        assertEquals(fresh.validationCiAttempts, 2);
        // A document save carrying an old in-memory view cannot reset the controller.
        await savePlan(tree, "demo", reopened.body, {
            ...reopened.attrs,
            validationCiAttempts: 0,
            validationCheckpoint: null,
        }, {
            expectedRevision: reopened.revision,
        });
        assertEquals((await loadPlan(tree, "demo"))?.attrs.validationCheckpoint?.repairGeneration, "repair-demo");
        assertEquals((await loadPlanActionEvidence(root, "controller-demo")).kind, "success");
        const controllerPath = controllerRecordPath(root, { planName: "demo", planId: "controller-demo" });
        assertEquals(controllerPath, controllerRecordPath(tree, { planName: "demo", planId: "controller-demo" }));
        assertStringIncludes(controllerPath, join(".wld", "internal", "controller", "plans", "controller-demo.json"));
        assertEquals((await readControllerRecord(tree, { planName: "demo", planId: "controller-demo" }))?.revision, 2);
        await assertRejects(
            () => fsLstat(join(root, ".wld", "controller", "plans", "controller-demo.json")),
            Error,
            "ENOENT",
        );
        await assertRejects(
            () => fsLstat(join(tree, ".wld", "internal", "controller", "plans", "controller-demo.json")),
            Error,
            "ENOENT",
        );
        await updateEntry(root, "attempt-demo", { status: "active" });
        assertEquals((await loadPlan(tree, "demo"))?.attrs.worktreeStatus, "active");
        assertEquals(await fsReadFile(join(root, "docs/plans/demo.md"), "utf8"), primaryBefore);
        assertStringIncludes(await fsReadFile(join(tree, "app.ts"), "utf8"), "true");
    } finally {
        await fsRm(root, { recursive: true });
        await fsRm(tree, { recursive: true });
    }
});

test("failed lifecycle transition restores its controller state and imported recovery hints", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-controller-rollback-"));
    try {
        await savePlan(root, "demo", "# Demo\n", {
            planId: "rollback-demo",
            status: "implemented",
            executionMode: "worktree",
            worktreeId: "legacy-attempt",
            worktreePath: `${root}/lost-tree`,
            validationCiAttempts: 2,
        });
        const before = await loadPlan(root, "demo");
        assertExists(before);
        const result = await runValidationOutcomeTransition({
            projectRoot: root,
            planName: "demo",
            outcome: "failed",
            settle: async () => {
                await updatePlanFrontMatter(
                    root,
                    "demo",
                    {
                        worktreeId: null,
                        executionMode: null,
                        validationCiAttempts: 0,
                    },
                    {},
                    { expectedRevision: before.revision },
                );
                throw new Error("Interrupted after controller write");
            },
        });
        assertEquals(result.status, "rolled_back");
        const after = await loadPlan(root, "demo");
        assertEquals(after?.attrs.worktreeId, "legacy-attempt");
        assertEquals(after?.attrs.validationCiAttempts, 2);
        assertEquals(after?.attrs.executionMode, "worktree");
        assertEquals(after?.markdown, before.markdown);
    } finally {
        await fsRm(root, { recursive: true });
    }
});

test("onboarding binds controller state to Plan identity, not a reusable document name", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-controller-identity-"));
    try {
        const path = await savePlan(root, "demo", "# Demo\n", {
            status: "implemented",
            executionMode: "non_git_in_place",
            validationCiAttempts: 2,
        });
        const identified = await ensurePlanIdentity(root, "demo");
        assertEquals((await readControllerRecord(root, identified))?.state.validationCiAttempts, 2);
        assertEquals(await readControllerRecord(root, { planName: "demo" }), null);
        await fsRename(path, join(root, "previous-plan.md"));
        await savePlan(root, "demo", "# New Plan\n", { status: "draft" });
        assertEquals((await loadPlan(root, "demo"))?.attrs.validationCiAttempts, undefined);
        assertEquals((await readControllerRecord(root, identified))?.state.validationCiAttempts, 2);
    } finally {
        await fsRm(root, { recursive: true });
    }
});

test("recovered registry authority retires legacy hints so cleanup cannot resurrect an attempt", async () => {
    const root = await fixture.checkout();
    try {
        await savePlan(root, "legacy", "# Legacy\n", {
            planId: "recovered-plan",
            status: "validated",
            worktreeId: "old-hint",
            worktreePath: `${root}/missing-tree`,
        });
        const identity = { planName: "legacy", planId: "recovered-plan" };
        assertExists((await readControllerRecord(root, identity))?.recovery);
        await addEntry(root, {
            ...identity,
            id: "recovered-attempt",
            path: `${root}/recovered-tree`,
            branch: "worktree/legacy",
            baseBranch: "main",
            baseRef: "refs/heads/main",
            baseCommit: await git(root, ["rev-parse", "HEAD"]),
            status: "validated",
            createdAt: "2026-08-25T00:00:00Z",
            updatedAt: "2026-08-25T00:00:00Z",
        });
        assertEquals((await loadPlan(root, "legacy"))?.attrs.worktreeId, "recovered-attempt");
        assertEquals((await readControllerRecord(root, identity))?.recovery, undefined);
        await pruneEntry(root, "recovered-attempt");
        assertEquals((await loadPlan(root, "legacy"))?.attrs.worktreeId, undefined);
    } finally {
        await fsRm(root, { recursive: true });
    }
});

test("checkpoint-only updates leave Plan bytes unchanged and reject a second stale claim", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-controller-in-place-"));
    try {
        await savePlan(root, "demo", "# Demo\n\n## Context\n\nA non-Git project.\n", {
            planId: "in-place-demo",
            status: "implemented",
            executionMode: "non_git_in_place",
            updatedAt: "2026-01-01T00:00:00Z",
        });
        const before = await loadPlan(root, "demo");
        assertExists(before);
        const checkpoint = makeValidationCheckpoint({
            attemptId: "in-place",
            generation: "one",
            status: "implemented",
            phase: "mechanical",
            state: "running",
        });
        await updatePlanFrontMatter(root, "demo", { validationCheckpoint: checkpoint }, {}, {
            expectedRevision: before.revision,
            expectedControllerRevision: before.controllerRevision,
        });
        assertEquals(await fsReadFile(before.path, "utf8"), before.markdown);
        await assertRejects(
            () =>
                updatePlanFrontMatter(
                    root,
                    "demo",
                    { validationCheckpoint: { ...checkpoint, generation: "two" } },
                    {},
                    {
                        expectedRevision: before.revision,
                        expectedControllerRevision: before.controllerRevision,
                    },
                ),
            StaleControllerWriteError,
        );
        const record = await readControllerRecord(root, { planName: "demo", planId: "in-place-demo" });
        assertEquals(record?.state.validationCheckpoint?.generation, "one");
        assert(record?.state.updatedAt !== before.attrs.updatedAt, "workflow timestamps belong to the controller");
    } finally {
        await fsRm(root, { recursive: true });
    }
});
