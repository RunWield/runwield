import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { dirname, join } from "node:path";
import { loadPlan } from "../../plan-store.js";
import { defineGitFixture, git } from "../git-test-fixture.ts";
import { loadEpicReviewContext, recordIntegrationNotes, withIntegrationNotes } from "./epic-review-context.ts";

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
    await writePlan(repo, "epic", {
        planId: "plan-epic",
        classification: "PROJECT",
        complexity: "HIGH",
        status: "ready_for_work",
        targetBranch: "epic/epic",
        affectedPaths: [],
        createdAt: "2026-01-01T00:00:00.000Z",
    }, EPIC_BODY);
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
    await writePlan(repo, "epic", {
        planId: "plan-epic",
        classification: "PROJECT",
        complexity: "HIGH",
        status: "ready_for_work",
        targetBranch: "epic/epic",
        affectedPaths: [],
        createdAt: "2026-01-01T00:00:00.000Z",
    }, EPIC_BODY);
    const before = (await loadPlan(repo, "epic"))?.markdown;

    assertEquals(await recordIntegrationNotes(repo, "epic", "epic/01-index", []), null);
    assertEquals((await loadPlan(repo, "epic"))?.markdown, before);

    const written = await recordIntegrationNotes(repo, "epic", "epic/01-index", [{
        check: "Index is read",
        where: "",
    }]);

    assertEquals(written, "docs/plans/epic.md");
    const epic = await loadPlan(repo, "epic");
    assertStringIncludes(epic?.markdown || "", "### Integration Notes");
    assertStringIncludes(epic?.markdown || "", "- Index is read");
    assertEquals(epic?.attrs.status, "ready_for_work");
});
