import { RunWieldButton } from "../../design-system/components/react/RunWieldPrimitives.tsx";
import { RunWieldSegmentedControl } from "../../design-system/components/react/RunWieldSegmentedControl.tsx";
import type { StandaloneReviewPayload } from "../../review/review-launcher.ts";
export type StandaloneReviewAction = "post_comments" | "approve_pr" | "approve_commit";
interface StandaloneCodeReviewActionsProps {
    review?: StandaloneReviewPayload;
    destination: string;
    busy: boolean;
    hasAnnotations: boolean;
    resultMessage: string;
    onDestination(destination: string): void;
    onAction(action: StandaloneReviewAction): void;
    onEngineer(): void;
}
export function StandaloneCodeReviewActions(
    { review, destination, busy, hasAnnotations, resultMessage, onDestination, onAction, onEngineer }:
        StandaloneCodeReviewActionsProps,
) {
    if (!review) return null;
    const reason = review.forge?.unavailableReason || review.forge?.postDisabledReason;
    const postDisabled = busy || !review.forge?.available || !review.forge.postEnabled;
    return (
        <>
            {review.mode === "pr" && (
                <RunWieldSegmentedControl aria-label="Review destination">
                    <button
                        type="button"
                        title="Post to PR"
                        aria-pressed={destination === "forge"}
                        onClick={() => onDestination("forge")}
                    >
                        <svg
                            aria-hidden="true"
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                        >
                            <path d="M7 17 17 7M7 7h10v10" />
                        </svg>
                        <span>Post to PR</span>
                    </button>
                    <button
                        type="button"
                        title="Engineer"
                        aria-pressed={destination === "engineer"}
                        onClick={() => onDestination("engineer")}
                    >
                        <svg
                            aria-hidden="true"
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                        >
                            <path d="m8 6-6 6 6 6m8-12 6 6-6 6" />
                        </svg>
                        <span>Engineer</span>
                    </button>
                </RunWieldSegmentedControl>
            )}
            {review.mode === "pr" && destination === "forge"
                ? (
                    <>
                        <RunWieldButton
                            disabled={postDisabled}
                            title={reason}
                            onClick={() => onAction("post_comments")}
                        >
                            Post comments
                        </RunWieldButton>
                        <RunWieldButton
                            variant="primary"
                            disabled={postDisabled}
                            title={reason}
                            onClick={() => onAction("approve_pr")}
                        >
                            Approve
                        </RunWieldButton>
                    </>
                )
                : (
                    <RunWieldButton disabled={busy || !hasAnnotations} onClick={onEngineer}>
                        Send to Engineer
                    </RunWieldButton>
                )}
            {review.mode === "uncommitted" && (
                <RunWieldButton
                    variant="primary"
                    disabled={busy || !review.commit?.enabled}
                    title={review.commit?.disabledReason ||
                        "The Operator writes a commit message, commits, and pushes these changes."}
                    onClick={() => onAction("approve_commit")}
                >
                    Approve &amp; Commit
                </RunWieldButton>
            )}
            {(resultMessage || review.resultMessage || reason) && (
                <span role="status">{resultMessage || review.resultMessage || reason}</span>
            )}
        </>
    );
}
