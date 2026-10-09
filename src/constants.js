/**
 * @module constants
 * Shared constants for RunWield CLI orchestration.
 */

import { join } from "@std/path";
import { RUNWIELD_SOURCE_ROOT } from "../runtime-root.js";

/** Name of the installed CLI binary shown in user-facing docs/help. */
export const CLI_BIN = "wld";

/** Fallback source-run invocation used in contributor docs and local dev. */
export const DEV_CLI_RUN = "deno run -A --unstable-no-legacy-abort src/cli.ts";

/** Legacy project-local collaboration secret path, retained for migration and Git hazard checks. */
export const PROJECT_SECRET_STORE_RELATIVE_PATH = ".wld/collaboration-secrets.json";

/**
 * Primary project root used for RunWield metadata, settings, and command state.
 *
 * A function for the same reason as getHomeDir: Deno.cwd() is process-global and
 * each test realm loads this module at an arbitrary moment, so a `const` snapshot
 * could capture another test file's temporary chdir and keep it forever. Nothing
 * in production chdirs, so this reads identically there.
 *
 * @returns {string}
 */
export function getCwd() {
    return Deno.cwd();
}

/**
 * Resolve a bundled passive resource for file APIs, not module imports.
 * Assets embedded with `deno compile --include` are rooted under `src/` in
 * both source runs and the compiled virtual filesystem.
 *
 * @param {...string} parts
 * @returns {string}
 */
function resolveBundledResourcePath(...parts) {
    return join(RUNWIELD_SOURCE_ROOT, ...parts);
}

/** Directory containing bundled default agent definition markdown files. */
export const AGENT_DEFS_DIR = resolveBundledResourcePath("agent-definitions");

/** Directory containing bundled default prompt template markdown files. */
export const PROMPT_TEMPLATES_DIR = resolveBundledResourcePath("prompt-templates");

/** Directory containing bundled default skill definitions. */
export const SKILLS_DIR = resolveBundledResourcePath("skills");

/** Directory containing bundled model preset definitions. */
export const MODEL_PRESETS_DIR = resolveBundledResourcePath("model-presets");

/** Path to the bundled core system prompt template. */
export const SYSTEM_PROMPT_TEMPLATE_PATH = resolveBundledResourcePath("shared", "session", "SYSTEM_PROMPT_TEMPLATE.md");

/** Path to the bundled sleep memory-maintenance prompt. */
export const SLEEP_PROMPT_PATH = resolveBundledResourcePath("cmd", "sleep", "prompt.md");

/** Directory containing bundled Snip filter definitions. */
export const SNIP_FILTERS_DIR = resolveBundledResourcePath("snip-filters");

/** Path to the bundled Catppuccin Mocha theme JSON. */
export const CATPPUCCIN_MOCHA_THEME_PATH = resolveBundledResourcePath("ui", "theme", "catppuccin-mocha.json");

/** Allowed Routing Intent values emitted by the router. */
export const ROUTING_INTENTS = [
    "INQUIRY",
    "IDEATION",
    "OPERATION",
    "QUICK_FIX",
    "PLANNED_CHANGE",
    "FEATURE",
    "PROJECT",
];

/** Canonical planned-work Routing Intent and Plan Classification. */
export const ROUTING_INTENT_PLANNED_CHANGE = "PLANNED_CHANGE";

/** Legacy planned-work workflow label accepted for compatibility. */
export const LEGACY_ROUTING_INTENT_FEATURE = "FEATURE";

/** Work Kind values describe the nature of planned executable work. */
export const WORK_KINDS = ["BUG_FIX", "FEATURE", "REFACTOR", "MAINTENANCE", "DOCUMENTATION"];

/**
 * @param {unknown} value
 * @returns {"INQUIRY"|"IDEATION"|"OPERATION"|"QUICK_FIX"|"PLANNED_CHANGE"|"PROJECT"|null}
 */
export function normalizeRoutingIntent(value) {
    if (typeof value !== "string") return null;
    if (value === LEGACY_ROUTING_INTENT_FEATURE) return ROUTING_INTENT_PLANNED_CHANGE;
    return ROUTING_INTENTS.includes(value)
        ? /** @type {"INQUIRY"|"IDEATION"|"OPERATION"|"QUICK_FIX"|"PLANNED_CHANGE"|"PROJECT"} */ (value)
        : null;
}

/**
 * @param {unknown} value
 * @returns {"QUICK_FIX"|"PLANNED_CHANGE"|"PROJECT"}
 */
export function normalizePlanClassification(value) {
    if (typeof value !== "string") return ROUTING_INTENT_PLANNED_CHANGE;
    if (value === LEGACY_ROUTING_INTENT_FEATURE) return ROUTING_INTENT_PLANNED_CHANGE;
    if (value === ROUTING_INTENT_PLANNED_CHANGE || value === "PROJECT" || value === "QUICK_FIX") return value;
    return ROUTING_INTENT_PLANNED_CHANGE;
}

/** @param {unknown} value */
export function isPlannedChangeClassification(value) {
    return value === ROUTING_INTENT_PLANNED_CHANGE || value === LEGACY_ROUTING_INTENT_FEATURE;
}

/**
 * @param {unknown} value
 * @returns {"BUG_FIX"|"FEATURE"|"REFACTOR"|"MAINTENANCE"|"DOCUMENTATION"|undefined}
 */
export function normalizeWorkKind(value) {
    if (typeof value !== "string") return undefined;
    return WORK_KINDS.includes(value)
        ? /** @type {"BUG_FIX"|"FEATURE"|"REFACTOR"|"MAINTENANCE"|"DOCUMENTATION"} */ (value)
        : undefined;
}

/**
 * @param {unknown} workKind
 * @returns {string}
 */
export function formatPlannedWorkLabel(workKind) {
    switch (normalizeWorkKind(workKind)) {
        case "BUG_FIX":
            return "Planned bug fix";
        case "FEATURE":
            return "Planned feature";
        case "REFACTOR":
            return "Planned refactor";
        case "MAINTENANCE":
            return "Planned maintenance";
        case "DOCUMENTATION":
            return "Planned documentation";
        default:
            return "Planned change";
    }
}

/** Allowed complexity values emitted by triage. */
export const COMPLEXITIES = ["LOW", "MEDIUM", "HIGH"];

/** Project-relative directory path where plan markdown files are stored. */
export const PLANS_DIR_NAME = "docs/plans";

/** Directory name where canonical Work Record markdown files are stored. */
export const WORK_RECORDS_DIR_NAME = "docs/work-records";

/** User-facing label for the Work Records command group. */
export const WORK_RECORDS_COMMAND_LABEL = "wr";

/** Default bind host for the local read-only Plans Workspace. */
export const PLAN_UI_DEFAULT_HOST = "127.0.0.1";

/** Default Plans Workspace port. 0 asks the OS for an available random port. */
export const PLAN_UI_DEFAULT_PORT = 0;

/** Query parameter accepted for bootstrapping Workspace access. */
export const PLAN_UI_TOKEN_QUERY = "token";

/** Header accepted by read-only Workspace API endpoints. */
export const PLAN_UI_TOKEN_HEADER = "x-runwield-workspace-token";

/** User-facing label for the Plans Workspace subcommand. */
export const PLAN_UI_COMMAND_LABEL = "plans ui";

/** Directory name for project-local RunWield metadata. */
export const RUNWIELD_DIR_NAME = ".wld";

/** Directory name for current project-local runtime state below `.wld`. */
export const PROJECT_INTERNAL_RUNTIME_DIR_NAME = "internal";

/**
 * Directory holding a project's RunWield runtime state — locks and lifecycle
 * journals.
 *
 * Normally `<project>/.wld`. Under a sandboxed test run it moves into that run's
 * sandbox instead, because these files serialize work *per project* and every test
 * that does not build its own project uses the checkout as its project root. Two
 * test runs at once therefore contended on the same lock files in the developer's
 * repository, and the loser waited out the lock timeout — one run could block
 * another for minutes, and a killed run left a lock that blocked everything after
 * it. Namespacing by sandbox keeps the mechanism identical and simply stops one run
 * from being another run's concurrent writer.
 *
 * @param {string} projectRoot
 * @returns {string}
 */
export function getRunWieldRuntimeDir(projectRoot) {
    const sandboxHome = readOptionalEnv("WLD_TEST_SANDBOX_HOME");
    if (!sandboxHome) return join(projectRoot, RUNWIELD_DIR_NAME);
    // Keyed by project root so a test that does use its own project still gets its
    // own lock namespace, and readable so a stray file can be traced back.
    const slug = String(projectRoot).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(-80) ||
        "project";
    return join(sandboxHome, "project-runtime", slug, RUNWIELD_DIR_NAME);
}

/** Durable execution worktree registry filename inside .wld/. */
export const WORKTREE_REGISTRY_FILE = "worktrees.json";

/** Best-effort lock filename for serialized worktree registry updates. */
export const WORKTREE_REGISTRY_LOCK_FILE = "worktrees.lock";

/** Directory for short-lived Plan mutation locks. */
export const PLAN_LOCKS_DIR_NAME = "plan-locks";

/** Directory for durable lifecycle transition journals. */
export const PLAN_TRANSITIONS_DIR_NAME = "plan-transitions";

/** Directory for local transition recovery backups. */
export const PLAN_BACKUPS_DIR_NAME = "plan-backups";

/** Directory for local transition staging artifacts. */
export const PLAN_STAGING_DIR_NAME = "plan-staging";

/** Git branch prefix for isolated execution worktrees. */
export const WORKTREE_BRANCH_PREFIX = "worktree/";

/**
 * Read an environment variable when permission is available.
 *
 * @param {string} name
 * @returns {string}
 */
function readOptionalEnv(name) {
    try {
        return Deno.env.get(name) || "";
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
 *
 * @param {string} path
 * @returns {boolean}
 */
export function isTestModulePath(path) {
    return TEST_MODULE_PATTERN.test(path);
}

// Under `deno test`, Deno.mainModule is the test file for each realm, and it is
// never a test module under the wld binary or `deno run`. Evaluated once: a
// realm's main module cannot change.
const IS_TEST_REALM = (() => {
    try {
        return isTestModulePath(new URL(Deno.mainModule).pathname);
    } catch {
        return false;
    }
})();

const UNSANDBOXED_TEST_RUN_MESSAGE =
    "Run the suite with `deno task test` (or scripts/run-tests.js), which points HOME and MNEMOTECA_DB_PATH at a " +
    "sandbox. Running `deno test` directly lets tests overwrite the real ~/.wld and the real mnemoteca memory database.";

// Fail the moment a test realm loads this module without the sandbox marker
// that only scripts/run-tests.js sets. The lazy guard below is what makes the
// damage impossible; this makes the mistake obvious immediately, before a
// half-finished run leaves confusing state behind. Nearly every test reaches
// this module transitively, so it needs no per-file opt-in.
if (IS_TEST_REALM && !readOptionalEnv("WLD_TEST_SANDBOX_HOME")) {
    throw new Error(`Refusing to load RunWield modules in an unsandboxed test run. ${UNSANDBOXED_TEST_RUN_MESSAGE}`);
}

/**
 * The rule behind the unsandboxed-test-run guard, as a pure function so it can
 * be asserted without mutating process-global state that concurrent tests read.
 * Returns the failure message, or null when resolution is safe.
 *
 * The check is whether the run is sandboxed at all, not which home was asked
 * for. Once scripts/run-tests.js owns HOME, the developer's real home is simply
 * not reachable, so tests are free to point HOME wherever they like — at their
 * own temp directories, or at a fictional path like /home/tester for pure path
 * math. Without the sandbox there is nothing standing between the suite and the
 * real ~/.wld, so no home resolution is safe.
 *
 * @param {{ isTestRealm: boolean, sandboxHome: string, homeDir: string }} context
 * @returns {string | null}
 */
export function describeUnsandboxedTestRun({ isTestRealm, sandboxHome, homeDir }) {
    if (!isTestRealm || !homeDir || sandboxHome || isTempTestHome(homeDir)) return null;
    return `Refusing to resolve a home directory (${homeDir}) during an unsandboxed test run. ` +
        UNSANDBOXED_TEST_RUN_MESSAGE;
}

/**
 * @param {string} homeDir
 * @returns {boolean}
 */
function isTempTestHome(homeDir) {
    try {
        const tempDir = Deno.realPathSync(readOptionalEnv("TMPDIR") || "/tmp");
        const resolvedHome = Deno.realPathSync(homeDir);
        return resolvedHome === tempDir || resolvedHome.startsWith(`${tempDir}/`);
    } catch {
        return false;
    }
}

/**
 * This is the single choke point every ~/.wld path resolves through, so failing
 * here stops the write before it happens rather than reporting it afterwards.
 *
 * @param {string} homeDir
 */
function assertTestRunIsSandboxed(homeDir) {
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
 *
 * @returns {string}
 */
export function getHomeDir() {
    const homeDir = readOptionalEnv("HOME") || (Deno.build.os === "windows" ? windowsHomeDir() : "");
    assertTestRunIsSandboxed(homeDir);
    return homeDir;
}

/** @returns {string} */
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

/**
 * Canonical agent identifiers. Most values match an agent definition filename
 * (without the `.md` extension) in `src/agent-definitions/`. The display name
 * for standard agents is the `name:` field inside that file and must be loaded
 * via `getAgentDisplayName()` from `shared/session/agents.js` — never
 * hardcoded.
 *
 * `INIT`, `SLICER`, `REVIEWER`, `REVIEWER_FEEDBACK_ENGINEER`, and `DELEGATED`
 * are workflow-dispatched runtime agent identifiers. Their definitions live in
 * the hidden `SUBAGENTS` registry, not top-level agent discovery, so they do not
 * appear in `/agent` listings or hidden subagent targets.
 *
 * `PLAN_ENGINEER` and `FRONTEND_ENGINEER` are a third kind: workflow-only *root*
 * agents. Their definitions are ordinary top-level, project/home-overridable
 * files, and they become the visible conversational agent while an approved Plan
 * executes — but their `workflowOnly: true` front matter keeps them out of
 * `/agent` listings and manual selection. They are not isolated subagents.
 *
 * Manual QA is also dispatched through `SUBAGENTS`, but it intentionally uses
 * the normal `OPERATOR` runtime agent identifier for its isolated prompt.
 */
/** @type {Readonly<{ROUTER: string, GUIDE: string, OPERATOR: string, PLANNER: string, ARCHITECT: string, ENGINEER: string, PLAN_ENGINEER: string, FRONTEND_ENGINEER: string, RECORDER: string, REVIEWER: string, REVIEWER_FEEDBACK_ENGINEER: string, SLICER: string, IDEATOR: string, INIT: string, DELEGATED: string}>} */
export const AGENTS = Object.freeze({
    ROUTER: "router",
    GUIDE: "guide",
    OPERATOR: "operator",
    PLANNER: "planner",
    ARCHITECT: "architect",
    ENGINEER: "engineer",
    PLAN_ENGINEER: "plan-engineer",
    FRONTEND_ENGINEER: "frontend-engineer",
    RECORDER: "recorder",
    REVIEWER: "reviewer",
    REVIEWER_FEEDBACK_ENGINEER: "reviewer-feedback-engineer",
    SLICER: "slicer",
    IDEATOR: "ideator",
    INIT: "init",
    DELEGATED: "delegated",
});

/**
 * Hidden workflow-dispatched subagent definition identifiers. These are loader
 * registry keys, not necessarily the runtime `AgentDefinition.name` returned by
 * the registry entry.
 *
 * @type {Readonly<{DELEGATED: string, DELEGATED_READ: string, INIT: string, INTEGRATION_REVIEWER: string, MANUAL_QA: string, REVIEWER: string, REVIEWER_FEEDBACK_ENGINEER: string, SLICER: string}>}
 */
export const SUBAGENTS = Object.freeze({
    DELEGATED: "delegated",
    DELEGATED_READ: "delegated-read",
    INIT: "init",
    INTEGRATION_REVIEWER: "integration-reviewer",
    MANUAL_QA: "manual-qa",
    REVIEWER: "reviewer",
    REVIEWER_FEEDBACK_ENGINEER: "reviewer-feedback-engineer",
    SLICER: "slicer",
});

/** Max concurrent read-only Delegated Agent Sessions per HostedSession. */
export const MAX_DELEGATED_READERS = 3;
