/** Explicit personal Work Record authority; discovery alone never selects it. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import { inspectProjectIdentity, type ProjectIdentity } from "../project-identity.ts";
import { ensurePrivateDir } from "../private-json-file.ts";
import { openNativeFileLock } from "../native-file-lock.ts";

const owners = new AsyncLocalStorage<ProjectIdentity>();
const mutations = new AsyncLocalStorage<string>();

export function currentWorkRecordOwner(): ProjectIdentity | undefined {
    return owners.getStore();
}

export function workRecordOwnerLayout() {
    const identity = owners.getStore();
    if (!identity) return undefined;
    const inspected = inspectProjectIdentity(identity.checkoutRoot);
    if (
        inspected.kind !== "existing" ||
        inspected.identity.projectId !== identity.projectId ||
        inspected.identity.repositoryId !== identity.repositoryId ||
        inspected.identity.personalOwner.identity !== identity.personalOwner.identity ||
        inspected.identity.executionAccountHome !== identity.executionAccountHome
    )
        throw new Error("The admitted Work Record owner is unavailable.");
    const root = join(identity.executionAccountHome, ".wld", "projects", identity.projectId);
    const internal = join(root, "internal", "work-records");
    const key = createHash("sha256").update(identity.personalOwner.identity).digest("hex");
    return {
        identity,
        root,
        internal,
        records: join(root, "work-records"),
        database: join(internal, "index.sqlite3"),
        lock: join(internal, "records.lock"),
        collection: `${identity.projectId}:${key}:work-records`,
    };
}

export function assertWorkRecordPath(path: string): void {
    const owner = owners.getStore();
    if (!owner) return;
    const root = owner.executionAccountHome;
    const rel = relative(root, path);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith("../")) throw new Error("Work Record path leaves its owner.");
    for (let cursor = path; ; cursor = dirname(cursor)) {
        try {
            if (lstatSync(cursor).isSymbolicLink())
                throw new Error(`Work Record path contains a symbolic link: ${cursor}`);
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        if (cursor === root) break;
    }
}

export async function withWorkRecordOwner<T>(
    cwd: string,
    identity: ProjectIdentity,
    run: () => Promise<T>,
): Promise<T> {
    const inspected = inspectProjectIdentity(cwd);
    if (
        identity.personalOwner.kind !== "execution-account" ||
        inspected.kind !== "existing" ||
        inspected.identity.projectId !== identity.projectId ||
        inspected.identity.repositoryId !== identity.repositoryId ||
        inspected.identity.personalOwner.identity !== identity.personalOwner.identity ||
        inspected.identity.executionAccountHome !== identity.executionAccountHome
    )
        throw new Error("Work Record admission does not belong to this Project and personal owner.");
    return await owners.run(identity, run);
}

/** All admitted record mutations, including multi-record supersession, share one native lock. */
export async function withWorkRecordMutation<T>(run: () => Promise<T>): Promise<T> {
    const layout = workRecordOwnerLayout();
    if (!layout || mutations.getStore() === layout.lock) return await run();
    assertWorkRecordPath(layout.lock);
    ensurePrivateDir(layout.internal);
    const lock = openNativeFileLock(layout.lock);
    try {
        await lock.lock(true);
        return await mutations.run(layout.lock, run);
    } finally {
        lock.close();
    }
}
