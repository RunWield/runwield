import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { argv, env, platform, versions } from "node:process";

/**
 * Read an environment variable when permission is available.
 */
export function readOptionalEnv(name: string) {
    try {
        return env[name] || "";
    } catch {
        return "";
    }
}

// Every naming convention `deno test` discovers: `test.js`, `foo.test.js` and
// `foo_test.js`, in each supported extension. This must stay in step with Deno's
// discovery rules — a convention missing here is a test realm running unguarded,
// which is exactly how src/cmd/init/*_test.js slipped past an earlier version.
const TEST_MODULE_PATTERN = /(^|[/\\])(test|.+[._]test)\.(js|mjs|jsx|ts|tsx|mts)$/;

/**
 * Whether a path is a module `deno test` would collect. Exported so the guard's
 * coverage is assertable — see src/constants.test.js.
 */
export function isTestModulePath(path: string) {
    return TEST_MODULE_PATTERN.test(path);
}

// Bun's preload enforces the sandbox before imports; keep the module-level guard
// for subprocesses that enter through a test file or Node's test context.
const IS_TEST_REALM =
    isTestModulePath(argv[1] || "") ||
    Boolean(versions.bun && argv[1] === "test") ||
    Boolean(readOptionalEnv("NODE_TEST_CONTEXT"));

const UNSANDBOXED_TEST_RUN_MESSAGE =
    "Run the suite with `bun run test`, whose isolated runners point HOME and " +
    "MNEMOTECA_DB_PATH at a sandbox. Direct test commands can overwrite real ~/.wld and memory databases.";

// Fail the moment a test realm loads this module without the sandbox marker
// that only scripts/run-tests.ts sets. The lazy guard below is what makes the
// damage impossible; this makes the mistake obvious immediately, before a
// half-finished run leaves confusing state behind. Nearly every test reaches
// this module transitively, so it needs no per-file opt-in.
if (IS_TEST_REALM && !readOptionalEnv("WLD_TEST_SANDBOX_HOME")) {
    throw new Error(`Refusing to load RunWield modules in an unsandboxed test run. ${UNSANDBOXED_TEST_RUN_MESSAGE}`);
}

interface TestRunContext {
    isTestRealm: boolean;
    sandboxHome: string;
    homeDir: string;
}

/**
 * The rule behind the unsandboxed-test-run guard, as a pure function so it can
 * be asserted without mutating process-global state that concurrent tests read.
 * Returns the failure message, or null when resolution is safe.
 *
 * The check is whether the run is sandboxed at all, not which home was asked
 * for. Once scripts/run-tests.ts owns HOME, the developer's real home is simply
 * not reachable, so tests are free to point HOME wherever they like — at their
 * own temp directories, or at a fictional path like /home/tester for pure path
 * math. Without the sandbox there is nothing standing between the suite and the
 * real ~/.wld, so no home resolution is safe.
 */
export function describeUnsandboxedTestRun({ isTestRealm, sandboxHome, homeDir }: TestRunContext) {
    if (!isTestRealm || !homeDir || sandboxHome || isTempTestHome(homeDir)) return null;
    return (
        `Refusing to resolve a home directory (${homeDir}) during an unsandboxed test run. ` +
        UNSANDBOXED_TEST_RUN_MESSAGE
    );
}

function isTempTestHome(homeDir: string) {
    try {
        const tempDir = realpathSync(readOptionalEnv("TMPDIR") || "/tmp");
        const resolvedHome = realpathSync(homeDir);
        const child = relative(tempDir, resolvedHome);
        return child === "" || (!child.startsWith("..") && !isAbsolute(child));
    } catch {
        return false;
    }
}

/**
 * This is the single choke point every ~/.wld path resolves through, so failing
 * here stops the write before it happens rather than reporting it afterwards.
 */
function assertTestRunIsSandboxed(homeDir: string) {
    const failure = describeUnsandboxedTestRun({
        isTestRealm: IS_TEST_REALM,
        sandboxHome: readOptionalEnv("WLD_TEST_SANDBOX_HOME"),
        homeDir,
    });
    if (failure) throw new Error(failure);
}

/**
 * Resolve the user's home directory.
 *
 * Deliberately a function, not a `const`. HOME is process-global and mutable:
 * the test suite swaps it, and Deno initializes each test module's realm at an
 * arbitrary moment, so a snapshot taken at import time can capture a home that
 * no longer applies — which is how test runs came to write into the real
 * ~/.wld. Read it per call so every caller sees the current value.
 */
export function getHomeDir() {
    const homeDir = readOptionalEnv("HOME") || (platform === "win32" ? windowsHomeDir() : "");
    assertTestRunIsSandboxed(homeDir);
    return homeDir;
}

function windowsHomeDir() {
    const userProfile = readOptionalEnv("USERPROFILE");
    if (userProfile) return userProfile;
    const drive = readOptionalEnv("HOMEDRIVE");
    const path = readOptionalEnv("HOMEPATH");
    if (drive && path) return `${drive}${path}`;
    const localAppData = readOptionalEnv("LOCALAPPDATA");
    if (localAppData) return localAppData;
    return "";
}
