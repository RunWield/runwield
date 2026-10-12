/** Illustrative fixture only. No live repository, user, model, or cost data. */
import { buildDeliveryReport } from "../../../shared/workflow/delivery-report.ts";
import { createPublicationAttempt } from "../../../shared/workflow/publication-attempt.ts";
const time = "2026-10-08T10:00:00Z";
export const DEV_DELIVERY_REPORT = buildDeliveryReport({
    planName: "Illustrative delivery fixture",
    attrs: {
        planId: "delivery-fixture",
        classification: "PLANNED_CHANGE",
        targetBranch: "main",
        deliveryBranch: "plan/illustrative-delivery",
        humanReviewMode: "always",
        humanReviewDecision: "approved",
        humanReviewedAt: time,
        workRecord: { status: "generated", path: "docs/work-records/illustrative-delivery.md" },
    },
    planPath: "docs/plans/illustrative-delivery.md",
    publication: {
        ...createPublicationAttempt({
            attemptId: "fixture",
            planId: "delivery-fixture",
            planName: "Illustrative delivery fixture",
            targetBranch: "plan/illustrative-delivery",
            executionBranch: "example-feature",
            executionCwd: "/fixture",
            publicationRoot: "/fixture",
            validatedCommit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
            targetHeadAtSeal: "c".repeat(40),
        }),
        publishedCommit: "b2c3d4e5f60718293a4b5c6d7e8f90123456789a",
        verifiedAt: time,
    },
    guidedReview: "auto",
    codeReview: "always",
    workRecordFailed: false,
    semanticRequired: true,
    evidence: {
        entries: [
            { version: 1, kind: "ci", outcome: "Exit 1", recordedAt: time, detail: "Illustrative failed check" },
            { version: 1, kind: "ci-repair", outcome: "Started", recordedAt: time, detail: "" },
            { version: 1, kind: "ci", outcome: "Exit 0", recordedAt: time, detail: "Illustrative passing check" },
            { version: 1, kind: "ai", outcome: "Approved", recordedAt: time, detail: "Illustrative reviewer approval" },
            {
                version: 1,
                kind: "human",
                outcome: "Approved",
                recordedAt: time,
                detail: "Illustrative human code review",
            },
        ],
        artifacts: [
            { title: "Test results", kind: "report", path: "fixture-tests.md" },
            { title: "Reviewer findings", kind: "report", path: "fixture-review.md" },
            { title: "Merge confirmation", kind: "report", path: "fixture-merge.md" },
        ],
    },
});
DEV_DELIVERY_REPORT.artifacts.forEach((artifact, i) => {
    artifact.artifactId = `delivery-fixture-${i}`;
});
export function devDeliveryArtifact(artifactId: string) {
    const artifact = DEV_DELIVERY_REPORT.artifacts.find((item) => item.artifactId === artifactId);
    if (!artifact) throw new Error("Session artifact not found.");
    return {
        ...artifact,
        imageBaseDir: "",
        markdown:
            `# ${artifact.title}\n\n> Illustrative fixture. These are not real delivery results.\n\n## Checked candidate\n\n${DEV_DELIVERY_REPORT.checkedCommit}\n\n## Delivered commit\n\n${DEV_DELIVERY_REPORT.deliveredCommit}\n\nHuman verification: Not recorded.\n`,
    };
}
