import type { ProjectStoreIdentity } from "@runwield/projects";
import {
    assertContainedPath,
    syncParentDirectory,
    writeJsonAtomically,
    writeTextAtomically,
} from "@runwield/resources/fs";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { join } from "node:path";
import { readRetainedPlanInput, type PackageInputReference } from "./file-snapshots.ts";
import { isPlanMilestoneVersion, type PlanMilestone, type PlanMilestoneEvent } from "./history.ts";
import { isPlanId } from "./identity.ts";
import {
    packageDocumentText,
    packageResourceRoles,
    packageResources,
    PlanPackageError,
    rethrowPackagePathError,
    type PackageDocument,
    type PackageDocuments,
} from "./package-data.ts";
import {
    ensurePackageDirectory,
    localPackageLayout,
    normalizePackageName,
    packageFileDigest,
    readPackageDocuments,
    statPackagePath,
} from "./package-files.ts";

interface MilestoneSelection {
    planId: string;
    history?: readonly PlanMilestone[];
}

interface MilestoneMetadata extends MilestoneSelection {
    name: string;
}

interface MilestoneSource {
    metadata: MilestoneMetadata;
    documents: readonly PackageDocument[];
}

function milestoneDigest(documents: readonly PackageDocument[]): string {
    return createHash("sha256")
        .update(JSON.stringify(documents.map(({ name, hash }) => [name, hash])))
        .digest("hex");
}

function historyDirectory(root: string, planId: string): string {
    if (!isPlanId(planId)) throw new PlanPackageError("malformed_metadata", "Invalid Plan ID.");
    const portable = /^[a-z0-9_-]{1,128}$/.test(planId) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(planId);
    const segment = portable ? planId : "~" + createHash("sha256").update(planId).digest("hex");
    return join(root, "history", segment);
}

function milestonePath(directory: string, version: string): string {
    if (!isPlanMilestoneVersion(version)) throw new PlanPackageError("unsafe_path", "Invalid Plan history version.");
    return join(directory, version);
}

function forOwner(owner: ProjectStoreIdentity) {
    const identity = structuredClone(owner);

    return {
        /** The catalog writer holds its locks and publishes these references with the Plan metadata. */
        async capture(
            source: MilestoneSource,
            event: PlanMilestoneEvent,
            input?: PackageInputReference,
        ): Promise<PlanMilestone[]> {
            const { home, plans, root, stages } = localPackageLayout(identity);
            const { history, ...metadata } = source.metadata;
            const directory = historyDirectory(root, metadata.planId);
            if (input && input.planId !== metadata.planId)
                throw new PlanPackageError("malformed_metadata", "Milestone input belongs to another Plan.");
            const candidates = input ? (await readRetainedPlanInput(identity, input)).documents : source.documents;
            if (
                candidates.some(
                    ({ name, role }) => !packageResources.includes(name) || packageResourceRoles[name] !== role,
                ) ||
                new Set(candidates.map(({ name }) => name)).size !== candidates.length ||
                candidates[0]?.name !== "context.md" ||
                candidates[1]?.name !== "validation.md"
            )
                throw new PlanPackageError("malformed_metadata", "Invalid Plan history capture documents.");
            const documents = candidates.map(({ name, role, bytes }) => {
                const frozen = new Uint8Array(bytes);
                return { name, role, bytes: frozen, hash: packageFileDigest(frozen) };
            });
            const digest = milestoneDigest(documents);
            const version = randomUUID();
            const destination = milestonePath(directory, version);
            const stage = join(stages, version);
            await ensurePackageDirectory(home, stage);
            for (const { name, bytes } of documents) writeTextAtomically(join(stage, name), bytes);
            writeJsonAtomically(join(stage, "plan.wld.json"), metadata);
            if (!input) {
                const livePath = join(plans, normalizePackageName(metadata.name));
                if (milestoneDigest(await readPackageDocuments(home, livePath)) !== digest)
                    throw new PlanPackageError("changed_input", "Plan documents changed during milestone capture.");
            }
            await ensurePackageDirectory(home, directory);
            await assertContainedPath(home, destination).catch(rethrowPackagePathError);
            if (await statPackagePath(destination))
                throw new PlanPackageError("collision", "Plan history version is already in use.");
            await fs.rename(stage, destination);
            syncParentDirectory(stage);
            syncParentDirectory(destination);
            return [...(history ?? []), { version, ...event, digest }];
        },

        async read(selection: MilestoneSelection, version: string): Promise<PackageDocuments> {
            const entry = selection.history?.find((item) => item.version === version);
            if (!entry) throw new PlanPackageError("missing", "Plan history version is unavailable.");
            const { home, root } = localPackageLayout(identity);
            const directory = historyDirectory(root, selection.planId);
            const documents = await readPackageDocuments(home, milestonePath(directory, entry.version));
            if (milestoneDigest(documents) !== entry.digest)
                throw new PlanPackageError("changed_input", "Frozen milestone documents changed.");
            return packageDocumentText(documents);
        },

        /** Called while replaying committed catalog pruning. Only the approved versions are removed. */
        async prune(planId: string, versions: readonly string[]): Promise<void> {
            const { home, root } = localPackageLayout(identity);
            const directory = historyDirectory(root, planId);
            for (const path of versions.map((version) => milestonePath(directory, version))) {
                await assertContainedPath(home, path).catch(rethrowPackagePathError);
                await fs.rm(path, { recursive: true, force: true });
            }
            await assertContainedPath(home, directory).catch(rethrowPackagePathError);
            await fs.rmdir(directory).catch((error: NodeJS.ErrnoException) => {
                if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code || "")) throw error;
            });
        },
    };
}

export const planHistoryFiles = { forOwner };
