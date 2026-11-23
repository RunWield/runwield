import { remotePersonalResourcesActive } from "@runwield/resources/personal";

export {
    assertPersonalResourcePath,
    assertPersonalResourcePathSync,
    configureRemotePersonalResources,
    personalAgentsRoot,
    personalGlobalRoot,
    personalPackageRoots,
    PersonalResourcePathError,
    remotePersonalResourcesActive,
    remoteProjectOwner,
    type RemotePersonalResources,
} from "@runwield/resources/personal";

/** A remote runtime must not create managed Session files without a laptop-native writer guard. */
export function requireLocalSessionWriter(): void {
    if (remotePersonalResourcesActive())
        throw new Error("Remote managed Session writes require a laptop-native writer guard");
}
