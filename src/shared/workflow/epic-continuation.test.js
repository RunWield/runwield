import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { loadPlan, updatePlanStatus } from "../../plan-store.js";
import { presentEpicChildPlan, resolveEpicContinuation } from "./epic-continuation.ts";
import { recordPlanEvent } from "./plan-lifecycle.js";

/**
 * @param {string} cwd
 * @param {string} name
 * @param {Record<string, unknown>} attrs
 */
async function writePlan(cwd, name, attrs) {
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
    lines.push("---", "", `# ${name}`, "");
    await Deno.writeTextFile(path, lines.join("\n"));
}

async function makeProject() {
    const cwd = await Deno.makeTempDir();
    await Deno.mkdir(join(cwd, "docs", "plans", "epic"), { recursive: true });
    await writePlan(cwd, "epic", {
        classification: "PROJECT",
        complexity: "HIGH",
        status: "ready_for_work",
        summary: "Parent epic",
        affectedPaths: [],
        createdAt: "2026-01-01T00:00:00.000Z",
    });
    return cwd;
}

Deno.test("resolveEpicContinuation selects the earliest non-terminal child by order", async () => {
    const cwd = await makeProject();
    await writePlan(cwd, "epic/01-done", {
        classification: "FEATURE",
        complexity: "MEDIUM",
        status: "validated",
        summary: "Done",
        affectedPaths: [],
        parentPlan: "epic",
        order: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
    });
    await writePlan(cwd, "epic/03-ready", {
        classification: "FEATURE",
        complexity: "MEDIUM",
        status: "ready_for_work",
        summary: "Ready",
        affectedPaths: [],
        parentPlan: "epic",
        order: 3,
        createdAt: "2026-01-01T00:00:00.000Z",
    });
    await writePlan(cwd, "epic/02-draft", {
        classification: "FEATURE",
        complexity: "MEDIUM",
        status: "draft",
        summary: "Draft",
        affectedPaths: [],
        parentPlan: "epic",
        dependencies: ["01-done"],
        order: 2,
        createdAt: "2026-01-01T00:00:00.000Z",
    });

    const result = await resolveEpicContinuation({ cwd, completedPlanName: "epic/01-done" });
    assertEquals(result.kind, "plan");
    assertEquals(result.childPlanName, "epic/02-draft");
});

Deno.test("resolveEpicContinuation trusts the delivered child document over a stale controller status", async () => {
    const cwd = await makeProject();
    await writePlan(cwd, "epic/01-done", {
        classification: "PLANNED_CHANGE",
        complexity: "MEDIUM",
        status: "ready_for_work",
        summary: "Done",
        affectedPaths: [],
        parentPlan: "epic",
        order: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
    });
    await writePlan(cwd, "epic/02-next", {
        classification: "PLANNED_CHANGE",
        complexity: "MEDIUM",
        status: "draft",
        summary: "Next",
        affectedPaths: [],
        parentPlan: "epic",
        dependencies: ["01-done"],
        order: 2,
        createdAt: "2026-01-01T00:00:00.000Z",
    });
    const completed = await loadPlan(cwd, "epic/01-done");
    if (!completed) throw new Error("Expected completed child Plan.");
    await updatePlanStatus(cwd, "epic/01-done", "ready_for_work", {}, { expectedRevision: completed.revision });
    const path = join(cwd, "docs", "plans", "epic", "01-done.md");
    await Deno.writeTextFile(
        path,
        (await Deno.readTextFile(path)).replace('status: "ready_for_work"', 'status: "validated"'),
    );

    const result = await resolveEpicContinuation({ cwd, completedPlanName: "epic/01-done" });

    assertEquals(result.kind, "plan");
    assertEquals(result.childPlanName, "epic/02-next");
});

Deno.test("a completed sequence reports no remaining children after its final child", async () => {
    const cwd = await makeProject();
    await writePlan(cwd, "epic", {
        classification: "PROJECT",
        type: "sequence",
        complexity: "HIGH",
        status: "ready_for_work",
        summary: "Completed sequence",
        affectedPaths: [],
        createdAt: "2026-01-01T00:00:00.000Z",
    });
    await writePlan(cwd, "epic/01-done", {
        classification: "FEATURE",
        complexity: "MEDIUM",
        status: "reviewed",
        parentPlan: "epic",
        order: 1,
        affectedPaths: [],
        createdAt: "2026-01-01T00:00:00.000Z",
    });
    await recordPlanEvent({
        cwd,
        planName: "epic/01-done",
        event: "validation_passed",
        currentStatus: "reviewed",
        details: {
            executionMode: "worktree",
            deliveryEvidence: {
                version: 1,
                mode: "worktree_merge",
                executionCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                targetBranch: "main",
                targetHeadBeforeMerge: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            },
        },
    });
    assertEquals((await loadPlan(cwd, "epic"))?.attrs.status, "verified");
    const result = await resolveEpicContinuation({ cwd, completedPlanName: "epic/01-done" });
    assertEquals(result.kind, "none");
    assertEquals(result.reason, "parent_epic_not_active");
});

Deno.test("resolveEpicContinuation stops on the first blocked child instead of skipping later work", async () => {
    const cwd = await makeProject();
    await writePlan(cwd, "epic/01-done", {
        classification: "FEATURE",
        complexity: "MEDIUM",
        status: "verified",
        summary: "Done",
        affectedPaths: [],
        parentPlan: "epic",
        order: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
    });
    await writePlan(cwd, "epic/02-hold", {
        classification: "FEATURE",
        complexity: "MEDIUM",
        status: "on_hold",
        summary: "Hold",
        affectedPaths: [],
        parentPlan: "epic",
        order: 2,
        createdAt: "2026-01-01T00:00:00.000Z",
    });
    await writePlan(cwd, "epic/03-ready", {
        classification: "FEATURE",
        complexity: "MEDIUM",
        status: "ready_for_work",
        summary: "Ready",
        affectedPaths: [],
        parentPlan: "epic",
        order: 3,
        createdAt: "2026-01-01T00:00:00.000Z",
    });

    const result = await resolveEpicContinuation({ cwd, completedPlanName: "epic/01-done" });
    assertEquals(result.kind, "blocked");
    assertEquals(result.reason, "child_on_hold");
    assertEquals(result.childPlanName, "epic/02-hold");
});

Deno.test("resolveEpicContinuation requires dependencies to be verified", async () => {
    const cwd = await makeProject();
    await writePlan(cwd, "epic/01-done", {
        classification: "FEATURE",
        complexity: "MEDIUM",
        status: "verified",
        summary: "Done",
        affectedPaths: [],
        parentPlan: "epic",
        order: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
    });
    await writePlan(cwd, "epic/02-next", {
        classification: "FEATURE",
        complexity: "MEDIUM",
        status: "ready_for_work",
        summary: "Next",
        affectedPaths: [],
        parentPlan: "epic",
        dependencies: ["missing-child"],
        order: 2,
        createdAt: "2026-01-01T00:00:00.000Z",
    });

    const result = await resolveEpicContinuation({ cwd, completedPlanName: "epic/01-done" });
    assertEquals(result.kind, "blocked");
    assertEquals(result.reason, "dependency_missing");
});

/**
 * @param {string} cwd
 * @param {string[]} events
 */
function makeFakeHostedSession(cwd, events) {
    return {
        cwd,
        getEventSink: () => (/** @type {any} */ event) => events.push(event),
    };
}

Deno.test("presentEpicChildPlan shows the loading notice and the same details as the manual load flow", async () => {
    const cwd = await makeProject();
    const path = join(cwd, "docs", "plans", "epic", "02-next.md");
    await Deno.writeTextFile(
        path,
        [
            "---",
            `classification: "FEATURE"`,
            `complexity: "MEDIUM"`,
            `status: "ready_for_work"`,
            `parentPlan: "epic"`,
            `order: 2`,
            `createdAt: "2026-01-01T00:00:00.000Z"`,
            "---",
            "",
            "# epic/02-next",
            "",
            "## Context",
            "",
            "Child context text.",
            "",
            "## Objective",
            "",
            "Child objective text.",
            "",
        ].join("\n"),
    );

    /** @type {any[]} */
    const events = [];
    const session = makeFakeHostedSession(cwd, events);
    const plan = await presentEpicChildPlan(/** @type {any} */ (session), "epic/02-next");

    assertEquals(Boolean(plan), true);
    const statuses = events.filter((event) => event.type === "system_status");
    assertEquals(statuses.length, 2);
    assertEquals(statuses[0].header, "RunWield");
    assertStringIncludes(statuses[0].message, "Loading Plan: epic/02-next");
    assertEquals(statuses[1].header, "Plan");
    assertStringIncludes(statuses[1].message, "Classification: PLANNED_CHANGE");
    assertStringIncludes(statuses[1].message, "Summary:        Child context text.");
    assertStringIncludes(statuses[1].message, "Child objective text.");
});

Deno.test("presentEpicChildPlan warns and returns null when the child Plan is missing", async () => {
    const cwd = await makeProject();
    /** @type {any[]} */
    const events = [];
    const session = makeFakeHostedSession(cwd, events);
    const plan = await presentEpicChildPlan(/** @type {any} */ (session), "epic/99-missing");

    assertEquals(plan, null);
    const statuses = events.filter((event) => event.type === "system_status");
    assertEquals(statuses.length, 2);
    assertStringIncludes(statuses[0].message, "Loading Plan: epic/99-missing");
    assertEquals(statuses[1].level, "warning");
    assertStringIncludes(statuses[1].message, "child Plan not found");
});
