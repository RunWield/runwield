import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertThrows } from "../../testing/assertions.ts";
import { decodeBase64Url, decodeUtf8Base64Url, encodeBase64Url, encodeUtf8Base64Url } from "./base64url.ts";

test("base64url round trips UTF-8 strings", () => {
    const encoded = encodeUtf8Base64Url("hello 🌎");
    assertEquals(decodeUtf8Base64Url(encoded), "hello 🌎");
});

test("base64url round trips binary data and omits padding", () => {
    const encoded = encodeBase64Url(new Uint8Array([0, 1, 2, 253, 254, 255]));
    assert(!encoded.includes("="));
    assert(!/[+/]/.test(encoded));
    assertEquals([...decodeBase64Url(encoded)], [0, 1, 2, 253, 254, 255]);
});

test("base64url supports missing padding and empty values", () => {
    assertEquals(decodeUtf8Base64Url("YQ"), "a");
    assertEquals([...decodeBase64Url("")], []);
});

test("base64url rejects invalid input", () => {
    assertThrows(() => decodeBase64Url("not+url-safe"));
    assertThrows(() => decodeBase64Url("abcde"));
});
