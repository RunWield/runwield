import { resolve } from "node:path";
import { formatArchiveRetentionNudge } from "../../shared/plan-archive-retention.ts";
import type { UiAPI } from "../../ui/tui/types.js";

const pendingArchives = new Set<string>();

interface BackgroundArchiveOptions {
    projectRoot: string;
    planName: string;
    uiAPI: UiAPI;
    archive: () => Promise<string>;
}

export function isPlanArchivePending(projectRoot: string, planName: string): boolean {
    return pendingArchives.has(`${resolve(projectRoot)}:${planName}`);
}

/** Keep archive I/O out of the menu, and report its outcome without starting an Agent turn. */
export function startBackgroundArchive({ projectRoot, planName, uiAPI, archive }: BackgroundArchiveOptions): void {
    const key = `${resolve(projectRoot)}:${planName}`;
    if (isPlanArchivePending(projectRoot, planName)) {
        uiAPI.appendSystemMessage(`Archive is already running for ${planName}.`, false, "RunWield");
        return;
    }
    pendingArchives.add(key);
    uiAPI.appendSystemMessage(`Archiving ${planName} in the background. You can keep working.`, false, "RunWield");
    void (async () => {
        try {
            const message = await archive();
            try {
                const nudge = await formatArchiveRetentionNudge(projectRoot);
                if (nudge) uiAPI.appendSystemMessage(nudge, false, "RunWield");
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                uiAPI.appendSystemMessage(`Archive retention check failed: ${reason}`, true, "RunWield");
            }
            uiAPI.appendSystemMessage(message, false, "RunWield");
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            uiAPI.appendSystemMessage(`Archive failed for ${planName}: ${reason}`, true, "RunWield");
        } finally {
            pendingArchives.delete(key);
        }
    })();
}
