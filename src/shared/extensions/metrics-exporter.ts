/** Host-approved metrics exporter inventory. This module never imports package code. */
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { isAbsolute, join, relative } from "@std/path";
import { withExportConfigurationLock } from "../workflow/metrics-export-storage.ts";
import { getCwd } from "../../constants.js";
import type { PackagePromptResourceOptions } from "../package-resources.ts";
import { getCustomSetting, getSettingsDir, getSettingsManager, setCustomSetting } from "../settings.js";
import {
    assertPersonalResourcePath,
    personalPackageRoots,
    remotePersonalResourcesActive,
} from "../remote/personal-resources.ts";

export interface MetricsExporterDeclaration {
    contract: 1;
    id: string;
    entry: string;
}

export interface MetricsExporterApproval {
    id: string;
    source: string;
    installedPath: string;
    version: string;
    approvedAt: string;
}

export interface InstalledMetricsExporter {
    id: string;
    source: string;
    installedPath: string;
    version: string;
    entryPath: string;
    approved: boolean;
}

const APPROVAL_KEY = "metricsExporterApprovals";

/** Invalid, missing, escaping, and Pi extension entries are not exporter declarations. */
export async function readMetricsExporterDeclaration(packageRoot: string): Promise<MetricsExporterDeclaration | null> {
    try {
        const manifest = JSON.parse(await Deno.readTextFile(join(packageRoot, "package.json")));
        const declaration = manifest?.wld?.metricsExporter;
        if (
            declaration?.contract !== 1 || typeof declaration.id !== "string" || !declaration.id.trim() ||
            typeof declaration.entry !== "string" || !declaration.entry || isAbsolute(declaration.entry)
        ) return null;
        const root = await Deno.realPath(packageRoot);
        const entryPath = await Deno.realPath(join(root, declaration.entry));
        const rest = relative(root, entryPath);
        if (!rest || rest === ".." || rest.startsWith("../") || rest.startsWith("..\\") || isAbsolute(rest)) {
            return null;
        }
        if (!(await Deno.stat(entryPath)).isFile) return null;
        const manager = new DefaultPackageManager({
            cwd: root,
            agentDir: root,
            settingsManager: SettingsManager.inMemory(),
        });
        const resources = await manager.resolveExtensionSources([root]);
        for (const resource of resources.extensions) {
            if (await Deno.realPath(resource.path) === entryPath) return null;
        }
        return { contract: 1, id: declaration.id, entry: declaration.entry };
    } catch {
        return null;
    }
}

function approvals(): MetricsExporterApproval[] {
    const records: MetricsExporterApproval[] = getCustomSetting(APPROVAL_KEY, "global");
    if (!Array.isArray(records)) return [];
    return records.filter((record) =>
        record && typeof record.id === "string" && typeof record.source === "string" &&
        typeof record.installedPath === "string" && typeof record.version === "string" &&
        typeof record.approvedAt === "string"
    );
}

function sameIdentity(record: MetricsExporterApproval, exporter: InstalledMetricsExporter): boolean {
    return record.id === exporter.id && record.source === exporter.source &&
        record.installedPath === exporter.installedPath && record.version === exporter.version;
}

export async function listInstalledMetricsExporters(
    options: PackagePromptResourceOptions = {},
): Promise<InstalledMetricsExporter[]> {
    const settings = options.settingsManager || getSettingsManager(options.cwd);
    if (!options.settingsManager) await settings.reload();
    const remote = remotePersonalResourcesActive();
    const roots = personalPackageRoots();
    // No resolve(): Project packages must never replace the user's exporter.
    const manager = remote ? null : new DefaultPackageManager({
        cwd: options.cwd || getCwd(),
        agentDir: options.agentDir || getSettingsDir("global"),
        settingsManager: settings,
    });
    const packages = remote
        ? (settings.getGlobalSettings().packages || []).map((entry) => {
            const source = typeof entry === "string" ? entry : entry.source;
            return { source, scope: "user", installedPath: roots[source] };
        })
        : manager!.listConfiguredPackages();
    const saved = approvals();
    const exporters: InstalledMetricsExporter[] = [];
    for (const pkg of packages) {
        if (pkg.scope !== "user" || !pkg.installedPath) continue;
        if (remote) {
            await assertPersonalResourcePath(pkg.installedPath, "metrics exporter package", { packageResource: true });
            await assertPersonalResourcePath(join(pkg.installedPath, "package.json"), "metrics exporter manifest", {
                packageResource: true,
            });
        }
        const declaration = await readMetricsExporterDeclaration(pkg.installedPath);
        if (!declaration) continue;
        const installedPath = await Deno.realPath(pkg.installedPath);
        const manifest = JSON.parse(await Deno.readTextFile(join(installedPath, "package.json")));
        const entryPath = await Deno.realPath(join(installedPath, declaration.entry));
        if (remote) {
            await assertPersonalResourcePath(join(pkg.installedPath, declaration.entry), "metrics exporter entry", {
                packageResource: true,
            });
        }
        const exporter: InstalledMetricsExporter = {
            id: declaration.id,
            source: pkg.source,
            installedPath,
            version: typeof manifest.version === "string" ? manifest.version : "",
            entryPath,
            approved: false,
        };
        exporter.approved = saved.some((record) => sameIdentity(record, exporter));
        exporters.push(exporter);
    }
    return exporters;
}

/** Re-read installed identities on every resolution. Worker execution belongs to the caller. */
export async function resolveApprovedMetricsExporters(
    options: PackagePromptResourceOptions = {},
): Promise<InstalledMetricsExporter[]> {
    return (await listInstalledMetricsExporters(options)).filter((exporter) => exporter.approved);
}

/** Short final identity check. The export configuration lock serializes approval edits. */
export function metricsExporterStillApproved(exporter: InstalledMetricsExporter): boolean {
    if (!approvals().some((saved) => sameIdentity(saved, exporter))) return false;
    const packages: Array<string | { source: string }> = getCustomSetting("packages", "global") ?? [];
    if (!packages.some((pkg) => (typeof pkg === "string" ? pkg : pkg.source) === exporter.source)) return false;
    try {
        if (isAbsolute(exporter.source) && Deno.realPathSync(exporter.source) !== exporter.installedPath) return false;
        const manifest = JSON.parse(Deno.readTextFileSync(join(exporter.installedPath, "package.json")));
        const declaration = manifest?.wld?.metricsExporter;
        return declaration?.contract === 1 && declaration.id === exporter.id &&
            (typeof manifest.version === "string" ? manifest.version : "") === exporter.version &&
            typeof declaration.entry === "string" &&
            Deno.realPathSync(join(exporter.installedPath, declaration.entry)) === exporter.entryPath;
    } catch {
        return false;
    }
}

export async function approveMetricsExporter(exporter: InstalledMetricsExporter): Promise<void> {
    await withExportConfigurationLock(async () => {
        const record: MetricsExporterApproval = {
            id: exporter.id,
            source: exporter.source,
            installedPath: exporter.installedPath,
            version: exporter.version,
            approvedAt: new Date().toISOString(),
        };
        await setCustomSetting(APPROVAL_KEY, [
            ...approvals().filter((saved) => !(saved.source === record.source && saved.id === record.id)),
            record,
        ], "global");
        if (!approvals().some((saved) => sameIdentity(saved, exporter))) {
            throw new Error(`Approval for metrics exporter ${exporter.id} was not saved`);
        }
    });
}

export async function removeMetricsExporterApprovals(source: string): Promise<void> {
    await withExportConfigurationLock(async () => {
        const saved = approvals();
        if (!saved.some((record) => record.source === source)) return;
        await setCustomSetting(APPROVAL_KEY, saved.filter((record) => record.source !== source), "global");
        if (approvals().some((record) => record.source === source)) {
            throw new Error("Exporter approval removal was not saved");
        }
    });
}
