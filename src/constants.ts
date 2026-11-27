import { toolRegistry } from "@runwield/tools";

export { CLI_BIN } from "./shared/cli-name.ts";
/**
 * @module constants
 * Shared constants for RunWield CLI orchestration.
 */

import { join } from "node:path";
import { cwd } from "node:process";
import { RUNWIELD_SOURCE_ROOT } from "../runtime-root.ts";

export { describeUnsandboxedTestRun, getHomeDir, isTestModulePath } from "@runwield/resources/home";

/** Fallback source-run invocation used in contributor docs and local dev. */
export const DEV_CLI_RUN = "bun src/cli.ts";

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

export function formatPlannedWorkLabel(workKind: string | null | undefined) {
    switch (toolRegistry.get("triage_report").normalizeWorkKind(workKind)) {
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

/** Git branch prefix for isolated execution worktrees. */
export const WORKTREE_BRANCH_PREFIX = "worktree/";

/** Max concurrent read-only Delegated Agent Sessions per HostedSession. */
export const MAX_DELEGATED_READERS = 3;
