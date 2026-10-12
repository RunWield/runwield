import { test } from "node:test";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import {
    decryptJsonPayload,
    encryptJsonPayload,
    exportContentKey,
    generateContentKey,
    importContentKey,
} from "./crypto.ts";
import { decodeBase64Url, encodeBase64Url } from "./base64url.ts";

test("content encryption keys export, import, and round trip JSON payloads", async () => {
    const key = await generateContentKey();
    const exported = await exportContentKey(key);
    const imported = await importContentKey(exported);
    const encrypted = await encryptJsonPayload({ planId: "plan-1", text: "secret" }, imported);
    assertEquals(await decryptJsonPayload(encrypted, key), { planId: "plan-1", text: "secret" });
});

test("decrypt fails closed for wrong keys", async () => {
    const key = await generateContentKey();
    const wrongKey = await generateContentKey();
    const encrypted = await encryptJsonPayload({ ok: true }, key);
    await assertRejects(() => decryptJsonPayload(encrypted, wrongKey));
});

test("decrypt fails closed for tampered and truncated ciphertext", async () => {
    const key = await generateContentKey();
    const encrypted = await encryptJsonPayload({ ok: true }, key);
    const bytes = decodeBase64Url(encrypted);
    bytes[bytes.length - 1] ^= 1;
    await assertRejects(() => decryptJsonPayload(encodeBase64Url(bytes), key));
    await assertRejects(() => decryptJsonPayload(encodeBase64Url(bytes.slice(0, 12)), key));
});

test("importContentKey rejects malformed key material", async () => {
    await assertRejects(() => importContentKey("abc"));
});
