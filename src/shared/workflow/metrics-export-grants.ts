/** Owner consent, transport credentials, and host-local reference identity. */
import { join } from "@std/path";
import { type InstalledMetricsExporter, resolveApprovedMetricsExporters } from "../extensions/metrics-exporter.ts";
import { resolvePrimaryCheckoutRoot } from "../primary-checkout.ts";
import { remotePersonalResourcesActive } from "../remote/personal-resources.ts";
import { getCustomSetting, setCustomSetting } from "../settings.js";
import { getWorkflowMetricsFilePath } from "./metrics.js";
import { withWorkflowMetricJournalLock } from "./metrics-journal.ts";
import { metricsDeliveryInFlight } from "./metrics-export-ledger.ts";
import { metricsExportDirectory, replaceExportFile, withExportConfigurationLock } from "./metrics-export-storage.ts";

export interface MetricsExportProjectStart {
    projectRoot: string;
    historyEpoch: string;
    offset: number;
}
export interface MetricsExportDestinationGrant {
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
}
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

export function readMetricsExportGrants(): MetricsExportDestinationGrant[] {
    const settings: ExportSettings | undefined = getCustomSetting("metricsExport", "global");
    return Array.isArray(settings?.destinations) ? settings.destinations : [];
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
    return exporter.approved && grant.exporterId === exporter.id && grant.exporterSource === exporter.source &&
        grant.exporterInstalledPath === exporter.installedPath && grant.exporterVersion === exporter.version;
}
function validateEndpoint(input: MetricsExportGrantInput): string {
    const url = new URL(input.endpoint);
    const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
    if (
        url.username || url.password || url.hash || (url.protocol !== "https:" &&
            !(url.protocol === "http:" && loopback && input.allowInsecureLocalEndpoint === true))
    ) {
        throw new Error("Export endpoint requires HTTPS, or explicit loopback HTTP permission");
    }
    return url.href;
}
async function projectStart(root: string): Promise<MetricsExportProjectStart> {
    const projectRoot = Deno.realPathSync(resolvePrimaryCheckoutRoot(Deno.realPathSync(root)));
    const path = getWorkflowMetricsFilePath(projectRoot);
    return await withWorkflowMetricJournalLock(path, (historyEpoch) => {
        let offset = 0;
        try {
            offset = Deno.statSync(path).size;
        } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
        return { projectRoot, historyEpoch, offset };
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
    const exporter = (await resolveApprovedMetricsExporters()).find((e) =>
        e.id === input.exporterId && e.source === input.exporterSource
    );
    if (!exporter) throw new Error("Metrics exporter is not installed and approved");
    const saved = readMetricsExportGrants();
    const previous = saved.find((g) => g.destinationId === input.destinationId);
    const destinationId = input.destinationId ?? crypto.randomUUID();
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(destinationId)) throw new Error("Invalid destination ID");
    const preserve = previous && previous.endpoint === endpoint &&
        previous.externalProject === input.externalProject &&
        grantMatchesExporter(previous, exporter);
    const projects: MetricsExportProjectStart[] = [];
    for (const root of input.projectRoots) {
        const canonical = Deno.realPathSync(resolvePrimaryCheckoutRoot(Deno.realPathSync(root)));
        if (projects.some((p) => p.projectRoot === canonical)) continue;
        projects.push(
            (preserve && previous.projects.find((p) => p.projectRoot === canonical)) ||
                await projectStart(canonical),
        );
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
        return JSON.parse(Deno.readTextFileSync(join(metricsExportDirectory(), "credentials.json")));
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return {};
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
            return JSON.parse(Deno.readTextFileSync(path));
        } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw new Error("Export identity is unavailable");
        }
        const identity = {
            ownerRef: crypto.randomUUID(),
            referenceKey: Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0"))
                .join(""),
        };
        replaceExportFile(path, JSON.stringify(identity));
        return identity;
    });
}
