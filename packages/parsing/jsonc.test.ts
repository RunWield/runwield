import { test } from "node:test";
import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { parse } from "./jsonc.ts";

test("settings JSONC accepts comments, trailing commas and literal comment characters", () => {
    deepStrictEqual(parse('{ /* settings */ "url": "https://example.com/a//b", "items": [1,2,], // line\n }'), {
        url: "https://example.com/a//b",
        items: [1, 2],
    });
});

test("settings JSONC rejects malformed input instead of returning a partial configuration", () => {
    for (const text of [
        '{"enabled": true, "secret":',
        '{"a":1} garbage',
        '{"a":1 /*',
        "",
        "// only comment",
        '{"a" 1}',
    ]) {
        throws(() => parse(text), SyntaxError, text);
    }
});

test("settings JSONC preserves prototype-like keys as data without inherited configuration", () => {
    const source = '{"__proto__":{"mcpServers":{"inherited":{}}},"nested":[{"__proto__":{"polluted":true}}],"zero":-0}';
    const value = parse(source);
    ok(value !== null && typeof value === "object");
    deepStrictEqual(value, JSON.parse(source));
    strictEqual(Object.hasOwn(value, "__proto__"), true);
    strictEqual(Reflect.get(value, "mcpServers"), undefined);
    strictEqual(Object.getPrototypeOf(value), Object.prototype);
});
