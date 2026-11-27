import { createHash } from "node:crypto";
import type { ProjectStoreIdentity } from "@runwield/projects";
import { plans, type PlanId } from "./index.ts";
import { decodePackageMarkdown } from "./format.ts";
import { mkdir, readFile, rename, rm, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { assertContainedPath, recoverWindowsRename } from "@runwield/resources/fs";
import {
    EPIC_ARTIFACT_FILE_NAMES,
    EPIC_MANUAL_QA_FILE_NAME,
    planArtifactReference,
    isEpicArtifactName,
    splitPlanName,
    type EpicArtifactName,
} from "./format/artifacts.ts";
import { PLANS_DIR_NAME } from "./classification.ts";

import {
    packageDocumentContent,
    packageWorkflowRevision,
    planPackageFamilyIds,
    readPlanPackage,
    savePlanPackageDocument,
    withPlanPackageLocks,
    type LoadedPlanPackage,
} from "./package-storage.ts";
import { PlanNotFoundError, StalePlanWriteError } from "./store-errors.ts";
import type { ProjectPlanArtifact, ProjectPlanArtifacts } from "./store.ts";
import { hasManualQaSection } from "./manual-qa.ts";

export { hasManualQaSection, prepareManualQaSection } from "./manual-qa.ts";

export type MoveEpicArtifactResult = {
    fileName: string;
    fromPath: string;
    toPath: string;
    relativePath: string;
};

/** Resolve the original checkout layout used by retained executions and archives. */
export function checkoutEpicArtifactPath(root: string, epicName: string, name: string, archived = false): string {
    const segments = splitPlanName(epicName);
    if (segments.length !== 1) throw new Error(`Epic Plan name must be top-level: ${epicName}`);
    if (segments[0] === "." || segments[0] === ".." || segments[0].includes("\\"))
        throw new Error(`Epic Plan name contains an unsafe path segment: ${epicName}`);
    if (!isEpicArtifactName(name)) throw new Error(`Unknown Epic Artifact: ${name}`);
    const docs = join(root, PLANS_DIR_NAME);
    return join(archived ? join(docs, "archived") : docs, segments[0], name);
}

async function readTextIfExists(path: string): Promise<string | null> {
    try {
        return await readFile(path, "utf8");
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
    }
}

export async function readCheckoutEpicArtifact(
    root: string,
    epicName: string,
    name: EpicArtifactName,
    archived = false,
) {
    const base = await realpath(root);
    const path = checkoutEpicArtifactPath(base, epicName, name, archived);
    try {
        const file = await realpath(path);
        const within = relative(base, file);
        if (!within || within === ".." || within.startsWith(`..${sep}`) || resolve(base, within) !== file)
            throw new Error("Epic artifact must remain inside its admitted Project.");
        return await readTextIfExists(file);
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
    }
}

export async function writeCheckoutEpicArtifact(
    root: string,
    epicName: string,
    name: EpicArtifactName,
    body: string,
): Promise<void> {
    const base = await realpath(root);
    const path = checkoutEpicArtifactPath(base, epicName, name);
    await assertContainedPath(base, path);
    const tmp = `${path}.${crypto.randomUUID()}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmp, body);
    try {
        await rename(tmp, path);
    } catch (error) {
        if (!(error instanceof Error && recoverWindowsRename(error, tmp, path))) {
            await rm(tmp, { force: true }).catch(() => {});
            throw error;
        }
    }
}

function checkoutArtifactRevision(planRevision: string, body: string | null): string {
    return body === null
        ? planRevision
        : createHash("sha256")
              .update(JSON.stringify([planRevision, body]))
              .digest("hex");
}

export async function readVersionedCheckoutEpicArtifact(
    root: string,
    epicName: string,
    name: EpicArtifactName,
    planRevision: string,
) {
    const body = await readCheckoutEpicArtifact(root, epicName, name);
    return body === null ? null : { body, revision: checkoutArtifactRevision(planRevision, body) };
}

/** Called after the retained checkout reloads its Epic under the Plan lock. */
export async function saveVersionedCheckoutEpicArtifact(
    root: string,
    epicName: string,
    name: EpicArtifactName,
    planRevision: string,
    body: string,
    expectedRevision?: string,
) {
    if (expectedRevision !== undefined) {
        const existing = await readVersionedCheckoutEpicArtifact(root, epicName, name, planRevision);
        const revision = existing?.revision ?? planRevision;
        if (expectedRevision !== revision) throw new StalePlanWriteError(expectedRevision, revision);
    }
    const markdown = decodePackageMarkdown(new TextEncoder().encode(body));
    await writeCheckoutEpicArtifact(root, epicName, name, markdown);
    return { body: markdown, revision: checkoutArtifactRevision(planRevision, markdown) };
}

export async function moveCheckoutEpicArtifacts(
    root: string,
    epicName: string,
    archive: boolean,
): Promise<MoveEpicArtifactResult[]> {
    const base = await realpath(root);
    const moved: MoveEpicArtifactResult[] = [];
    try {
        for (const name of EPIC_ARTIFACT_FILE_NAMES) {
            const fromPath = checkoutEpicArtifactPath(base, epicName, name, !archive);
            await assertContainedPath(base, fromPath);
            if ((await readTextIfExists(fromPath)) === null) continue;
            const toPath = checkoutEpicArtifactPath(base, epicName, name, archive);
            await assertContainedPath(base, toPath);
            const relativePath = relative(base, toPath).replaceAll("\\", "/");
            if ((await readTextIfExists(toPath)) !== null)
                throw new Error(`Epic Artifact already exists: ${relativePath}`);
            await mkdir(dirname(toPath), { recursive: true });
            await rename(fromPath, toPath);
            moved.push({ fileName: name, fromPath, toPath, relativePath });
        }
        return moved;
    } catch (error) {
        for (const item of moved.toReversed()) await rename(item.toPath, item.fromPath).catch(() => {});
        throw error;
    }
}

export function epicArtifactDocument(
    planId: PlanId,
    name: EpicArtifactName,
    content: Pick<ProjectPlanArtifact, "body" | "revision">,
): ProjectPlanArtifact {
    return {
        planId,
        name,
        relativePath: planArtifactReference(planId, name),
        body: content.body,
        revision: content.revision,
    };
}

export async function readActiveArtifactPackage(identity: ProjectStoreIdentity, planId: PlanId) {
    if (!plans.identity.isValid(planId)) throw new Error("Plan artifact access requires a durable Plan ID.");
    const plan = await readPlanPackage(identity, { planId });
    if (plan.kind !== "loaded") throw new Error(plan.message);
    if (plan.metadata.archive && !plan.metadata.archive.restoredAt) throw new PlanNotFoundError(planId);
    return plan;
}

function assertEpic(plan: LoadedPlanPackage): void {
    if (plan.metadata.definition.classification !== "PROJECT")
        throw new Error(`${plan.metadata.name} is not an Epic Plan.`);
}

export function assertEpicPackageFamily(epic: LoadedPlanPackage, child: LoadedPlanPackage): void {
    assertEpic(epic);
    if (child.metadata.parentPlanId !== epic.metadata.planId) {
        throw new Error(`Child Plan ${child.metadata.name} is not linked to Epic ${epic.metadata.name}.`);
    }
}

/** The canonical filesystem operations used by the Project-bound artifact collection. */
export function packageArtifactFiles(
    identity: ProjectStoreIdentity,
): Pick<ProjectPlanArtifacts, "read" | "save" | "findManualQaSection"> {
    return {
        async read(planId, name) {
            const plan = await readActiveArtifactPackage(identity, planId);
            assertEpic(plan);
            const content = packageDocumentContent(plan, name);
            return content ? epicArtifactDocument(planId, name, content) : null;
        },
        async save(planId, name, body, expectedRevision) {
            const observed = await readActiveArtifactPackage(identity, planId);
            assertEpic(observed);
            const ids = await planPackageFamilyIds(identity, [observed]);
            return await withPlanPackageLocks(identity, ids, async () => {
                const current = await readActiveArtifactPackage(identity, planId);
                assertEpic(current);
                const revision = packageWorkflowRevision(current);
                if (expectedRevision !== undefined && expectedRevision !== revision)
                    throw new StalePlanWriteError(expectedRevision, revision);
                const document = current.documents.find((entry) => entry.name === name);
                const saved = await savePlanPackageDocument(identity, planId, name, document?.hash ?? null, body);
                return epicArtifactDocument(planId, name, saved);
            });
        },
        async findManualQaSection(epicId, childId) {
            const [epic, child] = await Promise.all([
                readActiveArtifactPackage(identity, epicId),
                readActiveArtifactPackage(identity, childId),
            ]);
            assertEpicPackageFamily(epic, child);
            const existing = packageDocumentContent(epic, EPIC_MANUAL_QA_FILE_NAME);
            return {
                exists: hasManualQaSection(existing?.body ?? null, childId),
                relativePath: planArtifactReference(epicId, EPIC_MANUAL_QA_FILE_NAME),
            };
        },
    };
}
