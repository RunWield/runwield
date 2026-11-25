/** Explicit personal Work Record authority; discovery alone never selects it. */
import { workRecordFiles } from "@runwield/plans/work-record-files";
import { projects, type ProjectStoreIdentity as ProjectIdentity } from "@runwield/projects";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { join } from "node:path";

const owners = new AsyncLocalStorage<ProjectIdentity>();

export function currentWorkRecordOwner(): ProjectIdentity | undefined {
    return owners.getStore();
}

export function ownedWorkRecordFiles() {
    const identity = currentWorkRecordOwner();
    return identity ? workRecordFiles.forOwner(identity) : undefined;
}

export function requireOwnedWorkRecordFiles() {
    const files = ownedWorkRecordFiles();
    if (!files) throw new Error("Work Records require explicit personal-store admission.");
    return files;
}

export function workRecordOwnerLayout() {
    const identity = currentWorkRecordOwner();
    if (!identity) return undefined;
    const layout = workRecordFiles.forOwner(identity).layout;
    const key = createHash("sha256").update(identity.personalOwner.identity).digest("hex");
    return {
        ...layout,
        identity,
        database: join(layout.internal, "index.sqlite3"),
        collection: `${identity.projectId}:${key}:work-records`,
    };
}

export async function withWorkRecordOwner<T>(
    cwd: string,
    identity: ProjectIdentity,
    run: () => Promise<T>,
): Promise<T> {
    if (projects.home.isOwner(identity)) {
        projects.home.assertStoreIdentity(identity);
        return await owners.run(identity, run);
    }
    const inspected = projects.checkout.inspect(cwd);
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
    const files = ownedWorkRecordFiles();
    return files ? await files.mutate(run) : await run();
}

/** A registered legacy Project must not inherit another Project's personal authority. */
export function withoutWorkRecordOwner<T>(run: () => Promise<T>): Promise<T> {
    return owners.exit(run);
}
