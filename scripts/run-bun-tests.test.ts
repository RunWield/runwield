import { test } from "node:test";
import { equal, match, notEqual, ok } from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { env, execPath, versions } from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNNER = join(REPO_ROOT, "scripts", "run-bun-tests.ts");

interface CommandResult {
    code: number | null;
    output: string;
}

function run(args: string[], extraEnv: Record<string, string> = {}): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(execPath, args, {
            cwd: REPO_ROOT,
            env: { ...env, ...extraEnv },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (chunk) => (output += chunk.toString()));
        child.stderr.on("data", (chunk) => (output += chunk.toString()));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, output }));
    });
}

const isolatedCase = `
import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
test("each file has a fresh process and private state", () => {
    const home = process.env.HOME;
    equal(process.env.WLD_TEST_SANDBOX_HOME, home);
    equal(process.env.USERPROFILE, home);
    equal(process.env.ProgramData, join(home, "ProgramData"));
    equal(existsSync(process.env.ProgramData), true);
    equal(process.env.MNEMOTECA_DB_PATH, join(home, "mnemoteca-test.db"));
    equal(process.env.OPENAI_API_KEY, undefined);
    equal(process.env.WLD_TEST_SSHFS, "1");
    equal(process.env.WLD_TEST_SSHFS_STALL, "1");
    equal(existsSync(join(home, "claimed")), false);
    equal(existsSync(process.env.MNEMOTECA_DB_PATH), false);
    writeFileSync(join(home, "claimed"), "claimed");
    writeFileSync(process.env.MNEMOTECA_DB_PATH, "private database");
    console.log("ISOLATED_STATE=" + JSON.stringify({ home, pid: process.pid, tmp: process.env.TMPDIR }));
    equal(process.env.XDG_CONFIG_HOME, join(home, ".config"));
});
`;

interface IsolatedState {
    home: string;
    pid: number;
    tmp: string;
}
interface ReportResult {
    output: string;
    timedOut: boolean;
    code: number;
}
interface Report {
    results: ReportResult[];
    sandboxRoot: string | null;
}
async function readReport(output: string): Promise<Report> {
    const directory = /Reports: (.+)/.exec(output)?.[1];
    ok(directory, output);
    return JSON.parse(await readFile(join(directory, "run.json"), "utf8"));
}

for (const concurrency of [1, 2]) {
    test(
        `Bun runner isolates every file with ${concurrency} workers and removes successful sandboxes`,
        {
            skip: !versions.bun,
        },
        async () => {
            const fixture = await mkdtemp(join(REPO_ROOT, ".ci-cache", "bun-runner-fixture-"));
            try {
                const files = [join(fixture, "first.test.ts"), join(fixture, "second.test.ts")];
                await Promise.all(files.map((file) => writeFile(file, isolatedCase)));
                const result = await run([RUNNER, ...files], {
                    WLD_TEST_CONCURRENCY: String(concurrency),
                    OPENAI_API_KEY: "fixture-secret-never-forward",
                    WLD_TEST_SSHFS: "1",
                    WLD_TEST_SSHFS_STALL: "1",
                });
                equal(result.code, 0, result.output);
                const report = await readReport(result.output);
                equal(report.results.length, 2);
                const states: IsolatedState[] = report.results.map((entry) =>
                    JSON.parse(/ISOLATED_STATE=(.+)/.exec(entry.output)?.[1] || "null"),
                );
                notEqual(states[0].home, states[1].home);
                notEqual(states[0].pid, states[1].pid);
                notEqual(states[0].tmp, states[1].tmp);
                for (const state of states) {
                    await readFile(join(state.home, "claimed")).then(
                        () => {
                            throw new Error("Successful sandbox leaked");
                        },
                        (error) => equal(error.code, "ENOENT"),
                    );
                }
            } finally {
                await rm(fixture, { recursive: true, force: true });
            }
        },
    );
}

test("Bun direct tests are rejected before executing the body", { skip: !versions.bun }, async () => {
    const result = await run(["test", "./src/shared/private-json-file.test.ts"], {
        HOME: "",
        USERPROFILE: "",
        WLD_TEST_SANDBOX_HOME: "",
    });
    notEqual(result.code, 0);
    match(result.output, /Refusing unsandboxed Bun tests/);
    match(result.output, /0 pass/);
});

test("Bun runner reports assertion failure and retains isolated evidence", { skip: !versions.bun }, async () => {
    const fixture = await mkdtemp(join(REPO_ROOT, ".ci-cache", "bun-runner-failure-"));
    let report: Report | undefined;
    try {
        const file = join(fixture, "failure.test.ts");
        await writeFile(
            file,
            `import {test} from "node:test"; import {writeFileSync} from "node:fs"; import {join} from "node:path";
            test("expected failure", () => { writeFileSync(join(process.env.HOME, "failure-sentinel"), "retained bytes"); throw new Error("runner failure sentinel"); });`,
        );
        const result = await run([RUNNER, file]);
        equal(result.code, 1);
        match(result.output, /runner failure sentinel/);
        report = await readReport(result.output);
        ok(report.sandboxRoot);
        equal(report.results[0].code, 1);
        equal(await readFile(join(report.sandboxRoot, "0", "failure-sentinel"), "utf8"), "retained bytes");
    } finally {
        await rm(fixture, { recursive: true, force: true });
        if (report?.sandboxRoot) await rm(report.sandboxRoot, { recursive: true, force: true });
    }
});

test("Bun runner terminates an import that never settles", { skip: !versions.bun }, async () => {
    const fixture = await mkdtemp(join(REPO_ROOT, ".ci-cache", "bun-runner-timeout-"));
    let report: Report | undefined;
    try {
        const file = join(fixture, "hang.test.ts");
        await writeFile(file, "setInterval(() => {}, 1000); await new Promise(() => {});");
        const start = performance.now();
        const result = await run([RUNNER, file], { WLD_TEST_FILE_TIMEOUT_MS: "300" });
        equal(result.code, 1);
        ok(performance.now() - start < 5_000);
        report = await readReport(result.output);
        equal(report.results[0].timedOut, true);
    } finally {
        await rm(fixture, { recursive: true, force: true });
        if (report?.sandboxRoot) await rm(report.sandboxRoot, { recursive: true, force: true });
    }
});
