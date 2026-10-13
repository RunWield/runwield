import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    realpath as fsRealpath,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { dirname } from "node:path";
import { listPlanResources, loadPlan, parsePlanFrontMatter, savePlan } from "../../plan-store.js";
import { addEntry, findById, getWorktreeRegistryPath } from "../worktree-registry.js";
import { resolveValidationExecutionContext } from "./execution-context.ts";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";

// One base repository for the module, copied per test. Building it per test cost
// more than every Git query these tests run against it.
const baseRepo = defineCommittedGitFixture({ "file.txt": "base\n" });

test("resolveValidationExecutionContext blocks FEATURE validation without durable mode or worktree identity", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        await savePlan(cwd, "p", "# Plan", { classification: "FEATURE", status: "implemented" });
        const result = await resolveValidationExecutionContext({ projectRoot: cwd, planName: "p", triageMeta: {} });
        assertEquals(result.kind, "blocked");
        if (result.kind === "blocked") assertEquals(result.reason, "unknown_execution_mode");
    } finally {
        await fsRm(cwd, { recursive: true });
    }
});

test("resolveValidationExecutionContext accepts explicit non-Git mode", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        await savePlan(cwd, "p", "# Plan", {
            classification: "FEATURE",
            status: "implemented",
            executionMode: "non_git_in_place",
        });
        const result = await resolveValidationExecutionContext({ projectRoot: cwd, planName: "p", triageMeta: {} });
        assertEquals(result.kind, "ok");
        if (result.kind === "ok") assertEquals(result.context.executionMode, "non_git_in_place");
    } finally {
        await fsRm(cwd, { recursive: true });
    }
});

test("resolveValidationExecutionContext preserves active QUICK_FIX non-Git execution", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        await savePlan(cwd, "p", "# Plan", { classification: "QUICK_FIX", status: "implemented" });
        const result = await resolveValidationExecutionContext({
            projectRoot: cwd,
            planName: "p",
            triageMeta: { classification: "QUICK_FIX" },
            activeWorkflow: {
                planName: "p",
                projectRoot: cwd,
                executionCwd: cwd,
                nonGitInPlace: true,
            },
        });
        assertEquals(result.kind, "ok");
        if (result.kind === "ok") {
            assertEquals(result.context.executionMode, "non_git_in_place");
            assertEquals(result.context.executionCwd, cwd);
        }
    } finally {
        await fsRm(cwd, { recursive: true });
    }
});

test("resolveValidationExecutionContext preserves an explicit QUICK_FIX worktree", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        await savePlan(cwd, "p", "# Plan", { classification: "QUICK_FIX", status: "validated_ci" });
        const result = await resolveValidationExecutionContext({
            projectRoot: cwd,
            planName: "p",
            triageMeta: { classification: "QUICK_FIX" },
            explicitContext: {
                planName: "p",
                executionMode: "worktree",
                executionCwd: "/worktree-p",
                baselineTree: "tree-p",
                worktreeId: "wt-p",
                worktreeBranch: "worktree/p",
                worktreeBaseBranch: "main",
            },
        });
        assertEquals(result.kind, "ok");
        if (result.kind === "ok") assertEquals(result.context.executionMode, "worktree");
        if (result.kind === "ok" && result.context.executionMode === "worktree") {
            assertEquals(result.context.executionCwd, "/worktree-p");
            assertEquals(result.context.baselineTree, "tree-p");
            assertEquals(result.context.worktreeId, "wt-p");
        }
    } finally {
        await fsRm(cwd, { recursive: true });
    }
});

test("resolveValidationExecutionContext allows a legacy creation tree to differ from a retry baseline", async () => {
    const projectRoot = await baseRepo.checkout();
    const parent = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        const creationTree = await git(projectRoot, ["rev-parse", "HEAD^{tree}"]);
        const worktreePath = `${parent}/wt`;
        await git(projectRoot, ["worktree", "add", "-b", "runwield/worktree/p-wt", worktreePath, "HEAD"]);
        await fsWriteFile(`${worktreePath}/dependency.txt`, "integrated dependency\n");
        await git(worktreePath, ["add", "dependency.txt"]);
        await git(worktreePath, ["commit", "-m", "integrate dependency before retry"]);
        const baselineTree = await git(worktreePath, ["rev-parse", "HEAD^{tree}"]);
        await savePlan(worktreePath, "p", "# Plan", { classification: "FEATURE", status: "implemented" });
        await savePlan(projectRoot, "p", "# Plan", {
            classification: "FEATURE",
            status: "implemented",
            executionBaselineTree: baselineTree,
            worktreeId: "wt-1",
            worktreePath,
            worktreeBranch: "runwield/worktree/p-wt",
            worktreeBaseBranch: "main",
            worktreeStatus: "completed",
        });
        await addEntry(projectRoot, {
            id: "wt-1",
            planName: "p",
            planId: "plan-p",
            baseBranch: "main",
            baseRef: "HEAD",
            baseCommit: await git(projectRoot, ["rev-parse", "HEAD"]),
            baseTree: creationTree,
            branch: "runwield/worktree/p-wt",
            path: worktreePath,
            status: "completed",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        });

        const result = await resolveValidationExecutionContext({ projectRoot, planName: "p", triageMeta: {} });
        assertEquals(result.kind, "ok");
        if (result.kind === "ok") {
            assertEquals(result.context.executionMode, "worktree");
            assertEquals(result.persistedLegacyExecutionMode, false);
        }
    } finally {
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
        await fsRm(parent, { recursive: true }).catch(() => {});
    }
});

test("resolveValidationExecutionContext fixes a stale registry path from Git", async () => {
    const projectRoot = await baseRepo.checkout();
    const parent = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        const baselineTree = await git(projectRoot, ["rev-parse", "HEAD^{tree}"]);
        const actualPath = `${parent}/actual`;
        const stalePath = `${parent}/gone`;
        const branch = "runwield/worktree/p-stale-path";
        await git(projectRoot, ["worktree", "add", "-b", branch, actualPath, "HEAD"]);
        await savePlan(actualPath, "p", "# Plan", { classification: "FEATURE", status: "implemented" });
        await savePlan(projectRoot, "p", "# Plan", {
            planId: "plan-p",
            classification: "FEATURE",
            status: "implemented",
            executionMode: "worktree",
            worktreeId: "wt-stale",
        });
        await addEntry(projectRoot, {
            id: "wt-stale",
            planName: "p",
            planId: "plan-p",
            baseBranch: "main",
            baseRef: "HEAD",
            baseCommit: await git(projectRoot, ["rev-parse", "HEAD"]),
            baseTree: baselineTree,
            executionBaselineTree: baselineTree,
            branch,
            path: stalePath,
            status: "completed",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        });

        const result = await resolveValidationExecutionContext({ projectRoot, planName: "p" });

        assertEquals(result.kind, "ok");
        if (result.kind === "ok") assertEquals(result.context.executionCwd, await fsRealpath(actualPath));
        const fixedPath = (await findById(projectRoot, "wt-stale"))?.path;
        assertEquals(fixedPath ? await fsRealpath(fixedPath) : null, await fsRealpath(actualPath));
    } finally {
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
        await fsRm(parent, { recursive: true }).catch(() => {});
    }
});

test("resolveValidationExecutionContext recovers missing worktree metadata from registry by plan name", async () => {
    const projectRoot = await baseRepo.checkout();
    const parent = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        const baselineTree = await git(projectRoot, ["rev-parse", "HEAD^{tree}"]);
        const worktreePath = `${parent}/wt`;
        await git(projectRoot, ["worktree", "add", "-b", "runwield/worktree/p-wt", worktreePath, "HEAD"]);
        await fsWriteFile(`${worktreePath}/file.txt`, "base\nimplemented\n");
        await git(worktreePath, ["add", "file.txt"]);
        await git(worktreePath, ["commit", "-m", "implement p"]);
        await savePlan(projectRoot, "p", "# Plan", {
            classification: "FEATURE",
            status: "implemented",
            failureReason: "CI validation failed.",
        });
        const [plan] = await listPlanResources(projectRoot, { backfillMissing: true });
        if (!plan?.planId) throw new Error("Expected Plan ID");
        await addEntry(projectRoot, {
            id: "wt-1",
            planName: "p",
            planId: plan.planId,
            baseBranch: "main",
            baseRef: "HEAD",
            baseCommit: await git(projectRoot, ["rev-parse", "HEAD"]),
            baseTree: baselineTree,
            executionBaselineTree: baselineTree,
            branch: "runwield/worktree/p-wt",
            path: worktreePath,
            status: "validation_failed",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        });

        const result = await resolveValidationExecutionContext({ projectRoot, planName: "p", triageMeta: {} });
        assertEquals(result.kind, "ok");
        if (result.kind === "ok") {
            assertEquals(result.context.executionMode, "worktree");
            assertEquals(result.context.executionCwd, await fsRealpath(worktreePath));
            if (result.context.executionMode === "worktree") {
                assertEquals(result.context.baselineTree, baselineTree);
                assertEquals(result.context.worktreeId, "wt-1");
                assertEquals(result.context.worktreeBranch, "runwield/worktree/p-wt");
                assertEquals(result.context.worktreeBaseBranch, "main");
            }
            assertEquals(result.persistedLegacyExecutionMode, false);
        }
        const persistedPlan = await loadPlan(projectRoot, "p");
        assertEquals(persistedPlan?.attrs.worktreeId, "wt-1", "loaded views join the registry");
        const document = parsePlanFrontMatter(persistedPlan?.markdown || "").attrs;
        assertEquals(document.worktreeId, undefined);
        assertEquals(document.executionMode, undefined);
        assertEquals(document.executionBaselineTree, undefined);
        assertEquals(document.worktreePath, undefined);
        assertEquals(document.worktreeBranch, undefined);
        assertEquals(document.worktreeBaseBranch, undefined);
    } finally {
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
        await fsRm(parent, { recursive: true }).catch(() => {});
    }
});

test("resolveValidationExecutionContext repairs a saved baseline that hides completed code", async () => {
    const projectRoot = await baseRepo.checkout();
    const parent = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        const creationTree = await git(projectRoot, ["rev-parse", "HEAD^{tree}"]);
        const worktreePath = `${parent}/wt`;
        await git(projectRoot, ["worktree", "add", "-b", "runwield/worktree/p-wt", worktreePath, "HEAD"]);
        await fsWriteFile(`${worktreePath}/dependency.txt`, "integrated dependency\n");
        await git(worktreePath, ["add", "dependency.txt"]);
        await git(worktreePath, ["commit", "-m", "establish execution baseline"]);
        const registryBaselineTree = await git(worktreePath, ["rev-parse", "HEAD^{tree}"]);
        await savePlan(projectRoot, "p", "# Plan", {
            classification: "FEATURE",
            status: "implemented",
            executionMode: "worktree",
            executionBaselineTree: creationTree,
            worktreeId: "wt-1",
            worktreePath,
            worktreeBranch: "runwield/worktree/p-wt",
            worktreeBaseBranch: "main",
            worktreeStatus: "completed",
        });
        await addEntry(projectRoot, {
            id: "wt-1",
            planName: "p",
            planId: "plan-p",
            baseBranch: "main",
            baseRef: "HEAD",
            baseCommit: await git(projectRoot, ["rev-parse", "HEAD"]),
            baseTree: creationTree,
            executionBaselineTree: registryBaselineTree,
            branch: "runwield/worktree/p-wt",
            path: worktreePath,
            status: "completed",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        });

        const result = await resolveValidationExecutionContext({ projectRoot, planName: "p" });
        assertEquals(result.kind, "ok");
        if (result.kind === "ok" && result.context.executionMode === "worktree") {
            assertEquals(result.context.baselineTree, creationTree);
            assertEquals(result.selfHealNotices, [
                { kind: "review_range_fixed", planName: "p" },
                { kind: "execution_plan_fixed", planName: "p" },
            ]);
        }
        assertEquals((await findById(projectRoot, "wt-1"))?.executionBaselineTree, creationTree);
    } finally {
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
        await fsRm(parent, { recursive: true }).catch(() => {});
    }
});

test("resolveValidationExecutionContext ignores stale caller and session context", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        await savePlan(cwd, "p", "# Plan", { classification: "FEATURE", status: "implemented" });
        const result = await resolveValidationExecutionContext({
            projectRoot: cwd,
            planName: "p",
            explicitContext: { planName: "p", executionMode: "worktree", executionCwd: "/worktree-a" },
            activeWorkflow: { planName: "p", executionMode: "worktree", executionCwd: "/worktree-b" },
        });
        assertEquals(result.kind, "blocked");
        if (result.kind === "blocked") assertEquals(result.reason, "incomplete_worktree_identity");
    } finally {
        await fsRm(cwd, { recursive: true });
    }
});

test("resolveValidationExecutionContext uses imported controller mode instead of stale caller mode", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        await savePlan(cwd, "p", "# Plan", {
            classification: "FEATURE",
            status: "implemented",
            executionMode: "worktree",
            executionBaselineTree: "tree",
            worktreeId: "wt-1",
            worktreePath: "/tmp/wt",
            worktreeBranch: "runwield/worktree/p-wt",
            worktreeBaseBranch: "main",
        });
        const result = await resolveValidationExecutionContext({
            projectRoot: cwd,
            planName: "p",
            explicitContext: { planName: "p", nonGitInPlace: true },
        });
        assertEquals(result.kind, "blocked");
        if (result.kind === "blocked") assertEquals(result.reason, "worktree_inspection_failed");
    } finally {
        await fsRm(cwd, { recursive: true });
    }
});

test("resolveValidationExecutionContext recovers committed worktree baseline without a copied Plan file", async () => {
    const projectRoot = await baseRepo.checkout();
    const parent = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        const baselineTree = await git(projectRoot, ["rev-parse", "HEAD^{tree}"]);
        const worktreePath = `${parent}/wt`;
        await git(projectRoot, ["worktree", "add", "-b", "runwield/worktree/p-wt", worktreePath, "HEAD"]);
        await fsWriteFile(`${worktreePath}/file.txt`, "base\nimplemented\n");
        await git(worktreePath, ["add", "file.txt"]);
        await git(worktreePath, ["commit", "-m", "implement p"]);
        await savePlan(projectRoot, "p", "# Plan", {
            classification: "FEATURE",
            status: "implemented",
            worktreeId: "wt-1",
            worktreePath,
            worktreeBranch: "runwield/worktree/p-wt",
            worktreeBaseBranch: "main",
            worktreeStatus: "completed",
        });
        const [plan] = await listPlanResources(projectRoot, { backfillMissing: true });
        if (!plan?.planId) throw new Error("Expected Plan ID");
        await addEntry(projectRoot, {
            id: "wt-1",
            planName: "p",
            planId: plan.planId,
            baseBranch: "main",
            baseRef: "HEAD",
            baseCommit: await git(projectRoot, ["rev-parse", "HEAD"]),
            baseTree: baselineTree,
            branch: "runwield/worktree/p-wt",
            path: worktreePath,
            status: "completed",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        });

        const canonicalMarkdownBeforeResolution = (await loadPlan(projectRoot, "p"))?.markdown;
        const result = await resolveValidationExecutionContext({
            projectRoot,
            planName: "p",
            triageMeta: {},
        });

        assertEquals(result.kind, "ok");
        if (result.kind === "ok") {
            assertEquals(result.context.executionMode, "worktree");
            if (result.context.executionMode === "worktree") {
                assertEquals(result.context.executionCwd, await fsRealpath(worktreePath));
                assertEquals(result.context.baselineTree, baselineTree);
            }
            assertEquals(result.persistedLegacyExecutionMode, false);
            assertEquals(result.restoredPlanFile, { relativePath: "docs/plans/p.md" });
        }
        assertEquals(await fsReadFile(`${worktreePath}/docs/plans/p.md`, "utf8"), canonicalMarkdownBeforeResolution);
        const persistedPlan = await loadPlan(projectRoot, "p");
        assertEquals(persistedPlan?.attrs.executionMode, "worktree");
        assertEquals(persistedPlan?.attrs.executionBaselineTree, baselineTree);
        assertEquals(parsePlanFrontMatter(persistedPlan?.markdown || "").attrs.executionMode, undefined);
    } finally {
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
        await fsRm(parent, { recursive: true }).catch(() => {});
    }
});

test("resolveValidationExecutionContext makes registry identity authoritative over stale Plan copies", async () => {
    const projectRoot = await baseRepo.checkout();
    const parent = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        const baselineTree = await git(projectRoot, ["rev-parse", "HEAD^{tree}"]);
        const worktreePath = `${parent}/wt`;
        await git(projectRoot, ["worktree", "add", "-b", "runwield/worktree/p-wt", worktreePath, "HEAD"]);
        await savePlan(worktreePath, "p", "# Plan", {
            planId: "worktree-plan-id",
            classification: "FEATURE",
            status: "implemented",
        });
        await savePlan(projectRoot, "p", "# Plan", {
            planId: "canonical-plan-id",
            classification: "FEATURE",
            status: "implemented",
            executionMode: "worktree",
            executionBaselineTree: baselineTree,
            worktreeId: "wt-1",
            worktreePath,
            worktreeBranch: "runwield/worktree/p-wt",
            worktreeBaseBranch: "main",
            worktreeStatus: "completed",
        });
        await addEntry(projectRoot, {
            id: "wt-1",
            planName: "p",
            planId: "plan-p",
            baseBranch: "main",
            baseRef: "HEAD",
            baseCommit: await git(projectRoot, ["rev-parse", "HEAD"]),
            baseTree: baselineTree,
            branch: "runwield/worktree/p-wt",
            path: worktreePath,
            status: "completed",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        });

        // Three ids for one Plan: the primary-checkout file, the execution Plan,
        // and the registry entry. Once execution starts, the registry identifies
        // the attempt and the execution Plan is its authoritative Plan file. The
        // unrelated primary checkout is never rewritten.
        const result = await resolveValidationExecutionContext({ projectRoot, planName: "p", triageMeta: {} });
        assertEquals(result.kind, "ok");
        if (result.kind !== "ok") return;
        const notices = result.selfHealNotices || [];
        assertEquals(notices, [{ kind: "execution_plan_fixed", planName: "p" }]);

        // The execution Plan converges on the durable attempt id. The primary
        // checkout remains byte-for-byte outside the recovery transaction.
        const healed = await loadPlan(worktreePath, "p");
        assertEquals(healed?.attrs.planId, "plan-p");
        const entry = await findById(projectRoot, "wt-1");
        assertEquals(entry?.planId, "plan-p");
        const canonical = await loadPlan(projectRoot, "p");
        assertEquals(
            canonical?.attrs.planId,
            "canonical-plan-id",
            "the canonical Plan is never rewritten from a copy",
        );
    } finally {
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
        await fsRm(parent, { recursive: true }).catch(() => {});
    }
});

test("a damaged worktree registry blocks with commands instead of a stack trace", async () => {
    const projectRoot = await baseRepo.checkout();
    try {
        await savePlan(projectRoot, "p", "# Plan", {
            planId: "plan-ambiguous",
            classification: "FEATURE",
            status: "implemented",
            executionMode: "worktree",
        });
        // addEntry refuses to create a second live attempt, which is the guard working.
        // The damage this covers arrives the other way: a hand-edited file or a branch
        // merge that concatenated two registries.
        const baseCommit = await git(projectRoot, ["rev-parse", "HEAD"]);
        const attempt = (/** @type {string} */ id, /** @type {string} */ status) => ({
            id,
            planName: "p",
            planId: "plan-ambiguous",
            baseBranch: "main",
            baseRef: "HEAD",
            baseCommit,
            branch: `runwield/worktree/p-${id}`,
            path: `${projectRoot}/${id}`,
            status,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        });
        const registryPath = getWorktreeRegistryPath(projectRoot);
        await fsMkdir(dirname(registryPath), { recursive: true });
        await fsWriteFile(
            registryPath,
            JSON.stringify({ version: 2, entries: [attempt("wt-x", "active"), attempt("wt-y", "completed")] }),
        );

        const result = await resolveValidationExecutionContext({ projectRoot, planName: "p", triageMeta: {} });
        assertEquals(result.kind, "blocked");
        if (result.kind !== "blocked") return;
        assertEquals(result.reason, "worktree_registry_ambiguous");
        assertStringIncludes(result.message, "wt-x");
        assertStringIncludes(result.message, "wt-y");
        assertStringIncludes(result.message, "What you can do:");
        assertStringIncludes(result.message, "plans doctor");
        assertStringIncludes(result.message, "load-plan p");
    } finally {
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
    }
});

test("resolveValidationExecutionContext replaces a stale caller path with the saved worktree path", async () => {
    const projectRoot = await baseRepo.checkout();
    const parent = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        const baselineTree = await git(projectRoot, ["rev-parse", "HEAD^{tree}"]);
        const worktreePath = `${parent}/wt`;
        const otherPath = `${parent}/other`;
        await git(projectRoot, ["worktree", "add", "-b", "runwield/worktree/p-wt", worktreePath, "HEAD"]);
        await savePlan(worktreePath, "p", "# Plan", { classification: "FEATURE", status: "implemented" });
        await fsMkdir(otherPath);
        await savePlan(projectRoot, "p", "# Plan", {
            classification: "FEATURE",
            status: "implemented",
            executionMode: "worktree",
            executionBaselineTree: baselineTree,
            worktreeId: "wt-1",
            worktreePath,
            worktreeBranch: "runwield/worktree/p-wt",
            worktreeBaseBranch: "main",
            worktreeStatus: "completed",
        });
        await addEntry(projectRoot, {
            id: "wt-1",
            planName: "p",
            planId: "plan-p",
            baseBranch: "main",
            baseRef: "HEAD",
            baseCommit: await git(projectRoot, ["rev-parse", "HEAD"]),
            baseTree: baselineTree,
            branch: "runwield/worktree/p-wt",
            path: worktreePath,
            status: "completed",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        });
        const result = await resolveValidationExecutionContext({
            projectRoot,
            planName: "p",
            explicitContext: {
                planName: "p",
                executionMode: "worktree",
                executionCwd: otherPath,
                baselineTree,
                worktreeId: "wt-1",
                worktreeBranch: "runwield/worktree/p-wt",
                worktreeBaseBranch: "main",
            },
        });
        assertEquals(result.kind, "ok");
        if (result.kind === "ok") assertEquals(result.context.executionCwd, await fsRealpath(worktreePath));
    } finally {
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
        await fsRm(parent, { recursive: true }).catch(() => {});
    }
});

for (const primaryBranch of [false, true]) {
    test(`validation rejects primary checkout before repair (branch in primary: ${primaryBranch})`, async () => {
        const projectRoot = await baseRepo.checkout();
        try {
            const branch = "worktree/primary-guard";
            const path = primaryBranch ? `${projectRoot}/missing-attempt` : projectRoot;
            if (primaryBranch) await git(projectRoot, ["switch", "-c", branch]);
            await savePlan(projectRoot, "p", "# Plan", {
                planId: "primary-guard-plan",
                classification: "FEATURE",
                status: "implemented",
                executionMode: "worktree",
                worktreeId: "primary-guard",
                worktreePath: path,
                worktreeBranch: branch,
                worktreeBaseBranch: "main",
            });
            await addEntry(projectRoot, {
                id: "primary-guard",
                planName: "p",
                planId: "primary-guard-plan",
                path,
                branch,
                baseBranch: "main",
                baseRef: "main",
                baseCommit: await git(projectRoot, ["rev-parse", "HEAD"]),
                status: "completed",
                createdAt: "2026-09-08T00:00:00Z",
                updatedAt: "2026-09-08T00:00:00Z",
            });
            await fsWriteFile(`${projectRoot}/file.txt`, "unsaved developer work\n");
            await fsWriteFile(`${projectRoot}/untracked.txt`, "keep me\n");
            const before = await findById(projectRoot, "primary-guard");
            const status = await git(projectRoot, ["status", "--porcelain"]);
            const head = await git(projectRoot, ["rev-parse", "HEAD"]);
            const result = await resolveValidationExecutionContext({ projectRoot, planName: "p" });
            assertEquals(result.kind, "blocked");
            if (result.kind === "blocked") assertEquals(result.reason, "primary_checkout_is_not_execution_worktree");
            assertEquals(await git(projectRoot, ["branch", "--show-current"]), primaryBranch ? branch : "main");
            assertEquals(await git(projectRoot, ["rev-parse", "HEAD"]), head);
            assertEquals(await git(projectRoot, ["status", "--porcelain"]), status);
            assertEquals(await fsReadFile(`${projectRoot}/file.txt`, "utf8"), "unsaved developer work\n");
            assertEquals(await fsReadFile(`${projectRoot}/untracked.txt`, "utf8"), "keep me\n");
            assertEquals(await findById(projectRoot, "primary-guard"), before);
            if (!primaryBranch) assertEquals(await git(projectRoot, ["branch", "--list", branch]), "");
        } finally {
            await fsRm(projectRoot, { recursive: true });
        }
    });
}
