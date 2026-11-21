/** Durable laptop receipt for independently rechecked execution-host Git evidence. */
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { assertProjectStoreIdentity, type HomeProjectOwner } from "../shared/project-identity.ts";
import { assertManagedRuntimePath } from "../shared/project-runtime-managed.ts";
import { ensurePrivateDir, writeJsonAtomically } from "../shared/private-json-file.ts";
import {
    proveManagedProjectPublication,
    type ManagedProjectStoreLaunch,
} from "../shared/remote/project-store-launch.ts";
import { readPlanPackagePublication, type PackagePublicationReference } from "./packages.ts";
import type { PublicationAttempt } from "../shared/workflow/publication-attempt.ts";

export async function confirmManagedPublication(
    owner: HomeProjectOwner,
    launch: ManagedProjectStoreLaunch,
    reference: PackagePublicationReference,
    signal?: AbortSignal,
) {
    assertProjectStoreIdentity(owner);
    const manifest = await readPlanPackagePublication(owner, reference);
    const directory = join(
        owner.executionAccountHome,
        ".wld",
        "projects",
        owner.projectId,
        "internal",
        "plan-packages",
        "confirmed-publications",
    );
    const path = join(directory, `${reference.digest}.json`);
    await assertManagedRuntimePath(path, owner.executionAccountHome);
    ensurePrivateDir(directory);
    let retained: PublicationAttempt | undefined;
    try {
        retained = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const proof = await proveManagedProjectPublication(launch, manifest, retained, signal);
    writeJsonAtomically(path, { ...proof, phase: "publication_verified" });
    return { proof, manifest };
}
