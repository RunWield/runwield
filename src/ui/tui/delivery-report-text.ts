import {
    type DeliveryReport,
    type DeliveryReportArtifact,
    deliveryRowArtifacts,
} from "../../shared/workflow/delivery-report.ts";

export function deliveryReportText(report: DeliveryReport, sessionId?: string): string {
    const link = (artifact: DeliveryReportArtifact, label?: string) => {
        const title = label || (artifact.kind === "plan" ? "Approved Plan" : artifact.title);
        return sessionId && artifact.artifactId
            ? `\x1b]8;;runwield-artifact://${encodeURIComponent(sessionId)}/${
                encodeURIComponent(artifact.artifactId)
            }\x07${title} ↗\x1b]8;;\x07`
            : `${title} (reader unavailable)`;
    };
    const plan = report.artifacts.find((artifact) => artifact.kind === "plan");
    const confirmation = report.artifacts.find((artifact) => artifact.title === "Merge confirmation");
    const commit = (hash?: string) => hash && confirmation ? link(confirmation, hash) : hash || "Unavailable";
    return [
        report.heading,
        `Plan: ${report.planName}${plan ? ` · ${link(plan)}` : ""}`,
        `Checked candidate: ${commit(report.checkedCommit)}`,
        `Delivered commit: ${commit(report.deliveredCommit)}`,
        `Landing branch: ${report.targetBranch || "Not applicable / unavailable"}`,
        ...report.rows.map((row) =>
            `${row.label}: ${row.outcome}\n  ${row.detail}${
                deliveryRowArtifacts(report, row.label).map((artifact) => ` · ${link(artifact)}`).join("")
            }`
        ),
        `Settings: ${report.settings}`,
        ...(report.artifacts.length ? ["Click an artifact link, or Esc then Alt+] for Session artifacts."] : []),
    ].join("\n");
}
