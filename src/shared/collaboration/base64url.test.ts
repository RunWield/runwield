import { test } from "node:test";
import { assertEquals, assertThrows } from "../../testing/assertions.ts";
import { decodeBase64Url, decodeUtf8Base64Url, encodeBase64Url, encodeUtf8Base64Url } from "./base64url.ts";

test("base64url interoperates with UTF-8 wire values", () => {
    const encoded = encodeUtf8Base64Url("hello 🌎");
    assertEquals(encoded, "aGVsbG8g8J-Mjg");
    assertEquals(decodeUtf8Base64Url("aGVsbG8g8J-Mjg"), "hello 🌎");
});

test("base64url interoperates with URL-safe binary wire values", () => {
    const encoded = encodeBase64Url(new Uint8Array([0, 1, 2, 253, 254, 255]));
    assertEquals(encoded, "AAEC_f7_");
    assertEquals([...decodeBase64Url("AAEC_f7_")], [0, 1, 2, 253, 254, 255]);
});

test("base64url supports missing padding and empty values", () => {
    assertEquals(decodeUtf8Base64Url("YQ"), "a");
    assertEquals([...decodeBase64Url("")], []);
});

test("base64url rejects invalid input", () => {
    assertThrows(() => decodeBase64Url("not+url-safe"));
    assertThrows(() => decodeBase64Url("abcde"));
});
