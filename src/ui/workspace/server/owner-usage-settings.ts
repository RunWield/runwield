import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { listInstalledMetricsExporters } from "../../../shared/extensions/metrics-exporter.ts";
import type {
    InstalledMetricsExporter,
    MetricsExporterCredentialField,
} from "../../../shared/extensions/metrics-exporter.ts";
import { resolvePrimaryCheckoutRoot } from "../../../shared/primary-checkout.ts";
import { remotePersonalResourcesActive } from "../../../shared/remote/personal-resources.ts";
import { getCustomSetting, getMergedCustomSetting, setCustomSetting } from "../../../shared/settings.js";
import { isWorkflowMetricsEnabled } from "../../../shared/workflow/metrics-journal.ts";
import {
    clearMetricsExportCredentials,
    grantMetricsExportDestination,
    readMetricsExportGrants,
    revokeMetricsExportDestination,
    setMetricsExportCredentials,
    updateMetricsExportProjects,
} from "../../../shared/workflow/metrics-export-grants.ts";
import type { MetricsExportDestinationGrant } from "../../../shared/workflow/metrics-export-grants.ts";
import { readMetricsExportStatus } from "../../../shared/workflow/metrics-export-scheduler.ts";
import { clearUsageHistory, usageProjectIdentityForRoot } from "../../../shared/workflow/usage-reporting.ts";
import { listOwnerProjects, requireOwnerProjectRoot } from "./owner-projects.ts";
import type { OwnerProjectStore } from "./owner-projects.ts";

export interface UsageRecordingProject {
    projectId: string;
    label: string;
    enabled: boolean;
    setBy: "global" | "project" | "default";
}
export interface UsageRecording {
    globalEnabled: boolean;
    projects: UsageRecordingProject[];
}
export interface UsageExporter {
    exporterKey: string;
    id: string;
    version: string;
    state: "installed_unapproved" | "approved";
    credentialFields: MetricsExporterCredentialField[];
}
export interface UsageApprovedProject {
    projectId: string;
    label: string;
}
type CoreStatus = Awaited<ReturnType<typeof readMetricsExportStatus>>[number];
export interface UsageDestination {
    destinationId: string;
    exporterId: string;
    exporterApproved: boolean;
    endpoint: string;
    insecureLocalEndpoint: boolean;
    externalProject: string;
    projects: UsageApprovedProject[];
    unavailableProjectCount: number;
    credentials: CoreStatus["credentials"];
    credentialFields: MetricsExporterCredentialField[];
    counts: CoreStatus["counts"];
    latestCodes: CoreStatus["latestCodes"];
    lastAttemptAt: CoreStatus["lastAttemptAt"];
}
export interface UsageSettingsView {
    recording: UsageRecording;
    exportAvailable: boolean;
    unavailableReason: string | null;
    exporters: UsageExporter[];
    destinations: UsageDestination[];
}
export interface UsageSettingsRequest {
    enabled?: boolean;
    exporterKey?: string;
    destinationId?: string;
    endpoint?: string;
    externalProject?: string;
    allowInsecureLocalEndpoint?: boolean;
    projectIds?: string[];
    credentials?: Record<string, string>;
    clearCredentials?: boolean;
    confirmed?: boolean;
}
export interface UsageClearResult {
    projectId: string;
    cleared: boolean;
    reason: string | null;
    deliveryInFlight: boolean;
}
export interface UsageSettingsResult {
    newBoundary?: boolean;
    deliveryInFlight?: boolean;
    cleared?: UsageClearResult[];
    message?: string;
}
export interface UsageSettingsResponse extends UsageSettingsView {
    result?: UsageSettingsResult;
}

const REMOTE_MESSAGE = "Export settings are unavailable on this host because personal resources are remote-backed.";
export class UsageSettingsError extends Error {
    constructor(
        message: string,
        public status = 400,
    ) {
        super(message);
    }
}

function canonicalRoot(root: string) {
    return realpathSync(resolvePrimaryCheckoutRoot(realpathSync(root)));
}
function enabledProjects(store: OwnerProjectStore) {
    return listOwnerProjects(store)
        .filter((project) => project.enabled)
        .map((project) => ({
            projectId: project.projectId,
            label: safeLabel(project.displayName || project.rootLabel),
            root: canonicalRoot(requireOwnerProjectRoot(store, project.projectId)),
        }));
}
// Labels can be user-supplied, but local paths are never browser identities.
function safeLabel(value: string) {
    return /[/\\]|[A-Za-z]:/.test(value) ? "Local item" : value;
}
function exporterKey(exporter: InstalledMetricsExporter) {
    return createHash("sha256")
        .update(JSON.stringify([exporter.id, exporter.source]))
        .digest("hex");
}
function credentialFields(exporter: InstalledMetricsExporter | undefined) {
    return (exporter?.credentialFields ?? []).map((field) => ({ ...field, label: safeLabel(field.label) }));
}

export function loadUsageRecording(store: OwnerProjectStore): UsageRecording {
    const globalValue = getCustomSetting("workflowMetrics", "global");
    return {
        globalEnabled: isWorkflowMetricsEnabled(globalValue),
        projects: enabledProjects(store).map((project) => ({
            projectId: project.projectId,
            label: project.label,
            enabled: isWorkflowMetricsEnabled(getMergedCustomSetting("workflowMetrics", project.root)),
            setBy:
                getCustomSetting("workflowMetrics", "project", project.root) !== undefined
                    ? "project"
                    : globalValue !== undefined
                      ? "global"
                      : "default",
        })),
    };
}

export async function loadUsageSettings(store: OwnerProjectStore): Promise<UsageSettingsView> {
    const recording = loadUsageRecording(store);
    if (remotePersonalResourcesActive()) {
        return {
            recording,
            exportAvailable: false,
            unavailableReason: REMOTE_MESSAGE,
            exporters: [],
            destinations: [],
        };
    }
    const projects = enabledProjects(store);
    const exporters = await listInstalledMetricsExporters();
    const grants = readMetricsExportGrants();
    const statuses = await readMetricsExportStatus();
    return {
        recording,
        exportAvailable: true,
        unavailableReason: null,
        exporters: exporters.map((exporter) => ({
            exporterKey: exporterKey(exporter),
            id: safeLabel(exporter.id),
            version: safeLabel(exporter.version),
            state: exporter.approved ? "approved" : "installed_unapproved",
            credentialFields: credentialFields(exporter),
        })),
        destinations: statuses.map((status) => {
            const grant = grants.find(
                (entry) => entry.destinationId === status.destinationId && entry.grantId === status.grantId,
            );
            if (!grant) throw new UsageSettingsError("Export settings changed while loading. Refresh and try again.");
            const exporter = exporters.find(
                (entry) => entry.id === grant.exporterId && entry.source === grant.exporterSource,
            );
            const available = projects.filter((project) =>
                grant.projects.some((entry) => entry.projectRoot === project.root),
            );
            const availableRoots = new Set(projects.map((project) => project.root));
            return {
                destinationId: grant.destinationId,
                exporterId: safeLabel(grant.exporterId),
                exporterApproved: status.exporterApproved,
                endpoint: status.endpoint,
                insecureLocalEndpoint:
                    new URL(status.endpoint).protocol === "http:" && grant.allowInsecureLocalEndpoint,
                externalProject: status.externalProject,
                projects: available.map(({ projectId, label }) => ({ projectId, label })),
                unavailableProjectCount: grant.projects.filter((project) => !availableRoots.has(project.projectRoot))
                    .length,
                credentials: status.credentials,
                credentialFields: credentialFields(exporter),
                counts: status.counts,
                latestCodes: status.latestCodes,
                lastAttemptAt: status.lastAttemptAt,
            };
        }),
    };
}

function selectedRoots(store: OwnerProjectStore, projectIds: string[] | undefined) {
    if (!Array.isArray(projectIds) || projectIds.some((id) => typeof id !== "string")) {
        throw new UsageSettingsError("Choose registered, enabled Projects.");
    }
    const available = enabledProjects(store);
    return [
        ...new Set(
            projectIds.map((projectId) => {
                if (!available.some((project) => project.projectId === projectId)) {
                    throw new UsageSettingsError("Choose registered, enabled Projects.");
                }
                return canonicalRoot(requireOwnerProjectRoot(store, projectId));
            }),
        ),
    ];
}
function destination(body: UsageSettingsRequest) {
    const grant = readMetricsExportGrants().find((entry) => entry.destinationId === body.destinationId);
    if (!grant) throw new UsageSettingsError("Choose an existing destination.");
    return grant;
}
function preserveUnavailableRoots(store: OwnerProjectStore, grant: MetricsExportDestinationGrant, roots: string[]) {
    const available = new Set(enabledProjects(store).map((project) => project.root));
    return [
        ...new Set([
            ...grant.projects
                .filter((project) => !available.has(project.projectRoot))
                .map((project) => project.projectRoot),
            ...roots,
        ]),
    ];
}
function validateCredentials(fields: MetricsExporterCredentialField[], credentials: Record<string, string>) {
    if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) {
        throw new UsageSettingsError("Enter the declared credential fields.");
    }
    for (const [key, value] of Object.entries(credentials)) {
        if (
            !fields.some((field) => field.key === key) ||
            typeof value !== "string" ||
            value.length > 4096 ||
            /[\r\n]/.test(value)
        ) {
            throw new UsageSettingsError(
                "Enter only declared credential fields, up to 4096 characters without line breaks.",
            );
        }
    }
}
async function saveCredentials(destinationId: string, credentials: Record<string, string>, clear = false) {
    try {
        if (clear) await clearMetricsExportCredentials(destinationId);
        else await setMetricsExportCredentials(destinationId, credentials);
    } catch {
        throw new UsageSettingsError(
            "Credentials could not be saved. Refresh the destination and try saving credentials again.",
        );
    }
}

export async function mutateUsageSettings(
    store: OwnerProjectStore,
    action: string,
    body: UsageSettingsRequest,
): Promise<UsageSettingsResponse> {
    if (remotePersonalResourcesActive()) throw new UsageSettingsError(REMOTE_MESSAGE, 409);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new UsageSettingsError("Invalid request body.");
    let result: UsageSettingsResult = {};
    if (action === "recording") {
        if (typeof body.enabled !== "boolean") throw new UsageSettingsError("Choose recording on or off.");
        const saved = getCustomSetting("workflowMetrics", "global");
        await setCustomSetting(
            "workflowMetrics",
            saved && typeof saved === "object" && !Array.isArray(saved)
                ? { ...saved, enabled: body.enabled }
                : body.enabled,
            "global",
        );
    } else if (action === "clear") {
        const roots = selectedRoots(store, body.projectIds);
        if (body.confirmed !== true || !roots.length)
            throw new UsageSettingsError("Confirm clearing history and choose at least one Project.");
        const cleared = await clearUsageHistory(roots);
        const reasons: Record<string, string> = {
            lock_timeout: "History is busy. Try clearing it again.",
            recovery_pending: "History recovery must finish before it can be cleared. Try again.",
            storage_failure: "History could not be saved. Check host storage and try again.",
        };
        result.cleared = body.projectIds!.map((projectId) => {
            const root = canonicalRoot(requireOwnerProjectRoot(store, projectId));
            const entry = cleared.find((item) => item.projectId === usageProjectIdentityForRoot(root));
            return {
                projectId,
                cleared: entry?.persisted === true,
                reason: entry?.persisted ? null : reasons[entry?.reason || "storage_failure"],
                deliveryInFlight: entry?.deliveryInFlight === true,
            };
        });
        result.deliveryInFlight = cleared.some((entry) => entry.deliveryInFlight);
    } else if (action === "create" || action === "destination") {
        const exporters = await listInstalledMetricsExporters();
        const previous = action === "destination" ? destination(body) : undefined;
        const matches = exporters.filter((exporter) =>
            previous
                ? exporter.id === previous.exporterId && exporter.source === previous.exporterSource
                : exporterKey(exporter) === body.exporterKey,
        );
        if (matches.length !== 1 || !matches[0].approved)
            throw new UsageSettingsError("Choose an installed, approved exporter.");
        const exporter = matches[0];
        if (
            typeof body.endpoint !== "string" ||
            typeof body.externalProject !== "string" ||
            !body.externalProject.trim()
        ) {
            throw new UsageSettingsError("Enter an endpoint and external project.");
        }
        if (previous && body.confirmed !== true)
            throw new UsageSettingsError("Confirm the destination change before saving.");
        let roots = selectedRoots(store, body.projectIds);
        if (previous) roots = preserveUnavailableRoots(store, previous, roots);
        if (body.credentials !== undefined) validateCredentials(exporter.credentialFields, body.credentials);
        const grant = await grantMetricsExportDestination({
            destinationId: previous?.destinationId,
            exporterId: exporter.id,
            exporterSource: exporter.source,
            endpoint: body.endpoint,
            externalProject: body.externalProject,
            allowInsecureLocalEndpoint: body.allowInsecureLocalEndpoint === true,
            projectRoots: roots,
        });
        result.newBoundary = !!previous && previous.grantId !== grant.grantId;
        if (body.credentials && Object.keys(body.credentials).length) {
            await saveCredentials(grant.destinationId, body.credentials);
        }
    } else if (action === "projects") {
        const grant = destination(body);
        const roots = selectedRoots(store, body.projectIds);
        await updateMetricsExportProjects(grant.destinationId, preserveUnavailableRoots(store, grant, roots));
    } else if (action === "credentials") {
        const grant = destination(body);
        const exporter = (await listInstalledMetricsExporters()).find(
            (entry) => entry.id === grant.exporterId && entry.source === grant.exporterSource,
        );
        if (body.clearCredentials !== true) validateCredentials(exporter?.credentialFields ?? [], body.credentials!);
        await saveCredentials(grant.destinationId, body.credentials ?? {}, body.clearCredentials === true);
    } else if (action === "revoke") {
        const grant = destination(body);
        if (body.confirmed !== true) throw new UsageSettingsError("Confirm revoking this destination.");
        result = await revokeMetricsExportDestination(grant.destinationId);
    } else {
        throw new UsageSettingsError("Unknown usage settings action.");
    }
    return { ...(await loadUsageSettings(store)), result };
}

export async function loadUsageSummary(store: OwnerProjectStore) {
    const view = await loadUsageSettings(store);
    return {
        recording: view.recording,
        export: {
            available: view.exportAvailable,
            destinations: view.destinations.map(({ destinationId, exporterId, counts }) => ({
                destinationId,
                exporterId,
                counts,
            })),
        },
    };
}
