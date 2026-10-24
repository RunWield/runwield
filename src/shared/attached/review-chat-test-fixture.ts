import { ok as assert } from "node:assert/strict";
import { assertEquals } from "../../testing/assertions.ts";
import { EVIDENCE, runOperation } from "./attached-test-fixture.ts";
import type { AttachedJsonObject, AttachedWorkflowView } from "./operations.ts";
import type { ReviewConversation } from "../../ui/review/review-launcher.ts";

export interface BrowserConversation extends ReviewConversation {
    reviewRevision: number;
    plan: string;
    rawPatch: string;
}

export function reviewApi(page: string, path: string): URL {
    const url = new URL(page);
    return new URL(`/api/review/${path}${url.search}`, url);
}

export async function sendChat(page: string, message: string, revision = 0) {
    const response = await fetch(reviewApi(page, "deny"), {
        method: "POST",
        body: JSON.stringify({
            conversationTurn: true,
            feedback: message,
            annotations: [{ file: "implementation.ts", line: 1, text: "Selected value" }],
            reviewRevision: revision,
        }),
    });
    assertEquals(response.status, 200, await response.text());
}

export async function conversation(page: string): Promise<BrowserConversation> {
    const response = await fetch(reviewApi(page, "conversation"));
    assertEquals(response.status, 200);
    return await response.json();
}

export async function status(root: string, workflowId: string) {
    const result = await runOperation("status", root, { workflowId });
    assert(result.ok, JSON.stringify(result));
    return result.workflow;
}

export async function reply(
    root: string,
    workflow: AttachedWorkflowView,
    payload: AttachedJsonObject,
    operationId: string = crypto.randomUUID(),
) {
    return await runOperation("review_reply", root, {
        workflowId: workflow.workflowId,
        expectedRevision: workflow.revision,
        operationId,
        evidence: EVIDENCE,
        payload,
    });
}

export function pendingChat(workflow: AttachedWorkflowView) {
    const action = workflow.nextAction;
    assert((action.kind === "review" || action.kind === "code_review") && action.chat, JSON.stringify(workflow));
    return action.chat;
}
