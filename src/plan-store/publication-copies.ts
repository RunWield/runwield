import type { PackagePublicationReference } from "@runwield/plans/publication-copies";
import {
    assertPackageCopyTargets,
    assertPackagePublicationCandidate,
    assertPackagePublicationOwner,
    freezePlanPublicationPolicy,
    materializePackageCopies,
    packageArtifactEvidence,
    packageTargetEvidence,
    preparePackageCopyRetirement,
    sealPackagePublication,
    uncommittedPackageCopyPaths,
} from "./publication.ts";
import {
    checkLocalPublicationMetadata,
    finalizePublicationLifecycle,
    hasFinalizedPublicationLifecycle,
    readPublishedWorkRecordIndex,
} from "./delivery-copies.ts";
import { preserveUnpublishedPlanCopies, restoreUnpublishedPlanCopies } from "./delivery-backup.ts";
import { readPublishedRecordMarkdown } from "./published-source.ts";
import { openPlanStoreForCheckout } from "./project-plans.ts";

/** The admitted Plan workflow supplies the local or managed attempt authority. */
export const selectedPublicationCopies = {
    freezePolicy: freezePlanPublicationPolicy,
    seal: sealPackagePublication,
    assertOwner: assertPackagePublicationOwner,
} as const;

export function publicationCopiesForCheckout(root: string) {
    return {
        read: async (reference: PackagePublicationReference) => {
            const store = openPlanStoreForCheckout(root);
            if (!store) throw new Error("Publication owner is unavailable.");
            return await store.publicationCopies.read(reference);
        },
        readPublishedWorkRecord: readPublishedRecordMarkdown.bind(undefined, root),
        materialize: materializePackageCopies.bind(undefined, root),
        prepareRetirement: preparePackageCopyRetirement.bind(undefined, root),
        verifyCandidate: packageArtifactEvidence.bind(undefined, root),
        verifyTarget: packageTargetEvidence.bind(undefined, root),
        assertTargetDestinations: assertPackageCopyTargets.bind(undefined, root),
        assertIntegratedCandidate: assertPackagePublicationCandidate.bind(undefined, root),
        uncommittedPaths: uncommittedPackageCopyPaths.bind(undefined, root),
    };
}

/** Older attempts retain their documents in Git instead of an owner publication snapshot. */
export function retainedPublicationCopiesForCheckout(root: string) {
    return {
        finalize: finalizePublicationLifecycle.bind(undefined, root),
        isFinalized: hasFinalizedPublicationLifecycle.bind(undefined, root),
        checkMetadata: checkLocalPublicationMetadata.bind(undefined, root),
        readWorkRecordIndex: readPublishedWorkRecordIndex.bind(undefined, root),
        preserve: preserveUnpublishedPlanCopies.bind(undefined, root),
        restore: restoreUnpublishedPlanCopies.bind(undefined, root),
    };
}
