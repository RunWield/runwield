import { existsSync, statSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { ProjectId } from "@runwield/projects";
/** Owner consent, transport credentials, and host-local reference identity. */
import { join } from "node:path";
import { type InstalledMetricsExporter, resolveApprovedMetricsExporters } from "../extensions/metrics-exporter.ts";
import { remotePersonalResourcesActive } from "../remote/personal-resources.ts";
import { getCustomSetting, setCustomSetting } from "../settings.ts";
import { admitMeasurementProject, inspectMeasurementProject, type MeasurementProject } from "./metrics.ts";
import {
    readWorkflowMetricLegacyAdoption,
    readWorkflowMetricLegacySource,
    withWorkflowMetricJournalLock,
} from "./metrics-journal.ts";
import { metricsDeliveryInFlight } from "./metrics-export-ledger.ts";
import { metricsExportDirectory, replaceExportFile, withExportConfigurationLock } from "./metrics-export-storage.ts";

export type MetricsExportProjectStart = {
    projectRoot: string;
    projectId?: ProjectId;
    historyEpoch: string;
    offset: number;
    legacyAdoptionEpoch?: string;
};
export type MetricsExportDestinationGrant = {
    destinationId: string;
    grantId: string;
    exporterId: string;
    exporterSource: string;
    exporterInstalledPath: string;
    exporterVersion: string;
    endpoint: string;
    allowInsecureLocalEndpoint: boolean;
    externalProject: string;
    projects: MetricsExportProjectStart[];
    grantedAt: string;
};
export interface MetricsExportGrantInput {
    destinationId?: string;
    exporterId: string;
    exporterSource: string;
    endpoint: string;
    externalProject: string;
    allowInsecureLocalEndpoint?: boolean;
    projectRoots: string[];
}
export interface MetricsExportCredentials {
    [key: string]: string;
}
export interface MetricsExportCredentialRecord {
    revision: string;
    credentials: MetricsExportCredentials;
}
interface CredentialFile {
    [destinationId: string]: MetricsExportCredentialRecord;
}
export interface MetricsExportHostIdentity {
    ownerRef: string;
    referenceKey: string;
}
interface ExportSettings {
    destinations: MetricsExportDestinationGrant[];
}

const materializedHistoryEpoch = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Legacy path grants require a surviving journal boundary before they can deliver. */
export function measurementProjectForExport(start: MetricsExportProjectStart): MeasurementProject | undefined {
    const project = inspectMeasurementProject(start.projectRoot, start.projectId);
    if (!project || start.projectId) return project;
    const rootHash = createHash("sha256").update(start.projectRoot).digest("hex");
    const fence = readWorkflowMetricLegacyAdoption(project.journalPath);
    if (
        fence &&
        fence.sourceRootHash === rootHash &&
        start.historyEpoch !== "initial" &&
        (start.historyEpoch === fence.legacyHistoryEpoch ||
            (start.historyEpoch === fence.historyEpoch && start.legacyAdoptionEpoch === fence.historyEpoch))
    )
        return project;
    if (!materializedHistoryEpoch.test(start.historyEpoch)) return undefined;
    const source = readWorkflowMetricLegacySource(project.journalPath);
    if (
        source?.rootHash === rootHash &&
        source.historyEpoch === start.historyEpoch &&
        source.journalBytes >= start.offset
    ) {
        return project;
    }
}

export function readMetricsExportGrants(): MetricsExportDestinationGrant[] {
    const settings = getCustomSetting("metricsExport", "global") as ExportSettings | undefined;
    return (Array.isArray(settings?.destinations) ? settings.destinations : []).map((grant) => ({
        ...grant,
        projects: grant.projects.map((start) => {
            const project = measurementProjectForExport(start);
            if (!project) return start;
            const fence = readWorkflowMetricLegacyAdoption(project.journalPath);
            return {
                ...start,
                projectRoot: project.root,
                ...(fence && start.legacyAdoptionEpoch !== fence.historyEpoch
                    ? {
                          historyEpoch: fence.historyEpoch,
                          offset: fence.offset,
                          legacyAdoptionEpoch: fence.historyEpoch,
                      }
                    : {}),
            };
        }),
    }));
}
function requireLocal(): void {
    if (remotePersonalResourcesActive()) throw new Error("Export configuration requires the local host");
}
async function saveGrants(destinations: MetricsExportDestinationGrant[]): Promise<void> {
    await setCustomSetting("metricsExport", { destinations }, "global");
    if (JSON.stringify(readMetricsExportGrants()) !== JSON.stringify(destinations)) {
        throw new Error("Export grant write was not saved");
    }
}
export function grantMatchesExporter(
    grant: MetricsExportDestinationGrant,
    exporter: InstalledMetricsExporter,
): boolean {
    return (
        exporter.approved &&
        grant.exporterId === exporter.id &&
        grant.exporterSource === exporter.source &&
        grant.exporterInstalledPath === exporter.installedPath &&
        grant.exporterVersion === exporter.version
    );
}
function validateEndpoint(input: MetricsExportGrantInput): string {
    const url = new URL(input.endpoint);
    const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
    if (
        url.username ||
        url.password ||
        url.hash ||
        (url.protocol !== "https:" &&
            !(url.protocol === "http:" && loopback && input.allowInsecureLocalEndpoint === true))
    ) {
        throw new Error("Export endpoint requires HTTPS, or explicit loopback HTTP permission");
    }
    return url.href;
}
async function projectStart(project: MeasurementProject): Promise<MetricsExportProjectStart> {
    const { root: projectRoot, projectId, journalPath: path } = project;
    return await withWorkflowMetricJournalLock(path, (historyEpoch) => {
        let offset = 0;
        try {
            offset = statSync(path).size;
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        const adoption = readWorkflowMetricLegacyAdoption(path);
        return {
            projectRoot,
            projectId,
            historyEpoch,
            offset,
            ...(adoption ? { legacyAdoptionEpoch: adoption.historyEpoch } : {}),
        };
    });
}

/** Create or update consent. Transport or identity changes reset all start boundaries. */
export async function grantMetricsExportDestination(
    input: MetricsExportGrantInput,
): Promise<MetricsExportDestinationGrant> {
    requireLocal();
    return await withExportConfigurationLock(() => saveDestinationGrant(input));
}

/** Caller holds the configuration lock through reading consent and capturing starts. */
async function saveDestinationGrant(input: MetricsExportGrantInput): Promise<MetricsExportDestinationGrant> {
    const endpoint = validateEndpoint(input);
    const exporter = (await resolveApprovedMetricsExporters()).find(
        (e) => e.id === input.exporterId && e.source === input.exporterSource,
    );
    if (!exporter) throw new Error("Metrics exporter is not installed and approved");
    const saved = readMetricsExportGrants();
    const previous = saved.find((g) => g.destinationId === input.destinationId);
    const destinationId = input.destinationId ?? crypto.randomUUID();
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(destinationId)) throw new Error("Invalid destination ID");
    const preserve =
        previous &&
        previous.endpoint === endpoint &&
        previous.externalProject === input.externalProject &&
        grantMatchesExporter(previous, exporter);
    const projects: MetricsExportProjectStart[] = [];
    for (const root of input.projectRoots) {
        if (preserve && !existsSync(root)) {
            const unavailable = previous.projects.find((p) => p.projectRoot === root);
            if (unavailable && !projects.includes(unavailable)) {
                projects.push(unavailable);
                continue;
            }
        }
        const project = await admitMeasurementProject(root);
        if (projects.some((p) => p.projectId === project.projectId)) continue;
        const prior =
            preserve &&
            previous.projects.find(
                (p) =>
                    p.projectRoot === project.root && measurementProjectForExport(p)?.projectId === project.projectId,
            );
        projects.push(prior ? { ...prior, projectId: project.projectId } : await projectStart(project));
    }
    const grant: MetricsExportDestinationGrant = {
        destinationId,
        grantId: preserve ? previous.grantId : crypto.randomUUID(),
        exporterId: exporter.id,
        exporterSource: exporter.source,
        exporterInstalledPath: exporter.installedPath,
        exporterVersion: exporter.version,
        endpoint,
        externalProject: input.externalProject,
        allowInsecureLocalEndpoint: input.allowInsecureLocalEndpoint === true,
        projects,
        grantedAt: preserve ? previous.grantedAt : new Date().toISOString(),
    };
    await saveGrants([...saved.filter((g) => g.destinationId !== destinationId), grant]);
    return grant;
}
/** Updating projectRoots adds and removes explicit Projects; no Project is added implicitly. */
export async function updateMetricsExportProjects(
    destinationId: string,
    projectRoots: string[],
): Promise<MetricsExportDestinationGrant> {
    requireLocal();
    return await withExportConfigurationLock(async () => {
        const grant = readMetricsExportGrants().find((g) => g.destinationId === destinationId);
        if (!grant) throw new Error("Export grant does not exist");
        return await saveDestinationGrant({ ...grant, projectRoots });
    });
}
export async function revokeMetricsExportDestination(destinationId: string): Promise<{ deliveryInFlight: boolean }> {
    requireLocal();
    return await withExportConfigurationLock(async () => {
        await saveGrants(readMetricsExportGrants().filter((g) => g.destinationId !== destinationId));
        return { deliveryInFlight: metricsDeliveryInFlight(destinationId) };
    });
}
function readCredentialFile(): CredentialFile {
    try {
        return JSON.parse(readFileSync(join(metricsExportDirectory(), "credentials.json"), "utf8"));
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
        throw new Error("Export credentials are unavailable");
    }
}
export function readMetricsExportCredentials(destinationId: string): MetricsExportCredentialRecord {
    const saved = readCredentialFile();
    return Object.hasOwn(saved, destinationId) ? saved[destinationId] : { revision: "initial", credentials: {} };
}
export async function setMetricsExportCredentials(
    destinationId: string,
    credentials: MetricsExportCredentials,
): Promise<void> {
    requireLocal();
    await withExportConfigurationLock(() => {
        const saved: CredentialFile = {
            ...readCredentialFile(),
            [destinationId]: { revision: crypto.randomUUID(), credentials: { ...credentials } },
        };
        replaceExportFile(join(metricsExportDirectory(), "credentials.json"), JSON.stringify(saved));
        if (readCredentialFile()[destinationId]?.revision !== saved[destinationId].revision) {
            throw new Error("Export credentials write was not saved");
        }
    });
}
export async function clearMetricsExportCredentials(destinationId: string): Promise<void> {
    await setMetricsExportCredentials(destinationId, {});
}
export async function readMetricsExportHostIdentity(): Promise<MetricsExportHostIdentity> {
    requireLocal();
    return await withExportConfigurationLock(() => {
        const path = join(metricsExportDirectory(), "host.json");
        try {
            return JSON.parse(readFileSync(path, "utf8"));
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
                throw new Error("Export identity is unavailable");
        }
        const identity = {
            ownerRef: crypto.randomUUID(),
            referenceKey: Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
                b.toString(16).padStart(2, "0"),
            ).join(""),
        };
        replaceExportFile(path, JSON.stringify(identity));
        return identity;
    });
}
