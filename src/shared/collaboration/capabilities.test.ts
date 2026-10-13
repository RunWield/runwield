import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { ok as assert, match as assertMatch } from "node:assert/strict";
import {
    generateBearerCapability,
    hashCapability,
    MAINTAINER_SCOPE,
    redactSecrets,
    REVIEWER_SCOPE,
    timingSafeEqual,
} from "./capabilities.ts";

test("capability generation creates distinct URL-safe 256-bit bearer values", () => {
    const first = generateBearerCapability();
    const second = generateBearerCapability();
    assert(first !== second);
    assertMatch(first, /^[A-Za-z0-9_-]{43}$/);
});

test("capability hashes are deterministic server-safe values", async () => {
    const capability = "bearer-secret";
    const first = await hashCapability(capability);
    const second = await hashCapability(capability);
    assertEquals(first, second);
    assertMatch(first, /^sha256:[A-Za-z0-9_-]+$/);
    assert(!first.includes(capability));
});

test("capability helpers expose reviewer and maintainer scopes", () => {
    assertEquals(REVIEWER_SCOPE, "reviewer");
    assertEquals(MAINTAINER_SCOPE, "maintainer");
});

test("capability equality and redaction avoid raw bearer leakage", () => {
    assert(timingSafeEqual("same", "same"));
    assert(!timingSafeEqual("same", "different"));
    const generatedCapability = generateBearerCapability();
    const edgeCapability = "-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO_";
    const redacted = redactSecrets(
        `Authorization: Bearer raw-token #key=content&cap=raw-token raw-token appeared elsewhere ${generatedCapability} ${edgeCapability} sha256:abcdef`,
        ["raw-token"],
    );
    assert(!redacted.includes("raw-token"));
    assert(!redacted.includes(generatedCapability));
    assert(!redacted.includes(edgeCapability));
    assert(!redacted.includes("abcdef"));
});
