import { projects } from "@runwield/projects";
import { readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertManagedRuntimePath } from "../shared/project-runtime-managed.ts";
import { checkedProjectRuntimeLayout } from "@runwield/project-runtime/layout";
import { openNativeFileLock } from "../shared/native-file-lock.ts";
import { ensurePrivateDir, writeJsonAtomically } from "../shared/private-json-file.ts";
import { hasRetainedCheckoutSource } from "@runwield/plans/retained-checkout";
import { confirmRetention, type RetentionKind } from "./retention.ts";

export interface ApprovedPrune {
    token: string;
    label: string;
}
interface PruneRequest {
    binding: string;
    approved: ApprovedPrune[];
}
async function requestLocation(cwd: string, kind: RetentionKind) {
    if (hasRetainedCheckoutSource(cwd)) return;
    const inspected = projects.checkout.inspect(cwd);
    if (inspected.kind !== "existing") return;
    const identity = inspected.identity;
    const runtime = await checkedProjectRuntimeLayout(cwd);
    const path = join(runtime.selected.transitionJournalsDir, `prune-${kind}.json`);
    await assertManagedRuntimePath(path, identity.executionAccountHome);
    return {
        path,
        binding: JSON.stringify([
            identity.projectId,
            identity.repositoryId,
            identity.checkoutId,
            identity.personalOwner,
        ]),
    };
}
async function readRequest(location: { path: string; binding: string }): Promise<PruneRequest | undefined> {
    const bytes = await readFile(location.path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
    });
    if (bytes === undefined) return;
    const request: PruneRequest = JSON.parse(bytes);
    if (
        request.binding !== location.binding ||
        !Array.isArray(request.approved) ||
        request.approved.some((item) => !/^[0-9a-f]{64}$/.test(item.token) || typeof item.label !== "string")
    )
        throw new Error("Prune request belongs to another checkout or is damaged.");
    return request;
}
export async function pendingPruneRequest(cwd: string, kind: RetentionKind) {
    const location = await requestLocation(cwd, kind);
    return location ? (await readRequest(location))?.approved : undefined;
}

/** Save the full confirmation before the first effect. Replay can only narrow the remaining set. */
export async function confirmPruneRequest(
    cwd: string,
    kind: RetentionKind,
    approved: ApprovedPrune[],
    mnemotecaPort?: import("../shared/work-records/mnemoteca-port.ts").WorkRecordMnemotecaPort,
) {
    const location = await requestLocation(cwd, kind);
    const apply = async (request: PruneRequest) => {
        const deleted: string[] = [],
            skipped: string[] = [];
        while (request.approved.length) {
            const [item] = request.approved;
            const changed = await confirmRetention(cwd, kind, item.token, mnemotecaPort);
            (changed ? deleted : skipped).push(item.label);
            request.approved.shift();
            if (location && request.approved.length) writeJsonAtomically(location.path, request);
        }
        if (location) await unlink(location.path);
        return { deleted, skipped };
    };
    if (!location) return await apply({ binding: "", approved: [...approved] });
    ensurePrivateDir(dirname(location.path));
    const lockPath = location.path + ".lock";
    const inspected = projects.checkout.inspect(cwd);
    if (inspected.kind !== "existing") throw new Error("Missing Project binding before prune confirmation.");
    await assertManagedRuntimePath(lockPath, inspected.identity.executionAccountHome);
    const lock = openNativeFileLock(lockPath);
    try {
        await lock.lock(true);
        const retained = await readRequest(location);
        if (retained) return await apply(retained);
        const request = { binding: location.binding, approved: [...approved] };
        writeJsonAtomically(location.path, request);
        return await apply(request);
    } finally {
        lock.close();
    }
}
