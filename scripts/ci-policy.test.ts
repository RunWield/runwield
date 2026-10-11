import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";

interface DenoConfig {
    tasks: Record<string, string>;
}

const GOLDEN_TUI_DIRS = ["src/ui/tui/golden-scenarios", "src/ui/tui/testing"];

async function readDenoConfig(): Promise<DenoConfig> {
    return JSON.parse(await Deno.readTextFile(new URL("../deno.json", import.meta.url))) as DenoConfig;
}

Deno.test("the everyday test task leaves the Golden TUI portfolio to its own task", async () => {
    const { tasks } = await readDenoConfig();

    for (const dir of GOLDEN_TUI_DIRS) {
        assertStringIncludes(tasks["test:suite"], `--exclude ${dir}`);
        assertStringIncludes(tasks["test:golden-tui"], dir);
    }
});

Deno.test("the PR gate runs source quality and Golden TUI jobs in parallel", async () => {
    const { tasks } = await readDenoConfig();
    const workflow = await Deno.readTextFile(new URL("../.github/workflows/pr.yml", import.meta.url));

    assertEquals(tasks["pr:check"], "deno task ci");
    assertStringIncludes(workflow, "pull_request:");
    assertStringIncludes(workflow, "    ci:");
    assertStringIncludes(workflow, "run: deno task ci --source-only");
    assertEquals(tasks["test:all:suite"].includes("--exclude"), false);
    assertStringIncludes(workflow, "    golden:");
    assertStringIncludes(workflow, "run: deno task test:golden-tui --timings-file");
});

Deno.test("the test runner skips excluded paths it would otherwise discover", async () => {
    const root = await Deno.makeTempDir({ prefix: "runwield-exclude-policy-" });
    const reportDir = join(root, "reports");
    try {
        await Deno.writeTextFile(
            join(root, "passes.test.ts"),
            'Deno.test("passes", () => {});\n',
        );
        await Deno.writeTextFile(
            join(root, "fails.test.ts"),
            'Deno.test("fails", () => {\n    throw new Error("this file must never run");\n});\n',
        );

        const result = await new Deno.Command(Deno.execPath(), {
            args: [
                "run",
                "-A",
                new URL("./run-tests.js", import.meta.url).pathname,
                "--isolated",
                root,
                "--exclude",
                join(root, "fails.test.ts"),
                "--report-dir",
                reportDir,
            ],
            // Even a fractional worker setting must execute the selected test.
            env: { WLD_TEST_CONCURRENCY: "0.5" },
            stdout: "piped",
            stderr: "piped",
        }).output();

        const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
        assertEquals(result.code, 0, output);
        assertStringIncludes(output, "1 files passed");
        assertEquals(output.trim().split("\n").length, 1, output);
        const report = JSON.parse(await Deno.readTextFile(join(reportDir, "run.json")));
        assertEquals(report.completed, 1);
        assertEquals(report.concurrency, 1);
        assertEquals(report.failed, 0);
        assertEquals(report.files.length, 1);
        assertEquals(report.prewarmMs >= 0, true);
        const xmlFiles = [];
        for await (const entry of Deno.readDir(reportDir)) {
            if (entry.name.endsWith(".xml")) xmlFiles.push(entry.name);
        }
        assertEquals(xmlFiles.length, 1);
        const xml = await Deno.readTextFile(join(reportDir, xmlFiles[0]));
        assertStringIncludes(xml, 'name="passes"');
        assertStringIncludes(xml, 'time="');
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("isolated shards execute the whole fixture portfolio exactly once with real processes", async () => {
    const root = await Deno.makeTempDir({ prefix: "runwield-shard-policy-" });
    try {
        for (let index = 0; index < 5; index++) {
            await Deno.writeTextFile(
                join(root, `${index}.test.ts`),
                `Deno.test("case ${index}", async () => {
                    await Deno.writeTextFile(${JSON.stringify(join(root, `${index}.ran`))}, "ran\\n", { append: true });
                });\n`,
            );
        }
        const results = await Promise.all([1, 2, 3, 4].map((index) =>
            new Deno.Command(Deno.execPath(), {
                args: ["run", "-A", "scripts/run-tests.js", "--isolated", root, "--shard", `${index}/4`],
                stdout: "piped",
                stderr: "piped",
            }).output()
        ));
        for (const result of results) {
            assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
        }
        for (let index = 0; index < 5; index++) {
            assertEquals(await Deno.readTextFile(join(root, `${index}.ran`)), "ran\n");
        }
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("prepared dependencies preserve isolated execution and changed-source failures", async () => {
    const root = await Deno.makeTempDir({ prefix: "runwield-prepared-dependencies-" });
    const reports = join(root, "reports");
    try {
        const valuePath = join(root, "value.ts");
        await Deno.writeTextFile(valuePath, "export const value: number = 1;\n");
        for (const name of ["a", "b"]) {
            await Deno.writeTextFile(
                join(root, `${name}.test.ts`),
                `import chalk from "chalk";
                import { value } from "./value.ts";
                Deno.test("${name}", async () => {
                    const { default: stripAnsi } = await import("strip-ansi");
                    if (stripAnsi(chalk.red("loaded")) !== "loaded") throw new Error("npm imports failed");
                    if (value !== 1) throw new Error("changed source was executed");
                    await Deno.writeTextFile(${JSON.stringify(join(root, `${name}.json`))}, JSON.stringify({
                        pid: Deno.pid, home: Deno.env.get("HOME"), temp: Deno.env.get("TMPDIR"),
                        database: Deno.env.get("MNEMOTECA_DB_PATH"),
                    }));
                });\n`,
            );
        }
        const args = ["run", "-A", "scripts/run-tests.js", "--report-dir", reports, "--isolated", root];
        const command = new Deno.Command(Deno.execPath(), {
            args,
            env: { WLD_TEST_CONCURRENCY: "1" },
            stdout: "piped",
            stderr: "piped",
        });
        const passed = await command.output();
        const output = new TextDecoder().decode(passed.stdout) + new TextDecoder().decode(passed.stderr);
        assertEquals(passed.code, 0, output);
        assertStringIncludes(output, "2 files passed");
        assertEquals(output.trim().split("\n").length, 1, output);
        const a = JSON.parse(await Deno.readTextFile(join(root, "a.json")));
        const b = JSON.parse(await Deno.readTextFile(join(root, "b.json")));
        for (const key of ["pid", "home", "temp", "database"]) {
            assertEquals(a[key] === b[key], false, `${key} must remain isolated between files`);
        }

        // A prepared dependency directory must never cache application results
        // or conceal a newly failing test after a source edit.
        await Deno.writeTextFile(valuePath, "export const value: number = 2;\n");
        const failed = await command.output();
        assertEquals(failed.code, 1);
        const report = JSON.parse(await Deno.readTextFile(join(reports, "run.json")));
        assertEquals(report.completed, 2);
        assertEquals(report.failed, 2);
        for await (const entry of Deno.readDir(reports)) {
            if (!entry.name.endsWith(".xml")) continue;
            assertStringIncludes(await Deno.readTextFile(join(reports, entry.name)), "changed source was executed");
        }
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("release and PR require all source and Golden shards without cancelling siblings", async () => {
    for (const workflowName of ["release", "pr", "golden"]) {
        const workflow = await Deno.readTextFile(new URL(`../.github/workflows/${workflowName}.yml`, import.meta.url));
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
