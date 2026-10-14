import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { readdir as fsReaddir, readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { ok as assert } from "node:assert/strict";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath as fromFileUrl } from "node:url";

const SESSION_DIR = dirname(fromFileUrl(import.meta.url));
const REPO_ROOT = resolve(SESSION_DIR, "../../..");
const RUNTIME_DIR = join(SESSION_DIR, "runtime");

async function typeScriptFiles(root: string): Promise<string[]> {
    const files: string[] = [];
    for await (const entry of await fsReaddir(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) files.push(...await typeScriptFiles(path));
        else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
    }
    return files;
}

async function productionFiles(root: string): Promise<string[]> {
    const files: string[] = [];
    for await (const entry of await fsReaddir(root, { withFileTypes: true })) {
        if ([".git", "node_modules", ".astro", "dist"].includes(entry.name)) continue;
        const path = join(root, entry.name);
        if (entry.isDirectory()) files.push(...await productionFiles(path));
        else if (entry.isFile() && /\.[jt]sx?$/.test(entry.name) && !/\.test\.[jt]sx?$/.test(entry.name)) {
            files.push(path);
        }
    }
    return files;
}

test("SessionRuntime TypeScript implementation files stay below 1000 physical lines", async () => {
    const files = [join(SESSION_DIR, "session-runtime.ts"), ...await typeScriptFiles(RUNTIME_DIR)];
    assert(files.length > 2);
    for (const file of files) {
        const lines = (await fsReadFile(file, "utf8")).split("\n").length;
        assert(lines <= 999, `${relative(REPO_ROOT, file)} has ${lines} lines`);
    }
});

test("SessionRuntime has no JavaScript implementation or internal consumer imports", async () => {
    let oldImplementationExists = true;
    try {
        await fsStat(join(SESSION_DIR, "session-runtime.js"));
    } catch (error) {
        if ((error instanceof Error && "code" in error && error.code === "ENOENT")) oldImplementationExists = false;
        else throw error;
    }
    assertEquals(oldImplementationExists, false);

    const violations: string[] = [];
    for (const file of await productionFiles(join(REPO_ROOT, "src"))) {
        if (file.startsWith(`${RUNTIME_DIR}/`) || file === join(SESSION_DIR, "session-runtime.ts")) continue;
        const source = await fsReadFile(file, "utf8");
        if (/session\/runtime\/[^"']+\.ts/.test(source)) violations.push(relative(REPO_ROOT, file));
    }
    assertEquals(violations, []);
});
