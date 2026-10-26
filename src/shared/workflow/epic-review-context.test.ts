import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { dirname, join } from "node:path";
import { loadPlan, savePlan } from "../../plan-store.js";
import { defineGitFixture, git } from "../git-test-fixture.ts";
import {
    loadEpicReviewContext,
    recordIntegrationNotes,
    withIntegrationNotes,
    syncEpicChildPlanDeviations,
} from "./epic-review-context.ts";

type PlanFixtureAttribute = string | number | string[];
type PlanFixtureAttributes = Record<string, PlanFixtureAttribute>;

async function writePlan(cwd: string, name: string, attrs: PlanFixtureAttributes, body: string) {
    const path = join(cwd, "docs", "plans", `${name}.md`);
    await fsMkdir(dirname(path), { recursive: true });
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
    await fsWriteFile(path, lines.join("\n"));
}

const EPIC_BODY = [
    "# Epic",
    "",
    "## Objective",
    "",
    "Ship search across Plans.",
    "",
    "## Verification Plan",
    "",
    "- Search finds a Plan by title.",
    "",
    "## Edge Cases",
    "",
    "- Empty query.",
    "",
].join("\n");

const repoFixture = defineGitFixture(async (repo) => {
    await fsWriteFile(join(repo, "README.md"), "# Fixture\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "primary"]);
});

test("Integration Notes go in a managed subsection at the end of the Verification Plan", () => {
    const next = withIntegrationNotes(EPIC_BODY, "epic/01-index", [{ check: "Search reads the new index", where: "" }]);

    const notesAt = next.indexOf("### Integration Notes");
    assert(notesAt > next.indexOf("- Search finds a Plan by title."));
    assert(notesAt < next.indexOf("## Edge Cases"));
    assertStringIncludes(next, "**epic/01-index**\n\n- Search reads the new index");
    // The user's own text is untouched.
    assertStringIncludes(next, "## Objective\n\nShip search across Plans.");
    assertStringIncludes(next, "## Edge Cases\n\n- Empty query.");
});

test("a child's notes replace its earlier notes and other children's notes stay", () => {
    const first = withIntegrationNotes(EPIC_BODY, "epic/01-index", [{ check: "Old note", where: "" }]);
    const second = withIntegrationNotes(first, "epic/02-query", [{ check: "Query uses the index", where: "query.ts" }]);
    const third = withIntegrationNotes(second, "epic/01-index", [{ check: "New note", where: "index.ts" }]);

    assertEquals(third.includes("Old note"), false);
    assertStringIncludes(third, "- New note (index.ts)");
    assertStringIncludes(third, "- Query uses the index (query.ts)");
    assertEquals(third.split("### Integration Notes").length, 2);
    assert(third.indexOf("### Integration Notes") < third.indexOf("## Edge Cases"));
});

test("an Epic child is reviewed with its Epic context; a standalone Plan is not", async () => {
    const repo = await repoFixture.checkout();
    await writePlan(
        repo,
        "epic",
        {
            planId: "plan-epic",
            classification: "PROJECT",
            complexity: "HIGH",
            status: "ready_for_work",
            targetBranch: "epic/epic",
            affectedPaths: [],
            createdAt: "2026-01-01T00:00:00.000Z",
        },
        EPIC_BODY,
    );
    const child = {
        planId: "plan-child-1",
        classification: "PLANNED_CHANGE",
        complexity: "MEDIUM",
        status: "ready_for_work",
        parentPlan: "epic",
        order: 1,
        summary: "Build the index",
        targetBranch: "epic/epic",
        affectedPaths: [],
        createdAt: "2026-01-01T00:00:00.000Z",
    };
    await writePlan(repo, "epic/01-index", child, "# Index\n");
    await writePlan(
        repo,
        "epic/02-query",
        { ...child, planId: "plan-child-2", order: 2, summary: "Query it" },
        "# Q\n",
    );

    const context = await loadEpicReviewContext(repo, "epic/01-index", {
        parentPlan: "epic",
        status: "ready_for_work",
    });
    const standalone = await loadEpicReviewContext(repo, "solo", { classification: "PLANNED_CHANGE" });

    assertEquals(context?.epicPlanName, "epic");
    assertStringIncludes(context?.section || "", "### Epic Context");
    assertStringIncludes(context?.section || "", "Ship search across Plans.");
    assertStringIncludes(context?.section || "", "- epic/01-index (ready_for_work): Build the index ← this Plan");
    assertStringIncludes(context?.section || "", "- epic/02-query (ready_for_work): Query it");
    assertEquals(standalone, null);
});

test("recording notes writes the Epic's managed section; nothing to note writes nothing", async () => {
    const repo = await repoFixture.checkout();
    await writePlan(
        repo,
        "epic",
        {
            planId: "plan-epic",
            classification: "PROJECT",
            complexity: "HIGH",
            status: "ready_for_work",
            targetBranch: "epic/epic",
            affectedPaths: [],
            createdAt: "2026-01-01T00:00:00.000Z",
        },
        EPIC_BODY,
    );
    const before = (await loadPlan(repo, "epic"))?.markdown;

    assertEquals(await recordIntegrationNotes(repo, "epic", "epic/01-index", []), null);
    assertEquals((await loadPlan(repo, "epic"))?.markdown, before);

    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "Epic requirements"]);
    const executionRoot = `${repo}-execution`;
    await git(repo, ["worktree", "add", "-b", "worktree/notes", executionRoot]);
    const written = await recordIntegrationNotes(executionRoot, "epic", "epic/01-index", [
        {
            check: "Index is read",
            where: "",
        },
    ]);

    assertEquals(written, "docs/plans/epic.md");
    assertEquals((await loadPlan(repo, "epic"))?.markdown, before);
    const epic = await loadPlan(executionRoot, "epic");
    assertStringIncludes(epic?.markdown || "", "### Integration Notes");
    assertStringIncludes(epic?.markdown || "", "- Index is read");
    assertEquals(epic?.attrs.status, "ready_for_work");
    await git(repo, ["worktree", "remove", "--force", executionRoot]);
});

const DEVIATION = {
    id: "approved-change",
    supersededRequirement: "Ship search across Plans.",
    replacementRequirement: "Ship title search only.",
    reason: "The user narrowed search.",
    approvedAt: "2026-10-24T00:00:00.000Z",
};

test("Epic projections preserve sibling blocks and repair a missing block without rewriting matching content", async () => {
    const repo = await repoFixture.checkout();
    await savePlan(repo, "epic", EPIC_BODY, { classification: "PROJECT", status: "ready_for_work" });
    const original = (await loadPlan(repo, "epic"))!;
    for (const name of ["epic/a", "epic/b"]) {
        await savePlan(repo, name, "# Child", {
            classification: "PLANNED_CHANGE",
            parentPlan: "epic",
            planDeviations: [DEVIATION],
        });
        assertEquals(await syncEpicChildPlanDeviations(repo, name), "docs/plans/epic.md");
    }
    const both = (await loadPlan(repo, "epic"))!;
    assertEquals(both.attrs, original.attrs);
    assertStringIncludes(both.body, "## Objective\n\nShip search across Plans.");
    assert(both.body.indexOf("### Child Plan Deviations") < both.body.indexOf("## Verification Plan"));
    assertStringIncludes(both.body, "Approved at: 2026-10-24T00:00:00.000Z");
    assertEquals(await syncEpicChildPlanDeviations(repo, "epic/a"), null);
    assertEquals((await loadPlan(repo, "epic"))?.revision, both.revision);
    const aBlock = both.markdown.slice(
        both.markdown.indexOf('<!-- runwield:child-plan-deviations:start child="epic/a"'),
        both.markdown.indexOf('<!-- runwield:child-plan-deviations:end child="epic/a"') +
            '<!-- runwield:child-plan-deviations:end child="epic/a" -->'.length,
    );
    const b = (await loadPlan(repo, "epic/b"))!;
    await savePlan(
        repo,
        "epic/b",
        b.markdown,
        {
            planDeviations: [
                DEVIATION,
                { ...DEVIATION, id: "second", replacementRequirement: "Title and tag search." },
            ],
        },
        { expectedRevision: b.revision },
    );
    await syncEpicChildPlanDeviations(repo, "epic/b");
    const updated = (await loadPlan(repo, "epic"))!;
    assertStringIncludes(updated.markdown, aBlock);
    assertStringIncludes(updated.markdown, "2. Superseded requirement");
    await fsWriteFile(updated.path, updated.markdown.replace(aBlock, ""));
    assertEquals(await syncEpicChildPlanDeviations(repo, "epic/a"), "docs/plans/epic.md");
    assertStringIncludes((await loadPlan(repo, "epic"))!.markdown, aBlock);
});

for (const heading of ["## Deferred work", "### Deferred work"]) {
    test(`child deviation blocks stay separate when a requirement contains ${heading}`, async () => {
        const repo = await repoFixture.checkout();
        await savePlan(repo, "epic", EPIC_BODY, { classification: "PROJECT" });
        const replacementRequirement = `Keep title search.\n\n${heading}\n\nOmit full-text search.`;
        await savePlan(repo, "epic/a", "# Child A", {
            parentPlan: "epic",
            planDeviations: [{ ...DEVIATION, replacementRequirement }],
        });
        await syncEpicChildPlanDeviations(repo, "epic/a");
        await savePlan(repo, "epic/b", "# Child B", { parentPlan: "epic", planDeviations: [DEVIATION] });
        await syncEpicChildPlanDeviations(repo, "epic/b");
        const both = (await loadPlan(repo, "epic"))!;
        assert(
            both.body.indexOf('<!-- runwield:child-plan-deviations:end child="epic/a" -->') <
                both.body.indexOf('<!-- runwield:child-plan-deviations:start child="epic/b" -->'),
        );
        assert(both.body.indexOf("**epic/b**") < both.body.indexOf("## Verification Plan"));
        const child = (await loadPlan(repo, "epic/a"))!;
        const updatedRequirement = `${replacementRequirement}\n\nKeep the existing index.`;
        await savePlan(
            repo,
            "epic/a",
            child.markdown,
            { planDeviations: [{ ...DEVIATION, replacementRequirement: updatedRequirement }] },
            { expectedRevision: child.revision },
        );
        await syncEpicChildPlanDeviations(repo, "epic/a");
        assertEquals(
            (await loadPlan(repo, "epic"))!.body,
            both.body.replace(replacementRequirement, updatedRequirement),
        );
    });
}

for (const parent of ["missing", "standalone", "ordinary", "sequence"]) {
    test(`Epic sync writes nothing for ${parent}`, async () => {
        const repo = await repoFixture.checkout();
        if (parent !== "missing")
            await savePlan(repo, "parent", EPIC_BODY, {
                classification: parent === "ordinary" ? "PLANNED_CHANGE" : "PROJECT",
                ...(parent === "sequence" ? { type: "sequence" } : {}),
            });
        await savePlan(repo, "child", "# Child", {
            classification: "PLANNED_CHANGE",
            ...(parent !== "standalone" ? { parentPlan: "parent" } : {}),
            planDeviations: [DEVIATION],
        });
        const before = await loadPlan(repo, "parent");
        assertEquals(await syncEpicChildPlanDeviations(repo, "child"), null);
        assertEquals((await loadPlan(repo, "parent"))?.markdown, before?.markdown);
    });
}

test("removing a child's deviations removes only its managed block", async () => {
    const repo = await repoFixture.checkout();
    await savePlan(repo, "epic", EPIC_BODY, { classification: "PROJECT" });
    await savePlan(repo, "child", "# Child", { parentPlan: "epic", planDeviations: [DEVIATION] });
    await syncEpicChildPlanDeviations(repo, "child");
    const child = (await loadPlan(repo, "child"))!;
    await savePlan(repo, "child", child.markdown, { planDeviations: [] }, { expectedRevision: child.revision });
    await syncEpicChildPlanDeviations(repo, "child");
    const epic = (await loadPlan(repo, "epic"))!;
    assertStringIncludes(epic.body, "### Child Plan Deviations");
    assertEquals(epic.body.includes("**child**"), false);
    assertStringIncludes(epic.body, "Ship search across Plans.");
});

test("Integration Notes append when Verification Plan is absent and keep an existing subsection", () => {
    const first = withIntegrationNotes("# Epic\n", "a", [{ check: "One", where: "" }]);
    const second = withIntegrationNotes(first, "b", [{ check: "Two", where: "" }]);
    assertStringIncludes(first, "# Epic\n\n### Integration Notes");
    assertStringIncludes(second, "**a**\n\n- One");
    assertStringIncludes(second, "**b**\n\n- Two");
    assertEquals(second.split("### Integration Notes").length, 2);
});
