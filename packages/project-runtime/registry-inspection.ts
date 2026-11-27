import { CLI_BIN } from "@runwield/resources/cli-name";
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

export interface RegistryRecoveryAction {
    label: string;
    description: string;
    command?: string;
}

interface RegistryAmbiguityDetails {
    kind: string;
    entryIds: string[];
    planName?: string;
    recoveryActions: RegistryRecoveryAction[];
}

/**
 * A registry read could not answer the question that was asked.
 *
 * The registry is RunWield's own bookkeeping, so "invariant violated" is not an
 * explanation the user can act on — it reads as RunWield failing at its paperwork
 * and handing over the bill. Carry the affected attempt ids and the commands that
 * resolve them so every surface can say what to do next.
 */
export class WorktreeRegistryAmbiguityError extends Error {
    declare kind: RegistryAmbiguityDetails["kind"];
    declare entryIds: RegistryAmbiguityDetails["entryIds"];
    declare planName: RegistryAmbiguityDetails["planName"];
    declare recoveryActions: RegistryAmbiguityDetails["recoveryActions"];

    constructor(message: string, details: RegistryAmbiguityDetails) {
        super(message);
        this.name = "WorktreeRegistryAmbiguityError";
        this.kind = details.kind;
        this.entryIds = details.entryIds;
        this.planName = details.planName;
        this.recoveryActions = details.recoveryActions;
    }
}

export function registryRecoveryActions(planName?: string): RegistryRecoveryAction[] {
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
            ? [
                  {
                      label: "Choose which attempt survives",
                      description:
                          "Plan Recovery lists the attempts for this Plan so you can continue, retry, merge, or abandon one.",
                      command: `${CLI_BIN} load-plan ${planName}`,
                  },
              ]
            : []),
    ];
}

/** Read the registry at a checked layout path and report ambiguous attempt IDs. */
export async function readWorktreeRegistryAtPath(registryPath: string): Promise<WorktreeRegistryEntry[]> {
    try {
        const inspected = await inspectWorktreeRegistryAtPath(registryPath);
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
        // Reading is deliberately permissive. Two unfinished attempts for one Plan
        // make *that Plan's* lookups ambiguous; they say nothing about any other
        // Plan, and refusing every read over it made one damaged record disable every
        // worktree command in the project — including the ones that diagnose it. The
        // guard that matters is on the write side: `addEntry` and `updateEntry` still
        // refuse to create a second live attempt, so a permissive read cannot let one
        // in. Lookups below fail only when the entry they were asked for is the
        // ambiguous one.
        return entries;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
    }
}
