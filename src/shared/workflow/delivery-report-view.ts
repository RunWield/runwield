/** Browser-safe delivery evidence data and presentation values. */
import type { SessionArtifactKind } from "../session/session-artifact-types.ts";
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
export function deliveryRowArtifacts(report: DeliveryReport, label: string): DeliveryReportArtifact[] {
    const titles: Record<string, string[]> = {
        "Mechanical tests / CI": ["Test results"],
        "AI Code Review": ["Reviewer findings"],
        "Code Review": ["Review decisions", "Human decisions"],
        // Saved delivery reports retain their original row labels.
        "Human code review": ["Review decisions", "Human decisions"],
        "Semantic AI review": ["Reviewer findings"],
        Merge: ["Merge confirmation"],
        "Work Record": ["Work Record"],
    };
    return report.artifacts.filter((artifact) => titles[label]?.includes(artifact.title));
}
