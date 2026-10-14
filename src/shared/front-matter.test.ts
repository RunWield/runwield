import { test } from "node:test";
import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { extractYaml, test as hasFrontMatter } from "./front-matter.ts";

test("document front matter retains dates, lists, folded text, aliases and body", () => {
    const source =
        "\ufeff---yaml\r\ncreatedAt: 2026-10-10\r\npaths: &paths [src/a.ts, src/b.ts]\r\ncopy: *paths\r\nsummary: >-\r\n  first\r\n  second\r\n---\r\n# Body\r\ntext";
    const parsed = extractYaml(source);
    deepStrictEqual(parsed.attrs, {
        createdAt: new Date("2026-10-10"),
        paths: ["src/a.ts", "src/b.ts"],
        copy: ["src/a.ts", "src/b.ts"],
        summary: "first second",
    });
    strictEqual(parsed.body, "# Body\r\ntext");
    strictEqual(hasFrontMatter(source), true);
});

test("document front matter preserves empty documents and explicit YAML delimiters", () => {
    deepStrictEqual(extractYaml("---\n---\nbody"), { attrs: {}, frontMatter: "", body: "body" });
    deepStrictEqual(extractYaml("= yaml =\nname: demo\n= yaml =\nbody"), {
        attrs: { name: "demo" },
        frontMatter: "name: demo",
        body: "body",
    });
    strictEqual(hasFrontMatter("ordinary body"), false);
    strictEqual(hasFrontMatter("---\nname: unclosed"), false);
});

test("document front matter rejects duplicate keys, broken YAML and unsupported typed values", () => {
    for (const source of [
        "---\nname: one\nname: two\n---",
        "---\nname: [broken\n---",
        '---\nvalue: !!js/function "function() {}"\n---',
    ]) {
        throws(() => extractYaml(source));
    }
    throws(() => extractYaml("---\nmissing delimiter"), TypeError);
});
