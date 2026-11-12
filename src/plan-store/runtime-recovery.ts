/** Controller recovery is an owner operation; layout migration supplies already verified layout roots. */
import fsPromises, { readdir, readFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type NativeFileLock, openNativeFileLock } from "../shared/native-file-lock.ts";
import { info, syncDirectory, writeAtomic, preserve, equalBytes } from "../shared/runtime-recovery-files.ts";
import type { ControllerRecord } from "./controllers.ts";
function parseController(bytes: Uint8Array): ControllerRecord | null {
    try {
        const record: ControllerRecord = JSON.parse(new TextDecoder().decode(bytes));
        return record?.version === 1 &&
            Number.isInteger(record.revision) &&
            record.state &&
            typeof record.planName === "string"
            ? record
            : null;
    } catch {
        return null;
    }
}

/**
 * The adopted controller owns decisions, counters, document location and publication.
 * Old copies cannot overwrite them. Completion prose is recoverable information,
 * not permission to skip validation; import it only if the current report is absent.
 */
function recoverCompletionReport(currentBytes: Uint8Array, legacyBytes: Uint8Array): Uint8Array {
    const current = parseController(currentBytes);
    const legacy = parseController(legacyBytes);
    if (
        !current ||
        !legacy ||
        current.planId !== legacy.planId ||
        current.planName !== legacy.planName ||
        Object.hasOwn(current.state, "executionReport") ||
        !legacy.state.executionReport
    )
        return currentBytes;
    const recovered: ControllerRecord = {
        ...current,
        revision: current.revision + 1,
        state: { ...current.state, executionReport: legacy.state.executionReport },
    };
    return new TextEncoder().encode(`${JSON.stringify(recovered, null, 2)}\n`);
}

export interface PlanControllerRecoveryLocations {
    source: string;
    destination: string;
    archiveRoot: string;
}
/** Bootstrap only: layout migration has bounded and checked both roots under its migration lock. */
export async function recoverLegacyPlanControllers(locations: PlanControllerRecoveryLocations): Promise<void> {
    const stat = await info(locations.source);
    if (!stat || locations.source.endsWith(".lock")) return;
    if (
        stat.isSymbolicLink() ||
        (!stat.isDirectory() && !stat.isFile()) ||
        (await info(locations.destination))?.isSymbolicLink()
    )
        throw new Error("Plan controller recovery encountered an unsafe filesystem path.");
    if (stat.isDirectory()) {
        for (const entry of await readdir(locations.source, { withFileTypes: true }))
            await recoverLegacyPlanControllers({
                ...locations,
                source: join(locations.source, entry.name),
                destination: join(locations.destination, entry.name),
            });
        return;
    }
    const locks: NativeFileLock[] = [];
    try {
        if (locations.source.endsWith(".json")) {
            for (const path of [locations.source, locations.destination]) {
                await mkdir(dirname(path), { recursive: true, mode: 0o700 });
                const lock = openNativeFileLock(`${path}.lock`);
                locks.push(lock);
                await lock.lock(true);
            }
        }
        const legacy = await readFile(locations.source);
        await preserve(locations.source, legacy, locations.archiveRoot);
        if (!(await info(locations.destination))) await writeAtomic(locations.destination, legacy, true);
        else {
            const current = await readFile(locations.destination);
            const recovered = recoverCompletionReport(current, legacy);
            if (!equalBytes(current, recovered)) {
                await preserve(locations.destination, current, locations.archiveRoot);
                await writeAtomic(locations.destination, recovered);
            }
        }
        if (equalBytes(await readFile(locations.source), legacy)) {
            await fsPromises.rm(locations.source);
            await syncDirectory(dirname(locations.source));
        }
    } finally {
        for (const lock of locks.reverse()) lock.close();
    }
}
