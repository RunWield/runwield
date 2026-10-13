import { assertEquals } from "./testing/assertions.ts";
import { test } from "node:test";
import { readdir as fsReaddir, readFile as fsReadFile } from "node:fs/promises";
import { ok as assert } from "node:assert/strict";
import { extractYaml, test as hasFrontMatter } from "./shared/front-matter.ts";
import { join } from "node:path";

interface AdrFrontMatter {
    status: string;
}

const ADR_DIR = "docs/adr";
const ALLOWED_ADR_STATUSES = new Set(["proposed", "accepted"]);

async function* walkMarkdownFiles(dir: string): AsyncGenerator<string> {
    for await (const entry of await fsReaddir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            yield* walkMarkdownFiles(path);
            continue;
        }
        if (entry.isFile() && entry.name.endsWith(".md")) yield path;
    }
}

function frontMatterText(markdown: string): string {
    const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
    return match?.[1] || "";
}

test("ADR artifacts use required machine-readable status front matter", async () => {
    const checkedPaths = [];
    for await (const path of walkMarkdownFiles(ADR_DIR)) {
        checkedPaths.push(path);
        const markdown = await fsReadFile(path, "utf8");
        assert(hasFrontMatter(markdown), `${path} must start with YAML front matter`);

        const statusFields = frontMatterText(markdown).split("\n").filter((line) => /^status\s*:/.test(line));
        assertEquals(statusFields.length, 1, `${path} must define exactly one status field`);

        const { attrs, body } = extractYaml<AdrFrontMatter>(markdown);
        assertEquals(typeof attrs.status, "string", `${path} status must be a string`);
        assert(
            ALLOWED_ADR_STATUSES.has(attrs.status),
            `${path} status must be one of ${Array.from(ALLOWED_ADR_STATUSES).join(", ")}`,
        );
        assert(!/^## Status\s*$/m.test(body), `${path} must not use a prose ## Status section`);
    }

    assert(checkedPaths.length > 0, "expected at least one ADR artifact");
});
