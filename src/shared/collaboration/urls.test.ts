import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertThrows } from "../../testing/assertions.ts";
import { buildApiUrl, buildCollaborationUrl, parseCollaborationUrl, redactCollaborationUrl } from "./urls.ts";

test("collaboration URLs keep key and capability in distinct fragment fields", () => {
    const url = buildCollaborationUrl({
        serverUrl: "https://plans.example.test/",
        spaceId: "space-1",
        contentKey: "content-key",
        bearerCapability: "bearer-capability",
        role: "reviewer",
    });
    assertEquals(url, "https://plans.example.test/p/space-1#key=content-key&cap=bearer-capability&role=reviewer");
    const parsed = parseCollaborationUrl(url);
    assertEquals(parsed.serverUrl, "https://plans.example.test");
    assertEquals(parsed.contentKey, "content-key");
    assertEquals(parsed.bearerCapability, "bearer-capability");
    assertEquals(parsed.role, "reviewer");
});

test("maintainer URLs parse with fragment-free API URLs", () => {
    const url = buildCollaborationUrl({
        serverUrl: "https://plans.example.test/base",
        spaceId: "space-2",
        contentKey: "key-2",
        bearerCapability: "cap-2",
        role: "maintainer",
    });
    const parsed = parseCollaborationUrl(url);
    assertEquals(parsed.apiBaseUrl, "https://plans.example.test/base");
    assert(!parsed.apiBaseUrl.includes("#"));
    assertEquals(
        buildApiUrl(parsed.apiBaseUrl, `/api/spaces/${parsed.spaceId}`),
        "https://plans.example.test/base/api/spaces/space-2",
    );
});

test("collaboration URL parsing rejects missing fragments and invalid roles", () => {
    assertThrows(() => parseCollaborationUrl("https://plans.example.test/p/space-1#key=k&role=reviewer"));
    assertThrows(() => parseCollaborationUrl("https://plans.example.test/p/space-1#key=k&cap=c&role=owner"));
});

test("collaboration URL redaction removes key and capability", () => {
    const redacted = redactCollaborationUrl(
        "https://plans.example.test/p/space#key=secret-key&cap=secret-cap&role=reviewer",
    );
    assert(!redacted.includes("secret-key"));
    assert(!redacted.includes("secret-cap"));
});

test("API URLs reject endpoint paths that escape the server base", () => {
    assertThrows(() => buildApiUrl("https://plans.example.test/root", "https://other-host.example/api"));
    assertThrows(() => buildApiUrl("https://plans.example.test/root", "//other-host.example/api"));
    assertThrows(() => buildApiUrl("https://plans.example.test/root", "../api"));
    assertEquals(
        buildApiUrl("https://plans.example.test/root", "/api/spaces"),
        "https://plans.example.test/root/api/spaces",
    );
});
