import { useEffect, useState, type ReactNode } from "react";
import { RunWieldButton, RunWieldThinkingDots } from "../../design-system/components/react/RunWieldPrimitives.tsx";
import { RunWieldDialog } from "../../design-system/components/react/RunWieldDialog.tsx";
import { CLEAR_HISTORY_STATEMENT } from "./UsageSettings.tsx";
import type { UsageSettingsResponse } from "../server/owner-usage-settings.ts";
import { UsageTrend } from "../../design-system/components/react/UsageTrend.tsx";
import type { OwnerUsageLink, OwnerUsageReport } from "../server/owner-usage.ts";
import type { UsageMeasure, UsagePeriod, UsageTotals } from "../../../shared/workflow/usage-reporting.ts";
import "../../design-system/usage.css";

const number = new Intl.NumberFormat("en-US");
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 4 });

function Measure({ measure, cost = false }: { measure: UsageMeasure; cost?: boolean }) {
    return (
        <>
            <strong>{cost ? money.format(measure.value) : number.format(measure.value)}</strong>{" "}
            <small>
                {measure.exclusions ? `${measure.exclusions} observations excluded` : "No observation exclusions"}
            </small>
        </>
    );
}

interface UsageBreakdownRow {
    key: string;
    label: string;
    totals: UsageTotals;
    links?: OwnerUsageLink[];
    notice?: ReactNode;
}

function Breakdown({ rows, caption }: { rows: UsageBreakdownRow[]; caption: string }) {
    return (
        <div className="rw-usage-table-wrap" tabIndex={0} role="region" aria-label={caption}>
            <table className="rw-usage-table">
                <caption>{caption}</caption>
                <thead>
                    <tr>
                        <th scope="col">{caption === "By Project" ? "Project" : "Model / backend"}</th>
                        <th scope="col">Reported tokens</th>
                        <th scope="col">Estimated cost (USD)</th>
                        <th scope="col">Published</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row) => (
                        <tr key={row.key}>
                            <th scope="row">
                                {row.label}
                                {row.links && <Destinations links={row.links} />}
                                {row.notice}
                            </th>
                            <td>
                                <Measure measure={row.totals.tokens} />
                            </td>
                            <td>
                                <Measure measure={row.totals.estimatedCostUsd} cost />
                            </td>
                            <td>
                                {row.totals.publishedChanges}
                                <small>{row.totals.publishedChangesExclusions} observations excluded</small>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
            {!rows.length && <p className="empty">No recorded measurements for this breakdown.</p>}
        </div>
    );
}

function Destinations({ links }: { links: OwnerUsageLink[] }) {
    const destinations = new Map<string, string>();
    for (const link of links) {
        if (link.sessionHref) {
            destinations.set(link.sessionHref, link.sessionLabel ? `Session: ${link.sessionLabel}` : "Open Session");
        }
        if (link.planHref) destinations.set(link.planHref, `Plan: ${link.planLabel || "Plan"}`);
    }
    return (
        <>
            {[...destinations].map(([href, label]) => (
                <small key={href}>
                    <a href={href}>{label}</a>
                </small>
            ))}
        </>
    );
}

interface UsageStatusStripProps {
    recording: OwnerUsageReport["recording"];
    exportStatus: OwnerUsageReport["export"];
}

export function UsageStatusStrip({ recording, exportStatus }: UsageStatusStripProps) {
    const enabled = recording.projects.filter((project) => project.enabled).length;
    const recordingLabel =
        enabled === 0
            ? "Recording off"
            : enabled === recording.projects.length
              ? "Recording on"
              : `Recording on for ${enabled} of ${recording.projects.length} Projects`;
    return (
        <section className="rw-usage-status-strip" aria-label="Recording and export status">
            <strong>{recordingLabel}</strong>
            {!exportStatus.available && <p>Export is unavailable on this host.</p>}
            {exportStatus.available && !exportStatus.destinations.length && (
                <p>Export off — no destinations configured.</p>
            )}
            {exportStatus.destinations.map((destination) => (
                <p key={destination.destinationId}>
                    Export: {destination.exporterId} — {destination.counts.accepted} accepted,{" "}
                    {destination.counts.pending} pending, {destination.counts.confirmed} confirmed,{" "}
                    {destination.counts.unconfirmed} delivery unconfirmed, {destination.counts.rejected} rejected
                </p>
            ))}
            <a href="/usage/settings">Usage settings</a>
        </section>
    );
}

interface UsageHistoryClearNoticeProps {
    projectId: string;
    label: string;
    onCleared: (message: string) => void;
}

export function UsageHistoryClearNotice({ projectId, label, onCleared }: UsageHistoryClearNoticeProps) {
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    async function retry() {
        setBusy(true);
        setError("");
        try {
            const csrf =
                document.cookie
                    .split("; ")
                    .find((cookie) => cookie.startsWith("rw_owner_csrf="))
                    ?.slice("rw_owner_csrf=".length) || "";
            const response = await fetch("/api/owner/usage/clear", {
                method: "POST",
                headers: { "content-type": "application/json", "x-runwield-csrf": decodeURIComponent(csrf) },
                body: JSON.stringify({ projectIds: [projectId], confirmed: true }),
            });
            const next: UsageSettingsResponse & { error?: string } = await response.json();
            if (!response.ok) throw new Error(next.error || "History could not be cleared. Try again.");
            const result = next.result?.cleared?.find((item) => item.projectId === projectId);
            if (result?.cleared !== true) throw new Error(result?.reason || "Clear did not finish. Try again.");
            setOpen(false);
            onCleared(
                `${label}: history cleared.${result.deliveryInFlight ? " A request already sent cannot be recalled." : ""}`,
            );
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : "History could not be cleared. Try again.");
        } finally {
            setBusy(false);
        }
    }
    return (
        <div className="notice warning" role="status">
            <p>
                <strong>Clear did not finish</strong> — {label}. Old measurements are hidden until the clear finishes.
            </p>
            <RunWieldDialog
                open={open}
                onOpenChange={setOpen}
                busy={busy}
                trigger={<RunWieldButton>Retry clear</RunWieldButton>}
                title={`Retry clear for ${label}?`}
                description={CLEAR_HISTORY_STATEMENT}
                footer={
                    <>
                        <RunWieldButton disabled={busy} onClick={() => setOpen(false)}>
                            Cancel
                        </RunWieldButton>
                        <RunWieldButton variant="danger" disabled={busy} onClick={() => void retry()}>
                            {busy ? <RunWieldThinkingDots label="Clearing history" /> : "Retry clear"}
                        </RunWieldButton>
                    </>
                }
            >
                {error && <p role="alert">{error}</p>}
            </RunWieldDialog>
        </div>
    );
}

export function UsageReport() {
    const [report, setReport] = useState<OwnerUsageReport | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [preset, setPreset] = useState("30");
    const [projectId, setProjectId] = useState("");
    const [start, setStart] = useState("");
    const [end, setEnd] = useState("");
    const [custom, setCustom] = useState(false);
    const [range, setRange] = useState<UsagePeriod | null>(null);
    const [refresh, setRefresh] = useState(0);
    const [clearResult, setClearResult] = useState("");
    useEffect(() => {
        const controller = new AbortController();
        const params = new URLSearchParams({ preset });
        if (projectId) params.set("projectId", projectId);
        if (range) {
            params.set("start", range.start);
            params.set("end", range.end);
        }
        setLoading(true);
        setError("");
        void fetch(`/api/owner/usage?${params}`, { cache: "no-store", signal: controller.signal })
            .then(async (response) => {
                if (!response.ok) {
                    const failure: { error?: string } = await response.json();
                    throw new Error(failure.error || "Usage could not be loaded.");
                }
                const next: OwnerUsageReport = await response.json();
                if (!controller.signal.aborted) setReport(next);
            })
            .catch((caught: Error) => {
                if (!controller.signal.aborted) setError(caught.message);
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false);
            });
        return () => controller.abort();
    }, [preset, projectId, range, refresh]);
    const totals = report?.totals;
    const partialDays = report?.daily.filter((day) => day.gaps.length).length || 0;
    return (
        <div className="rw-usage-page">
            <h1>Usage</h1>
            {report && <UsageStatusStrip recording={report.recording} exportStatus={report.export} />}
            <form
                className="rw-usage-filters"
                onSubmit={(event) => {
                    event.preventDefault();
                    setCustom(true);
                    setRange({ start, end });
                    setRefresh((value) => value + 1);
                }}
            >
                <label>
                    Period
                    <select
                        value={custom ? "custom" : preset}
                        onChange={(event) => {
                            if (event.target.value === "custom") {
                                setStart(report?.period.start || "");
                                setEnd(report?.period.end || "");
                                setCustom(true);
                            } else {
                                setPreset(event.target.value);
                                setCustom(false);
                                setRange(null);
                            }
                        }}
                    >
                        <option value="7">Last 7 days</option>
                        <option value="30">Last 30 days</option>
                        <option value="90">Last 90 days</option>
                        <option value="custom">Date range</option>
                    </select>
                </label>
                <label>
                    Project
                    <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                        <option value="">All enabled Projects</option>
                        {report?.availableProjects.map((project) => (
                            <option key={project.projectId} value={project.projectId}>
                                {project.displayName || project.rootLabel}
                            </option>
                        ))}
                    </select>
                </label>
                {custom && (
                    <>
                        <label>
                            From
                            <input
                                type="date"
                                required
                                value={start}
                                onChange={(event) => {
                                    setStart(event.target.value);
                                }}
                            />
                        </label>
                        <label>
                            Until (exclusive)
                            <input
                                type="date"
                                required
                                value={end}
                                min={start || undefined}
                                onChange={(event) => {
                                    setEnd(event.target.value);
                                }}
                            />
                        </label>
                        <RunWieldButton type="submit">Apply range</RunWieldButton>
                    </>
                )}
            </form>
            {loading && (
                <p role="status">
                    <RunWieldThinkingDots label="Loading usage" />
                </p>
            )}
            {error && (
                <div className="notice danger" role="alert">
                    <p>{error}</p>
                    <RunWieldButton onClick={() => setRefresh((value) => value + 1)}>Retry</RunWieldButton>
                </div>
            )}
            {clearResult && <p role="status">{clearResult}</p>}
            {report && totals && !error && (
                <div aria-busy={loading}>
                    <p className="rw-usage-context">
                        {report.period.start} to {report.period.end} (exclusive) · Host time zone:{" "}
                        <strong>{report.timeZone}</strong>
                        <br />
                        Recorded through: {report.recordedThrough || "No recorded measurements"}
                    </p>
                    <dl className="rw-usage-summary">
                        <div>
                            <dt>Active days</dt>
                            <dd>
                                {totals.activeDays}
                                <small>{totals.activeDaysExclusions} observations excluded</small>
                                <small>{partialDays} partial days</small>
                            </dd>
                        </div>
                        <div>
                            <dt>Reported tokens</dt>
                            <dd>
                                <Measure measure={totals.tokens} />
                                <small>{partialDays} partial days</small>
                            </dd>
                        </div>
                        <div>
                            <dt>Estimated cost (USD)</dt>
                            <dd>
                                <Measure measure={totals.estimatedCostUsd} cost />
                                <small>{partialDays} partial days</small>
                            </dd>
                        </div>
                        <div>
                            <dt>Published changes</dt>
                            <dd>
                                {totals.publishedChanges}
                                <small>{totals.publishedChangesExclusions} observations excluded</small>
                                <small>{partialDays} partial days</small>
                            </dd>
                        </div>
                    </dl>
                    <div className="rw-usage-coverage">
                        <h2>Coverage</h2>
                        <p>
                            {Object.entries(report.coverage.gapDays)
                                .map(([reason, days]) => `${days} days: ${reason.replaceAll("_", " ")}`)
                                .join(" · ") || "No recorded gaps in this period."}
                        </p>
                        <p>
                            {report.coverage.incompleteOperations} pending measurements ·{" "}
                            {report.coverage.legacyRecords} legacy / partial records ·{" "}
                            {report.coverage.unavailableProjects} unreadable measurement journals
                        </p>
                        <p>
                            Reported cost: <Measure measure={totals.reportedCostUsd} cost />. Estimates are not billing
                            totals. Gaps are not zero activity.
                        </p>
                        {report.excludedProjects.length > 0 && (
                            <p>
                                Excluded Projects:{" "}
                                {report.excludedProjects
                                    .map(
                                        (project) =>
                                            `${project.displayName || project.rootLabel} (${project.exclusionReason})`,
                                    )
                                    .join(", ")}
                                . Their measurements are not included.
                            </p>
                        )}
                    </div>
                    {!report.recordedThrough && (
                        <p className="empty" role="status">
                            No recorded measurements. Only collected history appears here.
                        </p>
                    )}
                    <section className="rw-usage-section">
                        <h2>Daily reported tokens</h2>
                        <UsageTrend days={report.daily} />
                        <details>
                            <summary>Daily values and data completeness</summary>
                            <div className="rw-usage-table-wrap" tabIndex={0} role="region" aria-label="Daily values">
                                <table className="rw-usage-table">
                                    <caption>Daily values in {report.timeZone}</caption>
                                    <thead>
                                        <tr>
                                            <th scope="col">Day</th>
                                            <th scope="col">Reported tokens</th>
                                            <th scope="col">Estimated cost (USD)</th>
                                            <th scope="col">Data Complete</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {report.daily.map((day) => (
                                            <tr key={day.date}>
                                                <th scope="row">{day.date}</th>
                                                <td>
                                                    {day.tokens === null ? "Gap" : number.format(day.tokens)}
                                                    {day.tokens === null && day.totals.tokens.value > 0 && (
                                                        <small>
                                                            Known subtotal: {number.format(day.totals.tokens.value)}
                                                        </small>
                                                    )}
                                                </td>
                                                <td>
                                                    {day.gaps.length
                                                        ? day.totals.estimatedCostUsd.value > 0
                                                            ? `Known subtotal: ${money.format(
                                                                  day.totals.estimatedCostUsd.value,
                                                              )}`
                                                            : "—"
                                                        : money.format(day.totals.estimatedCostUsd.value)}
                                                    {day.totals.estimatedCostUsd.exclusions > 0 && (
                                                        <small>
                                                            {day.totals.estimatedCostUsd.exclusions} observations
                                                            excluded
                                                        </small>
                                                    )}
                                                </td>
                                                <td>
                                                    {day.gaps.length ? "Partial" : "Complete"}
                                                    {day.gaps.length > 0 && (
                                                        <small>{day.gaps.join(", ").replaceAll("_", " ")}</small>
                                                    )}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </details>
                    </section>
                    <dl className="rw-usage-outcomes">
                        <div>
                            <dt>Validation attempts</dt>
                            <dd>{totals.validationAttempts}</dd>
                        </div>
                        <div>
                            <dt>Repair rounds</dt>
                            <dd>{totals.repairRounds}</dd>
                        </div>
                        <div>
                            <dt>Ongoing delivery</dt>
                            <dd>
                                {totals.ongoing}
                                <small>As of latest recorded observation</small>
                            </dd>
                        </div>
                        <div>
                            <dt>Abandoned delivery</dt>
                            <dd>{totals.abandoned}</dd>
                        </div>
                    </dl>
                    <Breakdown
                        caption="By Project"
                        rows={report.projects.map((project) => ({
                            key: project.projectId,
                            label:
                                project.aliases.map((alias) => alias.label).join(" / ") +
                                (project.aliases.length > 1 ? " (shared history)" : ""),
                            totals: project.totals,
                            links: [...project.links, ...project.incomplete, ...project.ongoing],
                            notice: project.coverage.historyClearPending && (
                                <UsageHistoryClearNotice
                                    projectId={project.projectId}
                                    label={project.aliases.map((alias) => alias.label).join(" / ")}
                                    onCleared={(message) => {
                                        setClearResult(message);
                                        setRefresh((value) => value + 1);
                                    }}
                                />
                            ),
                        }))}
                    />
                    <Breakdown
                        caption="By model"
                        rows={report.models.map((model) => ({
                            key: model.key,
                            label: model.key,
                            totals: model.totals,
                        }))}
                    />
                    <Breakdown
                        caption="By backend"
                        rows={report.backends.map((backend) => ({
                            key: backend.key,
                            label: backend.key,
                            totals: backend.totals,
                        }))}
                    />
                </div>
            )}
        </div>
    );
}
