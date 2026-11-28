import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomically } from "@runwield/resources/fs";
import {
    currentOperationReceiptResultPath,
    captureBatchOperation,
    completeSequenceOperationReceipt,
    hasSequenceOperationReceipt,
    type BatchOperationIntent,
    inspectOperationReceipt,
    operationReceiptResultPath,
} from "@runwield/plans/operation-receipts";
import type { SavedChildFeaturePlan } from "../plan-store.ts";
import type { SequenceReviewResult } from "./sequence-review.ts";
import type { SharedPlanReviewActionResult } from "./review.ts";
import type { WorkflowControllerState, WorkflowWorktreeContext } from "@runwield/plans/controller-state";
import type { CollaborationMutation } from "./collaboration/operation-state.ts";
import type { CollaborationResult } from "./collaboration/operations.ts";

/** Keep the authoring result beside its receipt before the batch can publish any child. */
export function retainChildAuthoringResult(children: SavedChildFeaturePlan[]): void {
    const path = currentOperationReceiptResultPath("child-authoring-results");
    if (!path) return;
    writeJsonAtomically(path, children);
}
export function readChildAuthoringResult(
    directory: string,
    operationId: string,
    planId: string,
): SavedChildFeaturePlan[] {
    const receipt = inspectOperationReceipt(directory, operationId, planId);
    if (receipt.status !== "completed") throw new Error("Child authoring has not committed.");
    const path = operationReceiptResultPath(directory, operationId, "child-authoring-results");
    return JSON.parse(readFileSync(path, "utf8"));
}

interface SequenceOperationResult extends BatchOperationIntent {
    result: SequenceReviewResult;
}

export interface RetainedReviewCommit {
    path: string;
    planId: string;
    planName: string;
    beforeRevision: string;
    afterRevision: string;
    markdown: string;
    controllerRevision: number;
    controllerState: WorkflowControllerState;
    controllerRecovery?: WorkflowWorktreeContext;
    worktreeId?: string;
}

interface PlanReviewOperationResult {
    result: SharedPlanReviewActionResult;
    retained?: RetainedReviewCommit;
}

export function retainPlanReviewOperationResult(
    result: SharedPlanReviewActionResult,
    retained?: RetainedReviewCommit,
): void {
    const path = currentOperationReceiptResultPath("plan-review-results");
    if (path) writeJsonAtomically(path, { result, ...(retained && { retained }) } satisfies PlanReviewOperationResult);
}

export function readPendingRetainedReview(): PlanReviewOperationResult | undefined {
    const path = currentOperationReceiptResultPath("plan-review-results");
    if (!path || !existsSync(path)) return undefined;
    const operation: PlanReviewOperationResult = JSON.parse(readFileSync(path, "utf8"));
    return operation.retained ? operation : undefined;
}

export function readPlanReviewOperationResult(
    directory: string,
    operationId: string,
    planId: string,
): SharedPlanReviewActionResult | undefined {
    const receipt = inspectOperationReceipt(directory, operationId, planId);
    if (receipt.status !== "completed") return undefined;
    const path = operationReceiptResultPath(directory, operationId, "plan-review-results");
    if (!existsSync(path)) return undefined;
    const { result }: PlanReviewOperationResult = JSON.parse(readFileSync(path, "utf8"));
    return { ...result, revision: receipt.revision };
}

export function findSequenceReviewOperationResult(
    directory: string,
    operationId: string,
    planId: string,
): SequenceReviewResult | undefined {
    if (inspectOperationReceipt(directory, operationId, planId).status !== "completed") return undefined;
    if (!existsSync(operationReceiptResultPath(directory, operationId, "sequence-review-results"))) return undefined;
    return readSequenceOperationResult(directory, operationId, planId);
}

export function retainSequenceOperationResult(result: SequenceReviewResult): void {
    const operation = captureBatchOperation();
    const path = currentOperationReceiptResultPath("sequence-review-results");
    if (!operation || !path) return;
    writeJsonAtomically(path, { ...operation, result } satisfies SequenceOperationResult);
}

function retainedSequenceOperationResult(directory: string, operationId: string): SequenceOperationResult {
    const path = operationReceiptResultPath(directory, operationId, "sequence-review-results");
    return JSON.parse(readFileSync(path, "utf8"));
}

export function readSequenceOperationResult(
    directory: string,
    operationId: string,
    planId: string,
): SequenceReviewResult {
    if (inspectOperationReceipt(directory, operationId, planId).status !== "completed")
        throw new Error("Sequence review has not committed.");
    return retainedSequenceOperationResult(directory, operationId).result;
}

/** Settle after the native Sequence transition confirms the complete decision. */
export function settleSequenceOperationResult(directory: string, operationId: string): void {
    if (!hasSequenceOperationReceipt(directory, operationId)) return;
    const { result, ...retained } = retainedSequenceOperationResult(directory, operationId);
    completeSequenceOperationReceipt(directory, operationId, retained, result.revision);
}

/** A share receipt settled by the Plan Server's durable deletion or expiry record. */
export interface GoneShareOperationResult {
    action: "share-gone";
    value: { planId: string };
}

interface RetainedGoneShareOperationResult extends GoneShareOperationResult {
    requestId: string;
}

type RetainedCollaborationOperationResult = CollaborationResult | RetainedGoneShareOperationResult;

export function retainCollaborationOperationResult(result: RetainedCollaborationOperationResult): void {
    const path = currentOperationReceiptResultPath("collaboration-results");
    if (!path) return;
    writeJsonAtomically(path, result);
}
/** Keep the request identity on the owner so a retry can settle its exact local attempt. */
export function retainGoneShareOperationResult(planId: string, requestId: string): void {
    retainCollaborationOperationResult({ action: "share-gone", value: { planId }, requestId });
}

export function inspectCollaborationOperationResult(
    directory: string,
    operationId: string,
): RetainedCollaborationOperationResult | undefined {
    if (!/^[a-f0-9-]{36}$/.test(operationId)) throw new Error("Invalid collaboration operation identity.");
    const path = operationReceiptResultPath(directory, operationId, "collaboration-results");
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}
export function readCollaborationOperationResult(
    directory: string,
    operationId: string,
    projectId: string,
): CollaborationResult | GoneShareOperationResult {
    if (inspectOperationReceipt(directory, operationId, projectId).status !== "completed")
        throw new Error("Collaboration operation has not completed.");
    const result = inspectCollaborationOperationResult(directory, operationId);
    if (!result) throw new Error("Collaboration result is unavailable.");
    if (result.action === "share-gone") return { action: result.action, value: result.value };
    return result;
}

interface CollaborationEffectState {
    started: boolean;
    replayableShare?: boolean;
    mutation?: CollaborationMutation;
}
function collaborationEffectPath(directory: string, operationId: string): string {
    if (!/^[a-f0-9-]{36}$/.test(operationId)) throw new Error("Invalid collaboration effect identity.");
    const path = operationReceiptResultPath(directory, operationId, "collaboration-effects");
    return path;
}
export function markCollaborationNetworkEffect(started = true): void {
    const path = currentOperationReceiptResultPath("collaboration-effects");
    if (path)
        writeJsonAtomically(path, {
            started,
        } satisfies CollaborationEffectState);
}
export function markReplayableShareNetworkEffect(): void {
    const path = currentOperationReceiptResultPath("collaboration-effects");
    if (path) writeJsonAtomically(path, { started: true, replayableShare: true } satisfies CollaborationEffectState);
}
export function retainCollaborationMutation(mutation: CollaborationMutation): void {
    const path = currentOperationReceiptResultPath("collaboration-effects");
    if (path)
        writeJsonAtomically(path, {
            started: true,
            mutation,
        } satisfies CollaborationEffectState);
}
function collaborationEffect(directory: string, operationId: string): CollaborationEffectState {
    const path = collaborationEffectPath(directory, operationId);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { started: false };
}
export function collaborationNetworkEffectBlocksRetry(directory: string, operationId: string): boolean {
    const { started, replayableShare } = collaborationEffect(directory, operationId);
    return started && !replayableShare;
}
export function collaborationNetworkEffectStarted(directory: string, operationId: string): boolean {
    return collaborationEffect(directory, operationId).started;
}
export function inspectCollaborationMutation(
    directory: string,
    operationId: string,
): CollaborationMutation | undefined {
    return collaborationEffect(directory, operationId).mutation;
}
