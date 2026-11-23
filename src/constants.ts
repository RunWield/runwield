import { readOptionalEnv } from "@runwield/resources/home";
import { toolRegistry, type RoutingIntent } from "@runwield/tools";
export type { RoutingIntent, WorkKind } from "@runwield/tools";
export { PLANS_DIR_NAME, isPlannedChangeClassification } from "./plan-format/classification.ts";

export { CLI_BIN } from "./shared/cli-name.ts";
/**
 * @module constants
 * Shared constants for RunWield CLI orchestration.
 */

import { join } from "node:path";
import { cwd } from "node:process";
import { RUNWIELD_SOURCE_ROOT } from "../runtime-root.ts";
import { agentRegistry } from "./shared/session/agent-registry.ts";

export { describeUnsandboxedTestRun, getHomeDir, isTestModulePath } from "@runwield/resources/home";

/** Fallback source-run invocation used in contributor docs and local dev. */
export const DEV_CLI_RUN = "bun src/cli.ts";

/** Legacy project-local collaboration secret path, retained for migration and Git hazard checks. */
export const PROJECT_SECRET_STORE_RELATIVE_PATH = ".wld/collaboration-secrets.json";

/**
 * Primary project root used for RunWield metadata, settings, and command state.
 *
 * A function for the same reason as getHomeDir: Deno.cwd() is process-global and
 * each test realm loads this module at an arbitrary moment, so a `const` snapshot
 * could capture another test file's temporary chdir and keep it forever. Nothing
 * in production chdirs, so this reads identically there.
 */
export function getCwd() {
    return cwd();
}

/**
 * Resolve a bundled passive resource for file APIs, not module imports.
 * Assets embedded with `deno compile --include` are rooted under `src/` in
 * both source runs and the compiled virtual filesystem.
 */
function resolveBundledResourcePath(...parts: string[]) {
    return join(RUNWIELD_SOURCE_ROOT, ...parts);
}

/** Directory containing bundled default prompt template markdown files. */
export const PROMPT_TEMPLATES_DIR = resolveBundledResourcePath("prompt-templates");

/** Directory containing bundled default skill definitions. */
export const SKILLS_DIR = resolveBundledResourcePath("skills");

/** Directory containing bundled model preset definitions. */
export const MODEL_PRESETS_DIR = resolveBundledResourcePath("model-presets");

/** Path to the bundled sleep memory-maintenance prompt. */
export const SLEEP_PROMPT_PATH = resolveBundledResourcePath("cmd", "sleep", "prompt.md");

/** Directory containing bundled Snip filter definitions. */
export const SNIP_FILTERS_DIR = resolveBundledResourcePath("snip-filters");

/** Path to the bundled Catppuccin Mocha theme JSON. */
export const CATPPUCCIN_MOCHA_THEME_PATH = resolveBundledResourcePath("ui", "theme", "catppuccin-mocha.json");

export const { normalizeWorkKind, workKinds: WORK_KINDS } = toolRegistry.get("triage_report");

export type PlanClassification = Extract<RoutingIntent, "QUICK_FIX" | "PLANNED_CHANGE" | "PROJECT">;

export function formatPlannedWorkLabel(workKind: string | null | undefined) {
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
 */
export function getRunWieldRuntimeDir(projectRoot: string) {
    const sandboxHome = readOptionalEnv("WLD_TEST_SANDBOX_HOME");
    if (!sandboxHome) return join(projectRoot, RUNWIELD_DIR_NAME);
    // Keyed by project root so a test that does use its own project still gets its
    // own lock namespace, and readable so a stray file can be traced back.
    const slug =
        String(projectRoot)
            .replace(/[^a-zA-Z0-9._-]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(-80) || "project";
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

export const { primary: AGENTS, isolated: SUBAGENTS } = agentRegistry.ids;

/** Max concurrent read-only Delegated Agent Sessions per HostedSession. */
export const MAX_DELEGATED_READERS = 3;
