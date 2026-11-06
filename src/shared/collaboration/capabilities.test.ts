import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { ok as assert, match as assertMatch } from "node:assert/strict";
import { generateBearerCapability, hashCapability, redactSecrets, timingSafeEqual } from "./capabilities.ts";

test("capability generation creates distinct URL-safe 256-bit bearer values", () => {
    const first = generateBearerCapability();
    const second = generateBearerCapability();
    assert(first !== second);
    assertMatch(first, /^[A-Za-z0-9_-]{43}$/);
});

test("capability hashes are deterministic server-safe values", async () => {
    const capability = "bearer-secret";
    const first = await hashCapability(capability);
    assertEquals(first, "sha256:HN6ulCbw1uXdg94YTktIM6PMU3_ZBLPYvh3K8xXjx0g");
    assert((await hashCapability("other-secret")) !== first);
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
