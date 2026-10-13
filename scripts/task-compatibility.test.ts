import { test } from "node:test";
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { captureScriptProcess } from "./script-process.ts";

// Public tasks from the final Deno toolchain at 9d4bb0374. Keep this inventory
// independent of the active package manifest so accidental renames fail CI.
const LEGACY_TASKS = [
    "ci",
    "cli",
    "submodules:check",
    "submodules:check:remote",
    "snip:check",
    "language-policy:check",
    "seams:check",
    "doc-links:check",
    "docs:stage",
    "docs:dev",
    "docs:build",
    "docs:check",
    "skills:sync:check",
    "skills:sync:update",
    "seams:update",
    "test",
    "test:suite",
    "test:all",
    "test:all:suite",
    "pr:check",
    "lint",
    "githooks:install",
    "githooks:uninstall",
    "check",
    "workspace:dev",
    "workspace:remote",
    "workspace:remote:build",
    "workspace:remote:image:check",
    "workspace:react:check",
    "workspace:test",
    "workspace:build",
    "workspace:check",
    "compile",
    "ux:new-user",
    "ux:new-user:current",
    "release:check",
    "release:metadata",
    "release:candidate",
    "release:promote",
    "release:stable",
    "package:homebrew",
    "package:homebrew:check",
    "package:windows",
    "package:windows:check",
    "package:winget",
    "compile:watch",
    "prototype",
    "test:golden-tui",
    "test:golden-tui:extensive",
];

interface PackageConfig {
    scripts: Record<string, string>;
}
interface Invocation {
    path: string;
    args: string[];
}
interface CommandCase {
    task: string;
    args: string[];
    last: Invocation;
}

async function packageConfig(): Promise<PackageConfig> {
    return JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
}

test("all 49 public Deno tasks remain available under their original Bun script names", async () => {
    const { scripts } = await packageConfig();
    strictEqual(LEGACY_TASKS.length, 49);
    for (const task of LEGACY_TASKS) {
        ok(scripts[task], `Missing original task: ${task}`);
        ok(!/\bdeno\b|\brun [\w:]+:bun\b/.test(scripts[task]), `Noncanonical task: ${task}`);
    }
    for (const [alias, canonical] of Object.entries({
        "ci:bun": "ci",
        "check:bun": "check",
        "lint:bun": "lint",
        "workspace:build:bun": "workspace:build",
    }))
        strictEqual(scripts[alias], `bun run ${canonical}`);
});

test("original compound task names preserve argument boundaries and prerequisite failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "runwield-task-contract-"));
    const log = join(root, "invocations.jsonl");
    const cases: CommandCase[] = [
        {
            task: "compile",
            args: ["--output", "a directory/wld", "--target", "aarch64-apple-darwin"],
            last: {
                path: "scripts/compile-command.ts",
                args: ["--output", "a directory/wld", "--target", "aarch64-apple-darwin"],
            },
        },
        {
            task: "ci",
            args: ["--source-only", "--fail-fast"],
            last: { path: "scripts/run-ci.ts", args: ["--source-only", "--fail-fast"] },
        },
        { task: "pr:check", args: ["--source-only"], last: { path: "scripts/run-ci.ts", args: ["--source-only"] } },
        {
            task: "test",
            args: ["a directory/test.ts", "--filter", "literal [name]"],
            last: {
                path: "scripts/run-tests.js",
                args: [
                    "--exclude",
                    "src/ui/tui/golden-scenarios",
                    "--exclude",
                    "src/ui/tui/testing",
                    "a directory/test.ts",
                    "--filter",
                    "literal [name]",
                ],
            },
        },
        {
            task: "test:all",
            args: ["--fail-fast", "a directory/test.ts"],
            last: { path: "scripts/run-tests.js", args: ["--fail-fast", "a directory/test.ts"] },
        },
        {
            task: "workspace:build",
            args: ["--mode", "test mode"],
            last: {
                path: "node_modules/astro/bin/astro.mjs",
                args: ["build", "--config", "src/ui/workspace/astro.config.mjs", "--mode", "test mode"],
            },
        },
        {
            task: "docs:build",
            args: ["--outDir", "a directory"],
            last: { path: "docs-site/node_modules/astro/bin/astro.mjs", args: ["build", "--outDir", "a directory"] },
        },
        {
            task: "release:candidate",
            args: ["--version", "v1.2.3-rc.1"],
            last: { path: "scripts/release.js", args: ["candidate", "--version", "v1.2.3-rc.1"] },
        },
        {
            task: "package:windows",
            args: ["--binary", "a directory/wld.exe"],
            last: { path: "scripts/package-windows.js", args: ["--binary", "a directory/wld.exe"] },
        },
        {
            task: "prototype",
            args: ["example", "--", "--port", "4321"],
            last: { path: "scripts/run-prototype.js", args: ["example", "--", "--port", "4321"] },
        },
    ];
    // These fixture programs stand in for subprocess boundaries only. The actual
    // package shell commands and nested Bun script dispatch run unchanged.
    const paths = [
        ...new Set([
            ...cases.map((entry) => entry.last.path),
            "scripts/check-bun-runtime.ts",
            "scripts/write-version.js",
            "scripts/public-docs.ts",
        ]),
    ];
    try {
        await writeFile(join(root, "package.json"), JSON.stringify(await packageConfig()));
        for (const path of paths) {
            await mkdir(dirname(join(root, path)), { recursive: true });
            await writeFile(
                join(root, path),
                `
                import { appendFileSync } from "node:fs";
                appendFileSync(${JSON.stringify(log)}, JSON.stringify({ path: ${JSON.stringify(path)}, args: process.argv.slice(2) }) + "\\n");
                if (process.env.FAIL_TASK_ENTRY === ${JSON.stringify(path)}) process.exit(7);
            `,
            );
        }
        for (const entry of cases) {
            await writeFile(log, "");
            const result = await captureScriptProcess(process.execPath, {
                args: ["run", entry.task, ...entry.args],
                cwd: root,
                env: {
                    PATH: `${dirname(process.execPath)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH || ""}`,
                },
            });
            strictEqual(result.code, 0, new TextDecoder().decode(result.stderr));
            const calls: Invocation[] = (await readFile(log, "utf8"))
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line));
            deepStrictEqual(calls.at(-1), entry.last, entry.task);
            for (const prior of calls.slice(0, -1)) {
                ok(!prior.args.includes(entry.args[0]), `${entry.task} arguments leaked to preparation`);
            }
        }
        await writeFile(log, "");
        const failed = await captureScriptProcess(process.execPath, {
            args: ["run", "compile", "--output", "should-not-compile"],
            cwd: root,
            env: { FAIL_TASK_ENTRY: "node_modules/astro/bin/astro.mjs" },
        });
        strictEqual(failed.code, 7);
        ok(!(await readFile(log, "utf8")).includes('"path":"scripts/compile-command.ts"'));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
