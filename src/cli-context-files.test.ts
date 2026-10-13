import { runtimeSourceArgs } from "./testing/runtime-source-args.ts";
import { captureForegroundProcess } from "./shared/captured-process.ts";
import { test } from "node:test";
import {
    lstat as fsLstat,
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { assertEquals, assertStringIncludes } from "./testing/assertions.ts";
import { dirname, join } from "node:path";
import { fileURLToPath as fromFileUrl } from "node:url";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

async function makeTempDir(prefix: string): Promise<string> {
    return await fsMkdtemp(join(tmpdir(), prefix));
}

async function removeTempDir(path: string): Promise<void> {
    try {
        await fsRm(path, { recursive: true });
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await fsLstat(path);
        return true;
    } catch (error) {
        if ((error instanceof Error && "code" in error && error.code === "ENOENT")) return false;
        throw error;
    }
}

async function writePlan(projectRoot: string): Promise<void> {
    await fsMkdir(join(projectRoot, "docs", "plans"), { recursive: true });
    await fsWriteFile(
        join(projectRoot, "docs", "plans", "context-preservation.md"),
        [
            "---",
            'classification: "PLANNED_CHANGE"',
            'workKind: "BUG_FIX"',
            'complexity: "LOW"',
            'summary: "Keep context files untouched."',
            "affectedPaths: []",
            'createdAt: "2026-08-26T00:00:00Z"',
            'status: "draft"',
            "---",
            "",
            "# Context Preservation",
            "",
        ].join("\n"),
    );
}

test("CLI commands leave repository CONTEXT files untouched", async () => {
    const projectRoot = await makeTempDir("runwield-cli-context-files-");
    const homeDir = await makeTempDir("runwield-cli-context-home-");
    const rootContext = "Root CONTEXT content owned by another tool.\n";
    const rootMap = "# Context map\n\n- [Nested](./nested/CONTEXT.md)\n";
    const nestedContext = "Nested CONTEXT content owned by another tool.\n";

    try {
        await writePlan(projectRoot);
        await fsMkdir(join(projectRoot, "nested"), { recursive: true });
        await fsWriteFile(join(projectRoot, "CONTEXT.md"), rootContext);
        await fsWriteFile(join(projectRoot, "CONTEXT-MAP.md"), rootMap);
        await fsWriteFile(join(projectRoot, "nested", "CONTEXT.md"), nestedContext);

        const output = await captureForegroundProcess(process.execPath, {
            args: runtimeSourceArgs(["run", "-A", join(REPO_ROOT, "src", "cli.ts"), "plans"]),
            cwd: projectRoot,
            env: {
                HOME: homeDir,
                MNEMOTECA_DB_PATH: join(homeDir, "m.db"),
            },
        });
        const stdout = new TextDecoder().decode(output.stdout);
        const stderr = new TextDecoder().decode(output.stderr);

        assertEquals(output.code, 0);
        assertStringIncludes(stdout, "context-preservation");
        assertEquals(stderr.includes("domain-language migration"), false);
        assertEquals(stderr.includes("Migrated legacy domain"), false);
        assertEquals(await fsReadFile(join(projectRoot, "CONTEXT.md"), "utf8"), rootContext);
        assertEquals(await fsReadFile(join(projectRoot, "CONTEXT-MAP.md"), "utf8"), rootMap);
        assertEquals(await fsReadFile(join(projectRoot, "nested", "CONTEXT.md"), "utf8"), nestedContext);
        assertEquals(await pathExists(join(projectRoot, "docs", "domain-language.md")), false);
        assertEquals(await pathExists(join(projectRoot, "docs", "domain-language-map.md")), false);
        assertEquals(await pathExists(join(projectRoot, "nested", "domain-language.md")), false);
    } finally {
        await removeTempDir(projectRoot);
        await removeTempDir(homeDir);
    }
});
