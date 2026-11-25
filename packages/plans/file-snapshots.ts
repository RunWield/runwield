import { projects, type ProjectStoreIdentity } from "@runwield/projects";
import {
    assertContainedPath,
    syncParentDirectory,
    writeJsonAtomically,
    writeTextAtomically,
} from "@runwield/resources/fs";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { join } from "node:path";
import { isPlanId } from "./identity.ts";
import {
    packageResourceRoles,
    packageResources,
    PlanPackageError,
    rethrowPackagePathError,
    type PackageDocument,
} from "./package-data.ts";
import {
    ensurePackageDirectory,
    localPackageLayout,
    packageFileDigest as digest,
    readPackageDocuments,
    readPackageFile,
    statPackagePath,
} from "./package-files.ts";

export {
    ensurePackageDirectory,
    localPackageLayout,
    normalizePackageName,
    packageFileDigest,
    readPackageDocuments,
    readPackageFile,
    statPackagePath,
} from "./package-files.ts";

export {
    packageDocumentText,
    packageResourceRoles,
    packageResources,
    PlanPackageError,
    rethrowPackagePathError,
    type PackageDocument,
    type PackageIssueKind,
    type PackageResource,
    type PackageResourceRole,
} from "./package-data.ts";

export interface PackageInputReference {
    projectId: string;
    planId: string;
    inputId: string;
}
type InputResource = Pick<PackageDocument, "name" | "role" | "hash">;
export interface PackageInputManifest extends PackageInputReference {
    version: 1;
    metadataRevision: number;
    documents: InputResource[];
}
export interface PackageInput {
    path: string;
    manifest: PackageInputManifest;
    documents: PackageDocument[];
}
interface RetainedPlanInputSource {
    planId: string;
    metadataRevision: number;
    documents: readonly PackageDocument[];
}
interface StagedPlanInput {
    commit(): Promise<PackageInputReference>;
    discard(): Promise<void>;
}

/** The caller holds the catalog lock and rechecks the source before committing this input. */
export async function stageRetainedPlanInput(
    identity: ProjectStoreIdentity,
    source: RetainedPlanInputSource,
    reviewedContext?: string,
): Promise<StagedPlanInput> {
    const { home, internal, stages } = localPackageLayout(identity);
    const inputId = randomUUID();
    const reference = { projectId: identity.projectId, planId: source.planId, inputId };
    const documents = packageResources.flatMap((name) => {
        const document = source.documents.find((candidate) => candidate.name === name);
        if (!document || document.role !== packageResourceRoles[name]) return [];
        const bytes =
            name === "context.md" && reviewedContext !== undefined
                ? new TextEncoder().encode(reviewedContext)
                : document.bytes;
        return [{ name, role: packageResourceRoles[name], hash: digest(bytes), bytes }];
    });
    if (
        !isPlanId(source.planId) ||
        !Number.isSafeInteger(source.metadataRevision) ||
        source.metadataRevision < 1 ||
        documents.length !== source.documents.length ||
        documents[0]?.name !== "context.md" ||
        documents[1]?.name !== "validation.md"
    )
        throw new PlanPackageError("malformed_metadata", "Invalid retained-input source.");
    const manifest: PackageInputManifest = {
        version: 1,
        ...reference,
        metadataRevision: source.metadataRevision,
        documents: documents.map(({ name, role, hash }) => ({ name, role, hash })),
    };
    const stage = join(stages, inputId);
    await ensurePackageDirectory(home, stage);
    for (const { name, bytes } of documents) writeTextAtomically(join(stage, name), bytes);
    writeJsonAtomically(join(stage, "input.wld.json"), manifest);

    return {
        async commit() {
            projects.launch.verifyAccountHome(identity);
            await assertContainedPath(home, stage).catch(rethrowPackagePathError);
            const inputs = join(internal, "inputs");
            await ensurePackageDirectory(home, inputs);
            const destination = join(inputs, inputId);
            await assertContainedPath(home, destination).catch(rethrowPackagePathError);
            if (await statPackagePath(destination))
                throw new PlanPackageError("collision", "Retained-input identity is already in use.");
            await fs.rename(stage, destination);
            syncParentDirectory(stage);
            syncParentDirectory(destination);
            return reference;
        },
        async discard() {
            projects.launch.verifyAccountHome(identity);
            await assertContainedPath(home, stage).catch(rethrowPackagePathError);
            await fs.rm(stage, { recursive: true });
        },
    };
}

export async function readRetainedPlanInput(
    identity: ProjectStoreIdentity,
    reference: PackageInputReference,
): Promise<PackageInput> {
    const { home, internal } = localPackageLayout(identity);
    if (
        reference.projectId !== identity.projectId ||
        !isPlanId(reference.planId) ||
        !/^[0-9a-f-]{36}$/.test(reference.inputId)
    )
        throw new PlanPackageError("unsafe_path", "Invalid retained-input reference.");
    const path = join(internal, "inputs", reference.inputId);
    const bytes = await readPackageFile(home, join(path, "input.wld.json"));
    if (!bytes) throw new PlanPackageError("missing", "Retained input is missing.");
    let manifest: PackageInputManifest;
    try {
        manifest = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        throw new PlanPackageError("malformed_metadata", "Malformed retained input.");
    }
    if (
        !manifest ||
        manifest.version !== 1 ||
        manifest.planId !== reference.planId ||
        manifest.inputId !== reference.inputId ||
        manifest.projectId !== reference.projectId ||
        !Number.isSafeInteger(manifest.metadataRevision) ||
        manifest.metadataRevision < 1 ||
        !Array.isArray(manifest.documents)
    )
        throw new PlanPackageError("malformed_metadata", "Invalid retained-input identity.");
    const documents = await readPackageDocuments(home, path);
    if (
        documents.length !== manifest.documents.length ||
        documents.some((doc, index) => {
            const entry = manifest.documents[index];
            return !entry || entry.name !== doc.name || entry.role !== doc.role || entry.hash !== doc.hash;
        })
    )
        throw new PlanPackageError(
            "malformed_metadata",
            "Retained-input bytes or membership do not match the committed manifest.",
        );
    return { path, manifest, documents };
}
