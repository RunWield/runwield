import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
/**
 * @module ui/review/code-review
 * Launches the browser code-review surface for a completed workflow diff.
 */

import {
    type ReviewConversation,
    type ReviewDecisionValue,
    type StandaloneReviewPayload,
    startCodeReviewSurface,
} from "./review-launcher.ts";
import { isAbsolute, resolve } from "node:path";
import { mimeTypeForImagePath } from "../../shared/session/image-attachments.ts";
import type { GuidedReviewPolicy } from "../../shared/workflow/guided-review.js";
import type { BrowserPort } from "../../shared/browser-port.ts";

const MAX_CODE_REVIEW_IMAGE_BYTES = 20 * 1024 * 1024;

type ReviewData = ReviewDecisionValue;

interface ReviewDataRecord {
    [key: string]: ReviewData;
}

export type CodeReviewAnnotation = ReviewDataRecord & {
    file?: string;
    path?: string;
    filePath?: string;
    line?: number;
    text?: string;
    comment?: string;
};

interface ReviewImageAttachment {
    path: string;
    name: string;
}

interface LoadedReviewImage {
    base64: string;
    mimeType: string;
    name: string;
}

export interface CodeReviewDecision {
    [key: string]: ReviewData | Array<ReviewImageAttachment | LoadedReviewImage>;
    approved: boolean;
    feedback: string;
    annotations: CodeReviewAnnotation[];
    exit: boolean;
    canceled: boolean;
    conversationTurn?: boolean;
    images?: Array<ReviewImageAttachment | LoadedReviewImage>;
}

interface CodeReviewSurfaceReady {
    url: string;
    opened: boolean;
}

interface RunCodeReviewOptions {
    standaloneReview?: StandaloneReviewPayload;
    gitRef?: string;
    planName: string;
    planTitle?: string;
    diffText: string;
    planContent?: string;
    planAttrs?: Record<string, ReviewData>;
    executionCwd: string;
    targetBranch?: string;
    guidedReview?: GuidedReviewPolicy;
    reviewConversation?: ReviewConversation;
    agentLabel?: string;
    signal?: AbortSignal;
    browser: BrowserPort;
    onSurfaceReady?(surface: CodeReviewSurfaceReady): void;
}

function isReviewDataRecord(value: ReviewData): value is ReviewDataRecord {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeAnnotations(value: ReviewData): CodeReviewAnnotation[] {
    if (!Array.isArray(value)) return [];
    return value.filter(isReviewDataRecord) as CodeReviewAnnotation[];
}

function normalizeImageAttachments(value: ReviewData): ReviewImageAttachment[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((image) => {
        if (!isReviewDataRecord(image)) return [];
        const path = typeof image.path === "string" ? image.path.trim() : "";
        if (!path) return [];
        const name = typeof image.name === "string" && image.name.trim() ? image.name.trim() : "image";
        return [{ path, name }];
    });
}

export function normalizeCodeReviewDecision(decision: ReviewData): CodeReviewDecision {
    if (!isReviewDataRecord(decision)) {
        return { approved: false, feedback: "", annotations: [], exit: true, canceled: false };
    }

    const approved = decision.approved === true;
    const feedback = typeof decision.feedback === "string" ? decision.feedback : "";
    const annotations = normalizeAnnotations(decision.annotations);
    const images = normalizeImageAttachments(decision.images);
    const canceled = decision.canceled === true || decision.cancelled === true;
    const explicitlyExited = decision.exit === true || canceled;
    const reviewAction = ["post_comments", "approve_pr", "approve_commit"].includes(String(decision.reviewAction))
        ? decision.reviewAction
        : undefined;
    const noDecision = !reviewAction && !approved && !feedback.trim() && annotations.length === 0 &&
        images.length === 0;

    return {
        approved,
        ...(reviewAction && { reviewAction }),
        feedback,
        annotations,
        exit: explicitlyExited || noDecision,
        canceled,
        ...(decision.conversationTurn === true && { conversationTurn: true }),
        ...(images.length > 0 && { images }),
    };
}

/**
 * Read code-review images before the temporary upload files are removed.
 * Invalid files stay fail-soft so text and inline feedback are still delivered.
 */
async function loadCodeReviewImages(
    attachments: ReviewImageAttachment[],
    cwd: string,
): Promise<LoadedReviewImage[]> {
    const images: LoadedReviewImage[] = [];
    for (const attachment of attachments) {
        try {
            const path = isAbsolute(attachment.path) ? attachment.path : resolve(cwd, attachment.path);
            const stat = await fsStat(path);
            if (!stat.isFile() || stat.size > MAX_CODE_REVIEW_IMAGE_BYTES) {
                throw new Error(stat.size > MAX_CODE_REVIEW_IMAGE_BYTES ? "image exceeds 20 MB" : "path is not a file");
            }
            const bytes = await fsReadFile(path);
            images.push({
                base64: bytesToBase64(bytes),
                mimeType: mimeTypeForImagePath(path),
                name: attachment.name,
            });
        } catch (_error) {
            // The review decision remains usable when an attachment disappears.
        }
    }
    return images;
}

function bytesToBase64(bytes: Uint8Array): string {
    const chunks: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
    }
    return btoa(chunks.join(""));
}

export function formatCodeReviewAnnotations(annotations: CodeReviewAnnotation[]): string {
    if (annotations.length === 0) return "";

    return annotations.map((annotation, index) => {
        const file = annotation.file || annotation.path || annotation.filePath || "unknown file";
        const line = typeof annotation.line === "number" ? `:${annotation.line}` : "";
        const text = annotation.text || annotation.comment || "";
        return `${index + 1}. ${file}${line}${text ? `\n${text}` : ""}`;
    }).join("\n\n");
}

/**
 * Launch the browser code-review surface for the supplied diff.
 */
export async function runCodeReview({
    standaloneReview,
    gitRef,
    planName,
    planTitle,
    diffText,
    planContent,
    planAttrs,
    executionCwd,
    targetBranch,
    guidedReview,
    reviewConversation,
    agentLabel,
    signal,
    browser,
    onSurfaceReady,
}: RunCodeReviewOptions): Promise<CodeReviewDecision> {
    const server = await startCodeReviewSurface<ReviewData>({
        standaloneReview,
        rawPatch: diffText,
        gitRef: gitRef || `RunWield workflow diff: ${planName}`,
        agentCwd: executionCwd,
        targetBranch,
        planName,
        planTitle: typeof planTitle === "string" && planTitle.trim() ? planTitle.trim() : planName.trim(),
        planContent,
        planAttrs,
        guidedReview,
        reviewConversation,
        agentLabel,
        browser,
        onSurfaceReady,
    });

    let keepSurfaceOpen = false;
    let cancelListener: (() => void) | undefined;
    try {
        const canceled = new Promise<ReviewDataRecord>((resolveCanceled) => {
            if (signal?.aborted) {
                resolveCanceled({ canceled: true });
                return;
            }
            cancelListener = () => resolveCanceled({ canceled: true });
            signal?.addEventListener("abort", cancelListener, { once: true });
        });
        const rawDecision: ReviewData = await (
            signal ? Promise.race([server.waitForDecision(), canceled]) : server.waitForDecision()
        );
        const decision = normalizeCodeReviewDecision(
            rawDecision,
        );
        keepSurfaceOpen = decision.conversationTurn === true || Boolean(standaloneReview && decision.reviewAction);
        if (!decision.images?.length) return decision;
        const attachments = decision.images.filter((image): image is ReviewImageAttachment => "path" in image);
        const images = await loadCodeReviewImages(attachments, executionCwd);
        return { ...decision, images };
    } finally {
        if (cancelListener) signal?.removeEventListener("abort", cancelListener);
        // Conversation turns keep the token page alive until the refreshed diff is published.
        if (!keepSurfaceOpen) await server.stop();
    }
}
