import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { loadPlan, updatePlanFrontMatter } from "../../plan-store.js";
import { defineGitFixture, git } from "../git-test-fixture.ts";
import { createWorktreeGitArtifacts, removeWorktreeGitArtifacts, settleWorktreeAttempt } from "../worktree.js";
import { updateEntry } from "../worktree-registry.js";
import { prepareEditedSiblingPlans } from "./epic-sibling-drafts.ts";

type PlanFixtureAttribute = string | number | string[];
type PlanFixtureAttributes = Record<string, PlanFixtureAttribute>;

async function writePlan(cwd: string, name: string, attrs: PlanFixtureAttributes, body: string) {
    const path = join(cwd, "docs", "plans", `${name}.md`);
    await Deno.mkdir(dirname(path), { recursive: true });
    const lines = ["---"];
    for (const [key, value] of Object.entries(attrs)) {
        if (Array.isArray(value)) {
            lines.push(`${key}:`);
            for (const item of value) lines.push(`  - ${JSON.stringify(item)}`);
        } else {
            lines.push(`${key}: ${JSON.stringify(value)}`);
        }
    }
    lines.push("---", "", body);
    await Deno.writeTextFile(path, lines.join("\n"));
}

function childAttrs(order: number, status: string): PlanFixtureAttributes {
    return {
        planId: `plan-child-${order}`,
        classification: "PLANNED_CHANGE",
        complexity: "MEDIUM",
        status,
        parentPlan: "epic",
        order,
        targetBranch: "epic/epic",
        affectedPaths: [],
        createdAt: "2026-01-01T00:00:00.000Z",
    };
}

/** A child worktree as Planner leaves it: the child being planned plus its committed siblings. */
const familyFixture = defineGitFixture(async (repo) => {
    await writePlan(repo, "epic/01-current", childAttrs(1, "ready_for_work"), "# Current\n");
    await writePlan(repo, "epic/02-approved", childAttrs(2, "approved"), "# Approved\n\nOriginal scope.\n");
    await writePlan(repo, "epic/03-draft", childAttrs(3, "draft"), "# Draft\n");
    await writePlan(repo, "epic/04-started", childAttrs(4, "in_progress"), "# Started\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "Epic family"]);
});

const CURRENT_PATH = "docs/plans/epic/01-current.md";

async function withSiblingWorktree(repo: string, run: (path: string) => Promise<void>) {
    const worktree = await settleWorktreeAttempt(
        repo,
        await createWorktreeGitArtifacts({
            projectRoot: repo,
            planName: "epic/02-approved",
            planId: "plan-child-2",
        }),
    );
    await updateEntry(repo, worktree.id, { status: "planning" });
    try {
        await run(worktree.path);
    } finally {
        await removeWorktreeGitArtifacts({ projectRoot: repo, path: worktree.path, force: true });
    }
}

Deno.test("scope moves synchronize an unstarted sibling's registered worktree and survive retry", async () => {
    const repo = await familyFixture.checkout();
    await withSiblingWorktree(repo, async (authority) => {
        const sibling = await loadPlan(repo, "epic/02-approved");
        await Deno.writeTextFile(
            sibling!.path,
            sibling!.markdown.replace("Original scope.", "Use the laptop save bridge."),
        );

        for (let attempt = 0; attempt < 2; attempt++) {
            assertEquals(await prepareEditedSiblingPlans(repo, "epic/01-current", CURRENT_PATH), [
                "docs/plans/epic/02-approved.md",
            ]);
            const local = await loadPlan(repo, "epic/02-approved");
            const remote = await loadPlan(authority, "epic/02-approved");
            assertEquals(local?.attrs.status, "draft");
            assertEquals(remote?.attrs.status, "draft");
            assertEquals(local?.body, remote?.body);
            assertStringIncludes(remote!.body, "Use the laptop save bridge.");
        }
        const synchronized = await loadPlan(authority, "epic/02-approved");
        await updatePlanFrontMatter(authority, "epic/02-approved", { status: "ready_for_work" }, {}, {
            expectedRevision: synchronized!.revision,
        });
        await prepareEditedSiblingPlans(repo, "epic/01-current", CURRENT_PATH);
        assertEquals((await loadPlan(authority, "epic/02-approved"))?.attrs.status, "ready_for_work");
        assertEquals((await loadPlan(repo, "epic/02-approved"))?.attrs.status, "ready_for_work");
        const reapproved = await loadPlan(authority, "epic/02-approved");
        await updatePlanFrontMatter(authority, "epic/02-approved", { status: "in_progress" }, {}, {
            expectedRevision: reapproved!.revision,
        });
        await prepareEditedSiblingPlans(repo, "epic/01-current", CURRENT_PATH);
        assertEquals((await loadPlan(authority, "epic/02-approved"))?.attrs.status, "in_progress");
        assertEquals((await loadPlan(repo, "epic/02-approved"))?.attrs.status, "in_progress");
    });
});

Deno.test("independent sibling edits merge without losing either planning session's work", async () => {
    const repo = await familyFixture.checkout();
    const sibling = await loadPlan(repo, "epic/02-approved");
    const body = "# Original title\n\nContext.\n\nOriginal scope.\n\nVerification.\n";
    await Deno.writeTextFile(sibling!.path, sibling!.markdown.replace(sibling!.body, body));
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "Detailed sibling"]);
    await withSiblingWorktree(repo, async (authority) => {
        const local = await loadPlan(repo, "epic/02-approved");
        const remote = await loadPlan(authority, "epic/02-approved");
        await Deno.writeTextFile(
            local!.path,
            local!.markdown.replace("Original scope.", "Use the laptop save bridge."),
        );
        await Deno.writeTextFile(remote!.path, remote!.markdown.replace("Original title", "Revised title"));

        await prepareEditedSiblingPlans(repo, "epic/01-current", CURRENT_PATH);

        const merged = await loadPlan(authority, "epic/02-approved");
        assertStringIncludes(merged!.body, "Revised title");
        assertStringIncludes(merged!.body, "Use the laptop save bridge.");
        assertEquals((await loadPlan(repo, "epic/02-approved"))?.body, merged?.body);
    });
});

Deno.test("conflicting sibling scope is preserved in both worktrees", async () => {
    const repo = await familyFixture.checkout();
    await withSiblingWorktree(repo, async (authority) => {
        const local = await loadPlan(repo, "epic/02-approved");
        const remote = await loadPlan(authority, "epic/02-approved");
        const localText = local!.markdown.replace("Original scope.", "Use the laptop save bridge.");
        const remoteText = remote!.markdown.replace("Original scope.", "Use a different persistence design.");
        await Deno.writeTextFile(local!.path, localText);
        await Deno.writeTextFile(remote!.path, remoteText);

        await assertRejects(
            () => prepareEditedSiblingPlans(repo, "epic/01-current", CURRENT_PATH),
            Error,
            "conflicting scope changes",
        );
        assertEquals(await Deno.readTextFile(local!.path), localText);
        assertEquals(await Deno.readTextFile(remote!.path), remoteText);
    });
});

Deno.test("a sibling started in its authoritative worktree cannot be reshaped from a stale draft", async () => {
    const repo = await familyFixture.checkout();
    await withSiblingWorktree(repo, async (authority) => {
        const remote = await loadPlan(authority, "epic/02-approved");
        await updatePlanFrontMatter(authority, "epic/02-approved", { status: "in_progress" }, {}, {
            expectedRevision: remote!.revision,
        });
        const local = await loadPlan(repo, "epic/02-approved");
        await Deno.writeTextFile(local!.path, `${local!.markdown}\nMoved scope.\n`);
        await assertRejects(
            () => prepareEditedSiblingPlans(repo, "epic/01-current", CURRENT_PATH),
            Error,
            "has already started",
        );
        assertEquals((await loadPlan(authority, "epic/02-approved"))?.body, remote?.body);
    });
});

Deno.test("metadata-only normalization of a started sibling does not block preparation", async () => {
    const repo = await familyFixture.checkout();
    const sibling = await loadPlan(repo, "epic/04-started");
    await Deno.writeTextFile(
        sibling!.path,
        sibling!.markdown.replace('classification: "PLANNED_CHANGE"', 'classification: "FEATURE"'),
    );
    assertEquals(await prepareEditedSiblingPlans(repo, "epic/01-current", CURRENT_PATH), [
        "docs/plans/epic/04-started.md",
    ]);
    assertEquals((await loadPlan(repo, "epic/04-started"))?.attrs.status, "in_progress");
});

Deno.test("an approved sibling whose scope moved goes back to draft and travels with the child", async () => {
    const repo = await familyFixture.checkout();
    const approved = await loadPlan(repo, "epic/02-approved");
    await Deno.writeTextFile(
        approved!.path,
        approved!.markdown.replace("Original scope.", "Original scope, plus the parser split out of child 1."),
    );

    const paths = await prepareEditedSiblingPlans(repo, "epic/01-current", CURRENT_PATH);

    assertEquals(paths, ["docs/plans/epic/02-approved.md"]);
    assertEquals((await loadPlan(repo, "epic/02-approved"))?.attrs.status, "draft");
});

Deno.test("an edited draft sibling and a new split-out draft travel with the child unchanged in status", async () => {
    const repo = await familyFixture.checkout();
    const draft = await loadPlan(repo, "epic/03-draft");
    await Deno.writeTextFile(draft!.path, `${draft!.markdown}\nMoved here from child 1.\n`);
    await writePlan(repo, "epic/05-split", childAttrs(5, "draft"), "# Split out of child 1\n");

    const paths = await prepareEditedSiblingPlans(repo, "epic/01-current", CURRENT_PATH);

    assertEquals(paths.sort(), ["docs/plans/epic/03-draft.md", "docs/plans/epic/05-split.md"]);
    assertEquals((await loadPlan(repo, "epic/03-draft"))?.attrs.status, "draft");
});

Deno.test("a started sibling stays as it is", async () => {
    const repo = await familyFixture.checkout();
    const started = await loadPlan(repo, "epic/04-started");
    await Deno.writeTextFile(started!.path, `${started!.markdown}\nMore scope.\n`);

    const error = await assertRejects(() => prepareEditedSiblingPlans(repo, "epic/01-current", CURRENT_PATH));

    assertStringIncludes(String(error), "epic/04-started has already started (in_progress)");
});

Deno.test("a child with no sibling edits carries nothing extra", async () => {
    const repo = await familyFixture.checkout();
    await Deno.writeTextFile(join(repo, CURRENT_PATH), "---\nstatus: ready_for_work\n---\n# Edited current\n");

    assertEquals(await prepareEditedSiblingPlans(repo, "epic/01-current", CURRENT_PATH), []);
});
