import { strictEqual } from "node:assert/strict";
import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import {
    appendSessionCompleteGuidance,
    requestRecoverablePlanReview,
    SESSION_COMPLETE_GUIDANCE,
} from "./plan-review-recovery.ts";

test("Plan Review returns substantive answers intact without prompting for recovery", async () => {
    for (const response of [
        { _meta: { approved: true } },
        { approved: false, remoteReview: true },
        { approved: false, feedback: "change it" },
        { approved: false, images: [{ base64: "a", mimeType: "image/png" }] },
        { approved: false, annotations: [{ text: "revise" }] },
        { approved: false, globalAttachments: [{ path: "reference.png" }] },
    ]) {
        const result = await requestRecoverablePlanReview({
            requestReview: () => Promise.resolve(response),
            requestRetry: () => {
                throw new Error("A substantive answer must not open a recovery prompt");
            },
        });
        assertEquals(result, { kind: "answered", response });
    }
});

test("Plan Review recovers unanswered results instead of treating cancellation text as feedback", async () => {
    for (const response of [
        { outcome: "canceled" },
        { outcome: "blocked", feedback: "blocked" },
        { outcome: "unsupported", feedback: "unsupported" },
        { canceled: true, feedback: "Cancelled by user (Esc)" },
        { exit: true, feedback: "Exited" },
        { approved: false, feedback: "" },
    ]) {
        const approved = { _meta: { approved: true, approvalAction: "later" } };
        const reviews = [response, approved];
        const result = await requestRecoverablePlanReview({
            requestReview: () => Promise.resolve(reviews.shift()),
            requestRetry: () => Promise.resolve({ outcome: "accepted", value: true }),
        });
        assertEquals(result, { kind: "answered", response: approved });
    }
});

test("Plan Review recovery retries after unanswered review when user accepts", async () => {
    const reviews = [{ outcome: "canceled" }, { _meta: { approved: true, approvalAction: "run" } }];
    const prompts: string[] = [];
    const result = await requestRecoverablePlanReview({
        requestReview: () => Promise.resolve(reviews.shift()),
        requestRetry: (details) => {
            prompts.push(details.reason);
            return Promise.resolve({ outcome: "accepted", value: true });
        },
    });

    strictEqual(result.kind, "answered");
    assertEquals(result.response._meta?.approved, true);
    assertEquals(prompts, ["review_canceled"]);
});

test("Plan Review recovery completes session when retry is declined", async () => {
    const result = await requestRecoverablePlanReview({
        requestReview: () => Promise.resolve({ outcome: "unsupported", message: "server failed" }),
        requestRetry: () => Promise.resolve({ outcome: "canceled", value: false }),
    });

    strictEqual(result.kind, "complete");
    assertEquals(result.reason, "review_error");
    assertEquals(result.message, SESSION_COMPLETE_GUIDANCE);
});

test("Plan Review recovery completes session when retry confirmation throws", async () => {
    const result = await requestRecoverablePlanReview({
        requestReview: () => Promise.resolve({ outcome: "canceled" }),
        requestRetry: () => Promise.reject(new Error("confirmation canceled")),
    });

    strictEqual(result.kind, "complete");
    assertEquals(result.reason, "retry_canceled");
    assertEquals(result.message, SESSION_COMPLETE_GUIDANCE);
});

test("appendSessionCompleteGuidance appends the canonical message once", () => {
    const first = appendSessionCompleteGuidance("Plan saved.");
    assertEquals(first, `Plan saved.\n\n${SESSION_COMPLETE_GUIDANCE}`);
    assertEquals(appendSessionCompleteGuidance(first), first);
});
