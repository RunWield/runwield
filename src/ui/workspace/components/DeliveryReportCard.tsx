import { useState } from "react";
import {
    type DeliveryReport,
    type DeliveryReportArtifact,
    deliveryRowArtifacts,
} from "../../../shared/workflow/delivery-report.ts";
import { RunWieldButton, RunWieldThinkingDots } from "../../design-system/components/react/RunWieldPrimitives.tsx";

/** A saved report in the owning Session timeline, never a new dashboard. */
interface DeliveryReportCardProps {
    report: DeliveryReport;
    sessionPath?: string;
    onRetryWorkRecord?: (report: DeliveryReport) => Promise<string>;
}
export function DeliveryReportCard({ report, sessionPath, onRetryWorkRecord }: DeliveryReportCardProps) {
    const [pending, setPending] = useState(false);
    const [message, setMessage] = useState("");
    async function retry() {
        if (pending || !onRetryWorkRecord) return;
        setPending(true);
        setMessage("");
        try {
            setMessage(await onRetryWorkRecord(report));
        } catch (error) {
            setMessage(error instanceof Error ? error.message : String(error));
        } finally {
            setPending(false);
        }
    }
    const confirmation = report.artifacts.find((artifact) =>
        artifact.title === "Merge confirmation" && artifact.artifactId
    );
    const confirmationHref = confirmation && sessionPath
        ? `${sessionPath}/artifacts/${encodeURIComponent(confirmation.artifactId || "")}`
        : "";
    function artifactLink(artifact: DeliveryReportArtifact) {
        return artifact.artifactId && sessionPath
            ? (
                <a key={artifact.path} href={`${sessionPath}/artifacts/${encodeURIComponent(artifact.artifactId)}`}>
                    {artifact.kind === "plan" ? "Approved Plan" : artifact.title}
                </a>
            )
            : <span key={artifact.path}>{artifact.title}: reader unavailable</span>;
    }
    return (
        <article className="rw-delivery-report" aria-label="Delivery evidence">
            <header>
                <h3>{report.heading}</h3>
                <span>{report.planName}</span>
                {report.artifacts.filter((artifact) => artifact.kind === "plan").map(artifactLink)}
            </header>
            <dl className="rw-delivery-report-commits">
                <dt>Checked candidate</dt>
                <dd>
                    {report.checkedCommit && confirmationHref
                        ? (
                            <a href={confirmationHref + "#checked-candidate"}>
                                <code>{report.checkedCommit}</code>
                            </a>
                        )
                        : <code>{report.checkedCommit || "Unavailable"}</code>}
                </dd>
                <dt>Delivered commit</dt>
                <dd>
                    {report.deliveredCommit && confirmationHref
                        ? (
                            <a href={confirmationHref + "#delivered-commit"}>
                                <code>{report.deliveredCommit}</code>
                            </a>
                        )
                        : <code>{report.deliveredCommit || "Unavailable"}</code>}
                </dd>
                <dt>Landing branch</dt>
                <dd>{report.targetBranch || "Not applicable / unavailable"}</dd>
            </dl>
            <dl className="rw-delivery-report-checks">
                {report.rows.map((row) => (
                    <div key={row.label}>
                        <dt>{row.label}</dt>
                        <dd>
                            <strong className={`rw-delivery-${row.tone}`}>{row.outcome}</strong>
                            <p>{row.detail} {deliveryRowArtifacts(report, row.label).map(artifactLink)}</p>
                        </dd>
                    </div>
                ))}
            </dl>
            {report.workRecordFailed && onRetryWorkRecord && report.planId
                ? (
                    <RunWieldButton onClick={() => void retry()} disabled={pending}>
                        {pending ? <RunWieldThinkingDots label="Retrying Work Record" showLabel={false} /> : null}
                        {pending ? "Retrying Work Record…" : "Retry Work Record"}
                    </RunWieldButton>
                )
                : null}
            {message ? <p role="status">{message}</p> : null}
            <p className="rw-delivery-settings">
                <strong>Settings for this run</strong> {report.settings}
            </p>
        </article>
    );
}
