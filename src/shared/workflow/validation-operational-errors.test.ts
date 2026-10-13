import { test } from "node:test";
import { strictEqual as assertStrictEquals } from "node:assert/strict";
import { assertEquals, assertLessOrEqual } from "../../testing/assertions.ts";

import {
    classifyValidationOperationalError,
    parseBoundedRetryAfterMs,
    sanitizeOperationalMessage,
} from "./validation-operational-errors.ts";

test("classifies typed provider failures without retrying unknown legacy text", () => {
    const rateLimit = classifyValidationOperationalError({
        source: "provider",
        kind: "rate_limited",
        operation: "semantic_review",
        message: "rate limited",
        retryAfter: 1,
    });
    assertEquals(rateLimit.code, "provider/rate_limited");
    assertEquals(rateLimit.recoveryClass, "transient");
    assertEquals(rateLimit.retry?.retryAfterMs, 1000);

    const legacy = classifyValidationOperationalError({
        source: "provider",
        kind: "legacy_text",
        operation: "semantic_review",
        message: "some untyped backend error",
    });
    assertEquals(legacy.code, "provider/legacy_unclassified");
    assertEquals(legacy.recoveryClass, "fatal");
});

test("bounds Retry-After values", () => {
    assertEquals(parseBoundedRetryAfterMs(5, 60_000), 5000);
    assertEquals(parseBoundedRetryAfterMs(-1, 60_000), undefined);
    assertEquals(parseBoundedRetryAfterMs(120, 60_000), undefined);
    assertLessOrEqual(parseBoundedRetryAfterMs(new Date(Date.now() + 1000), 60_000) || 0, 1000);
});

test("classifies reviewer protocol, missing state, git, auth, permission, and policy failures", () => {
    assertEquals(
        classifyValidationOperationalError({
            source: "reviewer_protocol",
            kind: "missing_review_complete",
            operation: "semantic_review",
            message: "missing",
            required: "call review_complete",
        }).recoveryClass,
        "correctable",
    );

    assertEquals(
        classifyValidationOperationalError({
            source: "validation_state",
            kind: "plan_missing",
            operation: "validation_state",
            message: "plan missing",
        }).code,
        "validation_state/plan_missing",
    );

    assertEquals(
        classifyValidationOperationalError({
            source: "git_publication",
            kind: "target_reference_race",
            operation: "publication",
            message: "moved",
        }).recoveryClass,
        "transient",
    );

    assertEquals(
        classifyValidationOperationalError({
            source: "git_publication",
            kind: "remote_unavailable",
            operation: "publication",
            message: "network unavailable",
        }).recoveryClass,
        "transient",
    );

    assertEquals(
        classifyValidationOperationalError({
            source: "provider",
            kind: "authentication",
            operation: "semantic_review",
            message: "login expired",
        }).recoveryClass,
        "missing_information",
    );

    assertEquals(
        classifyValidationOperationalError({
            source: "provider",
            kind: "permission_denied",
            operation: "semantic_review",
            message: "denied",
        }).recoveryClass,
        "fatal",
    );

    assertEquals(
        classifyValidationOperationalError({
            source: "policy",
            kind: "prohibited",
            operation: "publication",
            message: "not allowed",
        }).code,
        "policy/prohibited",
    );
});

test("sanitizes operational text before metrics or user output", () => {
    const message = sanitizeOperationalMessage(`token\n${"x".repeat(700)}`);
    assertStrictEquals(message.includes("\n"), false);
    assertLessOrEqual(message.length, 500);
});
