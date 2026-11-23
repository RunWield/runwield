import {
    activatePersonalResourceMounts,
    assertPersonalResourceMountsSync,
    remotePersonalResourcesActive,
    type RemotePersonalResourceMounts,
} from "@runwield/resources/personal";
import type { ProjectPersonalOwner } from "../project-identity.ts";

export {
    assertPersonalResourcePath,
    assertPersonalResourcePathSync,
    personalAgentsRoot,
    personalGlobalRoot,
    personalPackageRoots,
    PersonalResourcePathError,
    remotePersonalResourcesActive,
} from "@runwield/resources/personal";

/** Resources and Project owner supplied by a verified remote connection. */
export interface RemotePersonalResources extends RemotePersonalResourceMounts {
    personalOwner?: ProjectPersonalOwner;
}

let owner: Readonly<ProjectPersonalOwner> | undefined;

/** Call only in the remote process after the connection supplies verified mounts and owner context. */
export function configureRemotePersonalResources({ personalOwner, ...mounts }: RemotePersonalResources): void {
    if (personalOwner && (personalOwner.kind !== "managed-remote" || !personalOwner.identity)) {
        throw new Error("Managed remote Project owner identity is required");
    }
    activatePersonalResourceMounts(mounts);
    owner = personalOwner && Object.freeze({ ...personalOwner });
}

/** Owner context arrives through verified activation, never from SSH variables or mount names. */
export function remoteProjectOwner(): ProjectPersonalOwner | undefined {
    if (!remotePersonalResourcesActive()) return undefined;
    assertPersonalResourceMountsSync("Project owner");
    if (!owner) throw new Error("Managed remote Project identity requires explicit laptop owner context");
    return owner;
}

/** A remote runtime must not create managed Session files without a laptop-native writer guard. */
export function requireLocalSessionWriter(): void {
    if (remotePersonalResourcesActive())
        throw new Error("Remote managed Session writes require a laptop-native writer guard");
}
