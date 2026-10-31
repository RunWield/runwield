import { test } from "node:test";
import { deepStrictEqual, strictEqual, ok, rejects } from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import process from "node:process";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { withProcessGlobalTestLock } from "./testing/process-global-lock.ts";
import { dirname, join } from "node:path";
import { listPlanResources, listPlans, readPlanResourceCatalog, ensurePlanIdentity } from "./plan-store.js";
import { defineGitFixture, git } from "./shared/git-test-fixture.ts";
import { enterProjectRuntime } from "./shared/project-runtime-layout.ts";
import { getRunWieldRuntimeDir } from "./constants.js";
import { addEntry } from "./shared/worktree-registry.js";
import {
    findTargetBranchPlansByParent,
    readTargetBranchPlanCatalogByParent,
} from "./shared/workflow/planning-worktree.ts";
import { loadBoard, loadPlanSummaries, loadPlanSummaryCatalog } from "./ui/workspace/server/plan-adapter.js";

const broken = "---\naffectedPaths: - src/a.ts\n  status: draft\n---\n# Broken\n";
function document(id: string, extra = "") {
    return `---\nplanId: ${id}\nclassification: FEATURE\nstatus: draft\n${extra}---\n# Healthy\n`;
}
async function put(root: string, name: string, markdown: string) {
    const path = join(root, "docs/plans", `${name}.md`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, markdown);
    return path;
}
async function tree(root: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) {
            for (const [name, bytes] of Object.entries(await tree(path))) result[`${entry.name}/${name}`] = bytes;
        } else if (entry.isFile()) result[entry.name] = (await readFile(path)).toString("base64");
    }
    return result;
}
async function snapshot(root: string) {
    return { project: await tree(root), runtime: await tree(getRunWieldRuntimeDir(root)) };
}
const fixture = defineGitFixture(async (root) => {
    await put(root, "ordinary", document("ordinary-id"));
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "healthy catalog"]);
});

for (const prepared of [false, true]) {
    test(`display catalog isolates named local failures with ${prepared ? "ready" : "pending"} runtime and never changes sources`, async () => {
        const root = await fixture.checkout();
        try {
            if (prepared) await enterProjectRuntime(root);
            await put(root, "broken", broken);
            await put(root, "nested/also-broken", broken);
            const before = await snapshot(root);
            for (let repeat = 0; repeat < 2; repeat++) {
                const catalog = await readPlanResourceCatalog(root);
                deepStrictEqual(
                    catalog.resources.map((plan) => plan.name),
                    ["ordinary"],
                );
                deepStrictEqual(catalog.diagnostics.map((issue) => issue.name).sort(), [
                    "broken",
                    "nested/also-broken",
                ]);
                ok(
                    catalog.diagnostics.every(
                        (issue) => issue.kind === "malformed" && issue.message.includes("(1:16)"),
                    ),
                );
                ok(catalog.diagnostics.every((issue) => !("planId" in issue)));
                const summary = await loadPlanSummaryCatalog(root);
                strictEqual(summary.plans.length, 1);
                strictEqual(summary.diagnostics.length, 2);
                strictEqual(JSON.stringify(summary.diagnostics).includes(root), false);
                strictEqual(JSON.stringify(summary.diagnostics).includes('"path"'), false);
                const board = await loadBoard(root);
                strictEqual(board.plans.length, 1);
                deepStrictEqual(board.diagnostics, summary.diagnostics);
                ok(board.groups);
                ok(board.screens);
                await rejects(() => listPlans(root), /could not be parsed/);
                await rejects(() => listPlanResources(root), /could not be parsed/);
                await rejects(() => loadPlanSummaries(root), /could not be parsed/);
                deepStrictEqual(await snapshot(root), before);
            }
            await rejects(() => ensurePlanIdentity(root, "ordinary"), /could not be parsed/);
            await put(root, "broken", document("corrected-id"));
            strictEqual((await readPlanResourceCatalog(root)).diagnostics.length, 1);
            await rm(join(root, "docs/plans/nested/also-broken.md"));
            strictEqual((await readPlanResourceCatalog(root)).diagnostics.length, 0);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
}

test("target display isolates and deduplicates malformed documents without guessing membership", async () => {
    const root = await fixture.checkout();
    try {
        await enterProjectRuntime(root);
        await git(root, ["switch", "-c", "target"]);
        await put(root, "child", document("child-id", "parentPlan: epic\n"));
        await put(root, "broken-target", broken);
        await put(root, "archived/broken", broken);
        await git(root, ["add", "."]);
        await git(root, ["commit", "-m", "target documents"]);
        await git(root, ["update-ref", "refs/remotes/origin/target", "HEAD"]);
        await git(root, ["switch", "main"]);
        for (const name of ["epic", "other-epic"]) {
            await put(
                root,
                name,
                `---\nplanId: ${name}-id\nclassification: PROJECT\ntargetBranch: target\n---\n# Epic\n`,
            );
        }
        const before = await snapshot(root);
        const catalog = await readPlanResourceCatalog(root);
        ok(catalog.resources.some((plan) => plan.name === "child"));
        deepStrictEqual(
            catalog.diagnostics.map((issue) => issue.name),
            ["broken-target"],
        );
        strictEqual("parentPlan" in catalog.diagnostics[0], false);
        await rejects(() => findTargetBranchPlansByParent(root, "target", "epic"));
        await rejects(() => listPlanResources(root));
        deepStrictEqual(await snapshot(root), before);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("registered document authority suppresses broken or healthy lower-priority copies", async () => {
    const root = await fixture.checkout();
    try {
        await enterProjectRuntime(root);
        await put(root, "epic", "---\nplanId: epic-id\nclassification: PROJECT\ntargetBranch: main\n---\n# Epic\n");
        await put(root, "ordinary", document("ordinary-id", "parentPlan: epic\n"));
        await git(root, ["add", "."]);
        await git(root, ["commit", "-m", "family"]);
        const worktree = `${root}-authority`;
        try {
            await git(root, ["worktree", "add", "-b", "execution", worktree]);
            await addEntry(root, {
                id: "attempt",
                planId: "ordinary-id",
                planName: "ordinary",
                path: worktree,
                branch: "execution",
                baseBranch: "main",
                baseRef: "main",
                baseCommit: "a".repeat(40),
                status: "active",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
            });
            await put(worktree, "ordinary", broken);
            const before = await snapshot(root);
            const catalog = await readPlanResourceCatalog(root);
            strictEqual(
                catalog.resources.some((plan) => plan.name === "ordinary"),
                false,
            );
            strictEqual(catalog.diagnostics.length, 1);
            strictEqual(catalog.diagnostics[0].planId, "ordinary-id");
            const target = await readTargetBranchPlanCatalogByParent(root, "main", "epic");
            strictEqual(target.plans.length, 0);
            strictEqual(target.diagnostics.length, 1);
            await rejects(() => listPlanResources(root), /could not be parsed/);
            deepStrictEqual(await snapshot(root), before);
            await put(worktree, "ordinary", document("ordinary-id", "parentPlan: epic\nsummary: Current authority\n"));
            await put(root, "ordinary", broken);
            const corrected = await readPlanResourceCatalog(root);
            strictEqual(corrected.diagnostics.length, 0);
            strictEqual(
                corrected.resources.find((plan) => plan.name === "ordinary")?.attrs.summary,
                "Current authority",
            );
            const correctedTarget = await readTargetBranchPlanCatalogByParent(root, "main", "epic");
            strictEqual(correctedTarget.diagnostics.length, 0);
            strictEqual(correctedTarget.plans[0]?.attrs.summary, "Current authority");
            await put(worktree, "ordinary", document("different-id", "parentPlan: epic\n"));
            await rejects(() => readPlanResourceCatalog(root), /different Plan ID|does not match/);
            await rejects(
                () => readTargetBranchPlanCatalogByParent(root, "main", "epic"),
                /different Plan ID|does not match/,
            );
        } finally {
            await rm(worktree, { recursive: true, force: true });
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("display resource reload reports a document that becomes malformed after discovery", async () => {
    await withProcessGlobalTestLock(async () => {
        const root = await fixture.checkout();
        const shim = await mkdtemp(join(tmpdir(), "catalog-git-"));
        const previous = process.env.PATH;
        const worktree = `${root}-reload-authority`;
        try {
            await enterProjectRuntime(root);
            await git(root, ["worktree", "add", "-b", "reload-authority", worktree]);
            await put(worktree, "authority", document("authority-id"));
            await addEntry(root, {
                id: "reload-attempt",
                planId: "authority-id",
                planName: "authority",
                path: worktree,
                branch: "reload-authority",
                baseBranch: "main",
                baseRef: "main",
                baseCommit: "a".repeat(40),
                status: "active",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
            });
            const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
            const replacement = join(shim, "broken.md");
            await writeFile(replacement, broken);
            const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
            // Git is the external boundary: registry inspection happens after local collection.
            // Change the already-collected file while that real subprocess runs.
            await writeFile(
                join(shim, "git"),
                `#!/bin/sh\nif [ "$1" = "worktree" ]; then\n/bin/cp ${quote(replacement)} ${quote(join(root, "docs/plans/ordinary.md"))}\nfi\nexec ${quote(realGit)} "$@"\n`,
            );
            await chmod(join(shim, "git"), 0o755);
            process.env.PATH = `${shim}:${previous || ""}`;
            const catalog = await readPlanResourceCatalog(root);
            deepStrictEqual(
                catalog.resources.map((plan) => plan.name),
                ["authority"],
            );
            deepStrictEqual(
                catalog.diagnostics.map((issue) => ({ name: issue.name, kind: issue.kind })),
                [{ name: "ordinary", kind: "malformed" }],
            );
            ok(catalog.diagnostics[0].message.includes("(1:16)"));
            await put(root, "ordinary", document("ordinary-id"));
            const strict = await listPlanResources(root);
            deepStrictEqual(
                strict.map((plan) => plan.name),
                ["authority"],
            );
        } finally {
            if (previous === undefined) delete process.env.PATH;
            else process.env.PATH = previous;
            await rm(shim, { recursive: true, force: true });
            await rm(worktree, { recursive: true, force: true });
            await rm(root, { recursive: true, force: true });
        }
    });
});

test("display catalog still rejects duplicate identity and blocked runtime access", async () => {
    const root = await fixture.checkout();
    try {
        const layout = await enterProjectRuntime(root);
        await put(root, "duplicate", document("ordinary-id"));
        await rejects(() => readPlanResourceCatalog(root), /Duplicate planId/);
        await rm(join(root, "docs/plans/duplicate.md"));
        await writeFile(layout.primary.layoutMarkerPath, JSON.stringify({ version: 999 }));
        await rejects(() => readPlanResourceCatalog(root), /not been changed|runtime/i);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("development Board carries the same safe catalog warnings through its cached data path", async () => {
    const root = await fixture.checkout();
    const output = await mkdtemp(join(tmpdir(), "catalog-dev-board-"));
    try {
        await put(root, "broken", broken);
        const built = await Bun.build({
            entrypoints: [new URL("./ui/workspace/server/astro-canonical-data.js", import.meta.url).pathname],
            outdir: output,
            target: "bun",
            define: { "import.meta.env.DEV": "true" },
        });
        ok(built.success, built.logs.map((message) => message.message).join("\n"));
        const { loadCanonicalBoard } = await import(join(output, "astro-canonical-data.js"));
        const board = await loadCanonicalBoard(root);
        const production = await loadBoard(root);
        deepStrictEqual(board.diagnostics, production.diagnostics);
        strictEqual(board.diagnostics[0].name, "broken");
        strictEqual(board.plans[0].planId, "ordinary-id");
        ok(board.groups);
        ok(board.screens);
        strictEqual(JSON.stringify(board.diagnostics).includes(root), false);
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(output, { recursive: true, force: true });
    }
});
