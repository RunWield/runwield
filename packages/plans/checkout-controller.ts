import { realpathSync as fsRealpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { WorktreeRegistryEntry } from "@runwield/project-runtime/registry-inspection";
import { isPublicationCleanupPending } from "@runwield/workflow-publication-format";
import {
    pickControllerState,
    type ControllerRecord,
    type WorkflowControllerState,
    type WorkflowWorktreeContext,
} from "./controller-state.ts";

export interface WorkflowIdentity {
    planId?: string;
    planName: string;
}

export type PendingControllerRepair = "import_legacy_state" | "clear_obsolete_recovery";

type CheckoutControllerLookup =
    { kind: "live" | "retired"; entry: WorktreeRegistryEntry } | { kind: "absent" | "uncertain" };

export async function readControllerRecordAtPath(
    controllerPlansDir: string,
    identity: WorkflowIdentity,
): Promise<ControllerRecord | null> {
    const key = identity.planId || `name:${identity.planName}`;
    try {
        const record: ControllerRecord = JSON.parse(
            await readFile(join(controllerPlansDir, `${encodeURIComponent(key)}.json`), "utf8"),
        );
        if (record.version !== 1 || !Number.isInteger(record.revision) || !record.state) {
            throw new Error(
                "RunWield could not read this Plan's saved workflow. Your files and commits are unchanged.",
            );
        }
        return record;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
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

/** Join the selected registry observation with the checkout's controller, without mutating either. */
export function projectCheckoutControllerView(
    lookup: CheckoutControllerLookup,
    record: ControllerRecord | null,
    legacy: WorkflowControllerState & WorkflowWorktreeContext,
    cwd: string,
) {
    const liveEntry = lookup.kind === "live" ? lookup.entry : null;
    const attempt = liveEntry?.status === "planning" ? null : liveEntry;
    const documentEntry =
        liveEntry?.status === "planning" ? null : liveEntry || (lookup.kind === "retired" ? lookup.entry : null);
    const pendingRepairs: PendingControllerRepair[] = [];
    if ((attempt || lookup.kind === "retired") && record?.recovery) {
        pendingRepairs.push("clear_obsolete_recovery");
    }
    const legacyState = pickControllerState(legacy);
    const mayImport = lookup.kind === "absent" || (attempt && canonicalPath(attempt.path) === canonicalPath(cwd));
    const importsLegacy =
        !record &&
        Boolean(mayImport && (Object.values(legacyState).some((value) => value != null) || legacy.worktreeId));
    if (importsLegacy) pendingRepairs.push("import_legacy_state");
    const publicationPendingCleanup = isPublicationCleanupPending(documentEntry?.publication);
    const worktree: WorkflowWorktreeContext = publicationPendingCleanup
        ? {}
        : documentEntry && documentEntry.status !== "abandoned"
          ? {
                worktreeId: documentEntry.id,
                worktreePath: documentEntry.path,
                worktreeBranch: documentEntry.branch,
                worktreeBaseBranch: documentEntry.baseBranch,
                worktreeBaseCommit: documentEntry.baseCommit,
                worktreeStatus: documentEntry.status === "validated" ? "completed" : documentEntry.status,
                executionBaselineTree:
                    documentEntry.status === "planning"
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
            ...(record?.state || {}),
            ...(attempt && attempt.status !== "abandoned" ? { executionMode: "worktree" as const } : {}),
            ...worktree,
        },
        revision: record?.revision || 0,
        publicationConfirmed: Boolean(
            publicationPendingCleanup &&
            attempt?.publication?.publishedCommit &&
            record?.state.publicationReceipt?.publishedCommit === attempt.publication.publishedCommit &&
            record.state.publicationReceipt.validatedCommit === attempt.publication.validatedCommit &&
            record.state.publicationReceipt.targetBranch === attempt.publication.targetBranch,
        ),
        pendingRepairs,
    };
}
