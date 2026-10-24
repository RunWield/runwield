import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { getHomeDir } from "../../constants.js";
import { remotePersonalResourcesActive } from "./personal-resources.ts";

let directory: string | undefined;

/** Transient output belongs to this remote runtime, never to remote Session storage. */
export function remoteBackgroundTaskLogDirectory(): string | undefined {
    if (!remotePersonalResourcesActive()) return undefined;
    if (directory) return directory;
    const temporaryRoot = realpathSync(tmpdir());
    const fromStorage = relative(join(realpathSync(getHomeDir()), ".wld"), temporaryRoot);
    if (!fromStorage || (fromStorage !== ".." && !fromStorage.startsWith(`..${sep}`) && !isAbsolute(fromStorage))) {
        throw new Error("Remote background task temporary storage must be outside ~/.wld");
    }
    const created = mkdtempSync(join(temporaryRoot, "runwield-background-"));
    try {
        chmodSync(created, 0o700);
    } catch (error) {
        rmSync(created, { recursive: true, force: true });
        throw error;
    }
    directory = created;
    process.once("exit", disposeRemoteBackgroundTaskLogs);
    return directory;
}

/** The connection shuts down its Sessions before it removes their transient output. */
export function disposeRemoteBackgroundTaskLogs(): void {
    if (!directory) return;
    rmSync(directory, { recursive: true, force: true });
    directory = undefined;
    process.off("exit", disposeRemoteBackgroundTaskLogs);
}
