import { test } from "node:test";
import { assertEquals, assertLessOrEqual } from "../../testing/assertions.ts";

import {
    calculateValidationRetryDelayMs,
    decideValidationRecovery,
    DEFAULT_VALIDATION_RETRY_POLICY,
    waitForValidationRetry,
} from "./validation-recovery.ts";
import { classifyValidationOperationalError } from "./validation-operational-errors.ts";

test("calculates capped exponential full jitter and honors bounded Retry-After", () => {
    assertEquals(
        calculateValidationRetryDelayMs({ retryIndex: 0, baseDelayMs: 100, maxDelayMs: 1000, randomUnit: 1 }),
        100,
    );
    assertEquals(
        calculateValidationRetryDelayMs({ retryIndex: 4, baseDelayMs: 100, maxDelayMs: 1000, randomUnit: 1 }),
        1000,
    );
    assertEquals(
        calculateValidationRetryDelayMs({ retryIndex: 2, baseDelayMs: 100, maxDelayMs: 1000, randomUnit: 0.5 }),
        200,
    );
    assertEquals(
        calculateValidationRetryDelayMs({
            retryIndex: 2,
            baseDelayMs: 100,
            maxDelayMs: 1000,
            randomUnit: 0.5,
            retryAfterMs: 250,
        }),
        250,
    );
});

test("maps transient failures to retry and pauses after the retry budget", () => {
    const failure = classifyValidationOperationalError({
        source: "provider",
        kind: "timeout",
        operation: "semantic_review",
        message: "timeout",
    });
    const retry = decideValidationRecovery({
        failure,
        attempt: 1,
        policy: DEFAULT_VALIDATION_RETRY_POLICY,
        randomUnit: 0,
    });
    assertEquals(retry.action, "retry");
    if (retry.action === "retry") assertLessOrEqual(retry.delayMs, DEFAULT_VALIDATION_RETRY_POLICY.maxDelayMs);

    const spent = decideValidationRecovery({
        failure,
        attempt: 4,
        policy: DEFAULT_VALIDATION_RETRY_POLICY,
        randomUnit: 0,
    });
    assertEquals(spent.action, "pause");
    assertEquals(spent.result.kind, "retry_later");
});

test("transient Reviewer failures use jittered backoff without consuming semantic rounds", () => {
    const retry = decideValidationRecovery({
        failure: classifyValidationOperationalError({
            source: "provider",
            kind: "timeout",
            operation: "semantic_review",
            message: "Reviewer timed out",
        }),
        attempt: 1,
        correctionAttempt: 1,
        nextPhase: "semantic",
        policy: DEFAULT_VALIDATION_RETRY_POLICY,
        randomUnit: 0.5,
    });

    assertEquals(retry.action, "retry");
    if (retry.action !== "retry") throw new Error("Reviewer timeout should retry.");
    assertEquals(retry.result.kind, "retry_later");
    assertEquals(retry.result.nextPhase, "semantic");
    assertEquals(retry.result.attempt, 1);
    assertEquals(retry.result.maxAttempts, DEFAULT_VALIDATION_RETRY_POLICY.maxRetries);
    assertEquals(retry.delayMs, DEFAULT_VALIDATION_RETRY_POLICY.baseDelayMs * 0.5);
});

test("correctable Reviewer failures stay in the same session with structured feedback", () => {
    const correction = decideValidationRecovery({
        failure: classifyValidationOperationalError({
            source: "reviewer_protocol",
            kind: "missing_review_complete",
            operation: "semantic_review",
            message: "Reviewer ended without review_complete.",
            required: "Call review_complete with the review result.",
        }),
        attempt: 1,
        correctionAttempt: 1,
        nextPhase: "semantic",
        policy: DEFAULT_VALIDATION_RETRY_POLICY,
    });

    assertEquals(correction.action, "correct");
    assertEquals(correction.result.kind, "agent_correction");
    assertEquals(correction.result.action, "correct_agent_output");
    assertEquals(correction.result.message, "Call review_complete with the review result.");
    assertEquals(correction.result.nextPhase, "semantic");
    assertEquals(correction.result.attempt, 1);
});

test("a missing optional Reviewer entity replans in the same session", () => {
    const correction = decideValidationRecovery({
        failure: classifyValidationOperationalError({
            source: "reviewer_protocol",
            kind: "missing_optional_entity",
            operation: "semantic_review",
            message: "The requested review item does not exist.",
            field: "review_diff",
            required: "List the available items and continue without the missing item.",
        }),
        attempt: 1,
        correctionAttempt: 1,
        nextPhase: "semantic",
        policy: DEFAULT_VALIDATION_RETRY_POLICY,
    });

    assertEquals(correction.action, "correct");
    assertEquals(correction.result.kind, "agent_correction");
    assertEquals(correction.result.action, "correct_agent_output");
    assertEquals(correction.result.nextPhase, "semantic");
});

test("maps correctable, missing-information, and fatal failures to separate actions", () => {
    const correctable = decideValidationRecovery({
        failure: classifyValidationOperationalError({
            source: "reviewer_protocol",
            kind: "missing_review_complete",
            operation: "semantic_review",
            message: "missing",
            required: "call review_complete",
        }),
        attempt: 1,
        policy: DEFAULT_VALIDATION_RETRY_POLICY,
    });
    assertEquals(correctable.action, "correct");
    assertEquals(correctable.result.delayMs, undefined);

    const missing = decideValidationRecovery({
        failure: classifyValidationOperationalError({
            source: "validation_state",
            kind: "plan_missing",
            operation: "validation_state",
            message: "missing",
        }),
        attempt: 1,
        policy: DEFAULT_VALIDATION_RETRY_POLICY,
    });
    assertEquals(missing.action, "pause");

    const fatal = decideValidationRecovery({
        failure: classifyValidationOperationalError({
            source: "policy",
            kind: "prohibited",
            operation: "publication",
            message: "no",
        }),
        attempt: 1,
        policy: DEFAULT_VALIDATION_RETRY_POLICY,
    });
    assertEquals(fatal.action, "halt");
});

test("stops retry waits on cancellation", async () => {
    const controller = new AbortController();
    const result = waitForValidationRetry(1000, controller.signal);
    controller.abort();
    assertEquals(await result, "canceled");
});
