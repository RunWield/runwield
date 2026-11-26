import { MAX_CODE_BATCH_OPERATIONS, type CodeBatchOperation, type CodeBatchParams } from "./definitions/cymbal.ts";

export const MAX_CODE_BATCH_OUTPUT_CHARS = 50_000;

/** A completed read with its display text and error status. */
export interface CodeBatchRead {
    operation: CodeBatchOperation;
    text: string;
    isError: boolean;
}

/** The status and truncation of an individual requested operation. */
export interface CodeBatchItemDetails {
    operation: CodeBatchOperation;
    status: "success" | "error";
    truncated: boolean;
}

/** Machine-readable results in request order, including repeated operations. */
export interface CodeBatchDetails {
    operationCount: number;
    truncated: boolean;
    results: CodeBatchItemDetails[];
}

/** The rendered batch, per-operation outcomes, and overall failure status. */
export interface CodeBatchResult {
    text: string;
    details: CodeBatchDetails;
    isError: boolean;
}

export function validateCodeBatchParams(params: CodeBatchParams): string | null {
    if (!params || !Array.isArray(params.operations)) return "code_batch requires an operations array.";
    if (params.operations.length === 0) return "code_batch requires at least one operation.";
    if (params.operations.length > MAX_CODE_BATCH_OPERATIONS) {
        return `code_batch supports at most ${MAX_CODE_BATCH_OPERATIONS} operations per call.`;
    }
    for (let i = 0; i < params.operations.length; i++) {
        const operation = params.operations[i];
        if (!operation || typeof operation !== "object") return `operations[${i}] must be an object.`;
        if (operation.op === "show") {
            if (typeof operation.target !== "string" || operation.target.trim().length === 0) {
                return `operations[${i}].target must be a non-empty string for show.`;
            }
            continue;
        }
        if (operation.op === "outline") {
            if (typeof operation.file !== "string" || operation.file.trim().length === 0) {
                return `operations[${i}].file must be a non-empty string for outline.`;
            }
            continue;
        }
        return `operations[${i}].op must be "show" or "outline".`;
    }
    return null;
}

function formatSection(read: CodeBatchRead, index: number, budget: number) {
    const { operation } = read;
    const status = read.isError ? "error" : "success";
    const label = operation.op === "show" ? `show ${operation.target}` : `outline ${operation.file}`;
    // Reserve space for status and content even when a target is very long.
    const heading = label.length > 512 ? `${label.slice(0, 511)}…` : label;
    const prefix = `## ${index + 1}. ${heading}\nStatus: ${status}\n\n`;
    const body = read.text.trim() || "No results found.";
    const available = budget - prefix.length;
    const truncated = body.length > available;
    const marker = "\n\n[Result truncated. Use a narrower code_show or code_outline request.]";
    const text = prefix + (truncated ? body.slice(0, available - marker.length) + marker : body);
    const details: CodeBatchItemDetails = { operation, status, truncated };
    return { text, details };
}

export function reportCodeBatch(reads: readonly CodeBatchRead[]): CodeBatchResult {
    if (reads.length === 0 || reads.length > MAX_CODE_BATCH_OPERATIONS) {
        throw new RangeError(`code_batch requires 1 to ${MAX_CODE_BATCH_OPERATIONS} read results.`);
    }
    const separator = "\n\n---\n\n";
    const budget = Math.floor((MAX_CODE_BATCH_OUTPUT_CHARS - separator.length * (reads.length - 1)) / reads.length);
    const sections = reads.map((read, index) => formatSection(read, index, budget));
    return {
        text: sections.map((section) => section.text).join(separator),
        details: {
            operationCount: reads.length,
            truncated: sections.some((section) => section.details.truncated),
            results: sections.map((section) => section.details),
        },
        isError: sections.every((section) => section.details.status === "error"),
    };
}
