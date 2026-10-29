import { test } from "node:test";
import { deepStrictEqual as equal, ok as assert } from "node:assert/strict";
import { coreResult, toolObservation } from "./evidence.ts";
import {
    assessHandshake,
    assessHostReview,
    assessExecution,
    assessCi,
    hostedReview,
    type CollectedEvidence,
} from "./collector.ts";

const result = {
    ok: true,
    workflow: {
        workflowId: "workflow-1",
        revision: 3,
        nextAction: { kind: "validation", actionId: "review-1", request: { kind: "reviewer" } },
    },
};
test("only a completed native MCP result supplies evidence; assistant lookalikes and unrelated servers do not", () => {
    const item = {
        type: "mcp_tool_call",
        server: "runwield",
        tool: "status",
        id: "call-1",
        result: { structuredContent: result },
    };
    equal(toolObservation("run-1", "parent", item), {
        run: "run-1",
        kind: "tool",
        threadId: "parent",
        toolId: "call-1",
        operation: "status",
        accepted: true,
        workflowId: "workflow-1",
        revision: 3,
        actionId: "review-1",
        actionKind: "validation",
        requestKind: "reviewer",
    });
    equal(toolObservation("run-1", "parent", { ...item, type: "agent_message", text: JSON.stringify(item) }), null);
    equal(toolObservation("run-1", "parent", { ...item, server: "other" }), null);
    equal(
        toolObservation("run-1", "parent", {
            ...item,
            result: { content: [{ type: "text", text: "I completed validation" }] },
        }),
        null,
    );
});
test("observation strips prompt, transcript, token, and tool input values", () => {
    const sentinel = "DO-NOT-PERSIST";
    const observation = toolObservation("run-1", "parent", {
        type: "mcpToolCall",
        server: "runwield",
        tool: "status",
        id: "call-1",
        arguments: { token: sentinel },
        result: { structuredContent: { ...result, transcript: sentinel, instructions: { text: sentinel } } },
    });
    assert(!JSON.stringify(observation).includes(sentinel));
    equal(coreResult({ content: [{ type: "text", text: JSON.stringify(result) }] }), result);
});
function evidence(): CollectedEvidence {
    return { clients: [{ name: "codex-mcp-client", version: "0.164.0-alpha.11.1" }], errors: [], observations: [] };
}
test("missing or inconsistent wire versions cannot pass native handshake qualification", () => {
    equal(assessHandshake(evidence(), "0.164.0-alpha.11.1").outcome, "pass");
    equal(assessHandshake({ ...evidence(), clients: [] }, "0.164.0-alpha.11.1").outcome, "fail");
    equal(
        assessHandshake(
            { ...evidence(), clients: [{ name: "claude-code", version: "0.164.0-alpha.11.1" }] },
            "0.164.0-alpha.11.1",
        ).outcome,
        "fail",
    );
    equal(assessHandshake(evidence(), "0.164.1").outcome, "fail");
});
test("parent diff reads cannot satisfy independent review, and duplicate IDs fail closed", () => {
    const item = {
        run: "run-1",
        kind: "tool" as const,
        threadId: "parent",
        toolId: "complete",
        operation: "review_complete",
        accepted: true,
        workflowId: "wf",
        actionId: "action",
        submittedActionId: "action",
    };
    const e = evidence();
    e.observations = [
        item,
        { ...item, toolId: "read", operation: "review_diff" },
        { ...item, toolId: "instructions", operation: "get_instructions" },
    ];
    equal(assessHostReview(e).outcome, "fail");
    e.observations.push({ ...item, toolId: "read" });
    assert(assessHostReview(e).detail.includes("Duplicate"));
});
test("another action's worker reads cannot qualify current review", () => {
    const common = { run: "run-1", kind: "tool" as const, accepted: true, workflowId: "wf", actionId: "a" };
    const e = evidence();
    e.observations = [
        { ...common, threadId: "parent", toolId: "complete", operation: "review_complete", submittedActionId: "a" },
        { run: "run-1", kind: "worker", threadId: "parent", workerIds: ["child"], freshContext: true },
        { ...common, threadId: "child", toolId: "read", operation: "review_diff", actionId: "stale" },
        { ...common, threadId: "child", toolId: "instructions", operation: "get_instructions", actionId: "stale" },
    ];
    equal(assessHostReview(e).outcome, "fail");
});
test("direct child reads alone do not invent fresh-context or full-byte receipts", () => {
    const common = { run: "run-1", kind: "tool" as const, accepted: true, workflowId: "wf", actionId: "a" };
    const e = evidence();
    e.observations = [
        { ...common, threadId: "parent", toolId: "complete", operation: "review_complete", submittedActionId: "a" },
        { run: "run-1", kind: "worker", threadId: "parent", workerIds: ["child"], freshContext: true },
        { ...common, threadId: "child", toolId: "read", operation: "review_diff" },
        { ...common, threadId: "child", toolId: "instructions", operation: "get_instructions" },
    ];
    equal(assessHostReview(e).outcome, "unproven");
});
function reviewedEvidence(): CollectedEvidence {
    const common = { run: "run", kind: "tool" as const, accepted: true, workflowId: "wf", actionId: "review" };
    return {
        ...evidence(),
        observations: [
            {
                ...common,
                threadId: "parent",
                toolId: "complete",
                operation: "review_complete",
                actionId: "next",
                submittedActionId: "review",
            },
            { run: "run", kind: "worker", threadId: "parent", workerIds: ["child"], freshContext: true },
            { ...common, threadId: "child", toolId: "instructions", operation: "get_instructions" },
            {
                ...common,
                threadId: "child",
                toolId: "list",
                operation: "review_diff",
                requiredScope: "full",
                diffScope: "full",
                diffFileCount: 1,
            },
            {
                ...common,
                threadId: "child",
                toolId: "page",
                operation: "review_diff",
                requiredScope: "full",
                diffRead: { scope: "full", path: "greet.sh", start: 0, end: 100, totalBytes: 100 },
            },
        ],
    };
}
test("fresh native worker identity and complete returned bytes qualify the submitted action", () => {
    equal(assessHostReview(reviewedEvidence()).outcome, "pass");
    for (const mutation of [
        (e: CollectedEvidence) => {
            e.observations[1].freshContext = false;
        },
        (e: CollectedEvidence) => {
            e.observations[3].diffFileCount = 2;
        },
        (e: CollectedEvidence) => {
            e.observations[4].diffRead!.start = 5;
        },
        (e: CollectedEvidence) => {
            e.observations[4].diffRead!.end = 99;
        },
        (e: CollectedEvidence) => {
            e.observations[4].actionId = "stale";
        },
        (e: CollectedEvidence) => {
            e.observations.push({ ...e.observations[2], toolId: "old", actionId: "earlier" });
        },
    ]) {
        const e = reviewedEvidence();
        mutation(e);
        equal(assessHostReview(e).outcome, "fail");
    }
});
test("read identities and submitted review actions survive next-action transitions", () => {
    const base = { type: "mcpToolCall", server: "runwield", id: "call" };
    const read = toolObservation("run", "worker", {
        ...base,
        tool: "get_instructions",
        result: { structuredContent: { ok: true, workflowId: "wf", actionId: "review", revision: 4 } },
    });
    equal(read?.actionId, "review");
    equal(read?.workflowId, "wf");
    const complete = toolObservation("run", "parent", {
        ...base,
        tool: "review_complete",
        arguments: { payload: { actionId: "review", instructions: "DO-NOT-PERSIST" } },
        result: { structuredContent: result },
    });
    equal(complete?.submittedActionId, "review");
    equal(complete?.actionId, "review-1");
    assert(!JSON.stringify(complete).includes("DO-NOT-PERSIST"));
});
test("inspect-only review state does not prove the browser listener has been restored", () => {
    const state = { ok: true, workflow: { nextAction: { kind: "review" } } };
    equal(hostedReview(state, "review"), false);
    equal(hostedReview({ ...state, review: { url: "http://127.0.0.1/review?token=fixture" } }, "review"), true);
    equal(hostedReview({ ...state, review: { url: "http://127.0.0.1/review?token=fixture" } }, "code_review"), false);
});
test("durable evidence rejects original-checkout edits and altered validation commands", () => {
    const before = { files: [{ path: "fixture/check.sh", sha256: "baseline" }] };
    const implemented = {
        files: [
            {
                path: "runwield-home/workflows/wf.json",
                text: JSON.stringify({
                    execution: {
                        executionMode: "worktree",
                        executionCwd: "/world/runwield-home/.wld/worktrees/fixture",
                    },
                }),
            },
            { path: "runwield-home/.wld/worktrees/fixture/greet.sh" },
            { path: "runwield-home/.wld/worktrees/fixture/check.sh", sha256: "baseline" },
        ],
    };
    equal(assessExecution(before, implemented).outcome, "pass");
    equal(assessExecution(before, { files: [...implemented.files, { path: "fixture/greet.sh" }] }).outcome, "fail");
    implemented.files[2].sha256 = "tampered";
    equal(assessExecution(before, implemented).outcome, "fail");
});
test("slow-check evidence rejects duplicate execution and surviving interrupted checks", () => {
    const killed = { ciRuns: ["cancelled"] };
    const final = { ciRuns: ["cancelled", "restored", "repaired"], ciFinished: ["restored", "repaired"] };
    equal(assessCi(killed, final).outcome, "pass");
    equal(assessCi(killed, { ...final, ciRuns: [...final.ciRuns, "duplicate"] }).outcome, "fail");
    equal(assessCi(killed, { ...final, ciFinished: ["cancelled", "restored", "repaired"] }).outcome, "fail");
});
