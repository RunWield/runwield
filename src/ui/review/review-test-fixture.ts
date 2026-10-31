import type { BrowserPort } from "../../shared/browser-port.ts";

export interface ReviewImageDecision {
    path: string;
    name: string;
}

export interface ReviewAnnotationDecision {
    id?: string;
    type?: string;
    scope?: string;
    file?: string;
    filePath?: string;
    line?: number;
    lineStart?: number;
    lineEnd?: number;
    side?: string;
    text?: string;
    comment?: string;
    images?: ReviewImageDecision[];
}

export interface ReviewDecisionBody {
    reviewRevision?: number;
    documents?: import("../../shared/workflow/sequence-review.ts").SequenceDocumentDecision[];
    approved?: boolean;
    conversationTurn?: boolean;
    feedback?: string;
    annotations?: ReviewAnnotationDecision[];
    images?: ReviewImageDecision[];
    globalAttachments?: ReviewImageDecision[];
    plan?: string;
    approvalAction?: "run" | "decompose" | "later";
    executionAgent?: "engineer" | "frontend-engineer";
    collaborationRecommendation?: "autonomous" | "pair";
    reviewType?: "plan" | "code";
}

type ReviewDecisionRoute = "decision" | "deny" | "feedback" | "exit";

export interface ScriptedReviewBrowser {
    browser: BrowserPort;
    urls: string[];
}

export function createScriptedReviewBrowser(
    route: ReviewDecisionRoute,
    body: ReviewDecisionBody,
    opened = true,
): ScriptedReviewBrowser {
    const urls: string[] = [];
    return {
        urls,
        browser: {
            async open(url: string): Promise<boolean> {
                urls.push(url);
                const reviewUrl = new URL(url);
                const token = reviewUrl.searchParams.get("token");
                if (!token) throw new Error("Review URL did not contain a token.");
                const response = await fetch(
                    new URL(`/api/review/${route}?token=${encodeURIComponent(token)}`, reviewUrl.origin),
                    {
                        method: "POST",
                        headers: {
                            "content-type": "application/json",
                            "x-runwield-review-token": token,
                        },
                        body: JSON.stringify(body),
                    },
                );
                if (!response.ok) {
                    throw new Error(`Review decision failed: ${response.status} ${await response.text()}`);
                }
                return opened;
            },
        },
    };
}
