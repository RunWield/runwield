/**
 * @module shared/worktree-registry
 * Durable registry for RunWield execution worktrees.
 */

import { dirname } from "@std/path";
import { readLockFileSnapshot, removeLockFileIfSnapshotMatches } from "./lock-file-snapshot.ts";
import { getLockHostname, isPidAlive } from "./process-liveness.ts";
import { CLI_BIN } from "../constants.js";
import { resolvePrimaryCheckoutRoot } from "./primary-checkout.ts";
import {
    enterProjectRuntime,
    resolveProjectRuntimeLayout,
    withProjectRuntimeReadScope,
} from "./project-runtime-layout.ts";
import { inspectPlanIdentityDocuments } from "./workflow/plan-diagnostic-evidence.ts";
import { assertPublicationAttempt } from "./workflow/publication-attempt.ts";

/** @typedef {import("./lock-file-snapshot.ts").LockFileSnapshot} LockFileSnapshot */

const LOCK_TIMEOUT_MS = 30_000;
const LOCK_RETRY_MS = 50;

/**
 * @typedef {Object} WorktreeRegistryEntry
 * @property {string} id
 * @property {string} planName
 * @property {string} [planId]
 * @property {string} baseBranch
 * @property {string} baseRef
 * @property {string} baseCommit
 * @property {string} [baseTree]
 * @property {string} [executionBaselineTree]
 * @property {string} branch
 * @property {string} path
 * @property {"planning"|"active"|"completed"|"execution_failed"|"validation_failed"|"validated"|"abandoned"} status
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {{ reason: string, recordedAt: string, candidates?: string[] }} [migrationIssue]
 * @property {import('./workflow/publication-attempt.ts').PublicationAttempt} [publication]
 */

/** @typedef {{ label: string, description: string, command?: string }} RegistryRecoveryAction */

/**
 * A registry read could not answer the question that was asked.
 *
 * The registry is RunWield's own bookkeeping, so "invariant violated" is not an
 * explanation the user can act on — it reads as RunWield failing at its paperwork
 * and handing over the bill. Carry the affected attempt ids and the commands that
 * resolve them so every surface can say what to do next.
 */
export class WorktreeRegistryAmbiguityError extends Error {
    /**
     * @param {string} message
     * @param {{ kind: string, entryIds: string[], planName?: string, recoveryActions: RegistryRecoveryAction[] }} details
     */
    constructor(message, details) {
        super(message);
        this.name = "WorktreeRegistryAmbiguityError";
        this.kind = details.kind;
        this.entryIds = details.entryIds;
        this.planName = details.planName;
        this.recoveryActions = details.recoveryActions;
    }
}

/**
 * @param {string} [planName]
 * @returns {RegistryRecoveryAction[]}
 */
function registryRecoveryActions(planName) {
    return [
        {
            label: "See every attempt RunWield knows about",
            description:
                "Reports the registry as it stands, including which attempts collide, without changing anything.",
            command: `${CLI_BIN} plans doctor`,
        },
        {
            label: "Let RunWield settle what it can prove",
            description:
                "Closes attempts that are provably finished or provably never started. Branches and worktree directories are never deleted.",
            command: `${CLI_BIN} plans doctor --repair`,
        },
        ...(planName
            ? [{
                label: "Choose which attempt survives",
                description:
                    "Plan Recovery lists the attempts for this Plan so you can continue, retry, merge, or abandon one.",
                command: `${CLI_BIN} load-plan ${planName}`,
            }]
            : []),
    ];
}

/**
 * @param {string} planName
 * @param {WorktreeRegistryEntry[]} entries
 */
function duplicateLiveAttemptError(planName, entries) {
    const described = entries.map((entry) => `${entry.id} (${entry.status})`).join(", ");
    return new WorktreeRegistryAmbiguityError(
        `${planName} has more than one unfinished worktree attempt — ${described} — so RunWield cannot tell which one ` +
            `holds your work. It is refusing to guess rather than validating or merging the wrong one. Nothing has been ` +
            `changed or deleted.`,
        {
            kind: "duplicate_live_attempt",
            entryIds: entries.map((entry) => entry.id),
            planName,
            recoveryActions: registryRecoveryActions(planName),
        },
    );
}

/**
 * Render an ambiguity into one block of prose plus copy-ready commands.
 *
 * Surfaces that can only carry a string — blocked lifecycle results, CLI stderr —
 * still have to give the user something to run, so the actions travel inline rather
 * than being dropped on the way out.
 *
 * @param {unknown} error
 * @returns {string | null} null when this is not a registry ambiguity
 */
export function describeRegistryAmbiguity(error) {
    if (!(error instanceof WorktreeRegistryAmbiguityError)) return null;
    const lines = [error.message, "", "What you can do:"];
    for (const action of error.recoveryActions) {
        lines.push(`- ${action.label}: ${action.description}`);
        if (action.command) lines.push(`    ${action.command}`);
    }
    return lines.join("\n");
}

/** @param {number} ms */
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
async function runGitResult(cwd, args) {
    const command = new Deno.Command("git", { args, cwd, stdout: "piped", stderr: "piped" });
    const { code, stdout, stderr } = await command.output();
    const decoder = new TextDecoder();
    return { code, stdout: decoder.decode(stdout), stderr: decoder.decode(stderr) };
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<string>}
 */
async function runGit(cwd, args) {
    const result = await runGitResult(cwd, args);
    if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`.trim());
    return result.stdout;
}

/**
 * Keep registry callers on the named registry path instead of rebuilding the
 * broader project runtime layout at each call site.
 *
 * @param {string} projectRoot
 */
export function getWorktreeRegistryPath(projectRoot) {
    return resolveProjectRuntimeLayout(projectRoot).primary.worktreeRegistryPath;
}

/**
 * Keep lock callers on the named registry lock path instead of rebuilding the
 * broader project runtime layout at each call site.
 *
 * @param {string} projectRoot
 */
export function getWorktreeRegistryLockPath(projectRoot) {
    return resolveProjectRuntimeLayout(projectRoot).primary.worktreeRegistryLockPath;
}

/**
 * @param {string} projectRoot
 * @param {WorktreeRegistryEntry[]} entries
 * @param {Array<{ name: string, attrs: { planId?: string, worktreeId?: string|null } }>} resources
 * @returns {Promise<boolean>}
 */
async function migrateLegacyRegistryEntries(projectRoot, entries, resources) {
    let changed = false;
    /** @type {Map<string, typeof resources>} */
    const byExactAttempt = new Map();
    for (const plan of resources) {
        if (typeof plan.attrs.planId !== "string" || typeof plan.attrs.worktreeId !== "string") continue;
        const key = `${plan.name}\0${plan.attrs.worktreeId}`;
        const matches = byExactAttempt.get(key) || [];
        matches.push(plan);
        byExactAttempt.set(key, matches);
    }
    /** @type {Map<string, Array<{ name: string, attrs: { planId?: string } }>>} */
    const byName = new Map();
    for (const plan of resources) {
        if (typeof plan.attrs.planId !== "string") continue;
        const matches = byName.get(plan.name) || [];
        matches.push(plan);
        byName.set(plan.name, matches);
    }
    const migrationIssues = [];
    // Exact worktreeId back-pointers first, in a pass of their own. A Plan naming
    // this exact attempt is real evidence; a matching Plan name is not. Resolving
    // the proven pairings before the guessed ones makes the outcome independent of
    // the order entries happen to sit in the file.
    for (const entry of entries) {
        if (entry.planId || !entry.planName) continue;
        const exactMatches = byExactAttempt.get(`${entry.planName}\0${entry.id}`) || [];
        const exactPlan = exactMatches.length === 1 ? exactMatches[0] : null;
        if (!exactPlan?.attrs.planId) continue;
        entry.planId = exactPlan.attrs.planId;
        delete entry.migrationIssue;
        changed = true;
    }
    for (const entry of entries) {
        if (entry.planId || !entry.planName) continue;
        const namedPlans = byName.get(entry.planName) || [];
        const plan = namedPlans.length === 1 ? namedPlans[0] : null;
        // Binding by Plan name alone can give two legacy attempts for one Plan the
        // same planId, which violates the one-live-attempt invariant and makes the
        // whole registry unreadable — every worktree command would then fail on data
        // RunWield itself migrated. Leave the id unset and record the conflict so
        // `wld plans doctor` can show both attempts and a human decides which
        // survives.
        const wouldDuplicateLiveAttempt = Boolean(
            plan?.attrs.planId && NONTERMINAL_STATUSES.has(entry.status) &&
                entries.some((other) =>
                    other.id !== entry.id && other.planId === plan.attrs.planId &&
                    NONTERMINAL_STATUSES.has(other.status)
                ),
        );
        if (plan?.attrs.planId && !wouldDuplicateLiveAttempt) {
            entry.planId = plan.attrs.planId;
            delete entry.migrationIssue;
            changed = true;
            continue;
        }
        if (!NONTERMINAL_STATUSES.has(entry.status)) continue;
        migrationIssues.push({
            id: entry.id,
            planName: entry.planName,
            reason: wouldDuplicateLiveAttempt
                ? "duplicate_live_attempt_for_plan"
                : namedPlans.length > 1
                ? "ambiguous_plan_name"
                : "plan_not_found_or_missing_plan_id",
            candidates: namedPlans.map((candidate) => candidate.name),
            recordedAt: new Date().toISOString(),
        });
    }
    if (migrationIssues.length > 0) {
        const path = resolveProjectRuntimeLayout(projectRoot).primary.worktreeRegistryMigrationIssuesPath;
        await Deno.mkdir(dirname(path), { recursive: true });
        await Deno.writeTextFile(path, JSON.stringify({ version: 1, issues: migrationIssues }, null, 2));
    }
    return changed;
}

/**
 * @param {WorktreeRegistryEntry[]} entries
 * @returns {boolean}
 */
function hasUnresolvedLegacyNonterminalEntries(entries) {
    return entries.some((entry) => !entry.planId && NONTERMINAL_STATUSES.has(entry.status));
}

/**
 * @param {string} projectRoot
 * @param {{ migrate?: boolean, planResources?: Array<{ name: string, attrs: { planId?: string, worktreeId?: string|null } }> }} [options]
 * @returns {Promise<WorktreeRegistryEntry[]>}
 */
async function readRegistry(projectRoot, options = {}) {
    const layout = await enterProjectRuntime(projectRoot);
    try {
        const inspected = await inspectWorktreeRegistryAtPath(layout.primary.worktreeRegistryPath);
        if (inspected.readError) throw inspected.readError;
        if (inspected.version > 2) {
            throw new Error(`Unsupported worktree registry schema version: ${inspected.version}`);
        }
        const malformed = inspected.integrityIssues.find((issue) => issue.kind === "malformed_registry");
        if (malformed) throw new Error(malformed.message);
        const duplicateId = inspected.integrityIssues.find((issue) => issue.kind === "duplicate_worktree_id");
        if (duplicateId) {
            throw new WorktreeRegistryAmbiguityError(
                `Worktree id ${
                    duplicateId.ids[0]
                } appears more than once in the registry, so RunWield cannot tell which ` +
                    `attempt any command means. Nothing has been changed or deleted.`,
                {
                    kind: "duplicate_worktree_id",
                    entryIds: duplicateId.ids,
                    recoveryActions: registryRecoveryActions(),
                },
            );
        }
        const entries = inspected.entries;
        const migrated = options.migrate === false || !Array.isArray(options.planResources)
            ? false
            : await migrateLegacyRegistryEntries(projectRoot, entries, options.planResources);
        // Reading is deliberately permissive. Two unfinished attempts for one Plan
        // make *that Plan's* lookups ambiguous; they say nothing about any other
        // Plan, and refusing every read over it made one damaged record disable every
        // worktree command in the project — including the ones that diagnose it. The
        // guard that matters is on the write side: `addEntry` and `updateEntry` still
        // refuse to create a second live attempt, so a permissive read cannot let one
        // in. Lookups below fail only when the entry they were asked for is the
        // ambiguous one.
        const hasUnresolvedLegacy = hasUnresolvedLegacyNonterminalEntries(entries);
        if (
            options.migrate !== false &&
            ((migrated && !hasUnresolvedLegacy) || (inspected.version < 2 && !hasUnresolvedLegacy))
        ) {
            await writeRegistry(projectRoot, entries);
        }
        return entries;
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return [];
        throw error;
    }
}

const NONTERMINAL_STATUSES = new Set([
    "planning",
    "active",
    "completed",
    "execution_failed",
    "validation_failed",
    "validated",
]);

/** @param {WorktreeRegistryEntry} entry */
function registryPlanKey(entry) {
    return entry.planId || entry.planName;
}

/**
 * @param {WorktreeRegistryEntry[]} entries
 * @param {WorktreeRegistryEntry} candidate
 */
function assertNoDuplicateNonterminalAttempt(entries, candidate) {
    if (!NONTERMINAL_STATUSES.has(candidate.status)) return;
    if (!candidate.planId) return;
    const key = registryPlanKey(candidate);
    const duplicate = entries.find((entry) =>
        entry.id !== candidate.id && entry.planId && registryPlanKey(entry) === key &&
        NONTERMINAL_STATUSES.has(entry.status)
    );
    if (duplicate) throw duplicateLiveAttemptError(candidate.planName, [duplicate, candidate]);
}

/**
 * @param {string} projectRoot
 * @param {WorktreeRegistryEntry[]} entries
 */
async function writeRegistry(projectRoot, entries) {
    const path = (await enterProjectRuntime(projectRoot)).primary.worktreeRegistryPath;
    await Deno.mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${crypto.randomUUID()}.tmp`;
    const payload = `${JSON.stringify({ version: 2, entries }, null, 2)}\n`;
    try {
        const file = await Deno.open(tmp, { create: true, write: true, truncate: true });
        try {
            await file.write(new TextEncoder().encode(payload));
            await file.sync();
        } finally {
            file.close();
        }
        await Deno.rename(tmp, path);
        const dir = await Deno.open(dirname(path), { read: true });
        try {
            await dir.sync();
        } finally {
            dir.close();
        }
    } catch (error) {
        await Deno.remove(tmp).catch(() => {});
        throw error;
    }
}

/** @param {LockFileSnapshot} snapshot */
async function isStaleLock(snapshot) {
    try {
        const parsed = JSON.parse(snapshot.text);
        const age = Date.now() - Number(parsed.createdAtMs || 0);
        if (parsed.hostname && parsed.hostname === getLockHostname()) {
            return !(await isPidAlive(Number(parsed.pid)));
        }
        return age > LOCK_TIMEOUT_MS;
    } catch {
        return Date.now() - snapshot.mtime > LOCK_TIMEOUT_MS;
    }
}

/**
 * Run a registry mutation/read under a best-effort file lock at an exact path.
 * @template T
 * @param {string} lockPath
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withWorktreeRegistryLockAtPath(lockPath, fn) {
    await Deno.mkdir(dirname(lockPath), { recursive: true });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    const token = crypto.randomUUID();

    while (true) {
        try {
            const file = await Deno.open(lockPath, { createNew: true, write: true });
            try {
                const payload = JSON.stringify({
                    token,
                    pid: Deno.pid,
                    hostname: getLockHostname(),
                    createdAtMs: Date.now(),
                });
                await file.write(new TextEncoder().encode(payload));
                await file.sync();
            } finally {
                file.close();
            }
            break;
        } catch (error) {
            if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
            const snapshot = await readLockFileSnapshot(lockPath);
            if (!snapshot) continue;
            if (await isStaleLock(snapshot) && await removeLockFileIfSnapshotMatches(lockPath, snapshot)) {
                continue;
            }
            if (Date.now() > deadline) throw new Error(`Timed out waiting for worktree registry lock: ${lockPath}`);
            await delay(LOCK_RETRY_MS);
        }
    }

    try {
        return await fn();
    } finally {
        const snapshot = await readLockFileSnapshot(lockPath);
        if (snapshot?.token === token) await removeLockFileIfSnapshotMatches(lockPath, snapshot);
    }
}

/**
 * Run a registry mutation/read under a best-effort file lock.
 * @template T
 * @param {string} projectRoot
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withWorktreeRegistryLock(projectRoot, fn) {
    return await withProjectRuntimeReadScope(async () => {
        const layout = await enterProjectRuntime(projectRoot);
        return await withWorktreeRegistryLockAtPath(layout.primary.worktreeRegistryLockPath, fn);
    });
}

/**
 * Read the registry at an exact path without enforcing every invariant.
 *
 * Never mutates or migrates. Diagnosis and layout migration must not change what
 * they are diagnosing.
 *
 * @param {string} registryPath
 * @returns {Promise<{ version: number, entries: WorktreeRegistryEntry[], integrityIssues: Array<{ kind: string, message: string, ids: string[] }>, readError?: Error }>}
 */
export async function inspectWorktreeRegistryAtPath(registryPath) {
    /** @type {Array<{ kind: string, message: string, ids: string[] }>} */
    const integrityIssues = [];
    let text;
    try {
        text = await Deno.readTextFile(registryPath);
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return { version: 2, entries: [], integrityIssues };
        return {
            version: 0,
            entries: [],
            integrityIssues,
            readError: error instanceof Error ? error : new Error(String(error)),
        };
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        return {
            version: 0,
            entries: [],
            integrityIssues,
            readError: error instanceof Error ? error : new Error(String(error)),
        };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        integrityIssues.push({
            kind: "malformed_registry",
            message: "The worktree registry root must be an object.",
            ids: [],
        });
        return { version: 0, entries: [], integrityIssues };
    }
    const version = typeof parsed.version === "number" ? parsed.version : 1;
    if (version !== 1 && version !== 2) {
        integrityIssues.push({
            kind: "unsupported_schema_version",
            message: `Registry schema version ${version} is not supported by this RunWield.`,
            ids: [],
        });
    }
    if (!Array.isArray(parsed.entries)) {
        integrityIssues.push({
            kind: "malformed_registry",
            message: "The worktree registry entries field must be an array.",
            ids: [],
        });
        return { version, entries: [], integrityIssues };
    }
    const entries = /** @type {WorktreeRegistryEntry[]} */ (parsed.entries);
    /** @type {Map<string, string[]>} */
    const byId = new Map();
    for (const entry of entries) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            integrityIssues.push({
                kind: "malformed_registry_entry",
                message: "Registry entries must be objects.",
                ids: [],
            });
            continue;
        }
        const missing = [];
        if (typeof entry.id !== "string" || !entry.id) missing.push("id");
        if (typeof entry.planName !== "string" || !entry.planName) missing.push("planName");
        if (typeof entry.baseBranch !== "string" || !entry.baseBranch) missing.push("baseBranch");
        if (typeof entry.baseRef !== "string" || !entry.baseRef) missing.push("baseRef");
        if (typeof entry.baseCommit !== "string" || !entry.baseCommit) missing.push("baseCommit");
        if (typeof entry.branch !== "string" || !entry.branch) missing.push("branch");
        if (typeof entry.path !== "string" || !entry.path) missing.push("path");
        if (typeof entry.status !== "string" || !entry.status) missing.push("status");
        if (missing.length > 0) {
            integrityIssues.push({
                kind: "malformed_registry_entry",
                message: `Registry entry ${String(entry.id || "<missing>")} is missing ${missing.join(", ")}.`,
                ids: typeof entry.id === "string" ? [entry.id] : [],
            });
        }
        if ("publication" in entry) {
            try {
                assertPublicationAttempt(
                    /** @type {import('./workflow/publication-attempt.ts').PublicationAttempt} */ (entry.publication),
                );
            } catch (error) {
                integrityIssues.push({
                    kind: "malformed_registry_entry",
                    message: error instanceof Error ? error.message : String(error),
                    ids: typeof entry.id === "string" ? [entry.id] : [],
                });
            }
        }
        if (typeof entry.id === "string") {
            const ids = byId.get(entry.id) || [];
            ids.push(entry.id);
            byId.set(entry.id, ids);
        }
    }
    for (const [id, ids] of byId) {
        if (ids.length > 1) {
            integrityIssues.push({
                kind: "duplicate_worktree_id",
                message: `Worktree id ${id} appears ${ids.length} times, so attempt lookups are ambiguous.`,
                ids: [id],
            });
        }
    }
    /** @type {Map<string, WorktreeRegistryEntry[]>} */
    const liveByPlan = new Map();
    /** @type {Map<string, WorktreeRegistryEntry[]>} */
    const legacyLiveByPlanName = new Map();
    for (const entry of entries) {
        if (!NONTERMINAL_STATUSES.has(entry.status)) continue;
        if (entry.planId) {
            const live = liveByPlan.get(entry.planId) || [];
            live.push(entry);
            liveByPlan.set(entry.planId, live);
        } else if (entry.planName) {
            const live = legacyLiveByPlanName.get(entry.planName) || [];
            live.push(entry);
            legacyLiveByPlanName.set(entry.planName, live);
        }
    }
    for (const [planId, live] of liveByPlan) {
        if (live.length > 1) {
            integrityIssues.push({
                kind: "duplicate_live_attempt",
                message: `Plan ${live[0].planName} (${planId}) has ${live.length} unfinished attempts: ${
                    live.map((entry) => `${entry.id} (${entry.status})`).join(", ")
                }.`,
                ids: live.map((entry) => entry.id),
            });
        }
    }
    for (const [planName, live] of legacyLiveByPlanName) {
        if (live.length > 1) {
            integrityIssues.push({
                kind: "duplicate_live_attempt",
                message: `Plan ${planName} has ${live.length} unfinished legacy attempts: ${
                    live.map((entry) => `${entry.id} (${entry.status})`).join(", ")
                }.`,
                ids: live.map((entry) => entry.id),
            });
        }
    }
    return { version, entries, integrityIssues };
}

/**
 * Read the registry without enforcing its invariants.
 *
 * Every other reader fails closed on a violated invariant, which is right for
 * code about to mutate an attempt and wrong for the tool whose job is to explain
 * the violation. `listEntries()` throwing means a diagnostic built on it reports
 * "registry could not be loaded" and loses every per-entry fact it needed — the
 * user is told their file is broken and handed nothing to act on. This returns the
 * entries as they are, plus what is wrong with them.
 *
 * Never mutates or migrates. Diagnosis must not change what it is diagnosing.
 *
 * @param {string} projectRoot
 * @returns {Promise<{ version: number, entries: WorktreeRegistryEntry[], integrityIssues: Array<{ kind: string, message: string, ids: string[] }>, readError?: Error }>}
 */
export async function inspectWorktreeRegistry(projectRoot) {
    const layout = await enterProjectRuntime(projectRoot);
    return await inspectWorktreeRegistryAtPath(layout.primary.worktreeRegistryPath);
}

/** @param {string} projectRoot @param {{ migrate?: boolean }} [options] */
export async function listEntries(projectRoot, options = {}) {
    return await withProjectRuntimeReadScope(async () => {
        const inspection = options.migrate === false ? null : await inspectWorktreeRegistry(projectRoot);
        const needsIdentityMigration = inspection?.entries.some((entry) => !entry.planId);
        const planResources = inspection && needsIdentityMigration
            ? await inspectPlanIdentityDocuments(resolvePrimaryCheckoutRoot(projectRoot), inspection.entries).catch(
                () => [],
            )
            : undefined;
        return await withWorktreeRegistryLock(
            projectRoot,
            () => readRegistry(projectRoot, { ...options, planResources }),
        );
    });
}

/**
 * @param {string} projectRoot
 * @param {WorktreeRegistryEntry} entry
 */
export async function addEntry(projectRoot, entry) {
    return await withWorktreeRegistryLock(projectRoot, async () => {
        const entries = await readRegistry(projectRoot);
        if (typeof entry.planId !== "string" || !entry.planId) {
            throw new Error(`Worktree registry entry ${entry.id} requires a stable planId.`);
        }
        if (entries.some((existing) => existing.id === entry.id)) {
            throw new Error(`Worktree registry entry already exists: ${entry.id}`);
        }
        assertNoDuplicateNonterminalAttempt(entries, entry);
        entries.push(entry);
        await writeRegistry(projectRoot, entries);
        return entry;
    });
}

/**
 * @param {string} projectRoot
 * @param {string} id
 * @param {Partial<WorktreeRegistryEntry>} updates
 * @returns {Promise<WorktreeRegistryEntry|null>}
 */
export async function updateEntry(projectRoot, id, updates) {
    return await withWorktreeRegistryLock(projectRoot, async () => {
        const entries = await readRegistry(projectRoot);
        const index = entries.findIndex((entry) => entry.id === id);
        if (index === -1) throw new Error(`Worktree registry entry not found: ${id}`);
        const immutableKeys = [
            "id",
            "planName",
            "planId",
            "baseBranch",
            "baseRef",
            "baseCommit",
            "baseTree",
            "branch",
            "path",
        ];
        for (const key of immutableKeys) {
            if (
                Object.hasOwn(updates, key) && /** @type {Record<string, unknown>} */
                (updates)[key] !== /** @type {Record<string, unknown>} */ (entries[index])[key]
            ) {
                throw new Error(`Worktree registry identity field cannot be updated: ${key}`);
            }
        }
        entries[index] = { ...entries[index], ...updates, updatedAt: updates.updatedAt || new Date().toISOString() };
        assertNoDuplicateNonterminalAttempt(entries.filter((entry) => entry.id !== id), entries[index]);
        await writeRegistry(projectRoot, entries);
        return entries[index];
    });
}

/**
 * @typedef {Object} PlanningWorktreeBase
 * @property {string} baseRef
 * @property {string} baseCommit
 * @property {string} baseTree
 */

/**
 * Advance a planning checkout's baseline after importing published child work.
 * Once execution starts its original baseline is immutable.
 * @param {string} projectRoot
 * @param {string} id
 * @param {string} expectedBaseCommit
 * @param {PlanningWorktreeBase} base
 * @returns {Promise<WorktreeRegistryEntry>}
 */
export async function refreshPlanningWorktreeBase(projectRoot, id, expectedBaseCommit, base) {
    return await withWorktreeRegistryLock(projectRoot, async () => {
        const entries = await readRegistry(projectRoot);
        const entry = entries.find((entry) => entry.id === id);
        if (!entry) throw new Error(`Worktree registry entry not found: ${id}`);
        if (entry.status !== "planning" || entry.executionBaselineTree || entry.publication) {
            throw new Error(`Cannot refresh the baseline of an execution worktree: ${id}`);
        }
        if (entry.baseCommit !== expectedBaseCommit) throw new Error(`Planning worktree baseline changed: ${id}`);
        Object.assign(entry, base, { updatedAt: new Date().toISOString() });
        await writeRegistry(projectRoot, entries);
        return entry;
    });
}

/**
 * Rename a restored document without changing its stable Plan or attempt identity.
 * Ordinary registry updates cannot rename an attempt. Only the archive transaction,
 * holding the document/catalog locks, may move this address. Publication receipts
 * bind the original path and must never be renamed underneath a pending publication.
 * @param {string} projectRoot
 * @param {string} id
 * @param {string} expectedName
 * @param {string} nextName
 */
export async function renameRestoredPlanEntry(projectRoot, id, expectedName, nextName) {
    return await withWorktreeRegistryLock(projectRoot, async () => {
        const entries = await readRegistry(projectRoot);
        const entry = entries.find((candidate) => candidate.id === id);
        if (!entry || entry.planName !== expectedName) {
            throw new Error(
                "The Plan location changed while restoring it. Its archived copy has been preserved; retry the restore.",
            );
        }
        if (entry.publication) {
            throw new Error(
                `Restore this Plan without --to first. Its saved publication uses ${expectedName}; finish publishing before renaming it.`,
            );
        }
        if (
            entries.some((candidate) =>
                candidate.id !== id && candidate.planName === nextName && NONTERMINAL_STATUSES.has(candidate.status)
            )
        ) {
            throw new Error(
                `Another execution already uses the Plan name ${nextName}. Choose a different restore name.`,
            );
        }
        entry.planName = nextName;
        entry.updatedAt = new Date().toISOString();
        await writeRegistry(projectRoot, entries);
        return entry;
    });
}

/**
 * Compare-and-swap the durable publication authority for one execution attempt.
 * A stale process cannot overwrite a phase another process has already proven.
 *
 * @param {string} projectRoot
 * @param {string} id
 * @param {number | null} expectedRevision null creates the first record
 * @param {import('./workflow/publication-attempt.ts').PublicationAttempt} publication
 */
export async function updatePublication(projectRoot, id, expectedRevision, publication) {
    return await withWorktreeRegistryLock(projectRoot, async () => {
        const entries = await readRegistry(projectRoot);
        const index = entries.findIndex((entry) => entry.id === id);
        if (index === -1) throw new Error(`Worktree registry entry not found: ${id}`);
        const current = entries[index].publication;
        const currentRevision = current?.revision ?? null;
        if (currentRevision !== expectedRevision) {
            throw new Error(
                `Publication attempt ${id} changed concurrently: expected revision ${String(expectedRevision)}, ` +
                    `found ${String(currentRevision)}.`,
            );
        }
        assertPublicationAttempt(publication);
        if (publication.attemptId !== id) {
            throw new Error(`Publication attempt id ${publication.attemptId} does not match registry entry ${id}.`);
        }
        entries[index] = {
            ...entries[index],
            status: "validated",
            publication,
            updatedAt: publication.updatedAt,
        };
        await writeRegistry(projectRoot, entries);
        return entries[index];
    });
}

/**
 * Retire only the snapshot whose durable revalidation request has been fulfilled.
 * The caller holds the Plan locks and has preserved the old record and checkout.
 * @param {string} projectRoot
 * @param {string} id
 * @param {number} expectedRevision
 */
export async function retirePublicationForRevalidation(projectRoot, id, expectedRevision) {
    return await withWorktreeRegistryLock(projectRoot, async () => {
        const entries = await readRegistry(projectRoot);
        const entry = entries.find((candidate) => candidate.id === id);
        const publication = entry?.publication;
        if (!entry || !publication || publication.revision !== expectedRevision || !publication.revalidation) {
            throw new Error(`Publication ${id} changed while preparing revalidation.`);
        }
        assertPublicationAttempt(publication);
        delete entry.publication;
        entry.status = "active";
        entry.updatedAt = new Date().toISOString();
        await writeRegistry(projectRoot, entries);
    });
}

/**
 * @typedef {Object} WorktreeRestoreEvidence
 * @property {string} id
 * @property {string} planName
 * @property {string} planId
 * @property {string} baseBranch
 * @property {string} [baseRef]
 * @property {string} [baseCommit]
 * @property {string} [baseTree]
 * @property {string} [executionBaselineTree]
 * @property {string} branch
 * @property {string} path
 * @property {WorktreeRegistryEntry["status"]} [status]
 */

/**
 * @param {string} porcelainText
 * @returns {Array<{ path: string, branch: string }>}
 */
function parseGitWorktreeRecords(porcelainText) {
    return porcelainText.trim().split("\n\n").filter(Boolean).map((record) => {
        const lines = record.split("\n");
        return {
            path: lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length).trim() || "",
            branch: lines.find((line) => line.startsWith("branch "))?.slice("branch ".length).trim() || "",
        };
    });
}

/**
 * @param {string} projectRoot
 * @param {WorktreeRestoreEvidence} evidence
 * @returns {Promise<{ restored: boolean, reason?: string, entry?: WorktreeRegistryEntry }>}
 */
export async function restoreEntryFromPlanEvidence(projectRoot, evidence) {
    return await withWorktreeRegistryLock(projectRoot, async () => {
        const entries = await readRegistry(projectRoot);
        const existing = entries.find((entry) => entry.id === evidence.id);
        if (existing) {
            return {
                restored: false,
                reason: `Worktree registry entry already exists: ${evidence.id}`,
                entry: existing,
            };
        }
        if (!evidence.planId) return { restored: false, reason: "Plan evidence has no planId." };
        if (!evidence.path || !evidence.branch || !evidence.baseBranch) {
            return { restored: false, reason: "Plan evidence is missing worktree path, branch, or target branch." };
        }

        const worktreeList = await runGit(projectRoot, ["worktree", "list", "--porcelain"]);
        const expectedRef = `refs/heads/${evidence.branch}`;
        let evidenceRealPath = evidence.path;
        try {
            evidenceRealPath = await Deno.realPath(evidence.path);
        } catch {
            return { restored: false, reason: `Recorded worktree path is missing: ${evidence.path}` };
        }
        const match = parseGitWorktreeRecords(worktreeList).find((record) => {
            let recordRealPath = record.path;
            try {
                recordRealPath = Deno.realPathSync(record.path);
            } catch {
                // Keep the recorded path; the equality will fail.
            }
            return (record.path === evidence.path || recordRealPath === evidenceRealPath) &&
                record.branch === expectedRef;
        });
        if (!match) {
            return { restored: false, reason: `Git does not show ${evidence.path} attached to ${evidence.branch}.` };
        }
        if ((await runGitResult(projectRoot, ["rev-parse", "--verify", `refs/heads/${evidence.branch}`])).code !== 0) {
            return { restored: false, reason: `Recorded worktree branch does not exist: ${evidence.branch}` };
        }
        if (
            (await runGitResult(projectRoot, ["rev-parse", "--verify", `refs/heads/${evidence.baseBranch}`])).code !== 0
        ) {
            return { restored: false, reason: `Recorded target branch does not exist: ${evidence.baseBranch}` };
        }

        const now = new Date().toISOString();
        const entry = {
            id: evidence.id,
            planName: evidence.planName,
            planId: evidence.planId,
            baseBranch: evidence.baseBranch,
            baseRef: evidence.baseRef || `refs/heads/${evidence.baseBranch}`,
            baseCommit: evidence.baseCommit ||
                (await runGit(projectRoot, ["rev-parse", `refs/heads/${evidence.baseBranch}`])).trim(),
            ...(evidence.baseTree ? { baseTree: evidence.baseTree } : {}),
            ...(evidence.executionBaselineTree ? { executionBaselineTree: evidence.executionBaselineTree } : {}),
            branch: evidence.branch,
            path: evidence.path,
            status: evidence.status || "completed",
            createdAt: now,
            updatedAt: now,
        };
        try {
            assertNoDuplicateNonterminalAttempt(entries, entry);
        } catch (error) {
            return { restored: false, reason: error instanceof Error ? error.message : String(error) };
        }
        entries.push(entry);
        await writeRegistry(projectRoot, entries);
        return { restored: true, entry };
    });
}

/**
 * Repair an entry's identity fields from proven Plan facts.
 *
 * `updateEntry` treats identity as immutable so ordinary callers cannot quietly
 * rebind an attempt to a different Plan. Reconciliation still has to correct
 * drift, so it gets this narrow door instead: a missing `planId` may be filled
 * in, and `planName` may be corrected, but an existing `planId` is never
 * reassigned and no path, branch, base, or status field is touched. Callers must
 * have proven the pairing (Plan `worktreeId` naming this exact attempt, or the
 * `planId` owner naming the Plan) before calling.
 *
 * @param {string} projectRoot
 * @param {string} id
 * @param {{ planName?: string, planId?: string }} identity
 */
/**
 * Update a registry location only after a caller has proved it from Git.
 *
 * @param {string} projectRoot
 * @param {string} id
 * @param {{ path: string, branch: string }} location
 */
export async function reconcileEntryGitLocation(projectRoot, id, location) {
    return await withWorktreeRegistryLock(projectRoot, async () => {
        const entries = await readRegistry(projectRoot);
        const index = entries.findIndex((entry) => entry.id === id);
        if (index === -1) throw new Error(`Worktree registry entry not found: ${id}`);
        entries[index] = {
            ...entries[index],
            path: location.path,
            branch: location.branch,
            updatedAt: new Date().toISOString(),
        };
        assertNoDuplicateNonterminalAttempt(entries.filter((entry) => entry.id !== id), entries[index]);
        await writeRegistry(projectRoot, entries);
        return entries[index];
    });
}

/**
 * Repair an entry's Plan identity after the caller proves the pairing.
 * @param {string} projectRoot
 * @param {string} id
 * @param {{ planName?: string, planId?: string }} identity
 */
export async function reconcileEntryIdentity(projectRoot, id, identity) {
    return await withWorktreeRegistryLock(projectRoot, async () => {
        const entries = await readRegistry(projectRoot);
        const index = entries.findIndex((entry) => entry.id === id);
        if (index === -1) throw new Error(`Worktree registry entry not found: ${id}`);
        const entry = entries[index];
        if (identity.planId && entry.planId && identity.planId !== entry.planId) {
            throw new Error(
                `Refusing to rebind worktree registry entry ${id} from planId ${entry.planId} to ${identity.planId}.`,
            );
        }
        entries[index] = {
            ...entry,
            ...(identity.planName ? { planName: identity.planName } : {}),
            ...(identity.planId && !entry.planId ? { planId: identity.planId } : {}),
            updatedAt: new Date().toISOString(),
        };
        await writeRegistry(projectRoot, entries);
        return entries[index];
    });
}

/**
 * @typedef {Object} PlanIdAdoption
 * @property {boolean} rebound
 * @property {string} [from] - The superseded planId, when there was one.
 * @property {string} [reason] - Why the rebind was declined.
 */

/**
 * Rebind an entry's `planId` to the canonical Plan's id.
 *
 * `reconcileEntryIdentity` refuses any rebind, which is the right guard against a
 * different Plan claiming an existing attempt. It is the wrong answer when the id
 * itself was minted twice for one Plan: the entry then carries a value that names
 * nothing, and lookups by `planId` miss the very attempt they are recovering.
 *
 * The rebind is only allowed with the pairing proven by `planName`, which is the
 * Plan store key. A caller must also have proven that this entry is the attempt the
 * canonical Plan names, exactly as for `reconcileEntryIdentity`.
 *
 * @param {string} projectRoot
 * @param {string} id
 * @param {{ planName: string, planId: string }} identity
 * @returns {Promise<PlanIdAdoption>}
 */
export async function adoptCanonicalPlanId(projectRoot, id, identity) {
    return await withWorktreeRegistryLock(projectRoot, async () => {
        const entries = await readRegistry(projectRoot);
        const index = entries.findIndex((entry) => entry.id === id);
        if (index === -1) return { rebound: false, reason: `Worktree registry entry not found: ${id}` };
        const entry = entries[index];
        if (entry.planId === identity.planId) return { rebound: false };
        if (entry.planName && entry.planName !== identity.planName) {
            return {
                rebound: false,
                reason: `Worktree registry entry ${id} belongs to ${entry.planName}, not ${identity.planName}.`,
            };
        }
        const from = entry.planId;
        entries[index] = {
            ...entry,
            planName: identity.planName,
            planId: identity.planId,
            updatedAt: new Date().toISOString(),
        };
        await writeRegistry(projectRoot, entries);
        return { rebound: true, ...(from ? { from } : {}) };
    });
}

/**
 * @param {string} projectRoot
 * @param {string} id
 */
export async function removeEntry(projectRoot, id) {
    return await withWorktreeRegistryLock(projectRoot, async () => {
        const entries = await readRegistry(projectRoot);
        const index = entries.findIndex((entry) => entry.id === id);
        if (index === -1) return;
        const entry = entries[index];
        entries[index] = {
            ...entry,
            status: NONTERMINAL_STATUSES.has(entry.status) ? "abandoned" : entry.status,
            updatedAt: new Date().toISOString(),
        };
        await writeRegistry(projectRoot, entries);
    });
}

/**
 * Permanently prune a registry entry after an owning repair flow proves it is a stale settled artifact.
 * Normal attempt removal should use removeEntry() so history is retained.
 *
 * @param {string} projectRoot
 * @param {string} id
 */
export async function pruneEntry(projectRoot, id) {
    return await withWorktreeRegistryLock(projectRoot, async () => {
        const entries = await readRegistry(projectRoot);
        const next = entries.filter((entry) => entry.id !== id);
        await writeRegistry(projectRoot, next);
    });
}

/**
 * @param {string} projectRoot
 * @param {string} planName
 */
export async function findByPlanName(projectRoot, planName) {
    const entries = await listEntries(projectRoot);
    const legacyMatches = entries.filter((entry) =>
        !entry.planId && entry.planName === planName && NONTERMINAL_STATUSES.has(entry.status)
    );
    if (legacyMatches.length > 1) throw duplicateLiveAttemptError(planName, legacyMatches);
    return legacyMatches[0] || null;
}

/**
 * Resolve the one live attempt for a Plan name regardless of whether it already
 * has a stable Plan ID. This is the recovery path when caller-held IDs are stale.
 *
 * @param {string} projectRoot
 * @param {string} planName
 * @param {{ migrate?: boolean }} [options]
 */
export async function findActiveByPlanName(projectRoot, planName, options = {}) {
    const entries = await listEntries(projectRoot, options);
    const matches = entries.filter((entry) =>
        entry.planName === planName && entry.status !== "planning" && NONTERMINAL_STATUSES.has(entry.status)
    );
    if (matches.length > 1) throw duplicateLiveAttemptError(planName, matches);
    return matches[0] || null;
}

/**
 * @param {string} projectRoot
 * @param {string} planId
 */
export async function findByPlanId(projectRoot, planId) {
    return (await findByPlanIds(projectRoot, [planId])).get(planId) || null;
}

/** Read one authoritative registry snapshot for a group of dashboard Plans.
 * @param {string} projectRoot
 * @param {string[]} planIds
 */
export async function findByPlanIds(projectRoot, planIds) {
    const entries = await listEntries(projectRoot);
    const matches = new Map();
    for (const planId of planIds) {
        const live = entries.filter((entry) =>
            entry.planId === planId && entry.status !== "planning" && NONTERMINAL_STATUSES.has(entry.status)
        );
        // Never hide two active attempts for one Plan behind a batch lookup.
        if (live.length > 1) throw duplicateLiveAttemptError(live[0].planName, live);
        matches.set(planId, live[0] || null);
    }
    return matches;
}

/**
 * Read-only evidence snapshot for Plan action preconditions.
 *
 * @param {string} projectRoot
 * @param {string} planId
 * @returns {Promise<{ kind: "ok", live: WorktreeRegistryEntry | null, entries: WorktreeRegistryEntry[] } | { kind: "ambiguous" | "unreadable", message: string, entryIds: string[] }>}
 */
export async function readPlanActionWorktreeEvidence(projectRoot, planId) {
    const inspected = await inspectWorktreeRegistry(projectRoot);
    if (inspected.readError) {
        return { kind: "unreadable", message: inspected.readError.message, entryIds: [] };
    }
    const integrityIssue = inspected.integrityIssues[0];
    if (integrityIssue) {
        return { kind: "ambiguous", message: integrityIssue.message, entryIds: integrityIssue.ids };
    }
    const entries = inspected.entries.filter((entry) => entry.planId === planId);
    const live = entries.filter((entry) => entry.status !== "planning" && NONTERMINAL_STATUSES.has(entry.status));
    if (live.length > 1) {
        return {
            kind: "ambiguous",
            message: duplicateLiveAttemptError(live[0].planName, live).message,
            entryIds: live.map((entry) => entry.id),
        };
    }
    return { kind: "ok", live: live[0] || null, entries };
}

/**
 * Look up one registry entry by attempt id.
 *
 * Pass `{ migrate: false }` when the registry itself must remain untouched.
 * Migrating reads inspect raw Plan identity evidence without changing Plan files.
 *
 * @param {string} projectRoot
 * @param {string} id
 * @param {{ migrate?: boolean }} [options]
 */
export async function findById(projectRoot, id, options = {}) {
    const entries = await listEntries(projectRoot, options);
    return entries.find((entry) => entry.id === id) || null;
}

/**
 * @param {Set<string>} paths
 * @param {string} path
 */
async function addWorktreePathVariants(paths, path) {
    paths.add(path);
    try {
        paths.add(await Deno.realPath(path));
    } catch {
        // Missing paths are handled by the caller's stat check.
    }
}

/** @param {string} projectRoot */
async function listGitWorktreePaths(projectRoot) {
    const command = new Deno.Command("git", {
        args: ["worktree", "list", "--porcelain"],
        cwd: projectRoot,
        stdout: "piped",
        stderr: "null",
    });
    const { code, stdout } = await command.output();
    if (code !== 0) return null;
    const text = new TextDecoder().decode(stdout);
    const paths = new Set();
    for (const line of text.split("\n")) {
        if (!line.startsWith("worktree ")) continue;
        const path = line.slice("worktree ".length).trim();
        if (!path) continue;
        await addWorktreePathVariants(paths, path);
    }
    return paths;
}

/** @param {string} projectRoot */
export async function pruneStaleEntries(projectRoot) {
    return await withWorktreeRegistryLock(projectRoot, async () => {
        const entries = await readRegistry(projectRoot);
        const gitWorktreePaths = await listGitWorktreePaths(projectRoot);
        const kept = [];
        const stale = [];
        for (const entry of entries) {
            try {
                const stat = await Deno.stat(entry.path);
                const realPath = await Deno.realPath(entry.path);
                const isRegisteredGitWorktree = !gitWorktreePaths ||
                    gitWorktreePaths.has(entry.path) || gitWorktreePaths.has(realPath);
                if (stat.isDirectory && isRegisteredGitWorktree) kept.push(entry);
                else stale.push(entry);
            } catch {
                stale.push(entry);
            }
        }
        return stale;
    });
}
