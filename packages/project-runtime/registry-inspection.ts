import { assertPublicationAttempt, type PublicationAttempt } from "@runwield/workflow-publication-format";
import { readFile as fsReadFile } from "node:fs/promises";

interface ContextFile {
    path: string;
    content: string;
    sourceDigest?: string;
}

export interface WorktreeProjectContext {
    files: ContextFile[];
    ownedGitignore: boolean;
}

export interface WorktreeRegistryEntry {
    id: string;
    planName: string;
    planId?: string;
    baseBranch: string;
    baseRef: string;
    baseCommit: string;
    baseTree?: string;
    executionBaselineTree?: string;
    /** Commit recorded when the implementation report was accepted. */
    implementationCommit?: string;
    branch: string;
    path: string;
    status: "planning" | "active" | "completed" | "execution_failed" | "validation_failed" | "validated" | "abandoned";
    createdAt: string;
    updatedAt: string;
    migrationIssue?: RegistryMigrationIssue;
    publication?: PublicationAttempt;
    creationContext?: WorktreeProjectContext;
}

interface RegistryMigrationIssue {
    reason: string;
    recordedAt: string;
    candidates?: string[];
}

interface RegistryIntegrityIssue {
    kind: string;
    message: string;
    ids: string[];
}

export interface WorktreeRegistryInspection {
    version: number;
    entries: WorktreeRegistryEntry[];
    integrityIssues: RegistryIntegrityIssue[];
    readError?: Error;
}

interface RegistryFile {
    version?: number;
    entries?: WorktreeRegistryEntry[];
}

const NONTERMINAL_STATUSES = new Set([
    "planning",
    "active",
    "completed",
    "execution_failed",
    "validation_failed",
    "validated",
]);

export function isNonterminalWorktreeStatus(status: WorktreeRegistryEntry["status"]): boolean {
    return NONTERMINAL_STATUSES.has(status);
}

/**
 * Read the registry at an exact path without enforcing every invariant.
 *
 * Never mutates or migrates. Diagnosis and layout migration must not change what
 * they are diagnosing.
 */
export async function inspectWorktreeRegistryAtPath(registryPath: string): Promise<WorktreeRegistryInspection> {
    const integrityIssues: RegistryIntegrityIssue[] = [];
    let text;
    try {
        text = await fsReadFile(registryPath, "utf8");
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return { version: 2, entries: [], integrityIssues };
        }
        return {
            version: 0,
            entries: [],
            integrityIssues,
            readError: error instanceof Error ? error : new Error(String(error)),
        };
    }
    let parsed: RegistryFile;
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
    const entries: WorktreeRegistryEntry[] = parsed.entries;
    const byId = new Map<string, string[]>();
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
                assertPublicationAttempt(entry.publication!);
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
    const liveByPlan = new Map<string, WorktreeRegistryEntry[]>();
    const legacyLiveByPlanName = new Map<string, WorktreeRegistryEntry[]>();
    for (const entry of entries) {
        if (!isNonterminalWorktreeStatus(entry.status)) continue;
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
                message: `Plan ${live[0].planName} (${planId}) has ${live.length} unfinished attempts: ${live
                    .map((entry) => `${entry.id} (${entry.status})`)
                    .join(", ")}.`,
                ids: live.map((entry) => entry.id),
            });
        }
    }
    for (const [planName, live] of legacyLiveByPlanName) {
        if (live.length > 1) {
            integrityIssues.push({
                kind: "duplicate_live_attempt",
                message: `Plan ${planName} has ${live.length} unfinished legacy attempts: ${live
                    .map((entry) => `${entry.id} (${entry.status})`)
                    .join(", ")}.`,
                ids: live.map((entry) => entry.id),
            });
        }
    }
    return { version, entries, integrityIssues };
}
