import process from "node:process";
/**
 * @module cmd/snip-filters
 * Install or clean up RunWield-managed Snip filters.
 */

import {
    cleanupRunWieldSnipFiltersForUser,
    getRunWieldSnipFilterInstallStatus,
    installRunWieldSnipFiltersForUser,
} from "../../shared/snip-filters.ts";

interface SkippedFilter {
    path: string;
    reason: string;
}

function formatPathList(paths: string[]): string {
    return paths.length === 0 ? "none" : paths.map((path) => `- ${path}`).join("\n");
}

function formatSkipped(skipped: SkippedFilter[]): string {
    return skipped.length === 0 ? "none" : skipped.map((item) => `- ${item.path} (${item.reason})`).join("\n");
}

export async function runSnipFiltersCommand(argv: string[]): Promise<void> {
    const action = argv[0] || "status";

    try {
        if (action === "install") {
            const result = await installRunWieldSnipFiltersForUser();
            console.log(`Installed RunWield Snip filters into ${result.filtersDir}`);
            console.log(`Updated:\n${formatPathList(result.installed)}`);
            if (result.removedLegacy.length > 0) {
                console.log(`Removed obsolete Harns filters:\n${formatPathList(result.removedLegacy)}`);
            }
            if (result.skipped.length > 0) {
                console.log(`Skipped:\n${formatSkipped(result.skipped)}`);
            }
            return;
        }

        if (action === "cleanup" || action === "remove" || action === "uninstall") {
            const result = await cleanupRunWieldSnipFiltersForUser();
            console.log(`Cleaned up RunWield Snip filters from ${result.filtersDir}`);
            console.log(`Removed:\n${formatPathList(result.removed)}`);
            if (result.removedLegacy.length > 0) {
                console.log(`Removed obsolete Harns filters:\n${formatPathList(result.removedLegacy)}`);
            }
            if (result.skipped.length > 0) {
                console.log(`Skipped:\n${formatSkipped(result.skipped)}`);
            }
            return;
        }

        if (action === "status") {
            const result = await getRunWieldSnipFilterInstallStatus();
            console.log(`RunWield Snip filter status in ${result.filtersDir}`);
            console.log(`Installed:\n${formatPathList(result.installed)}`);
            console.log(`Missing:\n${formatPathList(result.missing)}`);
            if (result.conflicts.length > 0) {
                console.log(`Conflicts:\n${formatPathList(result.conflicts)}`);
            }
            return;
        }

        console.error("Usage: wld snip-filters [install|cleanup|status]");
        process.exitCode = 1;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Snip filter command failed: ${message}`);
        process.exitCode = 1;
    }
}
