import { requirePinnedBun } from "./check-bun-runtime.ts";
import { tmpdir } from "node:os";
import {
    copyFile as fsCopyFile,
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readdir as fsReaddir,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import process from "node:process";
/**
 * Runs the test suite with each file in its own process and disposable home.
 *
 * Each file gets a fresh HOME, temporary directory and Mnemoteca database, even
 * when worker slots are reused. Only dependency caches and immutable fixture
 * templates may be shared. Mutable settings, stores, registries and locks stay
 * isolated; process-global environment or cwd changes cannot affect other files.
 *
 * Usage:
 *   bun scripts/run-tests.js                    isolated run of every test file
 *   bun scripts/run-tests.js --isolated <paths>  isolated run of matching files
 *
 * `--exclude <path>` removes matching files from discovery. `bun run test`
 * excludes the Golden portfolio; `bun run ci` includes source and Golden tests.
 * Type checking is a separate `bun run check` gate.
 *
 * Bun refuses legacy runtime permission flags instead of silently dropping
 * their restrictions. Only the frozen, installed dependency graph is used.
 */
import { retainTestEvidence } from "./retain-test-evidence.js";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath as fromFileUrl } from "node:url";
import { listCiFiles } from "./ci-files.ts";
import { runBoundedTest } from "./run-with-snip.ts";
import { mergeTestTimings, orderTestsByTiming, readTestTimings, writeTestTimings } from "./test-timings.js";

const TEST_FILE_TIMEOUT_MS = 10 * 60 * 1000;
const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));
const TEST_FILE_PATTERN = /(^|\/)(test|.+[._]test)\.(js|mjs|jsx|ts|tsx|mts)$/;
const SKIP_DIRS = new Set([
    "node_modules",
    "third_party",
    "dist",
    "bin",
    "_fresh",
    ".git",
    ".astro",
    ".history",
    ".wld",
]);
const DENO_SNIP_FILTER_FILES = [
    "deno-check.yaml",
    "deno-fmt.yaml",
    "deno-lint.yaml",
    "deno-test.yaml",
    "deno-task.yaml",
];

/** @param {string} dir @returns {AsyncGenerator<string>} */
async function* findTestFiles(dir) {
    for await (const entry of await fsReaddir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            yield* findTestFiles(join(dir, entry.name));
        } else if (!entry.name.startsWith("__debug") && TEST_FILE_PATTERN.test(entry.name)) {
            // Throwaway debug harnesses (files starting with `__debug`) never run in the
            // discovered suite; they are diagnosis scratch and may fail by design. Run one
            // explicitly by passing its path as an argument.
            yield join(dir, entry.name);
        }
    }
}

/**
 * @param {string} sandboxRoot
 * @param {string} name
 * @returns {Promise<Record<string, string>>}
 */
async function createSandboxEnv(sandboxRoot, name) {
    const home = join(sandboxRoot, name);
    const temp = join(home, "tmp");
    const snipFiltersDir = join(home, ".config", "snip", "filters");
    await Promise.all([
        fsMkdir(join(home, ".wld"), { recursive: true }),
        fsMkdir(join(home, "AppData", "Roaming"), { recursive: true }),
        fsMkdir(join(home, "AppData", "Local"), { recursive: true }),
        fsMkdir(join(home, "ProgramData"), { recursive: true }),
        fsMkdir(temp, { recursive: true }),
        fsMkdir(snipFiltersDir, { recursive: true }),
        fsMkdir(join(home, ".cache"), { recursive: true }),
        fsMkdir(join(home, ".local", "share"), { recursive: true }),
    ]);
    await Promise.all(
        DENO_SNIP_FILTER_FILES.map((fileName) =>
            fsCopyFile(join(REPO_ROOT, "src", "snip-filters", fileName), join(snipFiltersDir, fileName)),
        ),
    );
    if (process.platform === "win32") {
        await fsWriteFile(join(home, ".gitconfig"), "[core]\n\tlongpaths = true\n");
    }
    // WLD_TEST_SANDBOX_HOME is the marker src/constants.js refuses to run without.
    return {
        HOME: home,
        USERPROFILE: home,
        ...(process.platform === "win32" ? { GIT_CONFIG_GLOBAL: join(home, ".gitconfig") } : {}),
        APPDATA: join(home, "AppData", "Roaming"),
        LOCALAPPDATA: join(home, "AppData", "Local"),
        ProgramData: join(home, "ProgramData"),
        WLD_TEST_SANDBOX_HOME: home,
        MNEMOTECA_DB_PATH: join(home, "mnemoteca-test.db"),
        SNIP_DB_PATH: join(home, "snip-tracking.db"),
        TMPDIR: temp,
        TEMP: temp,
        TMP: temp,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_CACHE_HOME: join(home, ".cache"),
        XDG_DATA_HOME: join(home, ".local", "share"),
    };
}

/**
 * @typedef {Object} RunnerArguments
 * @property {string[]} excludedPaths absolute file or directory paths to drop from discovery
 * @property {boolean} failFast stop scheduling files after the first failure
 * @property {string | undefined} timingsFile timing history input and output path
 * @property {string | undefined} shard one-based shard index/count
 * @property {string | undefined} reportDir directory for per-test JUnit reports
 * @property {string | undefined} filter Deno-compatible test name substring or /regular expression/
 * @property {string[]} rest every remaining argument, in the order it was given
 */

/**
 * @param {string[]} args
 * @returns {RunnerArguments}
 */
export function parseRunnerArguments(args) {
    /** @type {string[]} */
    const excludedPaths = [];
    /** @type {string[]} */
    const rest = [];
    let failFast = false;
    let filter;
    let timingsFile;
    let reportDir;
    let shard = process.env["WLD_TEST_SHARD"];
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--filter" || arg.startsWith("--filter=")) {
            filter = arg === "--filter" ? args[++index] : arg.slice("--filter=".length);
            if (filter === undefined || filter.startsWith("--")) throw new Error("--filter requires a value.");
            continue;
        }
        if (arg === "--fail-fast") {
            failFast = true;
            continue;
        }
        if (arg === "--shard") {
            shard = args[++index];
            if (!shard) throw new Error("--shard requires index/count.");
            continue;
        }
        if (arg === "--report-dir") {
            const value = args[++index];
            if (!value) throw new Error("--report-dir requires a path.");
            reportDir = resolve(REPO_ROOT, value);
            continue;
        }
        if (arg === "--timings-file") {
            const value = args[++index];
            if (!value) throw new Error("--timings-file requires a path.");
            timingsFile = resolve(REPO_ROOT, value);
            continue;
        }
        if (arg !== "--exclude") {
            rest.push(arg);
            continue;
        }
        const value = args[++index];
        if (!value) throw new Error("--exclude requires a test file or directory.");
        excludedPaths.push(resolve(REPO_ROOT, value));
    }
    return { excludedPaths, failFast, timingsFile, reportDir, shard, filter, rest };
}

/**
 * Assign every file exactly once, independent of each runner's timing cache.
 * Sorting before round-robin assignment makes filesystem traversal irrelevant.
 * @param {string[]} files
 * @param {string | undefined} shard
 * @returns {string[]}
 */
export function selectTestShard(files, shard) {
    if (!shard) return files;
    const match = /^(\d+)\/(\d+)$/.exec(shard);
    const index = Number(match?.[1]);
    const count = Number(match?.[2]);
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index < 1 || count < index) {
        throw new Error(`Invalid test shard ${shard}; expected index/count with 1 <= index <= count.`);
    }
    return [...files].sort().filter((_file, position) => position % count === index - 1);
}

/**
 * @param {string} root
 * @param {string} file
 * @returns {boolean}
 */
function isPathAtOrBelow(root, file) {
    if (file === root) return true;
    const child = relative(root, file);
    return (
        child !== "" &&
        child !== "." &&
        !child.startsWith("..") &&
        !child.startsWith("/") &&
        !/^[A-Za-z]:[\\/]/.test(child)
    );
}

/**
 * @param {string} file
 * @param {string[]} excludedPaths
 * @returns {boolean}
 */
function isExcluded(file, excludedPaths) {
    return excludedPaths.some((excluded) => isPathAtOrBelow(excluded, file));
}

/**
 * @typedef {Object} SuiteOptions
 * @property {boolean} [failFast]
 * @property {string} [timingsFile]
 * @property {string} [reportDir]
 * @property {string} [shard]
 * @property {string} [filter]
 */

/**
 * @param {string} sandboxRoot
 * @param {string[]} [roots]
 * @param {string[]} [excludedPaths]
 * @param {SuiteOptions} [options]
 * @returns {Promise<number>} process exit code
 */
async function runIsolatedSuite(sandboxRoot, roots = [REPO_ROOT], excludedPaths = [], options = {}) {
    const suiteStart = performance.now();
    if (options.reportDir) await fsMkdir(options.reportDir, { recursive: true });
    const discovered = new Set();
    const repositoryFiles = (await listCiFiles(REPO_ROOT)).map((file) => resolve(REPO_ROOT, file));
    for (const root of roots) {
        const path = resolve(REPO_ROOT, root);
        const stat = await fsStat(path);
        if (stat.isFile()) {
            if (TEST_FILE_PATTERN.test(path)) discovered.add(path);
            continue;
        }
        if (isPathAtOrBelow(REPO_ROOT, path)) {
            for (const file of repositoryFiles) {
                if (
                    isPathAtOrBelow(path, file) &&
                    !basename(file).startsWith("__debug") &&
                    TEST_FILE_PATTERN.test(file)
                ) {
                    discovered.add(file);
                }
            }
            continue;
        }
        for await (const file of findTestFiles(path)) discovered.add(file);
    }
    const discoveredFiles = [...discovered].filter((file) => !isExcluded(file, excludedPaths)).sort();
    const previousTimings = options.timingsFile ? await readTestTimings(options.timingsFile) : {};
    const files = orderTestsByTiming(selectTestShard(discoveredFiles, options.shard), REPO_ROOT, previousTimings);

    let goldenFixtureRoot = "";
    if (files.some((file) => file.includes("/src/ui/tui/golden-scenarios/"))) {
        const { prepareGoldenRepositoryTemplates } = await import("../src/ui/tui/testing/isolated-environment.js");
        goldenFixtureRoot = join(sandboxRoot, "golden-fixtures");
        await prepareGoldenRepositoryTemplates(goldenFixtureRoot);
    }

    // Most integration work waits on Git and other subprocesses. Keep enough
    // independent files in flight to use the machine, with an explicit override
    // for smaller CI runners and concurrent local workloads.
    const configured = Number(process.env["WLD_TEST_CONCURRENCY"] || "");
    const concurrency =
        Number.isFinite(configured) && configured > 0
            ? Math.max(1, Math.floor(configured))
            : Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 8));
    const queue = [...files];
    /** @type {Array<{ file: string, failureLogPath: string }>} */
    const failures = [];
    /** @type {Array<{ file: string, durationMs: number }>} */
    const observedTimings = [];
    let completed = 0;
    let stopScheduling = false;
    const startedAt = Date.now();

    /** @param {number} slot */
    const worker = async (slot) => {
        let slotRuns = 0;
        while (queue.length > 0 && !stopScheduling) {
            const file = queue.shift();
            if (!file) return;
            const name = relative(REPO_ROOT, file);
            const fileStartedAt = Date.now();

            const env = await createSandboxEnv(sandboxRoot, `slot-${slot}-file-${slotRuns}`);
            for (const key of ["WLD_TEST_SSHFS", "WLD_TEST_SSHFS_STALL"]) {
                if (process.env[key] === "1") env[key] = "1";
            }

            for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TERM", "TZ"]) {
                if (process.env[key]) env[key] = process.env[key];
            }

            // Nested runner tests must exercise their entire fixture suite.
            env.WLD_TEST_SHARD = "";
            if (goldenFixtureRoot) env.WLD_GOLDEN_FIXTURE_ROOT = goldenFixtureRoot;
            slotRuns += 1;
            const reportArgs = options.reportDir
                ? [
                      "--reporter=junit",
                      `--reporter-outfile=${join(options.reportDir, `${name.replace(/[^a-zA-Z0-9.-]/g, "_")}.xml`)}`,
                  ]
                : [];
            const filterArgs =
                options.filter === undefined
                    ? []
                    : [
                          "--test-name-pattern",
                          options.filter.startsWith("/") && options.filter.endsWith("/")
                              ? options.filter.slice(1, -1)
                              : options.filter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
                      ];
            const testArgs = [
                "test",
                "--no-env-file",
                "--no-install",
                "--no-orphans",
                "--preload",
                join(REPO_ROOT, "scripts", "bun-test-sandbox.ts"),
                "--timeout",
                String(TEST_FILE_TIMEOUT_MS),
                ...reportArgs,
                ...filterArgs,
                file,
            ];
            const result = await runBoundedTest(testArgs, {
                command: process.execPath,
                clearEnv: true,
                cwd: REPO_ROOT,
                env,
                failureLabel: `tests (${name})`,
                timeoutMs: TEST_FILE_TIMEOUT_MS,
            });
            const durationMs = Date.now() - fileStartedAt;
            observedTimings.push({ file: name, durationMs });

            completed += 1;
            if (result.code !== 0) {
                failures.push({
                    file: name,
                    failureLogPath: result.failureLogPath || "failure log unavailable",
                });
                if (options.failFast) stopScheduling = true;
            }
        }
    };

    await Promise.all(Array.from({ length: concurrency }, (_unused, slot) => worker(slot)));

    failures.sort((left, right) => left.file.localeCompare(right.file));
    for (const failure of failures) console.log(`FAIL ${failure.file} — failure log: ${failure.failureLogPath}`);
    if (options.timingsFile) {
        await writeTestTimings(options.timingsFile, mergeTestTimings(previousTimings, observedTimings));
    }
    if (options.reportDir) {
        await fsWriteFile(
            join(options.reportDir, "run.json"),
            JSON.stringify(
                {
                    elapsedMs: performance.now() - suiteStart,
                    prewarmMs: 0,
                    concurrency,
                    shard: options.shard || null,
                    completed,
                    failed: failures.length,
                    skipped: files.length - completed,
                    files: observedTimings,
                },
                null,
                2,
            ) + "\n",
        );
    }
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
        `\n${failures.length === 0 ? "ok" : "FAILED"} | ${completed - failures.length} files passed | ` +
            `${failures.length} failed | ${files.length - completed} skipped (${seconds}s, ${concurrency} at a time)`,
    );
    return failures.length === 0 ? 0 : 1;
}

export async function main(args = process.argv.slice(2)) {
    requirePinnedBun();
    const {
        excludedPaths,
        failFast,
        filter,
        shard,
        timingsFile: requestedTimingsFile,
        reportDir: requestedReportDir,
        rest: runnerArgs,
    } = parseRunnerArguments(args);
    selectTestShard([], shard);

    const unsupported = runnerArgs.filter(
        (arg, index) => arg.startsWith("-") && !(index === 0 && arg === "--isolated"),
    );
    if (unsupported.length) {
        throw new Error(
            `Unsupported Bun test runner options: ${unsupported.join(", ")}. ` +
                "Deno runtime flags cannot be ignored. See docs/contributing.md#task-compatibility.",
        );
    }

    const sandboxRoot = await fsMkdtemp(join(tmpdir(), "runwield-test-sandboxes-"));
    // Return through finally so every isolated sandbox is cleaned before exit.
    let exitCode = 0;
    const suite =
        runnerArgs.some((arg) => arg.includes("src/ui/tui/golden-scenarios")) &&
        !excludedPaths.some((path) => path.endsWith("src/ui/tui/golden-scenarios"))
            ? "golden"
            : "tests";
    const reportsRoot = process.env["WLD_TEST_SANDBOX_HOME"] ? sandboxRoot : join(REPO_ROOT, ".ci-cache");
    const suffix = shard ? `-${shard.replace("/", "-of-")}` : "";
    const reportDir = requestedReportDir || join(reportsRoot, `${suite}${suffix}-report`);
    const timingsFile = requestedTimingsFile || join(reportsRoot, `${suite}${suffix}-timings.json`);
    try {
        if (runnerArgs[0] === "--isolated") {
            const roots = runnerArgs.slice(1);
            if (roots.length === 0) throw new Error("--isolated requires at least one test file or directory.");
            exitCode = await runIsolatedSuite(sandboxRoot, roots, excludedPaths, {
                failFast,
                filter,
                timingsFile,
                reportDir,
                shard,
            });
        } else if (runnerArgs.length > 0) {
            exitCode = await runIsolatedSuite(sandboxRoot, runnerArgs, excludedPaths, {
                failFast,
                filter,
                timingsFile,
                reportDir,
                shard,
            });
        } else {
            exitCode = await runIsolatedSuite(sandboxRoot, [REPO_ROOT], excludedPaths, {
                failFast,
                filter,
                timingsFile,
                reportDir,
                shard,
            });
        }
    } finally {
        if (exitCode !== 0) {
            const destination = `${sandboxRoot}-evidence`;
            await retainTestEvidence(sandboxRoot, destination);
            console.error(`Retained test evidence: ${destination}`);
        }
        await fsRm(sandboxRoot, { recursive: true }).catch(() => {});
    }
    return exitCode;
}

if (import.meta.main) process.exit(await main());
