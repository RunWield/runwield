import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import {
    appendSessionCompleteGuidance,
    isAnsweredPlanReview,
    requestRecoverablePlanReview,
    SESSION_COMPLETE_GUIDANCE,
} from "./plan-review-recovery.js";

test("Plan Review recovery treats approval, remote review, and substantive feedback as answered", () => {
    assertEquals(isAnsweredPlanReview({ _meta: { approved: true } }), true);
    assertEquals(isAnsweredPlanReview({ approved: false, remoteReview: true }), true);
    assertEquals(isAnsweredPlanReview({ approved: false, feedback: "change it" }), true);
    assertEquals(isAnsweredPlanReview({ approved: false, images: [{ base64: "a", mimeType: "image/png" }] }), true);
    assertEquals(isAnsweredPlanReview({ approved: false, annotations: [{ text: "revise" }] }), true);
    assertEquals(isAnsweredPlanReview({ approved: false, globalAttachments: [{ path: "reference.png" }] }), true);
});

test("Plan Review recovery treats cancellation, exit, and unsupported outcomes as unanswered before feedback", () => {
    assertEquals(isAnsweredPlanReview({ outcome: "canceled" }), false);
    assertEquals(isAnsweredPlanReview({ outcome: "blocked", feedback: "blocked" }), false);
    assertEquals(isAnsweredPlanReview({ outcome: "unsupported", feedback: "unsupported" }), false);
    assertEquals(isAnsweredPlanReview({ canceled: true, feedback: "Cancelled by user (Esc)" }), false);
    assertEquals(isAnsweredPlanReview({ exit: true, feedback: "Exited" }), false);
    assertEquals(isAnsweredPlanReview({ approved: false, feedback: "" }), false);
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

    assertEquals(result.kind, "answered");
    assertEquals(result.response._meta.approved, true);
    assertEquals(prompts, ["review_canceled"]);
});

test("Plan Review recovery completes session when retry is declined", async () => {
    const result = await requestRecoverablePlanReview({
        requestReview: () => Promise.resolve({ outcome: "unsupported", message: "server failed" }),
        requestRetry: () => Promise.resolve({ outcome: "canceled", value: false }),
    });

    assertEquals(result.kind, "complete");
    assertEquals(result.reason, "review_error");
    assertEquals(result.message, SESSION_COMPLETE_GUIDANCE);
});

test("Plan Review recovery completes session when retry confirmation throws", async () => {
    const result = await requestRecoverablePlanReview({
        requestReview: () => Promise.resolve({ outcome: "canceled" }),
        requestRetry: () => Promise.reject(new Error("confirmation canceled")),
    });

    assertEquals(result.kind, "complete");
    assertEquals(result.reason, "retry_canceled");
    assertEquals(result.message, SESSION_COMPLETE_GUIDANCE);
});

test("appendSessionCompleteGuidance appends the canonical message once", () => {
    const first = appendSessionCompleteGuidance("Plan saved.");
    assertEquals(first, `Plan saved.\n\n${SESSION_COMPLETE_GUIDANCE}`);
    assertEquals(appendSessionCompleteGuidance(first), first);
});
