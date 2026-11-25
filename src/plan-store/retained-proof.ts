import type { PackagePublicationReference } from "@runwield/plans/publication-copies";
/** Durable laptop receipt for independently rechecked execution-host Git evidence. */
import { projects, type HomeProjectOwner } from "@runwield/projects";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { assertManagedRuntimePath } from "../shared/project-runtime-managed.ts";
import { ensurePrivateDir, writeJsonAtomically } from "../shared/private-json-file.ts";
import {
    proveManagedProjectPublication,
    type ManagedProjectStoreLaunch,
} from "../shared/remote/project-store-launch.ts";
import { readPlanPackagePublication } from "./packages.ts";
import type { PublicationAttempt } from "@runwield/workflow/publication";

export async function confirmManagedPublication(
    owner: HomeProjectOwner,
    launch: ManagedProjectStoreLaunch,
    reference: PackagePublicationReference,
    signal?: AbortSignal,
) {
    projects.home.assertStoreIdentity(owner);
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
