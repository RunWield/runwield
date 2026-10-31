import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { parsePlanFrontMatter } from "../../plan-store.js";
import { defineGitFixture, git } from "../git-test-fixture.ts";
import { inspectTargetBranchPlansByParent } from "./planning-worktree.ts";

const smallCount = 2;
const largeCount = 32;

function childName(index: number) {
    return `nested/group/child-${String(index).padStart(2, "0")}`;
}

function childMarkdown(index: number) {
    return [
        "---",
        `planId: child-${index}`,
        `parentPlan: epic-${index % 2}`,
        "classification: FEATURE",
        "status: ready_for_work",
        "createdAt: 2026-01-01T00:00:00.000Z",
        "affectedPaths: [src/世界.ts]",
        "dependencies: [other/child]",
        `order: ${index}`,
        "---",
        `# Child ${index}`,
        "",
        "## Context",
        "",
        `Résumé 世界 🧭 ${index}`,
        "",
        "🧭 café 世界\n".repeat(2048),
    ].join("\n");
}

const fixture = defineGitFixture(async (repo) => {
    await writeFile(join(repo, "README.md"), "base\n");
    for (let index = 0; index < largeCount; index++) {
        const path = join(repo, "docs/plans", `${childName(index)}.md`);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, childMarkdown(index));
        if (index === smallCount - 1 || index === largeCount - 1) {
            await writeFile(join(repo, "docs/plans/standalone.md"), "---\nplanId: standalone\n---\n# Standalone\n");
            await writeFile(join(repo, "docs/plans/ignored.txt"), childMarkdown(100));
            await git(repo, ["add", "."]);
            await git(repo, ["commit", "-m", `catalog with ${index + 1} children`]);
            await git(repo, ["branch", index === smallCount - 1 ? "small" : "large"]);
        }
    }
    await git(repo, ["switch", "small"]);
});

interface GitTraceEvent {
    event: string;
}

async function inspectWithProcessCount(repo: string, branch: string, parent: string) {
    const trace = join(repo, "git-inspection-trace.jsonl");
    const previous = process.env.GIT_TRACE2_EVENT;
    try {
        await writeFile(trace, "");
        process.env.GIT_TRACE2_EVENT = trace;
        const children = await inspectTargetBranchPlansByParent(repo, branch, parent);
        const events: GitTraceEvent[] = (await readFile(trace, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        return { children, processes: events.filter((event) => event.event === "start").length };
    } finally {
        if (previous === undefined) delete process.env.GIT_TRACE2_EVENT;
        else process.env.GIT_TRACE2_EVENT = previous;
        await rm(trace, { force: true });
    }
}

async function projectSnapshot(repo: string) {
    return {
        refs: await git(repo, ["show-ref"]),
        head: await readFile(join(repo, ".git/HEAD"), "utf8"),
        index: await readFile(join(repo, ".git/index")),
        objects: await git(repo, ["cat-file", "--batch-check", "--batch-all-objects"]),
        fetchHead: await readFile(join(repo, ".git/FETCH_HEAD"), "utf8").catch(() => null),
        work: await readFile(join(repo, "README.md"), "utf8"),
    };
}

for (const remote of [false, true]) {
    test(`${remote ? "remote" : "local"} target inspection preserves children and bounds Git work as the catalog grows`, async (t) => {
        await withProcessGlobalTestLock(async () => {
            const repo = await fixture.checkout();
            const origin = `${repo}-origin.git`;
            try {
                if (remote) {
                    await git(repo, ["clone", "--bare", repo, origin]);
                    await git(repo, ["remote", "add", "origin", origin]);
                    // Only the remote has the large catalog; local lookup would lose thirty children.
                    await git(repo, ["branch", "-f", "large", "small"]);
                }
                await writeFile(join(repo, "README.md"), "staged user work\n");
                await git(repo, ["add", "README.md"]);
                await writeFile(join(repo, "README.md"), "unstaged user work\n");
                const before = await projectSnapshot(repo);
                const small = await inspectWithProcessCount(repo, "small", "epic-0.md");
                assertEquals(
                    small.children.map((child) => child.name),
                    [childName(0)],
                );
                for (const parent of [0, 1]) {
                    const large = await inspectWithProcessCount(repo, "origin/large", `epic-${parent}.md`);
                    const ref = remote ? "refs/runwield/target" : "refs/heads/large";
                    const expected = Array.from({ length: largeCount }, (_, index) => index)
                        .filter((index) => index % 2 === parent)
                        .map((index) => ({
                            name: childName(index),
                            path: `${ref}:docs/plans/${childName(index)}.md`,
                            attrs: parsePlanFrontMatter(childMarkdown(index)).attrs,
                        }));
                    assertEquals(large.children, expected);
                    assertEquals(
                        await projectSnapshot(repo),
                        before,
                        "inspection must not change project Git storage or work",
                    );
                    t.diagnostic(
                        `Git processes: ${smallCount} children=${small.processes}, ${largeCount} children=${large.processes}`,
                    );
                    assert(
                        large.processes <= small.processes + 1,
                        `Git work must stay bounded: ${small.processes} processes for ${smallCount} children, ${large.processes} for ${largeCount}`,
                    );
                }
                assertEquals(await inspectTargetBranchPlansByParent(repo, "large", "absent"), []);
                await assertRejects(() => inspectTargetBranchPlansByParent(repo, "missing", "epic-0"), Error);
                assertEquals(await projectSnapshot(repo), before);
            } finally {
                await rm(repo, { recursive: true, force: true });
                await rm(origin, { recursive: true, force: true });
            }
        });
    });
}

test("target inspection rejects a malformed full Unicode document instead of returning an empty catalog", async () => {
    const repo = await fixture.checkout();
    try {
        const path = join(repo, "docs/plans", `${childName(0)}.md`);
        await writeFile(path, `${childMarkdown(0)}\n<<<<<<< unresolved\n`);
        await git(repo, ["add", "."]);
        await git(repo, ["commit", "-m", "malformed child body"]);
        await assertRejects(
            () => inspectTargetBranchPlansByParent(repo, "small", "epic-0"),
            Error,
            "unresolved merge conflict markers",
        );
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});
