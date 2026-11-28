import { isProjectId, type ProjectId } from "@runwield/projects";
import { isNonterminalWorktreeStatus, type WorktreeRegistryEntry } from "@runwield/project-runtime/registry-inspection";
import type { CreateProjectPlan, PlanAuthoringInput, ReviseProjectPlan } from "./store.ts";

export type ExecutionRecoveryAction =
    "stop" | "clear" | "detach" | "clear-recovery" | "refresh" | "recreate" | "user-verified";

/** Names the saved host operation that replaces the reserved attempt. */
export interface ExecutionRecreation {
    operationId: string;
    replacementAttemptId: string;
    expectedRevision: string;
}

/** Identifies the reserved attempt and the state that the execution host must verify. */
export interface ExecutionRecoveryRequest {
    projectId: string;
    repositoryId: string;
    personalOwner: string;
    planId: string;
    planName: string;
    attemptId: string;
    purpose: "active" | "abandoned";
    recreate?: ExecutionRecreation;
}

/** Registry evidence available for a live worktree or retained in its removal journal. */
export type RecoveryExecutionRecord = Pick<
    WorktreeRegistryEntry,
    "id" | "planId" | "planName" | "path" | "branch" | "status"
> &
    Partial<WorktreeRegistryEntry>;

/** The host’s observation of the requested attempt, with its journal ID when applicable. */
export interface ExecutionRecoveryEvidence {
    request: ExecutionRecoveryRequest;
    entry: RecoveryExecutionRecord;
    observedAt: string;
    transitionId?: string;
}

/** Check the host reply against the original request before its registry fields can be used. */
export function validateExecutionRecoveryEvidence(
    request: ExecutionRecoveryRequest,
    evidence: ExecutionRecoveryEvidence,
): void {
    const reply = evidence?.request;
    const entry = evidence?.entry;
    const recreate = request.recreate;
    if (
        !reply ||
        reply.projectId !== request.projectId ||
        reply.repositoryId !== request.repositoryId ||
        reply.personalOwner !== request.personalOwner ||
        reply.planId !== request.planId ||
        reply.planName !== request.planName ||
        reply.attemptId !== request.attemptId ||
        reply.purpose !== request.purpose ||
        (recreate
            ? request.purpose !== "active" ||
              !/^[a-f0-9-]{36}$/.test(recreate.operationId) ||
              !/^[a-f0-9]{64}$/.test(recreate.expectedRevision) ||
              !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(recreate.replacementAttemptId) ||
              recreate.replacementAttemptId === request.attemptId ||
              reply.recreate?.operationId !== recreate.operationId ||
              reply.recreate?.replacementAttemptId !== recreate.replacementAttemptId ||
              reply.recreate?.expectedRevision !== recreate.expectedRevision ||
              evidence.transitionId !== recreate.operationId
            : reply.recreate !== undefined) ||
        !entry ||
        (recreate &&
            (entry.status !== "active" ||
                typeof entry.baseBranch !== "string" ||
                !entry.baseBranch ||
                [entry.baseCommit, entry.baseTree].some(
                    (value) => typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value),
                ))) ||
        entry.id !== (recreate?.replacementAttemptId ?? request.attemptId) ||
        entry.planId !== request.planId ||
        entry.planName !== request.planName ||
        (!recreate &&
            (request.purpose === "abandoned"
                ? entry.status !== "abandoned"
                : !isNonterminalWorktreeStatus(entry.status))) ||
        typeof entry.path !== "string" ||
        !entry.path.startsWith("/") ||
        entry.path.includes("\0") ||
        typeof entry.branch !== "string" ||
        !entry.branch ||
        entry.branch.includes("\0") ||
        [entry.baseBranch, entry.baseCommit, entry.baseTree, entry.executionBaselineTree].some(
            (value) => value !== undefined && (typeof value !== "string" || value.includes("\0")),
        ) ||
        typeof evidence.observedAt !== "string" ||
        !Number.isFinite(Date.parse(evidence.observedAt)) ||
        (!recreate &&
            evidence.transitionId !== undefined &&
            (request.purpose !== "abandoned" || typeof evidence.transitionId !== "string" || !evidence.transitionId))
    )
        throw new Error("Execution recovery proof changed ownership or does not prove the requested state.");
}

/** Authority returned by the personal Project's Plan store. */
export interface ProjectStoreBinding {
    projectId: ProjectId;
    repositoryId: string;
    ownerId: string;
}

/** Fresh managed creation reserves its Plan ID on the personal host. */
export interface ManagedPlanCreation {
    kind: "create-plan";
    operationId: string;
    input: CreateProjectPlan;
}

/** Managed revision addresses an existing Plan and carries its observed revision. */
export interface ManagedPlanRevision {
    kind: "revise-plan";
    operationId: string;
    planId: string;
    expectedRevision: string;
    input: Omit<ReviseProjectPlan, "expectedRevision">;
}

/** The original authoring command remains available for exact replay of retained requests. */
export interface LegacyManagedPlanAuthoring {
    kind: "author-plan";
    operationId: string;
    planId: string;
    input: PlanAuthoringInput;
}

/** The authenticated Plan store routes and the serialized body of a validated operation. */
export type ManagedPlanStoreRequest =
    | { route: "/project-store/inspect" | "/project-store/admit"; body?: never }
    | { route: "/project-store"; body: string };

/** Send a Plan store request with the host's authentication and connection lifetime. */
export type RequestManagedPlanStore = (request: ManagedPlanStoreRequest, signal?: AbortSignal) => Promise<Response>;

/** Check that a wire binding identifies exactly one Project, execution repository, and personal owner. */
export function validateProjectStoreBinding(binding: ProjectStoreBinding): void {
    if (
        !binding ||
        typeof binding !== "object" ||
        Array.isArray(binding) ||
        Object.keys(binding).sort().join(",") !== "ownerId,projectId,repositoryId"
    )
        throw new Error("Unsupported request fields.");
    if (
        !isProjectId(binding.projectId) ||
        typeof binding.repositoryId !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(binding.repositoryId) ||
        !/^[a-f0-9]{64}$/.test(binding.ownerId)
    )
        throw new Error("Invalid Project owner binding.");
}

/** Compare personal owner, Project, and repository identities. */
export function sameProjectStoreBinding(left: ProjectStoreBinding, right: ProjectStoreBinding): boolean {
    return (
        left.projectId === right.projectId && left.repositoryId === right.repositoryId && left.ownerId === right.ownerId
    );
}

/** A rejected owner mutation that can be submitted again with a fresh observation. */
export class ProjectStorePreconditionError extends Error {}

/** Maximum bytes in a Plan store message. */
export const PROJECT_STORE_MAX_BYTES = 1024 * 1024;

/** Read a bounded UTF-8 Plan store message. */
export async function readProjectStoreBody(source: Request | Response): Promise<string> {
    const reader = source.body?.getReader();
    if (!reader) throw new Error("Missing store body.");
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > PROJECT_STORE_MAX_BYTES) {
                await reader.cancel();
                throw new Error("Store body too large.");
            }
            parts.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
