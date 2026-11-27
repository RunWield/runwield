import { readOptionalEnv } from "@runwield/resources/home";
import { join } from "node:path";

/** Legacy project-local collaboration secret path, retained for migration and Git hazard checks. */
export const PROJECT_SECRET_STORE_RELATIVE_PATH = ".wld/collaboration-secrets.json";

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
