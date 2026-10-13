import { fileURLToPath } from "node:url";
import { runtimeSourceArgs } from "../src/testing/runtime-source-args.ts";
import { captureScriptProcess } from "./script-process.ts";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
    mkdtemp as fsMkdtemp,
    readdir as fsReaddir,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import process from "node:process";
import { assertEquals, assertStringIncludes } from "../src/testing/assertions.ts";
import { join } from "node:path";

interface PackageConfig {
    scripts: Record<string, string>;
}

const GOLDEN_TUI_DIRS = ["src/ui/tui/golden-scenarios", "src/ui/tui/testing"];

async function readPackageConfig(): Promise<PackageConfig> {
    return JSON.parse(await fsReadFile(new URL("../package.json", import.meta.url), "utf8")) as PackageConfig;
}

test("the everyday test task leaves the Golden TUI portfolio to its own task", async () => {
    const { scripts: tasks } = await readPackageConfig();

    for (const dir of GOLDEN_TUI_DIRS) {
        assertStringIncludes(tasks["test:suite"], `--exclude ${dir}`);
        assertStringIncludes(tasks["test:golden-tui"], dir);
    }
});

test("the PR gate runs source quality and Golden TUI jobs in parallel", async () => {
    const { scripts: tasks } = await readPackageConfig();
    const workflow = await fsReadFile(new URL("../.github/workflows/pr.yml", import.meta.url), "utf8");

    assertEquals(tasks["pr:check"], "bun run ci");
    assertStringIncludes(workflow, "pull_request:");
    assertStringIncludes(workflow, "    ci:");
    assertStringIncludes(workflow, "run: bun run ci --source-only");
    assertEquals(tasks["test:all:suite"].includes("--exclude"), false);
    assertStringIncludes(workflow, "    golden:");
    assertStringIncludes(workflow, "run: bun run test:golden-tui --timings-file");
});

test("the test runner skips excluded paths it would otherwise discover", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-exclude-policy-"));
    const reportDir = join(root, "reports");
    try {
        await fsWriteFile(
            join(root, "passes.test.ts"),
            'import { test } from "node:test"; test("passes", () => {});\n',
        );
        await fsWriteFile(
            join(root, "fails.test.ts"),
            'import { test } from "node:test"; test("fails", () => {\n    throw new Error("this file must never run");\n});\n',
        );

        const result = await captureScriptProcess(process.execPath, {
            args: runtimeSourceArgs([
                "run",
                "-A",
                fileURLToPath(new URL("./run-tests.js", import.meta.url)),
                "--isolated",
                root,
                "--exclude",
                join(root, "fails.test.ts"),
                "--report-dir",
                reportDir,
            ]),
            // Even a fractional worker setting must execute the selected test.
            env: { WLD_TEST_CONCURRENCY: "0.5" },
            stdout: "piped",
            stderr: "piped",
        });

        const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
        assertEquals(result.code, 0, output);
        assertStringIncludes(output, "1 files passed");
        assertEquals(output.trim().split("\n").length, 1, output);
        const report = JSON.parse(await fsReadFile(join(reportDir, "run.json"), "utf8"));
        assertEquals(report.completed, 1);
        assertEquals(report.concurrency, 1);
        assertEquals(report.failed, 0);
        assertEquals(report.files.length, 1);
        assertEquals(report.prewarmMs >= 0, true);
        const xmlFiles = [];
        for await (const entry of await fsReaddir(reportDir, { withFileTypes: true })) {
            if (entry.name.endsWith(".xml")) xmlFiles.push(entry.name);
        }
        assertEquals(xmlFiles.length, 1);
        const xml = await fsReadFile(join(reportDir, xmlFiles[0]), "utf8");
        assertStringIncludes(xml, 'name="passes"');
        assertStringIncludes(xml, 'time="');
    } finally {
        await fsRm(root, { recursive: true });
    }
});

test("isolated shards execute the whole fixture portfolio exactly once with real processes", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-shard-policy-"));
    try {
        for (let index = 0; index < 5; index++) {
            await fsWriteFile(
                join(root, `${index}.test.ts`),
                `import { test } from "node:test"; import { writeFile } from "node:fs/promises"; test("case ${index}", async () => {
                    await writeFile(${JSON.stringify(join(root, `${index}.ran`))}, "ran\\n", { flag: "a" });
                });\n`,
            );
        }
        const results = await Promise.all(
            [1, 2, 3, 4].map((index) =>
                captureScriptProcess(process.execPath, {
                    args: runtimeSourceArgs([
                        "run",
                        "-A",
                        "scripts/run-tests.js",
                        "--isolated",
                        root,
                        "--shard",
                        `${index}/4`,
                    ]),
                    stdout: "piped",
                    stderr: "piped",
                }),
            ),
        );
        for (const result of results) {
            assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
        }
        for (let index = 0; index < 5; index++) {
            assertEquals(await fsReadFile(join(root, `${index}.ran`), "utf8"), "ran\n");
        }
    } finally {
        await fsRm(root, { recursive: true });
    }
});

test("prepared dependencies preserve isolated execution and changed-source failures", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-prepared-dependencies-"));
    const reports = join(root, "reports");
    try {
        const valuePath = join(root, "value.ts");
        await fsWriteFile(valuePath, "export const value: number = 1;\n");
        for (const name of ["a", "b"]) {
            await fsWriteFile(
                join(root, `${name}.test.ts`),
                `import { test } from "node:test"; import { writeFile } from "node:fs/promises"; import chalk from ${JSON.stringify(
                    import.meta.resolve("chalk"),
                )};
                import { value } from "./value.ts";
                test("${name}", async () => {
                    const { default: stripAnsi } = await import(${JSON.stringify(import.meta.resolve("strip-ansi"))});
                    if (stripAnsi(chalk.red("loaded")) !== "loaded") throw new Error("npm imports failed");
                    if (value !== 1) throw new Error("changed source was executed");
                    if (process.env.WLD_TEST_SSHFS !== "1" || process.env.WLD_TEST_SSHFS_STALL !== "1") {
                        throw new Error("explicit SSHFS qualification flags were lost");
                    }
                    await writeFile(${JSON.stringify(join(root, `${name}.json`))}, JSON.stringify({
                        pid: process.pid, home: process.env.HOME, temp: process.env.TMPDIR,
                        database: process.env.MNEMOTECA_DB_PATH,
                    }));
                });\n`,
            );
        }
        const args = ["run", "-A", "scripts/run-tests.js", "--report-dir", reports, "--isolated", root];
        const command = () =>
            captureScriptProcess(process.execPath, {
                args: runtimeSourceArgs(args),
                env: { WLD_TEST_CONCURRENCY: "1", WLD_TEST_SSHFS: "1", WLD_TEST_SSHFS_STALL: "1" },
                stdout: "piped",
                stderr: "piped",
            });
        const passed = await command();
        const output = new TextDecoder().decode(passed.stdout) + new TextDecoder().decode(passed.stderr);
        assertEquals(passed.code, 0, output);
        assertStringIncludes(output, "2 files passed");
        assertEquals(output.trim().split("\n").length, 1, output);
        const a = JSON.parse(await fsReadFile(join(root, "a.json"), "utf8"));
        const b = JSON.parse(await fsReadFile(join(root, "b.json"), "utf8"));
        for (const key of ["pid", "home", "temp", "database"]) {
            assertEquals(a[key] === b[key], false, `${key} must remain isolated between files`);
        }

        // A prepared dependency directory must never cache application results
        // or conceal a newly failing test after a source edit.
        await fsWriteFile(valuePath, "export const value: number = 2;\n");
        const failed = await command();
        assertEquals(failed.code, 1);
        const report = JSON.parse(await fsReadFile(join(reports, "run.json"), "utf8"));
        assertEquals(report.completed, 2);
        assertEquals(report.failed, 2);
        for await (const entry of await fsReaddir(reports, { withFileTypes: true })) {
            if (!entry.name.endsWith(".xml")) continue;
            assertStringIncludes(await fsReadFile(join(reports, entry.name), "utf8"), "changed source was executed");
        }
    } finally {
        await fsRm(root, { recursive: true });
    }
});

test("release and PR require all source and Golden shards without cancelling siblings", async () => {
    for (const workflowName of ["release", "pr", "golden"]) {
        const workflow = await fsReadFile(new URL(`../.github/workflows/${workflowName}.yml`, import.meta.url), "utf8");
        const jobs = workflowName === "golden" ? ["golden-shards"] : ["ci-shards", "golden-shards"];
        for (const job of jobs) {
            const start = workflow.indexOf(`    ${job}:\n`);
            const next = workflow.slice(start + 1).search(/\n {4}[a-z][a-z-]*:\n/);
            const body = workflow.slice(start, next < 0 ? undefined : start + 1 + next);
            assertStringIncludes(body, "fail-fast: false");
            assertStringIncludes(body, "shard: [1, 2, 3, 4]");
            assertStringIncludes(body, "WLD_TEST_SHARD: ${{ matrix.shard }}/4");
            assertEquals(body.includes("continue-on-error"), false);
            assertStringIncludes(body, "actions/upload-artifact@v5");
            assertStringIncludes(body, "path: .ci-cache/");
            const gate = job.replace("-shards", "");
            assertStringIncludes(workflow, `    ${gate}:\n        if: always()\n        needs: ${job}`);
            assertStringIncludes(workflow, "run: test '$" + `{{ needs.${job}.result }}' = 'success'`);
        }
    }
});

test("test --filter preserves literal and regex selection through the real isolated runner", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-filter-policy-"));
    try {
        const file = join(root, "selection.test.ts");
        const marker = join(root, "selected.txt");
        await fsWriteFile(
            file,
            `
            import { test } from "node:test";
            import { appendFileSync } from "node:fs";
            test("prefix literal [name] suffix", async (t) => {
                appendFileSync(${JSON.stringify(marker)}, "parent\\n");
                await t.test("child step", () => appendFileSync(${JSON.stringify(marker)}, "child\\n"));
            });
            test("literal n", () => { throw new Error("literal filter was treated as a regex"); });
            test("unselected", () => { throw new Error("filter was lost"); });
        `,
        );
        for (const filter of [["--filter", "literal [name]"], ["--filter=/^prefix literal \\[name\\] suffix$/"]]) {
            await fsWriteFile(marker, "");
            const result = await captureScriptProcess(process.execPath, {
                args: ["run", "test:suite", file, ...filter],
                stdout: "piped",
                stderr: "piped",
            });
            assertEquals(
                result.code,
                0,
                new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr),
            );
            assertEquals(await fsReadFile(marker, "utf8"), "parent\nchild\n");
        }
        for (const prefix of [[], ["--isolated"]]) {
            const result = await captureScriptProcess(process.execPath, {
                args: ["run", "test:suite", ...prefix, file, "--deny-read=/private"],
            });
            assertEquals(result.code, 1);
            assertStringIncludes(new TextDecoder().decode(result.stderr), "Deno runtime flags cannot be ignored");
        }
    } finally {
        await fsRm(root, { recursive: true, force: true });
    }
});
