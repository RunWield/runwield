/** Saved delivery evidence shared by the terminal and Workspace session surfaces. */
import type { PublicationAttempt } from "./publication-attempt.ts";
import type { SessionArtifactKind } from "../session/file-session-store-types.ts";
type PlanAttributes = import("../../plan-store.js").PlanFrontMatter;
export interface DeliveryReportArtifact {
    title: string;
    kind: SessionArtifactKind;
    path: string;
    artifactId?: string;
}
export interface DeliveryReportRow {
    label: string;
    outcome: string;
    detail: string;
    tone: "success" | "warning" | "neutral";
}
export interface DeliveryReport {
    version: 1;
    planName: string;
    planId?: string;
    heading: string;
    checkedCommit?: string;
    deliveredCommit?: string;
    targetBranch?: string;
    rows: DeliveryReportRow[];
    artifacts: DeliveryReportArtifact[];
    settings: string;
    workRecordFailed: boolean;
}
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
            label: "Semantic AI review",
            outcome: !input.semanticRequired
                ? "Not required"
                : semantic?.kind === "ai-skip"
                ? semantic.outcome === "Human takeover" ? "Handed to human" : "Skipped"
                : semantic?.outcome === "Approved"
                ? "Passed"
                : "Evidence unavailable",
            tone: input.semanticRequired && semantic?.outcome === "Approved" ? "success" : "neutral",
            detail: input.semanticRequired && semantic?.kind === "ai-skip"
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
            label: "Human code review",
            outcome: humanApproved ? "Approved" : skipped ? "Skipped" : "Not recorded",
            tone: humanApproved ? "success" : "warning",
            detail: humanApproved
                ? `Decision recorded ${attrs.humanReviewedAt}. ${
                    counts("human", "human-revision", "rounds / revisions started")
                }`
                : mode === "none"
                ? "Reason: codereview = Never (stored: none). Rounds and revisions unavailable."
                : skipped
                ? "Skipped by user. Rounds and revisions unavailable."
                : "No recorded human approval. Rounds and revisions unavailable.",
        },
        {
            label: "Human verification",
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
                ? `Published commit confirmed on ${publication?.targetBranch}.`
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
        heading: confirmed ? "Code delivered" : "Workflow complete",
        checkedCommit: publication?.validatedCommit || attrs.validatedCommit || undefined,
        deliveredCommit: confirmed ? publication?.publishedCommit : undefined,
        targetBranch: publication?.targetBranch || attrs.targetBranch,
        rows,
        artifacts: [
            ...(input.evidence?.artifacts || []),
            ...(input.planPath ? [{ title: "Plan", kind: "plan" as const, path: input.planPath }] : []),
            ...(workRecordCreated && attrs.workRecord?.path &&
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
export function deliveryRowArtifacts(report: DeliveryReport, label: string): DeliveryReportArtifact[] {
    const titles: Record<string, string[]> = {
        "Mechanical tests / CI": ["Test results"],
        "Semantic AI review": ["Reviewer findings"],
        "Human code review": ["Human decisions"],
        "Merge": ["Merge confirmation"],
        "Work Record": ["Work Record"],
    };
    return report.artifacts.filter((artifact) => titles[label]?.includes(artifact.title));
}
