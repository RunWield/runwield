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

export function retainCollaborationOperationResult(result: CollaborationResult): void {
    const path = currentOperationReceiptResultPath("collaboration-results");
    if (!path) return;
    writeJsonAtomically(path, result);
}
export function inspectCollaborationOperationResult(
    directory: string,
    operationId: string,
): CollaborationResult | undefined {
    if (!/^[a-f0-9-]{36}$/.test(operationId)) throw new Error("Invalid collaboration operation identity.");
    const path = operationReceiptResultPath(directory, operationId, "collaboration-results");
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}
export function readCollaborationOperationResult(
    directory: string,
    operationId: string,
    projectId: string,
): CollaborationResult {
    if (inspectOperationReceipt(directory, operationId, projectId).status !== "completed")
        throw new Error("Collaboration operation has not completed.");
    const result = inspectCollaborationOperationResult(directory, operationId);
    if (!result) throw new Error("Collaboration result is unavailable.");
    return result;
}

interface CollaborationEffectState {
    started: boolean;
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
export function collaborationNetworkEffectStarted(directory: string, operationId: string): boolean {
    return collaborationEffect(directory, operationId).started;
}
export function inspectCollaborationMutation(
    directory: string,
    operationId: string,
): CollaborationMutation | undefined {
    return collaborationEffect(directory, operationId).mutation;
}
