/** Saved delivery evidence shared by the terminal and Workspace session surfaces. */
import type { PublicationAttempt } from "./publication-attempt.ts";
import type { DeliveryReport, DeliveryReportRow } from "./delivery-report-view.ts";
export type { DeliveryReport, DeliveryReportRow, DeliveryReportArtifact } from "./delivery-report-view.ts";
export { deliveryRowArtifacts } from "./delivery-report-view.ts";
type PlanAttributes = import("../../plan-store.js").PlanFrontMatter;
export interface DeliveryReportInput {
    planName: string;
    attrs: Partial<PlanAttributes>;
    planPath?: string;
    publication?: PublicationAttempt;
    guidedReview: string;
    codeReview: string;
    workRecordFailed: boolean;
    semanticRequired: boolean;
    evidence?: import("./delivery-evidence.ts").DeliveryEvidenceSummary;
}
/** Called only after publication gates succeed. Retry-budget counters are not historical totals. */
export function buildDeliveryReport(input: DeliveryReportInput): DeliveryReport {
    const { attrs, publication } = input;
    const confirmed = Boolean(publication?.verifiedAt && publication.publishedCommit);
    const landingBranch = publication?.targetBranch || attrs.deliveryBranch || attrs.targetBranch;
    const intendedTarget = attrs.targetBranch?.trim();
    const readyForMerge =
        confirmed &&
        !attrs.parentPlan &&
        Boolean(attrs.deliveryBranch) &&
        Boolean(intendedTarget) &&
        landingBranch !== intendedTarget?.replace(/^origin\//, "");
    const humanApproved = attrs.humanReviewDecision === "approved" && Boolean(attrs.humanReviewedAt);
    const mode = attrs.humanReviewMode || input.codeReview;
    const skipped = attrs.humanReviewDecision === "skipped" || attrs.humanReviewDecision === "not_required";
    const humanVerified = Boolean(attrs.userVerifiedAt && attrs.userVerificationNote);
    const workRecordCreated = attrs.workRecord?.status === "generated" && Boolean(attrs.workRecord.path);
    const counts = (kind: string, repair: string, nouns = "runs / repair cycles started") => {
        const entries = input.evidence?.entries || [];
        const runs = entries.filter((entry) => entry.kind === kind).length;
        const repairs = entries.filter((entry) => entry.kind === repair).length;
        return runs || repairs ? `${runs} / ${repairs} recorded ${nouns}.` : "Run and repair totals unavailable.";
    };
    const entries = input.evidence?.entries || [];
    const ci = entries.filter((entry) => entry.kind === "ci").at(-1);
    const ciPassed = ci?.outcome === "Exit 0";
    const semantic = entries.filter((entry) => entry.kind === "ai" || entry.kind === "ai-skip").at(-1);
    const rows: DeliveryReportRow[] = [
        {
            label: "Mechanical tests / CI",
            outcome: ciPassed ? "Passed" : "Evidence unavailable",
            tone: ciPassed ? "success" : "neutral",
            detail: `${counts("ci", "ci-repair")} ${
                input.evidence?.artifacts.some((a) => a.title === "Test results")
                    ? "Test results attached."
                    : "Detailed test results unavailable."
            }`,
        },
        {
            label: "AI Code Review",
            outcome: !input.semanticRequired
                ? "Not required"
                : semantic?.kind === "ai-skip"
                  ? semantic.outcome === "Human takeover"
                      ? "Handed to user"
                      : "Skipped"
                  : semantic?.outcome === "Approved"
                    ? "Passed"
                    : "Evidence unavailable",
            tone: input.semanticRequired && semantic?.outcome === "Approved" ? "success" : "neutral",
            detail:
                input.semanticRequired && semantic?.kind === "ai-skip"
                    ? semantic.detail
                    : input.semanticRequired
                      ? `${counts("ai", "ai-repair")} ${
                            input.evidence?.artifacts.some((a) => a.title === "Reviewer findings")
                                ? "Reviewer findings attached."
                                : "Reviewer findings unavailable."
                        }`
                      : "This workflow does not require semantic review. Run and repair totals unavailable.",
        },
        {
            label: "Code Review",
            outcome: humanApproved ? "Approved" : skipped ? "Skipped" : "Not recorded",
            tone: humanApproved ? "success" : "warning",
            detail: humanApproved
                ? `Decision recorded ${attrs.humanReviewedAt}. ${counts(
                      "human",
                      "human-revision",
                      "rounds / revisions started",
                  )}`
                : mode === "none"
                  ? "Reason: codereview = Never (stored: none). Rounds and revisions unavailable."
                  : skipped
                    ? "Skipped by user. Rounds and revisions unavailable."
                    : "No recorded user approval. Rounds and revisions unavailable.",
        },
        {
            label: "User verification",
            outcome: humanVerified ? "Attested by user" : "Not recorded",
            tone: humanVerified ? "success" : "warning",
            detail: humanVerified
                ? `${attrs.userVerifiedAt}: ${attrs.userVerificationNote}`
                : "No recorded evidence of a person exercising the result.",
        },
        {
            label: "Merge",
            outcome: confirmed
                ? "Confirmed"
                : attrs.executionMode === "non_git_in_place"
                  ? "Not applicable"
                  : "Evidence unavailable",
            tone: confirmed ? "success" : "neutral",
            detail: confirmed
                ? `Published commit confirmed on ${landingBranch}.` +
                  (readyForMerge
                      ? ` Merge ${landingBranch} into ${intendedTarget}, or open a PR to ${intendedTarget}.`
                      : "")
                : "A completed status alone is not proof of a merge.",
        },
        {
            label: "Work Record",
            outcome: input.workRecordFailed ? "Failed" : workRecordCreated ? "Created" : "Unavailable",
            tone: input.workRecordFailed ? "warning" : workRecordCreated ? "success" : "neutral",
            detail: input.workRecordFailed
                ? "Retry regenerates this record. wld wr backfill regenerates missing or failed records across completed Plans."
                : workRecordCreated
                  ? "Generated Work Record attached."
                  : "No generated Work Record backlink is available.",
        },
    ];
    return {
        version: 1,
        planName: input.planName,
        planId: attrs.planId,
        heading: readyForMerge ? "Ready for your merge/PR" : confirmed ? "Code delivered" : "Workflow complete",
        checkedCommit: publication?.validatedCommit || attrs.validatedCommit || undefined,
        deliveredCommit: confirmed ? publication?.publishedCommit : undefined,
        targetBranch: landingBranch,
        rows,
        artifacts: [
            ...(input.evidence?.artifacts || []),
            ...(input.planPath ? [{ title: "Plan", kind: "plan" as const, path: input.planPath }] : []),
            ...(workRecordCreated &&
            attrs.workRecord?.path &&
            !input.evidence?.artifacts.some((artifact) => artifact.kind === "work-record")
                ? [{ title: "Work Record", kind: "work-record" as const, path: attrs.workRecord.path }]
                : []),
        ],
        settings: `codereview = ${
            mode === "none" ? "Never (stored: none)" : mode
        }; guidedReview = ${input.guidedReview} (effective). Policy does not mean verification was performed.`,
        workRecordFailed: input.workRecordFailed,
    };
}
