import { readdir, rmdir } from "node:fs/promises";

import {
    lstat as fsLstat,
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    stat as fsStat,
    symlink as fsSymlink,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import {
    ensureExecutionPlanFile,
    loadCanonicalExecutionPlanSource,
    prepareExecutionPlanFile,
} from "./execution-plan-file.js";
import { injectFrontMatter, parsePlanFrontMatter, planDocumentMarkdown } from "../../plan-store.js";

async function makeTempProject() {
    const root = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    await fsMkdir(join(root, "docs", "plans"), { recursive: true });
    return root;
}

test("prepareExecutionPlanFile restores absent top-level and nested execution Plans exactly", async () => {
    const projectRoot = await makeTempProject();
    const executionRoot = await makeTempProject();
    const markdown = injectFrontMatter("# Plan\n\nBody", { planId: "plan-1", status: "implemented" });
    await fsWriteFile(join(projectRoot, "docs", "plans", "epic", "child.md"), markdown).catch(async () => {
        await fsMkdir(join(projectRoot, "docs", "plans", "epic"));
        await fsWriteFile(join(projectRoot, "docs", "plans", "epic", "child.md"), markdown);
    });

    await fsRm(join(executionRoot, "docs", "plans"), { recursive: true });
    const result = await prepareExecutionPlanFile({ projectRoot, executionCwd: executionRoot, planName: "epic/child" });

    assertEquals(result.kind, "restored");
    assertEquals(result.relativePath, "docs/plans/epic/child.md");
    assertEquals(
        await fsReadFile(join(executionRoot, "docs", "plans", "epic", "child.md"), "utf8"),
        planDocumentMarkdown(markdown),
    );
});

test("prepareExecutionPlanFile fills a missing Plan ID from the primary Plan", async () => {
    const projectRoot = await makeTempProject();
    const executionRoot = await makeTempProject();
    await fsWriteFile(
        join(projectRoot, "docs", "plans", "demo.md"),
        injectFrontMatter("# Canonical", { planId: "plan-1" }),
    );
    const legacy = injectFrontMatter("# Legacy", {});
    await fsWriteFile(join(executionRoot, "docs", "plans", "demo.md"), legacy);

    const result = await prepareExecutionPlanFile({ projectRoot, executionCwd: executionRoot, planName: "demo" });

    assertEquals(result.kind, "reconciled");
    const healed = parsePlanFrontMatter(await fsReadFile(join(executionRoot, "docs", "plans", "demo.md"), "utf8"));
    assertEquals(healed.attrs.planId, "plan-1");
    assertEquals(healed.body, "# Legacy");
});

test("prepareExecutionPlanFile reconciles stale execution metadata without replacing its Plan body", async () => {
    const projectRoot = await makeTempProject();
    const executionRoot = await makeTempProject();
    await fsWriteFile(
        join(projectRoot, "docs", "plans", "demo.md"),
        injectFrontMatter("# Canonical body\n\nPrimary checkout prose.", {
            planId: "plan-1",
            classification: "PLANNED_CHANGE",
            status: "ready_for_work",
            executionAgent: "engineer",
            collaborationRecommendation: "autonomous",
            implementedAt: "2026-01-01T00:00:00.000Z",
            validationCiAttempts: 2,
            validationCheckpoint: {
                version: 1,
                attemptId: "attempt-1",
                generation: "generation-1",
                expectedStatus: "ready_for_work",
                nextPhase: "mechanical",
                state: "paused",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
        }),
    );
    const executionMarkdown =
        injectFrontMatter("# Worktree body\n\nPreserve this exact prose.", {
            planId: "plan-1",
            classification: "QUICK_FIX",
            status: "approved",
            executionAgent: "frontend-engineer",
            collaborationRecommendation: "pair",
            implementedAt: null,
            validationCiAttempts: 0,
            validationCheckpoint: null,
            summary: "keep-me",
        }) + "\n";
    await fsWriteFile(join(executionRoot, "docs", "plans", "demo.md"), executionMarkdown);

    const result = await prepareExecutionPlanFile({ projectRoot, executionCwd: executionRoot, planName: "demo" });

    assertEquals(result.kind, "reconciled");
    const reconciledMarkdown = await fsReadFile(join(executionRoot, "docs", "plans", "demo.md"), "utf8");
    assertEquals(reconciledMarkdown.includes("validationCheckpoint:"), false);
    assertEquals(reconciledMarkdown, planDocumentMarkdown(reconciledMarkdown));
    // Retain the legacy formatter check in the Deno lane; Bun's portable
    // document output is checked above without requiring a second runtime.

    const reconciled = parsePlanFrontMatter(reconciledMarkdown);
    assertEquals(reconciled.attrs.classification, "PLANNED_CHANGE");
    assertEquals(reconciled.attrs.status, "ready_for_work");
    assertEquals(reconciled.attrs.executionAgent, "engineer");
    assertEquals(reconciled.attrs.collaborationRecommendation, "autonomous");
    assertEquals(reconciled.attrs.implementedAt, undefined);
    assertEquals(reconciled.attrs.validationCiAttempts, undefined);
    assertEquals(reconciled.attrs.validationCheckpoint, undefined);
    assertEquals(reconciled.attrs.summary, "");
    assertEquals(reconciled.body, "# Worktree body\n\nPreserve this exact prose.\n");
});

test("prepareExecutionPlanFile heals a diverged Plan ID toward canonical and blocks symlinked parents", async () => {
    const projectRoot = await makeTempProject();
    const executionRoot = await makeTempProject();
    await fsWriteFile(
        join(projectRoot, "docs", "plans", "demo.md"),
        injectFrontMatter("# Canonical", { planId: "plan-1" }),
    );
    // The plan name is the store key, so an execution copy at the same path is this
    // Plan with a twice-minted id, not a different Plan. Blocking here stranded the
    // Plan over Front Matter RunWield owns, so the canonical id wins.
    const diverged = injectFrontMatter("# Worktree body\n\nUser-owned prose survives.", { planId: "plan-2" });
    await fsWriteFile(join(executionRoot, "docs", "plans", "demo.md"), diverged);

    const healed = await prepareExecutionPlanFile({ projectRoot, executionCwd: executionRoot, planName: "demo" });
    assertEquals(healed.kind, "reconciled");
    assertEquals(healed.healedPlanId, { from: "plan-2", to: "plan-1" });
    const afterHeal = parsePlanFrontMatter(await fsReadFile(join(executionRoot, "docs", "plans", "demo.md"), "utf8"));
    assertEquals(afterHeal.attrs.planId, "plan-1");
    assertEquals(afterHeal.body, "# Worktree body\n\nUser-owned prose survives.");

    // Healing is one-directional: the canonical Plan is never rewritten from a copy.
    const canonicalAfter = parsePlanFrontMatter(
        await fsReadFile(join(projectRoot, "docs", "plans", "demo.md"), "utf8"),
    );
    assertEquals(canonicalAfter.attrs.planId, "plan-1");

    const linkedRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    await fsRm(join(executionRoot, "docs", "plans", "demo.md"));
    await rmdir(join(executionRoot, "docs", "plans"));
    await fsSymlink(linkedRoot, join(executionRoot, "docs", "plans"));
    const symlink = await prepareExecutionPlanFile({ projectRoot, executionCwd: executionRoot, planName: "demo" });
    assertEquals(symlink.kind, "symlink");
});

test("loadCanonicalExecutionPlanSource classifies absent and malformed canonical source", async () => {
    const projectRoot = await makeTempProject();
    const absent = await loadCanonicalExecutionPlanSource(projectRoot, "missing");
    assertEquals(absent.kind, "absent");
    assertStringIncludes(absent.relativePath, "docs/plans/missing.md");

    await fsWriteFile(join(projectRoot, "docs", "plans", "bad.md"), "---\n: bad\n---\n# Bad");
    const malformed = await loadCanonicalExecutionPlanSource(projectRoot, "bad");
    assertEquals(malformed.kind, "malformed");
});

test("prepareExecutionPlanFile classifies canonical symlink and non-regular sources", async () => {
    const projectRoot = await makeTempProject();
    const executionRoot = await makeTempProject();
    const outside = join(await fsMkdtemp(join(tmpdir(), "plan-outside-")), "outside.md");
    await fsWriteFile(outside, "");
    await fsSymlink(outside, join(projectRoot, "docs", "plans", "linked.md"));
    const linked = await prepareExecutionPlanFile({ projectRoot, executionCwd: executionRoot, planName: "linked" });
    assertEquals(linked.kind, "symlink");

    await fsMkdir(join(projectRoot, "docs", "plans", "directory.md"));
    const directory = await prepareExecutionPlanFile({
        projectRoot,
        executionCwd: executionRoot,
        planName: "directory",
    });
    assertEquals(directory.kind, "non_regular");
});

test("loadCanonicalExecutionPlanSource rejects symlinked and non-directory canonical parents", async () => {
    const projectRoot = await makeTempProject();
    const outsidePlans = await makeTempProject();
    await fsWriteFile(
        join(outsidePlans, "docs", "plans", "demo.md"),
        injectFrontMatter("# Outside", { planId: "outside-plan" }),
    );

    await rmdir(join(projectRoot, "docs", "plans"));
    await fsSymlink(join(outsidePlans, "docs", "plans"), join(projectRoot, "docs", "plans"));
    const symlinkedParent = await loadCanonicalExecutionPlanSource(projectRoot, "demo");
    assertEquals(symlinkedParent.kind, "symlink");
    assertEquals(symlinkedParent.relativePath, "docs/plans/demo.md");

    await fsRm(join(projectRoot, "docs", "plans"));
    await fsMkdir(join(projectRoot, "docs", "plans"), { recursive: true });
    await fsWriteFile(join(projectRoot, "docs", "plans", "epic"), "not a directory");
    const nonDirectoryParent = await loadCanonicalExecutionPlanSource(projectRoot, "epic/child");
    assertEquals(nonDirectoryParent.kind, "non_regular");
    assertEquals(nonDirectoryParent.relativePath, "docs/plans/epic/child.md");
});

test("prepareExecutionPlanFile preserves a symlink and blocks", async () => {
    const projectRoot = await makeTempProject();
    const executionRoot = await makeTempProject();
    const canonical = injectFrontMatter("# Canonical", {});
    await fsWriteFile(join(projectRoot, "docs", "plans", "demo.md"), canonical);
    const outside = join(await fsMkdtemp(join(tmpdir(), "plan-outside-")), "outside.md");
    const sentinel = "Existing outside Plan must remain untouched.\n";
    await fsWriteFile(outside, sentinel);
    await fsSymlink(outside, join(executionRoot, "docs", "plans", "demo.md"));

    const result = await prepareExecutionPlanFile({ projectRoot, executionCwd: executionRoot, planName: "demo" });

    assertEquals(result.kind, "symlink");
    assertEquals((await fsLstat(join(executionRoot, "docs", "plans", "demo.md"))).isSymbolicLink(), true);
    assertEquals(await fsReadFile(outside, "utf8"), sentinel);
});

test("prepareExecutionPlanFile preserves a non-file path and blocks", async () => {
    const projectRoot = await makeTempProject();
    const executionRoot = await makeTempProject();
    const canonical = injectFrontMatter("# Canonical", {});
    await fsWriteFile(join(projectRoot, "docs", "plans", "demo.md"), canonical);
    await fsRm(join(executionRoot, "docs", "plans", "demo.md")).catch(() => {});
    await fsMkdir(join(executionRoot, "docs", "plans", "demo.md"));

    const result = await prepareExecutionPlanFile({ projectRoot, executionCwd: executionRoot, planName: "demo" });

    assertEquals(result.kind, "non_regular");
    assertEquals((await fsStat(join(executionRoot, "docs", "plans", "demo.md"))).isDirectory(), true);
});

test("prepareExecutionPlanFile preserves malformed bytes and blocks", async () => {
    const projectRoot = await makeTempProject();
    const executionRoot = await makeTempProject();
    const canonical = injectFrontMatter("# Canonical", {});
    const malformed = "---\n: bad\n---\n# Bad";
    await fsWriteFile(join(projectRoot, "docs", "plans", "demo.md"), canonical);
    await fsWriteFile(join(executionRoot, "docs", "plans", "demo.md"), malformed);

    const result = await prepareExecutionPlanFile({ projectRoot, executionCwd: executionRoot, planName: "demo" });

    assertEquals(result.kind, "malformed");
    assertEquals(await fsReadFile(join(executionRoot, "docs", "plans", "demo.md"), "utf8"), malformed);
});

test("prepareExecutionPlanFile reports restore failure when plans parent cannot be created", async () => {
    const projectRoot = await makeTempProject();
    const executionRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    await fsWriteFile(join(projectRoot, "docs", "plans", "demo.md"), injectFrontMatter("# Canonical", {}));
    await fsMkdir(join(executionRoot, "docs"), { recursive: true });
    await fsWriteFile(join(executionRoot, "docs", "plans"), "not a directory");

    const result = await prepareExecutionPlanFile({ projectRoot, executionCwd: executionRoot, planName: "demo" });

    assertEquals(result.kind, "non_regular");
    assertEquals(await fsReadFile(join(executionRoot, "docs", "plans"), "utf8"), "not a directory");
});

test("ensureExecutionPlanFile handles real concurrent publication without overwriting", async () => {
    const projectRoot = await makeTempProject();
    const executionRoot = await makeTempProject();
    const canonicalMarkdown = injectFrontMatter("# Canonical", { planId: "plan-1" });
    await fsWriteFile(join(projectRoot, "docs", "plans", "demo.md"), canonicalMarkdown);
    const source = await loadCanonicalExecutionPlanSource(projectRoot, "demo");
    if (source.kind !== "loaded") throw new Error("source did not load");
    await fsRm(join(executionRoot, "docs", "plans", "demo.md")).catch(() => {});

    const results = await Promise.all([
        ensureExecutionPlanFile({ executionCwd: executionRoot, planName: "demo", canonicalSource: source }),
        ensureExecutionPlanFile({ executionCwd: executionRoot, planName: "demo", canonicalSource: source }),
    ]);

    assertEquals(
        results.every((result) => result.kind === "restored" || result.kind === "present"),
        true,
    );
    assertEquals(
        results.some((result) => result.kind === "restored"),
        true,
    );
    assertEquals(
        await fsReadFile(join(executionRoot, "docs", "plans", "demo.md"), "utf8"),
        planDocumentMarkdown(canonicalMarkdown),
    );
});

test("ensureExecutionPlanFile keeps a concurrent body while fixing owned metadata", async () => {
    const projectRoot = await makeTempProject();
    const executionRoot = await makeTempProject();
    const canonicalMarkdown = injectFrontMatter("# Canonical", { planId: "plan-1", status: "implemented" });
    await fsWriteFile(join(projectRoot, "docs", "plans", "demo.md"), canonicalMarkdown);
    const source = await loadCanonicalExecutionPlanSource(projectRoot, "demo");
    if (source.kind !== "loaded") throw new Error("source did not load");
    const concurrent = injectFrontMatter("# Concurrent", { planId: "plan-1", status: "approved" });
    await fsWriteFile(join(executionRoot, "docs", "plans", "demo.md"), concurrent);

    const result = await ensureExecutionPlanFile({
        executionCwd: executionRoot,
        planName: "demo",
        canonicalSource: source,
    });

    assertEquals(result.kind, "reconciled");
    const resultPlan = parsePlanFrontMatter(await fsReadFile(join(executionRoot, "docs", "plans", "demo.md"), "utf8"));
    assertEquals(resultPlan.body, "# Concurrent");
    assertEquals(resultPlan.attrs.planId, "plan-1");
    assertEquals(resultPlan.attrs.status, "implemented");
    const entries = [];
    for await (const entry of await readdir(join(executionRoot, "docs", "plans"), { withFileTypes: true })) {
        entries.push(entry.name);
    }
    assertEquals(
        entries.some((name) => name.startsWith(".rw-plan-")),
        false,
    );
});

test("ensureExecutionPlanFile materializes the complete latest Plan before execution starts", async () => {
    const projectRoot = await makeTempProject();
    const executionRoot = await makeTempProject();
    const canonicalMarkdown = injectFrontMatter("# Latest Plan", {
        planId: "plan-1",
        status: "ready_for_work",
        summary: "latest definition",
    });
    const oldMarkdown = injectFrontMatter("# Old Plan", {
        planId: "plan-1",
        status: "draft",
        summary: "stale definition",
    });
    await fsWriteFile(join(projectRoot, "docs", "plans", "demo.md"), canonicalMarkdown);
    await fsWriteFile(join(executionRoot, "docs", "plans", "demo.md"), oldMarkdown);
    const source = await loadCanonicalExecutionPlanSource(projectRoot, "demo");
    if (source.kind !== "loaded") throw new Error("source did not load");

    const result = await ensureExecutionPlanFile({
        executionCwd: executionRoot,
        planName: "demo",
        canonicalSource: source,
        replaceFromCanonical: true,
    });

    assertEquals(result.kind, "reconciled");
    assertEquals(
        await fsReadFile(join(executionRoot, "docs", "plans", "demo.md"), "utf8"),
        planDocumentMarkdown(canonicalMarkdown),
    );
});
