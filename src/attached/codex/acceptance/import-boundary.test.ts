import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test("Codex acceptance can observe Core but cannot import lifecycle writers", async () => {
    const directory = fileURLToPath(new URL(".", import.meta.url));
    const seen = new Set<string>();
    async function inspect(path: string): Promise<void> {
        if (seen.has(path)) return;
        seen.add(path);
        assert(
            !/(?:coordinator|operations|record-store|plan-lifecycle|plan-store|worktree-registry|controller-registry)\.[jt]s$/.test(
                path,
            ),
            `Acceptance imports Core authority: ${path}`,
        );
        const source = (await readFile(path, "utf8")).replace(/import\s+type\b[^;]+;/g, "");
        for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g))
            if (match[1].startsWith(".")) await inspect(resolve(dirname(path), match[1]));
    }
    for (const file of await readdir(directory))
        if (file.endsWith(".ts") && !file.endsWith(".test.ts")) await inspect(resolve(directory, file));
    assert(seen.size >= 5);
});
