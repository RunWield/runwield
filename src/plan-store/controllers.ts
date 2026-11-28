import {
    inspectWorktreeRegistryAtPath,
    type WorktreeRegistryEntry,
} from "@runwield/project-runtime/registry-inspection";
import { projects } from "@runwield/projects";
import {
    projectCheckoutControllerView,
    readControllerRecordAtPath,
    type WorkflowIdentity,
} from "@runwield/plans/retained-checkout";
import { managedPersonalStoreActive } from "@runwield/plans/managed-project-connection";
import {
    currentManagedRetainedExecution,
    readManagedRetainedExecution,
    writeManagedRetainedController,
    readManagedRelatedController,
    writeManagedRelatedController,
} from "./managed.ts";
import {
    currentPackageSelection,
    packageWorkflowLocks,
    selectedPackage,
    packageController,
    updatePackageWorkflowMetadata,
} from "./workflows.ts";
import { recoverWindowsRename } from "../shared/native-file-replace-windows.ts";
import { platform } from "node:process";
import { open as fsOpen } from "node:fs/promises";
import { openNativeFileLock } from "../shared/native-file-lock.ts";
import { realpathSync as fsRealpathSync } from "node:fs";
import {
    lstat as fsLstat,
    mkdir as fsMkdir,
    readdir as fsReaddir,
    realpath as fsRealpath,
    rename as fsRename,
    rm as fsRm,
} from "node:fs/promises";
/** File-backed controller state shared by all worktrees of one project. */
import { dirname, join, resolve } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import {
    enterProjectRuntime,
    checkedProjectRuntimeLayout,
    invalidateProjectRuntimeReadScope,
    resolveProjectRuntimeLayout,
    withProjectRuntimeReadScope,
} from "@runwield/project-runtime/layout";
import { inspectWorktreeRegistry } from "../shared/worktree-registry.ts";
import { captureForegroundProcess } from "@runwield/resources/process";
import { parsePlanFrontMatter } from "@runwield/plans/format";
import { isPublicationCleanupPending } from "@runwield/workflow/publication";
import {
    CONTROLLER_STATE_FIELDS,
    pickControllerState,
    type ControllerRecord,
    type WorkflowControllerState,
    type WorkflowWorktreeContext,
} from "@runwield/plans/controller-state";

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
    )
        return true;
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

export class StaleControllerWriteError extends Error {
    constructor() {
        super("The workflow advanced while this operation was running. Reload its current state and continue.");
        this.name = "StaleControllerWriteError";
    }
}

function canonicalPath(path: string): string {
    try {
        return fsRealpathSync(path);
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return resolve(path);
        throw error;
    }
}

function selectedRoot(cwd: string): string {
    return canonicalPath(resolve(cwd));
}

function projectRoot(cwd: string): string {
    return canonicalPath(projects.checkout.primaryRoot(selectedRoot(cwd)));
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

export async function readControllerRecord(cwd: string, identity: WorkflowIdentity): Promise<ControllerRecord | null> {
    const retained = currentManagedRetainedExecution();
    if (retained) {
        if (retained.planName !== identity.planName || (identity.planId && identity.planId !== retained.planId)) {
            const other = await readManagedRetainedExecution(cwd, identity.planId || identity.planName);
            if (other && other.planName === identity.planName) return other.controller;
            return await readManagedRelatedController(cwd, identity);
        }
        return (await readManagedRetainedExecution(cwd, retained.planId, retained.attempt.id))?.controller ?? null;
    }

    if (currentPackageSelection()) {
        const plan = (await selectedPackage(identity.planName))!;
        if (identity.planId && identity.planId !== plan.metadata.planId)
            throw new Error("Package controller identity mismatch.");
        return {
            version: 1,
            revision: plan.metadata.revision,
            planId: plan.metadata.planId,
            planName: plan.metadata.name,
            state: await packageController(plan),
        };
    }
    const layout = await checkedProjectRuntimeLayout(selectedRoot(cwd));
    return await readControllerRecordAtPath(layout.primary.controllerPlansDir, identity);
}

/** Resolve retained delivery evidence when its primary Plan document is absent. */
export async function findRecordingControllerByName(cwd: string, planName: string): Promise<ControllerRecord | null> {
    const directory = (await checkedProjectRuntimeLayout(selectedRoot(cwd))).primary.controllerPlansDir;
    let match: ControllerRecord | null = null;
    try {
        for await (const entry of await fsReaddir(directory, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
            const key = decodeURIComponent(entry.name.slice(0, -5));
            if (key.startsWith("name:")) continue;
            const record = await readControllerRecordAtPath(directory, { planId: key, planName });
            if (record?.planName !== planName || !record.state.recordingSource) continue;
            if (match) throw new Error("More than one delivered Plan has this name. Its Work Record was not changed.");
            match = record;
        }
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    return match;
}

async function atomicWrite(path: string, record: ControllerRecord): Promise<void> {
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    const data = new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`);
    try {
        const file = await fsOpen(temporary, "wx");
        try {
            await file.writeFile(data);
            await file.sync();
        } finally {
            await file.close();
        }
        try {
            await fsRename(temporary, path);
        } catch (error) {
            if (!(error instanceof Error && recoverWindowsRename(error, temporary, path))) throw error;
        }
        // Windows cannot fsync a directory; the file was flushed before atomic rename.
        if (platform !== "win32") {
            const directory = await fsOpen(dirname(path), "r");
            try {
                await directory.sync();
            } finally {
                await directory.close();
            }
        }
    } finally {
        await fsRm(temporary).catch((error) => {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
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
    if (!identity.planId || (await readControllerRecord(cwd, identity))) return;
    const temporaryIdentity = { planName: identity.planName };
    if (!(await readControllerRecord(cwd, temporaryIdentity))) return;
    const path = await enteredControllerRecordPath(cwd, temporaryIdentity);
    const lock = openNativeFileLock(`${path}.lock`);
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
    if (!identity.planId || !(await readControllerRecord(cwd, identity))) return;
    const path = await enteredControllerRecordPath(cwd, { planName: identity.planName });
    await fsRm(path).catch((error) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
}

export async function writeControllerState(
    cwd: string,
    identity: WorkflowIdentity,
    updates: WorkflowControllerState,
    options: ControllerWriteOptions = {},
): Promise<ControllerRecord> {
    const retained = currentManagedRetainedExecution();
    if (retained)
        return retained.planName === identity.planName && (!identity.planId || identity.planId === retained.planId)
            ? await writeManagedRetainedController(cwd, identity, updates, options)
            : await writeManagedRelatedController(cwd, identity, updates, options);
    if (currentPackageSelection()) {
        return await packageWorkflowLocks([identity.planName], async () => {
            const before = await readControllerRecord(cwd, identity);
            if (options.initializeOnly) return before!;
            if (options.expectedRevision !== undefined && options.expectedRevision !== before?.revision)
                throw new StaleControllerWriteError();
            await updatePackageWorkflowMetadata(identity.planName, updates);
            return (await readControllerRecord(cwd, identity))!;
        });
    }
    invalidateProjectRuntimeReadScope();
    try {
        const path = await enteredControllerRecordPath(cwd, identity);
        await fsMkdir(dirname(path), { recursive: true });
        // Keep this inode: deleting a lock file lets a third process lock a different
        // inode while an existing waiter still owns the original one.
        const lock = openNativeFileLock(`${path}.lock`);
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
                before &&
                controllerStatesEqual(before.state, record.state) &&
                JSON.stringify(before.recovery) === JSON.stringify(record.recovery)
            )
                return before;
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
        identity.planId && entry.planId ? entry.planId === identity.planId : entry.planName === identity.planName,
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

/** Prove that an older failed creation never saved the identity it was about to own. */
async function isRolledBackAnonymousCreation(cwd: string, entry: WorktreeRegistryEntry): Promise<boolean> {
    try {
        await fsLstat(entry.path);
        return false;
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const head = await captureForegroundProcess("git", {
        cwd,
        env: { GIT_NO_LAZY_FETCH: "1" },
        args: ["rev-parse", "--verify", `refs/heads/${entry.branch}`],
    });
    if (head.code !== 0 || new TextDecoder().decode(head.stdout).trim() !== entry.baseCommit) return false;
    const document = await captureForegroundProcess("git", {
        cwd,
        env: { GIT_NO_LAZY_FETCH: "1" },
        args: ["show", `${entry.baseCommit}:docs/plans/${entry.planName}.md`],
    });
    return document.code === 0 && !parsePlanFrontMatter(new TextDecoder().decode(document.stdout)).attrs.planId;
}

export type ControllerDocumentWorktree = WorktreeRegistryEntry & { documentUnavailable?: string };

export class RegisteredPlanDocumentUnavailableError extends Error {
    readonly kind = "registered_plan_document_unavailable";
    constructor(entry: ControllerDocumentWorktree) {
        super(
            `Registered Plan ${entry.planName} is unavailable at ${entry.path}: ${entry.documentUnavailable}. The primary copy will not be used.`,
        );
        this.name = "RegisteredPlanDocumentUnavailableError";
    }
}

export function assertControllerDocumentAvailable(entry: ControllerDocumentWorktree): void {
    if (entry.documentUnavailable) throw new RegisteredPlanDocumentUnavailableError(entry);
}

/** Validate registry authority against this project's attached worktrees before reading document bytes. */
export async function inspectControllerDocumentWorktrees(
    cwd: string,
    entries: WorktreeRegistryEntry[],
): Promise<ControllerDocumentWorktree[]> {
    if (!entries.length) return [];
    const output = await captureForegroundProcess("git", {
        cwd: projectRoot(cwd),
        env: { GIT_NO_LAZY_FETCH: "1" },
        args: ["worktree", "list", "--porcelain", "-z"],
    });
    const attached = new Set<string>();
    if (output.success) {
        for (const field of new TextDecoder().decode(output.stdout).split("\0")) {
            if (!field.startsWith("worktree ")) continue;
            try {
                attached.add(await fsRealpath(field.slice("worktree ".length)));
            } catch {
                /* Missing checkout. */
            }
        }
    }
    return await Promise.all(
        entries.map(async (entry) => {
            try {
                // Check every document path component, not only the checkout root.
                for (const planPath of [`${entry.planName}.md`, `archived/${entry.planName}.md`]) {
                    let component = entry.path;
                    for (const segment of ["", "docs", "plans", ...planPath.split("/")]) {
                        if (segment) component = join(component, segment);
                        const stat = await fsLstat(component).catch((error) => {
                            if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
                            throw error;
                        });
                        if (stat?.isSymbolicLink())
                            return { ...entry, documentUnavailable: "the document path uses a symlink" };
                    }
                }
                const canonical = await fsRealpath(entry.path);
                return attached.has(canonical)
                    ? entry
                    : {
                          ...entry,
                          documentUnavailable: "the directory is not an attached Git worktree of this project",
                      };
            } catch (error) {
                return { ...entry, documentUnavailable: error instanceof Error ? error.message : String(error) };
            }
        }),
    );
}

/** Document candidates include reopened Plans, but never expose retired attempt IDs as live. */
export async function listControllerDocumentWorktrees(cwd: string) {
    return await withProjectRuntimeReadScope(async () => {
        const registry = await inspectWorktreeRegistry(projectRoot(cwd));
        const active = registry.entries.filter((entry) => entry.status !== "abandoned");
        const selected = new Set(active.map((entry) => entry.planName));
        const live = active.filter((entry) => !isPublicationCleanupPending(entry.publication));
        const retired = registry.entries
            .filter((entry) => entry.status === "abandoned")
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        for (const entry of retired) {
            if (selected.has(entry.planName)) continue;
            const controller = managedPersonalStoreActive()
                ? (await readManagedRetainedExecution(cwd, entry.planId || entry.planName, entry.id))?.controller
                : await readControllerRecord(cwd, { planName: entry.planName, planId: entry.planId });
            if (controller?.state.documentWorktreeId !== entry.id) continue;
            if (await isRolledBackAnonymousCreation(projectRoot(cwd), entry)) continue;
            live.push(entry);
            selected.add(entry.planName);
        }
        return await inspectControllerDocumentWorktrees(cwd, live);
    });
}

/** Build the joined controller view without importing or cleaning controller state. */
export async function inspectControllerView(
    cwd: string,
    identity: WorkflowIdentity,
    legacy: WorkflowControllerState & WorkflowWorktreeContext,
) {
    const layout = await checkedProjectRuntimeLayout(cwd);
    const registry = await inspectWorktreeRegistryAtPath(layout.primary.worktreeRegistryPath);
    const candidates = registry.readError
        ? []
        : registry.entries.filter((entry) =>
              identity.planId && entry.planId ? entry.planId === identity.planId : entry.planName === identity.planName,
          );
    const live = candidates.filter((entry) => entry.status !== "abandoned");
    const lookup =
        registry.readError || live.length > 1
            ? { kind: "uncertain" as const }
            : live[0]
              ? { kind: "live" as const, entry: live[0] }
              : candidates.at(-1)
                ? { kind: "retired" as const, entry: candidates.at(-1)! }
                : { kind: "absent" as const };
    const record = currentManagedRetainedExecution()
        ? await readControllerRecord(cwd, identity)
        : await readControllerRecordAtPath(layout.primary.controllerPlansDir, identity);
    return projectCheckoutControllerView(lookup, record, legacy, cwd);
}

export async function prepareControllerView(
    cwd: string,
    identity: WorkflowIdentity,
    legacy: WorkflowControllerState & WorkflowWorktreeContext,
) {
    await enterProjectRuntime(cwd);
    return await withProjectRuntimeReadScope(async () => {
        const lookup = await inspectControllerWorktree(cwd, identity);
        const liveEntry = lookup.kind === "live" ? lookup.entry : null;
        const attempt = liveEntry?.status === "planning" ? null : liveEntry;
        let record = await readControllerRecord(cwd, identity);
        if ((attempt || lookup.kind === "retired") && record?.recovery) {
            // Once the registry owns the attempt, old import hints are finished.
            // Keeping them would resurrect a phantom attempt after publication prunes it.
            record = await writeControllerState(cwd, identity, {}, { recovery: null });
        }
        if (!record) {
            // Only the execution copy may seed legacy state once execution exists.
            // A stale primary document is never a fallback for missing runtime facts.
            const mayImport =
                lookup.kind === "absent" || (attempt && canonicalPath(attempt.path) === canonicalPath(cwd));
            if (
                mayImport &&
                (Object.values(pickControllerState(legacy)).some((value) => value != null) || legacy.worktreeId)
            ) {
                const recovery =
                    !attempt && legacy.worktreeId
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
        return await inspectControllerView(cwd, identity, legacy);
    });
}
