import { projects, type ProjectStoreIdentity } from "@runwield/projects";
import {
    assertContainedPath,
    ensurePrivateDir,
    syncParentDirectory,
    writeJsonAtomically,
    writeTextAtomically,
} from "@runwield/resources/fs";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { isPlanId } from "./identity.ts";
import {
    packageResourceRoles,
    packageResources,
    PlanPackageError,
    rethrowPackagePathError,
    type PackageDocument,
} from "./package-data.ts";

export {
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

function snapshotRoot(identity: ProjectStoreIdentity): string {
    if (identity.personalOwner.kind !== "execution-account")
        throw new PlanPackageError("unavailable", "Managed-remote packages require their personal-store transport.");
    projects.home.assertStoreIdentity(identity);
    return join(identity.executionAccountHome, ".wld", "projects", identity.projectId, "internal", "plan-packages");
}

async function stat(path: string) {
    try {
        return await fs.lstat(path);
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
    }
}

async function readResource(home: string, path: string): Promise<Uint8Array | null> {
    await assertContainedPath(home, path).catch(rethrowPackagePathError);
    const info = await stat(path);
    if (!info) return null;
    if (!info.isFile()) throw new PlanPackageError("unsafe_path", `Package resource is not a regular file: ${path}`);
    return await fs.readFile(path);
}

async function makeDirectory(home: string, path: string): Promise<void> {
    await assertContainedPath(home, path).catch(rethrowPackagePathError);
    const created: string[] = [];
    for (let cursor = path; cursor !== home && dirname(cursor) !== cursor; cursor = dirname(cursor)) {
        if (!(await stat(cursor))) created.push(cursor);
    }
    ensurePrivateDir(path);
    for (const entry of created) syncParentDirectory(entry);
}

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The caller holds the catalog lock and rechecks the source before committing this input. */
export async function stageRetainedPlanInput(
    identity: ProjectStoreIdentity,
    source: RetainedPlanInputSource,
    reviewedContext?: string,
): Promise<StagedPlanInput> {
    const internal = snapshotRoot(identity);
    const home = identity.executionAccountHome;
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
    const stage = join(internal, "staging", inputId);
    await makeDirectory(home, stage);
    for (const { name, bytes } of documents) writeTextAtomically(join(stage, name), bytes);
    writeJsonAtomically(join(stage, "input.wld.json"), manifest);

    return {
        async commit() {
            projects.launch.verifyAccountHome(identity);
            await assertContainedPath(home, stage).catch(rethrowPackagePathError);
            const inputs = join(internal, "inputs");
            await makeDirectory(home, inputs);
            const destination = join(inputs, inputId);
            await assertContainedPath(home, destination).catch(rethrowPackagePathError);
            if (await stat(destination))
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
    const internal = snapshotRoot(identity);
    const home = identity.executionAccountHome;
    if (
        reference.projectId !== identity.projectId ||
        !isPlanId(reference.planId) ||
        !/^[0-9a-f-]{36}$/.test(reference.inputId)
    )
        throw new PlanPackageError("unsafe_path", "Invalid retained-input reference.");
    const path = join(internal, "inputs", reference.inputId);
    const bytes = await readResource(home, join(path, "input.wld.json"));
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
    const documents: PackageDocument[] = [];
    for (const name of packageResources) {
        const content = await readResource(home, join(path, name));
        if (!content) {
            if (name === "context.md" || name === "validation.md")
                throw new PlanPackageError("missing_document", `Missing required document: ${name}`);
        } else documents.push({ name, role: packageResourceRoles[name], bytes: content, hash: digest(content) });
    }
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
