import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { getCwd } from "../../constants.js";
import { readdir as fsReaddir, readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * @param {string} dir
 * @param {boolean} [includeTests]
 * @returns {AsyncGenerator<string>}
 */
async function* walkJsFiles(dir, includeTests = false) {
    for await (const entry of await fsReaddir(dir, { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
            if (entry.name === "node_modules" || entry.name === ".git") continue;
            yield* walkJsFiles(path, includeTests);
        } else if (entry.isFile() && entry.name.endsWith(".js") && (includeTests || !entry.name.endsWith(".test.js"))) {
            yield path;
        }
    }
}

test("production code does not import removed mutable session-state singleton", async () => {
    /** @type {string[]} */
    const matches = [];
    const root = import.meta.dirname ?? getCwd();
    for await (const path of walkJsFiles(join(root, "..", "..", "..", "src"))) {
        const source = await fsReadFile(path, "utf8");
        if (source.includes("session-state.js")) matches.push(path);
    }

    assertEquals(matches, []);
});

test("shared core and tools never import UI or ACP adapters", async () => {
    /** @type {string[]} */
    const matches = [];
    const base = import.meta.dirname ?? getCwd();
    const projectRoot = join(base, "..", "..", "..");
    for (const root of [join(projectRoot, "src", "shared"), join(projectRoot, "src", "tools")]) {
        for await (const path of walkJsFiles(root, true)) {
            const source = await fsReadFile(path, "utf8");
            if (/from\s+["'][^"']*(?:\/ui\/|\/acp\/)/.test(source)) matches.push(path);
            if (/import\(["'][^"']*(?:\/ui\/|\/acp\/)/.test(source)) matches.push(path);
        }
    }

    assertEquals(Array.from(new Set(matches)).sort(), []);
});
