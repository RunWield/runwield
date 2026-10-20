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

interface WorkflowStep {
    if?: string;
    uses?: string;
    run?: string;
    with?: Record<string, string>;
    env?: Record<string, string>;
}
interface WorkflowMatrixEntry {
    runner: string;
    arch?: string;
    phase?: string;
    shard?: number;
    asset?: string;
}
interface WorkflowJob {
    if?: string;
    uses?: string;
    needs?: string | string[];
    with?: Record<string, string>;
    "runs-on"?: string;
    steps?: WorkflowStep[];
    strategy?: {
        "fail-fast": boolean;
        "max-parallel"?: number;
        matrix: { runner?: string[]; shard?: number[]; include?: WorkflowMatrixEntry[] };
    };
}
interface GateWorkflow {
    name: string;
    on: Record<string, { inputs?: Record<string, { required: boolean; type: string }> } | null>;
    jobs: Record<string, WorkflowJob>;
    concurrency?: { "cancel-in-progress": boolean };
}
async function readGate(name: string): Promise<GateWorkflow> {
    const { load } = await import("js-yaml");
    return load(await fsReadFile(`.github/workflows/${name}.yml`, "utf8")) as GateWorkflow;
}

test("ordinary PRs keep only the Ubuntu source and Linux Golden portfolio", async () => {
    const pr = await readGate("pr");
    assertEquals(pr.name, "pr-gate");
    assertEquals(Object.keys(pr.jobs).sort(), ["ci", "ci-shards", "golden", "golden-shards"]);
    for (const name of ["ci-shards", "golden-shards"]) {
        assertEquals(pr.jobs[name]["runs-on"], "ubuntu-latest");
        assertEquals(pr.jobs[name].strategy?.matrix.shard, [1, 2, 3, 4]);
        assertEquals(pr.jobs[name].strategy?.["fail-fast"], false);
    }
    for (const name of ["ci", "golden"]) {
        assertEquals(pr.jobs[name].if, "always()");
        assertEquals(pr.jobs[name].needs, `${name}-shards`);
        assertEquals(pr.jobs[name].steps?.[0].run, `test '\${{ needs.${name}-shards.result }}' = 'success'`);
    }
    const { scripts } = await readPackageConfig();
    assertEquals(scripts.ci, "bun scripts/check-bun-runtime.ts && bun scripts/run-ci.ts");
});

test("platform checks are release-only, use the selected commit, and cannot silently skip private repositories", async () => {
    const release = await readGate("release");
    assertEquals(release.name, "release-gate");
    assertEquals(release.concurrency?.["cancel-in-progress"], false);
    const paths = await fsReaddir(".github/workflows");
    for (const platform of ["unix", "windows", "containers"]) {
        assertEquals(paths.includes(`bun-${platform}.yml`), false);
        const workflow = await readGate(`release-${platform}`);
        assertEquals(Object.keys(workflow.on).sort(), ["workflow_call", "workflow_dispatch"]);
        assertEquals(workflow.on.workflow_call?.inputs?.source_sha, {
            description: "Exact product commit selected by release-gate",
            required: true,
            type: "string",
        });
        assertEquals(workflow.concurrency, undefined, "A diagnostic run must not cancel a release call");
        const call = release.jobs[`${platform}-checks`];
        assertEquals(call.uses, `./.github/workflows/release-${platform}.yml`);
        assertEquals(call.needs, "metadata");
        assertEquals(call.with, {
            source_sha: "${{ needs.metadata.outputs.source_sha }}",
            build_version: "${{ needs.metadata.outputs.build_version }}",
            ...(platform === "containers"
                ? { legacy_recovery: "${{ needs.metadata.outputs.legacy_containers == 'true' }}" }
                : {}),
        });
        for (const [name, job] of Object.entries(workflow.jobs)) {
            assertEquals(
                job.if,
                platform === "containers"
                    ? name === "legacy-containers"
                        ? "inputs.legacy_recovery"
                        : "${{ !inputs.legacy_recovery }}"
                    : undefined,
                "Only frozen historical container recipes may select a compatibility job",
            );
            const checkouts = job.steps?.filter((step) => step.uses?.startsWith("actions/checkout@")) || [];
            assertEquals(checkouts.length, 1);
            assertEquals(checkouts[0].with?.ref, "${{ inputs.source_sha || github.sha }}");
            assertEquals(
                job.steps?.some((step) => /bun test\b|run-bun-tests\.ts/.test(step.run || "")),
                false,
            );
        }
    }
});

test("release matrix preserves native source and package coverage without duplicate Ubuntu source or a new Windows asset", async () => {
    const unix = await readGate("release-unix");
    assertEquals(unix.jobs.source.strategy?.matrix.runner, ["macos-latest"]);
    assertEquals(unix.jobs.source.strategy?.matrix.shard, [1, 2, 3, 4]);
    assertEquals(unix.jobs.package.strategy?.matrix.runner, ["ubuntu-latest", "macos-latest"]);
    const windows = (await readGate("release-windows")).jobs.native;
    assertEquals(windows.strategy?.["max-parallel"], 5);
    assertEquals(windows.strategy?.["fail-fast"], false);
    const entries = windows.strategy?.matrix.include || [];
    assertEquals(entries.length, 10);
    for (const arch of ["x64", "arm64"]) {
        assertEquals(
            entries.filter((entry) => entry.arch === arch && entry.phase === "source").map((entry) => entry.shard),
            [1, 2, 3, 4],
        );
        assertEquals(entries.filter((entry) => entry.arch === arch && entry.phase === "package").length, 1);
    }
    const release = await readGate("release");
    assertEquals(release.jobs.build.strategy?.matrix.include?.length, 5);
    const build = await fsReadFile(".github/workflows/release.yml", "utf8");
    assertEquals(build.includes("asset_suffix: windows-arm64"), false);
    assertEquals(
        release.jobs["native-package-check"].strategy?.matrix.include?.map((entry) => entry.asset),
        ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"],
    );
});

test("Windows source jobs reuse architecture-specific Snip binaries without installing Go on cache hits", async () => {
    const steps = (await readGate("release-windows")).jobs.native.steps || [];
    const cache = steps.find((step) => step.with?.key?.startsWith("snip-"));
    assertEquals(cache?.uses, "actions/cache@v4");
    assertEquals(cache?.if, "matrix.phase == 'source'");
    assertEquals(cache?.with?.key, "snip-${{ runner.os }}-${{ matrix.arch }}-v0.24.1");
    assertEquals(cache?.with?.path, "${{ runner.temp }}/runwield-ci-bin/snip.exe");
    const go = steps.find((step) => step.uses?.startsWith("actions/setup-go@"));
    assertEquals(go?.if, "matrix.phase == 'source' && steps.snip-cache.outputs.cache-hit != 'true'");
    const install = steps.find((step) => step.run?.includes("go install"))?.run || "";
    assertStringIncludes(install, "if (!(Test-Path -LiteralPath (Join-Path $env:GOBIN 'snip.exe'))) {");
    assertStringIncludes(install, "go install github.com/edouard-claude/snip/cmd/snip@v0.24.1");
    assertStringIncludes(install, "$env:GOBIN >> $env:GITHUB_PATH");
});

test("Windows source jobs verify cached OpenSSH archives before extraction", async () => {
    const steps = (await readGate("release-windows")).jobs.native.steps || [];
    const cache = steps.find((step) => step.with?.key?.startsWith("openssh-"));
    assertEquals(cache?.uses, "actions/cache@v4");
    assertEquals(cache?.if, "matrix.phase == 'source'");
    assertEquals(cache?.with?.key, "openssh-${{ runner.os }}-${{ matrix.arch }}-10.0.0.0p2-Preview");
    assertEquals(cache?.with?.path, "${{ runner.temp }}/openssh-cache");
    const prepare = steps.find((step) => step.run?.includes("OpenSSH archive checksum mismatch"));
    assertEquals(prepare?.if, "matrix.phase == 'source'");
    const script = prepare?.run || "";
    assertStringIncludes(script, "if (!(Test-Path -LiteralPath $zip)) {\n");
    assertStringIncludes(
        script,
        "}\nif ((Get-FileHash $zip -Algorithm SHA256).Hash -ne $hash) { throw 'OpenSSH archive checksum mismatch' }\n",
    );
    assertStringIncludes(script, "Expand-Archive $zip -DestinationPath $destination");
});

test("publication requires every product and source gate including actual package bytes", async () => {
    const workflow = await readGate("release");
    const release = workflow.jobs.release;
    const gates = [
        "ci",
        "golden",
        "release-check",
        "assets",
        "windows-package-check",
        "homebrew-check",
        "native-package-check",
        "unix-checks",
        "windows-checks",
        "containers-checks",
    ];
    assertEquals(release.needs, [
        "metadata",
        "docs-artifact",
        "ci",
        "golden",
        "release-check",
        "assets",
        "windows-package-check",
        "native-package-check",
        "homebrew-check",
        "unix-checks",
        "windows-checks",
        "containers-checks",
    ]);
    assertStringIncludes(release.if || "", "!cancelled()");
    for (const gate of gates) assertStringIncludes(release.if || "", `needs.${gate}.result == 'success'`);
    const native = workflow.jobs["native-package-check"];
    assertEquals(native.needs, ["metadata", "assets"]);
    assertEquals(
        native.steps?.find((step) => step.uses?.startsWith("actions/download-artifact@"))?.with?.name,
        "release-upload",
    );
    const check = native.steps?.find((step) => step.run?.includes("tar -xzf"))?.run || "";
    assertStringIncludes(check, "./native-package/wld --remote-preflight");
    assertStringIncludes(check, "artifact.version !== process.env.BUILD_VERSION");
    assertStringIncludes(check, "artifact.target !== process.env.TARGET");
    assertStringIncludes(check, "embedded.buildId !== artifact.buildId");
});
