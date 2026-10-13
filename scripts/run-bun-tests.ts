/** Bun migration suite: one child process and disposable HOME/database per test file. */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { argv, env, execPath, platform } from "node:process";
import { fileURLToPath } from "node:url";
import { requirePinnedBun } from "./check-bun-runtime.ts";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FILE_TIMEOUT_MS = 10 * 60 * 1000;

interface TestResult {
    file: string;
    code: number;
    timedOut: boolean;
    elapsedMs: number;
    output: string;
}

async function isolatedEnvironment(home: string): Promise<Record<string, string>> {
    const childEnv: Record<string, string> = {};
    for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TERM", "TZ"]) {
        const value = env[key];
        if (value) childEnv[key] = value;
    }
    for (const key of ["WLD_TEST_SSHFS", "WLD_TEST_SSHFS_STALL"]) {
        if (env[key] === "1") childEnv[key] = "1";
    }
    Object.assign(childEnv, {
        HOME: home,
        USERPROFILE: home,
        WLD_TEST_SANDBOX_HOME: home,
        MNEMOTECA_DB_PATH: join(home, "mnemoteca-test.db"),
        SNIP_DB_PATH: join(home, "snip-tracking.db"),
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_CACHE_HOME: join(home, ".cache"),
        XDG_DATA_HOME: join(home, ".local", "share"),
        APPDATA: join(home, "AppData", "Roaming"),
        LOCALAPPDATA: join(home, "AppData", "Local"),
        ProgramData: join(home, "ProgramData"),
        TMPDIR: join(home, "tmp"),
        TEMP: join(home, "tmp"),
        TMP: join(home, "tmp"),
    });
    await Promise.all(
        [
            home,
            join(home, ".wld"),
            childEnv.XDG_CONFIG_HOME,
            childEnv.XDG_CACHE_HOME,
            childEnv.XDG_DATA_HOME,
            childEnv.APPDATA,
            childEnv.LOCALAPPDATA,
            childEnv.ProgramData,
            childEnv.TMPDIR,
        ].map((path) => mkdir(path, { recursive: true })),
    );
    if (platform === "win32") {
        // Git for Windows requires this opt-in for nested disposable worktrees.
        // Pin it to this private file so Golden HOME changes cannot read host config.
        childEnv.GIT_CONFIG_GLOBAL = join(home, ".gitconfig");
        await writeFile(childEnv.GIT_CONFIG_GLOBAL, "[core]\n\tlongpaths = true\n");
    }
    return childEnv;
}

async function runFile(file: string, home: string, reportDir: string, timeoutMs: number): Promise<TestResult> {
    const start = performance.now();
    const childEnv = await isolatedEnvironment(home);
    return await new Promise<TestResult>((resolveResult) => {
        const child = spawn(
            execPath,
            [
                "test",
                "--path-ignore-patterns=third_party/**",
                "--no-env-file",
                "--no-install",
                "--no-orphans",
                "--timeout",
                String(timeoutMs),
                `./${relative(REPO_ROOT, file).replaceAll("\\", "/")}`,
            ],
            {
                cwd: REPO_ROOT,
                env: childEnv,
                stdio: ["ignore", "pipe", "pipe"],
            },
        );
        let output = "";
        let timedOut = false;
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
        let forcedKill: ReturnType<typeof setTimeout> | undefined;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            forcedKill = setTimeout(() => child.kill("SIGKILL"), 2_000);
        }, timeoutMs);
        child.on("error", (error) => (output += `${error.message}\n`));
        child.on("close", (code) => {
            clearTimeout(timer);
            clearTimeout(forcedKill);
            resolveResult({
                file,
                code: timedOut ? 1 : (code ?? 1),
                timedOut,
                elapsedMs: performance.now() - start,
                output,
            });
        });
    }).then(async (result) => {
        await writeFile(join(reportDir, file.replace(/[^a-zA-Z0-9._-]/g, "_") + ".log"), result.output);
        return result;
    });
}

export async function main(args: string[] = argv.slice(2)): Promise<number> {
    requirePinnedBun();
    const selected: string[] = args.length
        ? args
        : JSON.parse(await readFile(new URL("./bun-test-files.json", import.meta.url), "utf8"));
    if (!selected.length) throw new Error("No Bun tests selected.");
    const files = [
        ...new Set(
            selected.map((file) => {
                const path = resolve(REPO_ROOT, file);
                const child = relative(REPO_ROOT, path);
                if (child.startsWith("..") || isAbsolute(child) || !/[._]test\.(?:[cm]?[jt]sx?)$/.test(file)) {
                    throw new Error(`Expected an in-repository test file, got ${file}`);
                }
                return path;
            }),
        ),
    ];
    const requested = Number(env.WLD_TEST_CONCURRENCY || 8);
    if (!Number.isSafeInteger(requested) || requested < 1) {
        throw new Error("WLD_TEST_CONCURRENCY must be a positive integer.");
    }
    const timeoutMs = Number(env.WLD_TEST_FILE_TIMEOUT_MS || FILE_TIMEOUT_MS);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
        throw new Error("WLD_TEST_FILE_TIMEOUT_MS must be a positive integer.");
    }
    // Nested Git worktrees repeat the sandbox path in their directory names.
    // Keep Windows roots short without changing per-file isolation or cleanup.
    const root = await realpath(await mkdtemp(join(tmpdir(), platform === "win32" ? "rw-" : "runwield-bun-tests-")));
    const reportsRoot = join(REPO_ROOT, ".ci-cache");
    await mkdir(reportsRoot, { recursive: true });
    const reportDir = await mkdtemp(join(reportsRoot, "bun-report-"));
    const results: TestResult[] = [];
    let next = 0;
    let failed = false;
    try {
        const workers = await Promise.allSettled(
            Array.from({ length: Math.min(requested, files.length) }, async () => {
                while (next < files.length) {
                    const index = next++;
                    const result = await runFile(files[index], join(root, String(index)), reportDir, timeoutMs);
                    results.push(result);
                    if (result.code !== 0) {
                        failed = true;
                        console.error(result.output);
                    }
                }
            }),
        );
        const rejected = workers.filter((worker) => worker.status === "rejected");
        if (rejected.length) {
            failed = true;
            throw new AggregateError(
                rejected.map((worker) => worker.reason),
                `Bun test workers failed; evidence: ${root}`,
            );
        }
        await writeFile(
            join(reportDir, "run.json"),
            JSON.stringify({ results, sandboxRoot: failed ? root : null }, null, 2) + "\n",
        );
        console.log(
            `Bun migration suite: ${
                results.length - results.filter((result) => result.code).length
            }/${files.length} files passed. Reports: ${reportDir}`,
        );
        if (failed) console.error(`Retained isolated failure evidence: ${root}`);
        return failed ? 1 : 0;
    } finally {
        if (!failed) await rm(root, { recursive: true, force: true });
    }
}

if (import.meta.main) process.exitCode = await main();
