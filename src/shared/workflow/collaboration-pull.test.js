import { assert, assertEquals } from "@std/assert";
import {
    buildPullRevisionRequest,
    formatPullCommentsForPrompt,
    selectPullPlanningAgent,
    summarizePullPlanningOutcome,
} from "./collaboration-pull.ts";

Deno.test("selectPullPlanningAgent routes PROJECT Plans to Architect and FEATURE Plans to Planner", () => {
    assertEquals(selectPullPlanningAgent({ classification: "PROJECT" }), "architect");
    assertEquals(selectPullPlanningAgent({ type: "epic" }), "planner");
    assertEquals(selectPullPlanningAgent({ classification: "FEATURE" }), "planner");
});

Deno.test("formatPullCommentsForPrompt preserves global, inline, resolved, and unreadable comment context", () => {
    const prompt = formatPullCommentsForPrompt([
        {
            id: "c1",
            createdAt: "now",
            resolved: false,
            readable: true,
            type: "global_comment",
            displayName: "Alice",
            body: "Clarify scope.",
        },
        {
            id: "c2",
            createdAt: "later",
            resolved: true,
            readable: true,
            type: "comment",
            displayName: "Bob",
            body: "Inline note.",
            originalText: "selected text",
            anchor: { blockId: "b1", startOffset: 1, endOffset: 4 },
        },
        { id: "c3", createdAt: "bad", resolved: false, readable: false, error: "tampered" },
    ]);

    assert(prompt.includes("c1") && prompt.includes("global"));
    assert(prompt.includes("selected text") && prompt.includes("blockId"));
    assert(prompt.includes("unreadable") && prompt.includes("tampered"));
});

Deno.test("buildPullRevisionRequest includes structured metadata and redacts secret-looking URL fragments", () => {
    const request = buildPullRevisionRequest({
        planName: "demo",
        title: "Demo Plan",
        attrs: {
            classification: "FEATURE",
            summary: "Demo summary",
            status: "draft",
            affectedPaths: ["src/demo.js", "src/demo.test.js"],
        },
        remote: {
            serverUrl:
                "https://plans.example/p/s#key=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&cap=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb&role=maintainer",
            spaceId: "s",
            revision: 2,
        },
        comments: [{
            id: "c1",
            createdAt: "now",
            resolved: false,
            readable: true,
            type: "global_comment",
            displayName: "Alice",
            body: "Feedback",
        }],
    });

    assert(request.includes("Title: Demo Plan"));
    assert(request.includes("Summary: Demo summary"));
    assert(request.includes("Status: draft"));
    assert(request.includes("Classification: PLANNED_CHANGE"));
    assert(!request.includes("Classification: FEATURE"));
    assert(request.includes("Affected paths: src/demo.js, src/demo.test.js"));
    assert(request.includes("Pulled revision: 2"));
    assert(request.includes("Feedback"));
    assert(!request.includes("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
    assert(!request.includes("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
    assert(request.includes("wld plans push <plan>"));
});

Deno.test("summarizePullPlanningOutcome points maintainers to push instead of execution", () => {
    assertEquals(
        summarizePullPlanningOutcome({ outcome: "saved" }, "demo"),
        'Planning agent finished with outcome "saved". Review the local revision, then publish with: wld plans push demo',
    );
});
