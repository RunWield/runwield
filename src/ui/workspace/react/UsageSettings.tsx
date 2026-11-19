import { useEffect, useRef, useState } from "react";
import {
    RunWieldButton,
    RunWieldThinkingDots,
    RunWieldTabs,
} from "../../design-system/components/react/RunWieldPrimitives.tsx";
import { RunWieldDialog } from "../../design-system/components/react/RunWieldDialog.tsx";
import type { MetricsExporterCredentialField } from "../../../shared/extensions/metrics-exporter.ts";
import type {
    UsageDestination,
    UsageRecordingProject,
    UsageSettingsRequest,
    UsageSettingsResponse,
    UsageSettingsView,
} from "../server/owner-usage-settings.ts";
import "../../design-system/usage.css";

export const CLEAR_HISTORY_STATEMENT =
    "Removes measurement history and pending export payloads for the chosen Projects. Sessions, Plans, worktrees, and settings stay. Data already exported to the destination is not erased. A request already sent cannot be recalled.";
export const REVOKE_STATEMENT =
    "Stops new sends now. A request already sent cannot be recalled. Enabling export again starts a new boundary; pending items are not sent.";
export const CHANGE_DESTINATION_STATEMENT =
    "Starts a new export boundary. Items still pending under the old settings are not sent.";
export const UNCONFIRMED_EXPLANATION =
    "The destination may or may not have the item. RunWield does not resend it, so remote totals are not inflated. This is an export state, not a workflow failure.";
export const PROJECT_REMOVAL_EXPLANATION =
    "Removing or disabling a Project in Workspace does not change export approval";

interface MutationProps {
    mutate: (action: string, body: UsageSettingsRequest) => Promise<boolean>;
    busy: boolean;
    error: string;
}
interface ProjectChecklistProps {
    projects: UsageRecordingProject[];
    selected: string[];
    onChange: (ids: string[]) => void;
    exportLabels?: boolean;
    disabled?: boolean;
}
function ProjectChecklist({
    projects,
    selected,
    onChange,
    exportLabels = false,
    disabled = false,
}: ProjectChecklistProps) {
    const [search, setSearch] = useState("");
    const visible = projects.filter((project) => project.label.toLowerCase().includes(search.trim().toLowerCase()));
    return (
        <fieldset className="rw-usage-project-checklist" disabled={disabled}>
            <legend>{exportLabels ? "Approved Projects" : "Projects"}</legend>
            {!projects.length && <p>No enabled Projects are registered.</p>}
            {projects.length > 8 && (
                <label className="rw-usage-project-search">
                    Find Projects
                    <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
                </label>
            )}
            <p className="rw-usage-project-summary" role="status">
                {selected.length} of {projects.length} Projects selected
            </p>
            <div className="rw-usage-project-options">
                {visible.map((project) => (
                    <label className="rw-usage-check" key={project.projectId}>
                        <input
                            type="checkbox"
                            checked={selected.includes(project.projectId)}
                            onChange={(event) =>
                                onChange(
                                    event.target.checked
                                        ? [...selected, project.projectId]
                                        : selected.filter((id) => id !== project.projectId),
                                )
                            }
                        />
                        <span>
                            {project.label}
                            {exportLabels && (
                                <small>
                                    {selected.includes(project.projectId) ? "Export approved" : "Not exported"}
                                </small>
                            )}
                        </span>
                    </label>
                ))}
                {!!projects.length && !visible.length && <p>No Projects match your search.</p>}
            </div>
        </fieldset>
    );
}
interface CredentialInputsProps {
    fields: MetricsExporterCredentialField[];
    prefix: string;
}
function CredentialInputs({ fields, prefix }: CredentialInputsProps) {
    return !fields.length ? (
        <p>This exporter needs no credentials</p>
    ) : (
        fields.map((field) => (
            <label key={field.key}>
                {field.label}
                <input
                    name={`credential:${field.key}`}
                    type={field.secret ? "password" : "text"}
                    autoComplete="new-password"
                    maxLength={4096}
                    id={`${prefix}-${field.key}`}
                />
            </label>
        ))
    );
}
function credentialsFromForm(form: HTMLFormElement, fields: MetricsExporterCredentialField[]) {
    const values = new FormData(form);
    const credentials: Record<string, string> = {};
    for (const field of fields) {
        const value = values.get(`credential:${field.key}`);
        if (typeof value === "string" && value) credentials[field.key] = value;
    }
    return credentials;
}

interface DestinationFormProps extends MutationProps {
    view: UsageSettingsView;
    onSaved: () => void;
}
function AddDestinationForm({ view, mutate, busy, onSaved }: DestinationFormProps) {
    const approved = view.exporters.filter((exporter) => exporter.state === "approved");
    const [key, setKey] = useState(approved[0]?.exporterKey || "");
    const exporter = approved.find((entry) => entry.exporterKey === key);
    const [projectIds, setProjectIds] = useState<string[]>([]);
    return (
        <form
            className="owner-form rw-usage-destination-form"
            onSubmit={async (event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const data = new FormData(form);
                const saved = await mutate("create", {
                    exporterKey: key,
                    endpoint: String(data.get("endpoint") || ""),
                    externalProject: String(data.get("externalProject") || ""),
                    allowInsecureLocalEndpoint: data.get("local") === "on",
                    projectIds,
                    credentials: credentialsFromForm(form, exporter?.credentialFields ?? []),
                });
                if (saved) {
                    form.reset();
                    onSaved();
                }
            }}
        >
            <fieldset disabled={busy}>
                <legend>Add destination</legend>
                <label>
                    Metrics exporter
                    <select value={key} onChange={(event) => setKey(event.target.value)}>
                        {approved.map((entry) => (
                            <option key={entry.exporterKey} value={entry.exporterKey}>
                                {entry.id} {entry.version}
                            </option>
                        ))}
                    </select>
                </label>
                <label>
                    Endpoint
                    <input type="url" name="endpoint" required placeholder="https://cloud.langfuse.com" />
                </label>
                <label>
                    External project
                    <input name="externalProject" required />
                </label>
                <label className="rw-usage-check">
                    <input type="checkbox" name="local" />
                    <span>Local development endpoint</span>
                </label>
                <p>HTTP is allowed only for a loopback address with this option selected.</p>
                <ProjectChecklist
                    projects={view.recording.projects}
                    selected={projectIds}
                    onChange={setProjectIds}
                    exportLabels
                />
                <CredentialInputs key={key} fields={exporter?.credentialFields ?? []} prefix="new" />
                <div className="workspace-settings-actions">
                    <RunWieldButton type="submit" variant="primary">
                        {busy ? <RunWieldThinkingDots label="Saving destination" /> : "Save destination"}
                    </RunWieldButton>
                    <RunWieldButton onClick={onSaved}>Cancel</RunWieldButton>
                </div>
            </fieldset>
        </form>
    );
}

interface DestinationPanelProps extends MutationProps {
    destination: UsageDestination;
    projects: UsageRecordingProject[];
}
function DestinationPanel({ destination, projects, mutate, busy, error }: DestinationPanelProps) {
    const [projectIds, setProjectIds] = useState(destination.projects.map((project) => project.projectId));
    const [changeOpen, setChangeOpen] = useState(false);
    const [revokeOpen, setRevokeOpen] = useState(false);
    const transportForm = useRef<HTMLFormElement>(null);
    const [endpoint, setEndpoint] = useState(destination.endpoint);
    const [externalProject, setExternalProject] = useState(destination.externalProject);
    const [local, setLocal] = useState(destination.insecureLocalEndpoint);
    const [editing, setEditing] = useState(false);
    const [tab, setTab] = useState("projects");
    return (
        <article
            className="rw-usage-destination"
            aria-label={`${destination.exporterId} — ${destination.externalProject}`}
        >
            <header className="rw-usage-settings-heading">
                <h3>
                    {destination.exporterId} — {destination.externalProject}
                </h3>
                <span className="badge">
                    {destination.exporterApproved ? "Exporter approved" : "Exporter not approved"}
                </span>
            </header>
            <p className="rw-usage-endpoint">{destination.endpoint}</p>
            {destination.insecureLocalEndpoint && <span className="badge">Local development (HTTP)</span>}
            <p className="rw-usage-destination-summary">
                {destination.counts.pending} pending · {destination.counts.unconfirmed} delivery unconfirmed ·
                Credentials: {destination.credentials.configured ? "Configured" : "Not configured"}
            </p>
            <RunWieldTabs
                variant="underline"
                label={`${destination.exporterId} — ${destination.externalProject} settings`}
                defaultValue="projects"
                value={tab}
                onValueChange={setTab}
                keepMounted
                tabs={[
                    {
                        value: "projects",
                        label: "Approved Projects",
                        children: (
                            <form
                                onSubmit={async (event) => {
                                    event.preventDefault();
                                    await mutate("projects", {
                                        destinationId: destination.destinationId,
                                        projectIds,
                                    });
                                }}
                            >
                                <fieldset disabled={busy}>
                                    <ProjectChecklist
                                        projects={projects}
                                        selected={projectIds}
                                        onChange={setProjectIds}
                                        exportLabels
                                    />
                                    {destination.unavailableProjectCount > 0 && (
                                        <p>
                                            {destination.unavailableProjectCount} approved Projects are not available in
                                            Workspace.
                                        </p>
                                    )}
                                    <p>{PROJECT_REMOVAL_EXPLANATION}. Unchecking a Project here stops its export.</p>
                                    <RunWieldButton type="submit">Save approved Projects</RunWieldButton>
                                </fieldset>
                            </form>
                        ),
                    },
                    {
                        value: "credentials",
                        label: "Credentials",
                        children: (
                            <section aria-label="Credentials">
                                <h4>Credentials</h4>
                                <p>{destination.credentials.configured ? "Configured" : "Not configured"}</p>
                                {!destination.credentialFields.length ? (
                                    <p>This exporter needs no credentials</p>
                                ) : (
                                    <form
                                        className="owner-form"
                                        onSubmit={async (event) => {
                                            event.preventDefault();
                                            const form = event.currentTarget;
                                            if (
                                                await mutate("credentials", {
                                                    destinationId: destination.destinationId,
                                                    credentials: credentialsFromForm(
                                                        form,
                                                        destination.credentialFields,
                                                    ),
                                                })
                                            )
                                                form.reset();
                                        }}
                                    >
                                        <fieldset disabled={busy}>
                                            <CredentialInputs
                                                fields={destination.credentialFields}
                                                prefix={destination.destinationId}
                                            />
                                            <p>
                                                Saved credentials are never shown. Enter all credential fields to
                                                replace them.
                                            </p>
                                            <div className="workspace-settings-actions">
                                                <RunWieldButton type="submit">Save credentials</RunWieldButton>
                                                {destination.credentials.configured && (
                                                    <RunWieldButton
                                                        onClick={() =>
                                                            void mutate("credentials", {
                                                                destinationId: destination.destinationId,
                                                                clearCredentials: true,
                                                            })
                                                        }
                                                    >
                                                        Remove credentials
                                                    </RunWieldButton>
                                                )}
                                            </div>
                                        </fieldset>
                                    </form>
                                )}
                            </section>
                        ),
                    },
                    {
                        value: "delivery",
                        label: "Delivery status",
                        children: (
                            <section aria-label="Delivery status">
                                <h4>Delivery status</h4>
                                <dl className="rw-usage-delivery-counts">
                                    <div>
                                        <dt>Pending</dt>
                                        <dd>{destination.counts.pending}</dd>
                                    </div>
                                    <div>
                                        <dt>Accepted</dt>
                                        <dd>{destination.counts.accepted}</dd>
                                    </div>
                                    <div>
                                        <dt>Confirmed</dt>
                                        <dd>{destination.counts.confirmed}</dd>
                                    </div>
                                    <div>
                                        <dt>Delivery unconfirmed</dt>
                                        <dd>{destination.counts.unconfirmed}</dd>
                                    </div>
                                    <div>
                                        <dt>Rejected</dt>
                                        <dd>{destination.counts.rejected}</dd>
                                    </div>
                                </dl>
                                <p>
                                    <strong>Delivery unconfirmed</strong> — {UNCONFIRMED_EXPLANATION}
                                </p>
                                <p>
                                    <strong>Rejected</strong> — when credentials were the cause, updating the
                                    credentials lets those items send again.
                                </p>
                                <p>
                                    Latest codes:{" "}
                                    {destination.latestCodes.length
                                        ? destination.latestCodes
                                              .map((code) =>
                                                  code === "process_lost"
                                                      ? "process_lost (export process ended)"
                                                      : code?.includes("deadline")
                                                        ? `${code} (delivery time limit reached)`
                                                        : code,
                                              )
                                              .join(", ")
                                        : "None"}
                                </p>
                                <p>
                                    Last attempt:{" "}
                                    {destination.lastAttemptAt
                                        ? new Date(destination.lastAttemptAt).toLocaleString()
                                        : "No attempts"}
                                </p>
                            </section>
                        ),
                    },
                    {
                        value: "destination",
                        label: "Destination",
                        children: (
                            <>
                                <RunWieldButton disabled={busy} onClick={() => setEditing(!editing)}>
                                    {editing ? "Cancel destination edit" : "Edit endpoint or external project"}
                                </RunWieldButton>
                                {editing && (
                                    <form
                                        className="owner-form"
                                        ref={transportForm}
                                        onSubmit={(event) => {
                                            event.preventDefault();
                                            setChangeOpen(true);
                                        }}
                                    >
                                        <fieldset disabled={busy}>
                                            <legend>Destination settings</legend>
                                            <label>
                                                Endpoint
                                                <input
                                                    type="url"
                                                    required
                                                    value={endpoint}
                                                    onChange={(event) => setEndpoint(event.target.value)}
                                                />
                                            </label>
                                            <label>
                                                External project
                                                <input
                                                    required
                                                    value={externalProject}
                                                    onChange={(event) => setExternalProject(event.target.value)}
                                                />
                                            </label>
                                            <label className="rw-usage-check">
                                                <input
                                                    type="checkbox"
                                                    checked={local}
                                                    onChange={(event) => setLocal(event.target.checked)}
                                                />
                                                <span>Local development endpoint</span>
                                            </label>
                                            <RunWieldDialog
                                                open={changeOpen}
                                                onOpenChange={(open) => {
                                                    if (!open || transportForm.current?.reportValidity())
                                                        setChangeOpen(open);
                                                }}
                                                busy={busy}
                                                trigger={<RunWieldButton>Review destination change</RunWieldButton>}
                                                title="Change destination?"
                                                description={CHANGE_DESTINATION_STATEMENT}
                                                footer={
                                                    <>
                                                        <RunWieldButton
                                                            disabled={busy}
                                                            onClick={() => setChangeOpen(false)}
                                                        >
                                                            Cancel
                                                        </RunWieldButton>
                                                        <RunWieldButton
                                                            variant="danger"
                                                            disabled={busy}
                                                            onClick={async () => {
                                                                if (
                                                                    await mutate("destination", {
                                                                        destinationId: destination.destinationId,
                                                                        endpoint,
                                                                        externalProject,
                                                                        allowInsecureLocalEndpoint: local,
                                                                        projectIds: destination.projects.map(
                                                                            (project) => project.projectId,
                                                                        ),
                                                                        confirmed: true,
                                                                    })
                                                                ) {
                                                                    setChangeOpen(false);
                                                                }
                                                            }}
                                                        >
                                                            {busy ? (
                                                                <RunWieldThinkingDots label="Saving destination" />
                                                            ) : (
                                                                "Change destination"
                                                            )}
                                                        </RunWieldButton>
                                                    </>
                                                }
                                            >
                                                {error && <p role="alert">{error}</p>}
                                            </RunWieldDialog>
                                        </fieldset>
                                    </form>
                                )}
                                <RunWieldDialog
                                    open={revokeOpen}
                                    onOpenChange={setRevokeOpen}
                                    busy={busy}
                                    trigger={
                                        <RunWieldButton variant="danger" disabled={busy}>
                                            Revoke destination
                                        </RunWieldButton>
                                    }
                                    title="Revoke destination?"
                                    description={REVOKE_STATEMENT}
                                    footer={
                                        <>
                                            <RunWieldButton disabled={busy} onClick={() => setRevokeOpen(false)}>
                                                Cancel
                                            </RunWieldButton>
                                            <RunWieldButton
                                                variant="danger"
                                                disabled={busy}
                                                onClick={async () => {
                                                    if (
                                                        await mutate("revoke", {
                                                            destinationId: destination.destinationId,
                                                            confirmed: true,
                                                        })
                                                    )
                                                        setRevokeOpen(false);
                                                }}
                                            >
                                                {busy ? (
                                                    <RunWieldThinkingDots label="Revoking destination" />
                                                ) : (
                                                    "Revoke destination"
                                                )}
                                            </RunWieldButton>
                                        </>
                                    }
                                >
                                    {error && <p role="alert">{error}</p>}
                                </RunWieldDialog>{" "}
                            </>
                        ),
                    },
                ]}
            />
        </article>
    );
}

interface UsageSettingsProps {
    initialView?: UsageSettingsView;
}
export function UsageSettings({ initialView }: UsageSettingsProps = {}) {
    const [view, setView] = useState<UsageSettingsView | null>(initialView ?? null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(!initialView);
    const [refresh, setRefresh] = useState(0);
    const [result, setResult] = useState("");
    const [adding, setAdding] = useState(false);
    const [clearOpen, setClearOpen] = useState(false);
    const [clearIds, setClearIds] = useState<string[]>([]);
    const [revision, setRevision] = useState(0);
    const destinationsHeading = useRef<HTMLHeadingElement>(null);

    useEffect(() => {
        const controller = new AbortController();
        setError("");
        setLoading(true);
        void fetch("/api/owner/usage/settings", { cache: "no-store", signal: controller.signal })
            .then(async (response) => {
                const next: UsageSettingsView & { error?: string } = await response.json();
                if (!response.ok) throw new Error(next.error || "Usage settings could not be loaded.");
                if (!controller.signal.aborted) {
                    setView(next);
                    setRevision((value) => value + 1);
                }
            })
            .catch((caught: Error) => {
                if (!controller.signal.aborted) setError(caught.message);
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false);
            });
        return () => controller.abort();
    }, [refresh]);

    async function mutate(action: string, body: UsageSettingsRequest) {
        setBusy(true);
        setError("");
        setResult("");
        try {
            const csrf =
                document.cookie
                    .split("; ")
                    .find((cookie) => cookie.startsWith("rw_owner_csrf="))
                    ?.split("=")
                    .slice(1)
                    .join("=") || "";
            const response = await fetch(`/api/owner/usage/${action === "clear" ? "clear" : `settings/${action}`}`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-runwield-csrf": decodeURIComponent(csrf) },
                body: JSON.stringify(body),
            });
            const next: UsageSettingsResponse & { error?: string } = await response.json();
            if (!response.ok) throw new Error(next.error || "Usage settings could not be saved.");
            setView(next);
            if (action === "revoke") requestAnimationFrame(() => destinationsHeading.current?.focus());
            const clearResults = next.result?.cleared;
            const message = clearResults
                ? clearResults
                      .map(
                          (item) =>
                              `${view?.recording.projects.find((project) => project.projectId === item.projectId)?.label || "Project"}: ${item.cleared ? "history cleared" : item.reason}`,
                      )
                      .join(". ")
                : action === "recording"
                  ? `Global recording is ${body.enabled ? "on" : "off"}.`
                  : action === "revoke"
                    ? "Destination revoked."
                    : action === "credentials"
                      ? "Credentials saved."
                      : action === "projects"
                        ? "Export approval saved."
                        : next.result?.newBoundary
                          ? "Destination saved. A new export boundary has started."
                          : "Destination saved.";
            setResult(
                `${message}${next.result?.deliveryInFlight ? " One request was already sent and cannot be recalled." : ""}`,
            );
            return true;
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : "Usage settings could not be saved.");
            return false;
        } finally {
            setBusy(false);
        }
    }
    const disabled = busy || loading || view?.exportAvailable === false;
    const mutationProps = { mutate, busy: disabled, error };
    const sections = ["Local recording", "Metrics exporters", "Destinations", "Clear history"];
    return (
        <div className="rw-usage-settings">
            <div className="rw-usage-settings-heading">
                <h1>Usage settings</h1>
                <RunWieldButton disabled={busy || loading} onClick={() => setRefresh((value) => value + 1)}>
                    Refresh
                </RunWieldButton>
            </div>
            {error && (
                <div role="alert">
                    <p>{error}</p>
                    <RunWieldButton disabled={busy || loading} onClick={() => setRefresh((value) => value + 1)}>
                        Retry
                    </RunWieldButton>
                </div>
            )}
            {result && <p role="status">{result}</p>}
            {!view &&
                sections.map((section) => (
                    <section className="owner-card" key={section}>
                        <h2>{section}</h2>
                        {error ? (
                            <p>Could not load {section.toLowerCase()}. Use Retry above.</p>
                        ) : (
                            <RunWieldThinkingDots label={`Loading ${section.toLowerCase()}`} />
                        )}
                    </section>
                ))}
            {view && (
                <>
                    {loading && <RunWieldThinkingDots label="Refreshing usage settings" />}
                    {!view.exportAvailable && <p role="status">{view.unavailableReason}</p>}
                    <section className="owner-card" aria-labelledby="usage-recording-title">
                        <h2 id="usage-recording-title">Local recording</h2>
                        <p>Recording stays on this host. Turning it off does not hide older measurements.</p>
                        <label className="rw-usage-check">
                            <input
                                type="checkbox"
                                role="switch"
                                checked={view.recording.globalEnabled}
                                disabled={disabled}
                                onChange={(event) => void mutate("recording", { enabled: event.target.checked })}
                            />
                            <span>Record usage globally</span>
                        </label>
                        {busy && <RunWieldThinkingDots label="Saving usage settings" />}
                        <p>
                            Project settings override this global choice. This control does not change a Project’s
                            settings file.
                        </p>
                        <ul className="rw-usage-recording-projects" tabIndex={0} aria-label="Project recording states">
                            {view.recording.projects.map((project) => (
                                <li key={project.projectId}>
                                    <div>
                                        <strong>{project.label}</strong>
                                        <span>{project.enabled ? "Recording on" : "Recording off"}</span>
                                    </div>
                                    <p>
                                        {project.setBy === "project"
                                            ? "Set in this Project's settings file"
                                            : project.setBy === "global"
                                              ? "Set globally"
                                              : "Default (off)"}
                                    </p>
                                </li>
                            ))}
                        </ul>
                        {!view.recording.projects.length && <p>No enabled Projects are registered.</p>}
                    </section>
                    <section className="owner-card" aria-labelledby="usage-exporters-title">
                        <h2 id="usage-exporters-title">Metrics exporters</h2>
                        {!view.exportAvailable ? (
                            <p>{view.unavailableReason}</p>
                        ) : !view.exporters.length ? (
                            <>
                                <p>No metrics exporter is installed</p>
                                <p>
                                    On the host, run <code>wld install &lt;source&gt;</code> to install a metrics
                                    exporter and review its approval.
                                </p>
                            </>
                        ) : (
                            <ul className="rw-usage-exporters">
                                {view.exporters.map((exporter) => (
                                    <li key={exporter.exporterKey}>
                                        <strong>{exporter.id}</strong> {exporter.version}
                                        <p>
                                            {exporter.state === "approved" ? (
                                                "Approved on this host"
                                            ) : (
                                                <>
                                                    Installed, not approved. Approve it on the host: run{" "}
                                                    <code>wld install</code> for this package again
                                                </>
                                            )}
                                        </p>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>
                    <section className="owner-card" aria-labelledby="usage-destinations-title">
                        <div className="rw-usage-settings-heading">
                            <h2 id="usage-destinations-title" tabIndex={-1} ref={destinationsHeading}>
                                Destinations
                            </h2>
                            {view.exportAvailable &&
                                view.exporters.some((exporter) => exporter.state === "approved") &&
                                !adding && (
                                    <RunWieldButton disabled={disabled} onClick={() => setAdding(true)}>
                                        Add destination
                                    </RunWieldButton>
                                )}
                        </div>
                        {!view.destinations.length && (
                            <p>No export destinations are configured. Measurements stay on this host.</p>
                        )}
                        {adding && (
                            <AddDestinationForm view={view} {...mutationProps} onSaved={() => setAdding(false)} />
                        )}
                        {view.destinations.map((destination) => (
                            <DestinationPanel
                                key={`${destination.destinationId}-${revision}`}
                                destination={destination}
                                projects={view.recording.projects}
                                {...mutationProps}
                            />
                        ))}
                    </section>
                    <section className="owner-card" aria-labelledby="usage-clear-title">
                        <h2 id="usage-clear-title">Clear history</h2>
                        <p>Choose which Projects’ local measurement history to remove.</p>
                        {!view.recording.projects.length && <p>No enabled Projects are registered.</p>}
                        <RunWieldDialog
                            open={clearOpen}
                            onOpenChange={setClearOpen}
                            busy={busy}
                            trigger={
                                <RunWieldButton variant="danger" disabled={disabled || !view.recording.projects.length}>
                                    Clear history
                                </RunWieldButton>
                            }
                            title="Clear measurement history?"
                            description={CLEAR_HISTORY_STATEMENT}
                            footer={
                                <>
                                    <RunWieldButton disabled={busy} onClick={() => setClearOpen(false)}>
                                        Cancel
                                    </RunWieldButton>
                                    <RunWieldButton
                                        variant="danger"
                                        disabled={busy || !clearIds.length}
                                        onClick={async () => {
                                            if (await mutate("clear", { projectIds: clearIds, confirmed: true })) {
                                                setClearOpen(false);
                                                setClearIds([]);
                                            }
                                        }}
                                    >
                                        {busy ? (
                                            <RunWieldThinkingDots label="Clearing history" />
                                        ) : (
                                            "Clear selected history"
                                        )}
                                    </RunWieldButton>
                                </>
                            }
                        >
                            <ProjectChecklist
                                projects={view.recording.projects}
                                selected={clearIds}
                                onChange={setClearIds}
                                disabled={busy}
                            />
                            {error && <p role="alert">{error}</p>}
                        </RunWieldDialog>
                    </section>
                </>
            )}
        </div>
    );
}
