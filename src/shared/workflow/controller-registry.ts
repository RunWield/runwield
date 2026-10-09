/** File-backed controller state shared by all worktrees of one project. */
import { dirname, join, resolve } from "@std/path";
import { AsyncLocalStorage } from "node:async_hooks";
import { resolvePrimaryCheckoutRoot } from "../primary-checkout.ts";
import {
    enterProjectRuntime,
    invalidateProjectRuntimeReadScope,
    resolveProjectRuntimeLayout,
    withProjectRuntimeReadScope,
} from "../project-runtime-layout.ts";
import { inspectWorktreeRegistry, inspectWorktreeRegistryAtPath } from "../worktree-registry.js";
import { isPublicationCleanupPending } from "./publication-attempt.ts";
import {
    CONTROLLER_STATE_FIELDS,
    pickControllerState,
    type WorkflowControllerState,
    type WorkflowWorktreeContext,
} from "./controller-state.ts";

type WriteScope = {
    revisions: Map<string, number>;
    previousRecovery: Map<string, WorkflowWorktreeContext | undefined>;
    parent?: WriteScope;
};
const writes = new AsyncLocalStorage<WriteScope>();

/** Attribute writes to their transition, including nested lifecycle transitions. */
export function withControllerWriteTracking<T>(run: () => Promise<T>): Promise<T> {
    return writes.run({ revisions: new Map(), previousRecovery: new Map(), parent: writes.getStore() }, run);
}

export function controllerStatesEqual(a: WorkflowControllerState, b: WorkflowControllerState): boolean {
    const left = pickControllerState(a);
    const right = pickControllerState(b);
    return CONTROLLER_STATE_FIELDS.every((key) => JSON.stringify(left[key]) === JSON.stringify(right[key]));
}

export async function restoreOwnControllerWrite(
    cwd: string,
    identity: WorkflowIdentity,
    state: WorkflowControllerState,
): Promise<boolean> {
    const current = await readControllerRecord(cwd, identity);
    const path = controllerRecordPath(cwd, identity);
    const scope = writes.getStore();
    const recovery = scope?.previousRecovery.has(path) ? scope.previousRecovery.get(path) : current?.recovery;
    if (
        controllerStatesEqual(current?.state || {}, state) &&
        JSON.stringify(recovery) === JSON.stringify(current?.recovery)
    ) return true;
    if (!current || scope?.revisions.get(path) !== current.revision) {
        return false;
    }
    const restored: WorkflowControllerState = {};
    for (const key of CONTROLLER_STATE_FIELDS) Object.assign(restored, { [key]: state[key] });
    try {
        await writeControllerState(cwd, identity, restored, {
            expectedRevision: current.revision,
            recovery: recovery || null,
        });
        return true;
    } catch (error) {
        if (error instanceof StaleControllerWriteError) return false;
        throw error;
    }
}

export interface WorkflowIdentity {
    planId?: string;
    planName: string;
}

export interface ControllerRecord {
    version: 1;
    revision: number;
    planId?: string;
    planName: string;
    state: WorkflowControllerState;
    /** Imported only when the old registry is missing; removed after registry recovery. */
    recovery?: WorkflowWorktreeContext;
}

export class StaleControllerWriteError extends Error {
    constructor() {
        super("The workflow advanced while this operation was running. Reload its current state and continue.");
        this.name = "StaleControllerWriteError";
    }
}

function canonicalPath(path: string): string {
    try {
        return Deno.realPathSync(path);
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return resolve(path);
        throw error;
    }
}

function selectedRoot(cwd: string): string {
    return canonicalPath(resolve(cwd));
}

function projectRoot(cwd: string): string {
    return canonicalPath(resolvePrimaryCheckoutRoot(selectedRoot(cwd)));
}

export function controllerRecordPath(cwd: string, identity: WorkflowIdentity): string {
    const key = identity.planId || `name:${identity.planName}`;
    return join(
        resolveProjectRuntimeLayout(projectRoot(cwd)).primary.controllerPlansDir,
        `${encodeURIComponent(key)}.json`,
    );
}

async function enteredControllerRecordPath(cwd: string, identity: WorkflowIdentity): Promise<string> {
    const key = identity.planId || `name:${identity.planName}`;
    return join(
        (await enterProjectRuntime(selectedRoot(cwd))).primary.controllerPlansDir,
        `${encodeURIComponent(key)}.json`,
    );
}

export async function readControllerRecordAtPath(
    controllerPlansDir: string,
    identity: WorkflowIdentity,
): Promise<ControllerRecord | null> {
    const key = identity.planId || `name:${identity.planName}`;
    try {
        const record: ControllerRecord = JSON.parse(
            await Deno.readTextFile(join(controllerPlansDir, `${encodeURIComponent(key)}.json`)),
        );
        if (record.version !== 1 || !Number.isInteger(record.revision) || !record.state) {
            throw new Error(
                "RunWield could not read this Plan's saved workflow. Your files and commits are unchanged.",
            );
        }
        return record;
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return null;
        throw error;
    }
}

export async function readControllerRecord(cwd: string, identity: WorkflowIdentity): Promise<ControllerRecord | null> {
    await enterProjectRuntime(selectedRoot(cwd));
    return await readControllerRecordAtPath(
        resolveProjectRuntimeLayout(projectRoot(cwd)).primary.controllerPlansDir,
        identity,
    );
}

/** Resolve retained delivery evidence when its primary Plan document is absent. */
export async function findRecordingControllerByName(cwd: string, planName: string): Promise<ControllerRecord | null> {
    await enterProjectRuntime(selectedRoot(cwd));
    const directory = resolveProjectRuntimeLayout(projectRoot(cwd)).primary.controllerPlansDir;
    let match: ControllerRecord | null = null;
    try {
        for await (const entry of Deno.readDir(directory)) {
            if (!entry.isFile || !entry.name.endsWith(".json")) continue;
            const key = decodeURIComponent(entry.name.slice(0, -5));
            if (key.startsWith("name:")) continue;
            const record = await readControllerRecordAtPath(directory, { planId: key, planName });
            if (record?.planName !== planName || !record.state.recordingSource) continue;
            if (match) throw new Error("More than one delivered Plan has this name. Its Work Record was not changed.");
            match = record;
        }
    } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    return match;
}

async function atomicWrite(path: string, record: ControllerRecord): Promise<void> {
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    const data = new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`);
    try {
        const file = await Deno.open(temporary, { createNew: true, write: true });
        try {
            let offset = 0;
            while (offset < data.length) offset += await file.write(data.subarray(offset));
            await file.sync();
        } finally {
            file.close();
        }
        await Deno.rename(temporary, path);
        const directory = await Deno.open(dirname(path), { read: true });
        try {
            await directory.sync();
        } finally {
            directory.close();
        }
    } finally {
        await Deno.remove(temporary).catch((error) => {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
        });
    }
}

export interface ControllerWriteOptions {
    expectedRevision?: number;
    /** Import only once. Old Plan copies can never overwrite a controller record. */
    initializeOnly?: boolean;
    recovery?: WorkflowWorktreeContext | null;
}

/** Move pre-onboarding state to its stable identity exactly once. */
export async function bindControllerPlanIdentity(cwd: string, identity: WorkflowIdentity): Promise<void> {
    if (!identity.planId || await readControllerRecord(cwd, identity)) return;
    const temporaryIdentity = { planName: identity.planName };
    if (!await readControllerRecord(cwd, temporaryIdentity)) return;
    const path = await enteredControllerRecordPath(cwd, temporaryIdentity);
    const lock = await Deno.open(`${path}.lock`, { create: true, read: true, write: true });
    try {
        await lock.lock(true);
        const unnamed = await readControllerRecord(cwd, temporaryIdentity);
        if (!unnamed) return;
        await writeControllerState(cwd, identity, unnamed.state, { initializeOnly: true, recovery: unnamed.recovery });
    } finally {
        lock.close();
    }
}

/** Called under the Plan lock only after the document's stable identity was saved. */
export async function finishControllerPlanIdentity(cwd: string, identity: WorkflowIdentity): Promise<void> {
    if (!identity.planId || !await readControllerRecord(cwd, identity)) return;
    const path = await enteredControllerRecordPath(cwd, { planName: identity.planName });
    await Deno.remove(path).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
}

export async function writeControllerState(
    cwd: string,
    identity: WorkflowIdentity,
    updates: WorkflowControllerState,
    options: ControllerWriteOptions = {},
): Promise<ControllerRecord> {
    invalidateProjectRuntimeReadScope();
    try {
        const path = await enteredControllerRecordPath(cwd, identity);
        await Deno.mkdir(dirname(path), { recursive: true });
        // Keep this inode: deleting a lock file lets a third process lock a different
        // inode while an existing waiter still owns the original one.
        const lock = await Deno.open(`${path}.lock`, { create: true, read: true, write: true });
        try {
            await lock.lock(true);
            // Runtime entry precedes the inode lock. Re-entering migration here
            // could recover an old write and wait for the very lock we own.
            const before = await readControllerRecordAtPath(dirname(path), identity);
            if (options.initializeOnly && before) return before;
            if (options.expectedRevision !== undefined && (before?.revision || 0) !== options.expectedRevision) {
                throw new StaleControllerWriteError();
            }
            const recovery = options.recovery === undefined ? before?.recovery : options.recovery;
            const record: ControllerRecord = {
                version: 1,
                revision: (before?.revision || 0) + 1,
                ...identity,
                state: { ...before?.state, ...pickControllerState(updates) },
                ...(recovery ? { recovery } : {}),
            };
            if (
                before && controllerStatesEqual(before.state, record.state) &&
                JSON.stringify(before.recovery) === JSON.stringify(record.recovery)
            ) return before;
            await atomicWrite(path, record);
            if (!options.initializeOnly) {
                for (let scope = writes.getStore(); scope; scope = scope.parent) {
                    scope.revisions.set(path, record.revision);
                    if (!scope.previousRecovery.has(path)) scope.previousRecovery.set(path, before?.recovery);
                }
            }
            return record;
        } finally {
            lock.close();
        }
    } finally {
        invalidateProjectRuntimeReadScope();
    }
}

/** Absence, history, and an unreadable registry have different import semantics. */
export async function inspectControllerWorktree(cwd: string, identity: WorkflowIdentity) {
    const registry = await inspectWorktreeRegistry(selectedRoot(cwd));
    if (registry.readError) return { kind: "uncertain" as const };
    const candidates = registry.entries.filter((entry) =>
        identity.planId && entry.planId ? entry.planId === identity.planId : entry.planName === identity.planName
    );
    const live = candidates.filter((entry) => entry.status !== "abandoned");
    if (live.length > 1) {
        // Document reads must still work so recovery can show both attempts.
        // The action/execution boundary rejects ambiguous registry lookups.
        return { kind: "uncertain" as const };
    }
    if (live[0]) return { kind: "live" as const, entry: live[0] };
    const retired = candidates.at(-1);
    return retired ? { kind: "retired" as const, entry: retired } : { kind: "absent" as const };
}

/** Only a live attempt supplies execution identity. History cannot reopen a branch. */
export async function readControllerWorktree(cwd: string, identity: WorkflowIdentity) {
    const result = await inspectControllerWorktree(cwd, identity);
    return result.kind === "live" && result.entry.status !== "planning" ? result.entry : null;
}

/** Document candidates include reopened Plans, but never expose retired attempt IDs as live. */
export async function listControllerDocumentWorktrees(cwd: string) {
    return await withProjectRuntimeReadScope(async () => {
        const registry = await inspectWorktreeRegistry(projectRoot(cwd));
        const active = registry.entries.filter((entry) => entry.status !== "abandoned");
        const selected = new Set(active.map((entry) => entry.planName));
        const live = active.filter((entry) => !isPublicationCleanupPending(entry.publication));
        const retired = registry.entries.filter((entry) => entry.status === "abandoned")
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        for (const entry of retired) {
            if (selected.has(entry.planName)) continue;
            const controller = await readControllerRecord(cwd, { planName: entry.planName, planId: entry.planId });
            if (controller?.state.documentWorktreeId !== entry.id) continue;
            live.push(entry);
            selected.add(entry.planName);
        }
        return live;
    });
}

export type PendingControllerRepair = "import_legacy_state" | "clear_obsolete_recovery";

/** Build the joined controller view without importing or cleaning controller state. */
export async function inspectControllerView(
    cwd: string,
    identity: WorkflowIdentity,
    legacy: WorkflowControllerState & WorkflowWorktreeContext,
) {
    const layout = resolveProjectRuntimeLayout(projectRoot(cwd));
    const registry = await inspectWorktreeRegistryAtPath(layout.primary.worktreeRegistryPath);
    const candidates = registry.readError
        ? []
        : registry.entries.filter((entry) =>
            identity.planId && entry.planId ? entry.planId === identity.planId : entry.planName === identity.planName
        );
    const live = candidates.filter((entry) => entry.status !== "abandoned");
    const lookup = registry.readError || live.length > 1
        ? { kind: "uncertain" as const }
        : live[0]
        ? { kind: "live" as const, entry: live[0] }
        : candidates.at(-1)
        ? { kind: "retired" as const, entry: candidates.at(-1)! }
        : { kind: "absent" as const };
    const liveEntry = lookup.kind === "live" ? lookup.entry : null;
    const attempt = liveEntry?.status === "planning" ? null : liveEntry;
    const documentEntry = liveEntry?.status === "planning"
        ? null
        : liveEntry || (lookup.kind === "retired" ? lookup.entry : null);
    const record = await readControllerRecordAtPath(layout.primary.controllerPlansDir, identity);
    const pendingRepairs: PendingControllerRepair[] = [];
    if ((attempt || lookup.kind === "retired") && record?.recovery) {
        pendingRepairs.push("clear_obsolete_recovery");
    }
    const legacyState = pickControllerState(legacy);
    const mayImport = lookup.kind === "absent" ||
        (attempt && canonicalPath(attempt.path) === canonicalPath(cwd));
    const importsLegacy = !record && Boolean(
        mayImport && (Object.values(legacyState).some((value) => value != null) || legacy.worktreeId),
    );
    if (importsLegacy) pendingRepairs.push("import_legacy_state");
    const recovery = importsLegacy && !attempt && legacy.worktreeId
        ? {
            worktreeId: legacy.worktreeId,
            worktreePath: legacy.worktreePath,
            worktreeBranch: legacy.worktreeBranch,
            worktreeBaseBranch: legacy.worktreeBaseBranch,
            worktreeStatus: legacy.worktreeStatus,
            executionBaselineTree: legacy.executionBaselineTree,
        }
        : undefined;
    const worktree: WorkflowWorktreeContext = documentEntry && documentEntry.status !== "abandoned"
        ? {
            worktreeId: documentEntry.id,
            worktreePath: documentEntry.path,
            worktreeBranch: documentEntry.branch,
            worktreeBaseBranch: documentEntry.baseBranch,
            worktreeStatus: documentEntry.status === "validated" ? "completed" : documentEntry.status,
            executionBaselineTree: documentEntry.status === "planning"
                ? undefined
                : documentEntry.executionBaselineTree || documentEntry.baseTree,
        }
        : lookup.kind === "retired"
        ? { worktreeStatus: "abandoned" }
        : lookup.kind === "uncertain"
        ? {}
        : record?.recovery || recovery || {};
    return {
        state: {
            ...(record?.state || (importsLegacy ? legacyState : {})),
            ...(attempt && attempt.status !== "abandoned" ? { executionMode: "worktree" as const } : {}),
            ...worktree,
        },
        revision: record?.revision || 0,
        pendingRepairs,
    };
}

export async function loadControllerView(
    cwd: string,
    identity: WorkflowIdentity,
    legacy: WorkflowControllerState & WorkflowWorktreeContext,
) {
    return await withProjectRuntimeReadScope(async () => {
        const lookup = await inspectControllerWorktree(cwd, identity);
        const liveEntry = lookup.kind === "live" ? lookup.entry : null;
        const attempt = liveEntry?.status === "planning" ? null : liveEntry;
        const documentEntry = liveEntry?.status === "planning"
            ? null
            : liveEntry || (lookup.kind === "retired" ? lookup.entry : null);
        let record = await readControllerRecord(cwd, identity);
        if ((attempt || lookup.kind === "retired") && record?.recovery) {
            // Once the registry owns the attempt, old import hints are finished.
            // Keeping them would resurrect a phantom attempt after publication prunes it.
            record = await writeControllerState(cwd, identity, {}, { recovery: null });
        }
        if (!record) {
            // Only the execution copy may seed legacy state once execution exists.
            // A stale primary document is never a fallback for missing runtime facts.
            const mayImport = lookup.kind === "absent" ||
                (attempt && canonicalPath(attempt.path) === canonicalPath(cwd));
            if (
                mayImport &&
                (Object.values(pickControllerState(legacy)).some((value) => value != null) || legacy.worktreeId)
            ) {
                const recovery = !attempt && legacy.worktreeId
                    ? {
                        worktreeId: legacy.worktreeId,
                        worktreePath: legacy.worktreePath,
                        worktreeBranch: legacy.worktreeBranch,
                        worktreeBaseBranch: legacy.worktreeBaseBranch,
                        worktreeBaseCommit: legacy.worktreeBaseCommit,
                        worktreeStatus: legacy.worktreeStatus,
                        executionBaselineTree: legacy.executionBaselineTree,
                    }
                    : undefined;
                record = await writeControllerState(cwd, identity, pickControllerState(legacy), {
                    initializeOnly: true,
                    recovery,
                });
            }
        }
        const state = record?.state || {};
        const worktree: WorkflowWorktreeContext = documentEntry && documentEntry.status !== "abandoned"
            ? {
                worktreeId: documentEntry.id,
                worktreePath: documentEntry.path,
                worktreeBranch: documentEntry.branch,
                worktreeBaseBranch: documentEntry.baseBranch,
                worktreeBaseCommit: documentEntry.baseCommit,
                worktreeStatus: documentEntry.status === "validated" ? "completed" : documentEntry.status,
                executionBaselineTree: documentEntry.status === "planning"
                    ? undefined
                    : documentEntry.executionBaselineTree || documentEntry.baseTree,
            }
            : lookup.kind === "retired"
            ? { worktreeStatus: "abandoned" }
            : lookup.kind === "uncertain"
            ? {}
            : record?.recovery || {};
        return {
            state: {
                ...state,
                ...(attempt && attempt.status !== "abandoned" ? { executionMode: "worktree" as const } : {}),
                ...worktree,
            },
            revision: record?.revision || 0,
        };
    });
}
