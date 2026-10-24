import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Follow project imports as well: an alias or intermediary must not hide a write-capable dependency.
test("acceptance runtime has no dependency on Core lifecycle writers", async () => {
    const directory = fileURLToPath(new URL(".", import.meta.url));
    const seen = new Set<string>();
    async function inspect(path: string): Promise<void> {
        if (seen.has(path)) return;
        seen.add(path);
        assert(
            !/(?:coordinator|operations|record-store|plan-lifecycle|plan-store|worktree-registry|controller-registry)\.[jt]s$/.test(
                path,
            ),
            `Acceptance must read artifacts, not import Core authority: ${path}`,
        );
        const source = await readFile(path, "utf8");
        for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g)) {
            const specifier = match[1];
            if (specifier.startsWith(".")) await inspect(resolve(dirname(path), specifier));
        }
    }
    for (const file of await readdir(directory)) {
        if (file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.endsWith("-test-fixture.ts"))
            await inspect(resolve(directory, file));
    }
    assert(seen.size >= 3);
});
