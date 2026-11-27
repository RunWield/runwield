import { PlanNotFoundError } from "@runwield/plans/store";
import { join, dirname, relative } from "node:path";
import { inspectLocalHomeStore, withLocalPlanWorkflow } from "./access.ts";
import { plans, type PlanId } from "@runwield/plans";
import {
    EPIC_MANUAL_QA_FILE_NAME,
    EPIC_INTEGRATION_REPORT_FILE_NAME,
    planArtifactReference,
    isEpicArtifactName,
    splitPlanName,
    type EpicArtifactName,
} from "@runwield/plans/format";
import {
    checkoutEpicArtifactPath,
    epicArtifactDocument,
    hasManualQaSection,
    packageArtifactFiles,
    readActiveArtifactPackage,
    prepareManualQaSection,
    readVersionedCheckoutEpicArtifact,
    saveVersionedCheckoutEpicArtifact,
    writeCheckoutEpicArtifact,
} from "@runwield/plans/artifact-files";
import type { ManualQaSection, ProjectPlanArtifacts } from "@runwield/plans/store";
import {
    appendManagedEpicQa,
    managedPlanStoreActive,
    readManagedActivePlanById,
    readManagedDocument,
    saveManagedEpicArtifact,
} from "./managed.ts";
import { currentPackageProject, currentPackageSelection, appendGeneratedManualQaSection } from "./workflows.ts";
import { packageWorkflowRevision } from "@runwield/plans/package-storage";
import { findPlanById, loadPlan } from "./queries.ts";
import { withPlanLock } from "../plan-store.ts";
import { withOrderedTransitionResources } from "./transitions.ts";
import type { bindProjectPlanStore } from "./project-binding.ts";

function requireArtifactName(name: string): EpicArtifactName {
    if (!isEpicArtifactName(name)) throw new Error(`Unknown Epic Artifact: ${name}`);
    return name;
}

function relativeArtifactPath(cwd: string, path: string): string {
    return relative(cwd, path).replaceAll("\\", "/");
}

type ArtifactPlan = Awaited<ReturnType<typeof findPlanById>>;
type ArtifactPlanIdentity = {
    attrs: Pick<ArtifactPlan["attrs"], "classification" | "planId" | "parentPlan">;
    path: string;
    revision: string;
    name: string;
};

function requirePlanId(plan: ArtifactPlanIdentity): PlanId {
    const planId = plan.attrs.planId;
    if (!plans.identity.isValid(planId)) throw new Error("Plan artifact access requires a durable Plan ID.");
    return planId;
}

function assertEpic(plan: ArtifactPlanIdentity): void {
    if (plan.attrs.classification !== "PROJECT") throw new Error(`${plan.name} is not an Epic Plan.`);
}

async function planById(cwd: string, planId: PlanId): Promise<ArtifactPlanIdentity> {
    if (!plans.identity.isValid(planId)) throw new Error("Plan artifact access requires a durable Plan ID.");
    const identity = currentPackageProject();
    if (identity) {
        const selected = await readActiveArtifactPackage(identity, planId);
        return {
            attrs: { classification: selected.metadata.definition.classification, planId },
            path: join(selected.path, "context.md"),
            revision: packageWorkflowRevision(selected),
            name: selected.metadata.name,
        };
    }
    const plan = managedPlanStoreActive()
        ? await readManagedActivePlanById(cwd, planId)
        : await findPlanById(cwd, planId);
    if (!plan || plan.planId !== planId) throw new PlanNotFoundError(planId);
    return plan;
}

interface ArtifactRead {
    body: string;
    revision: string;
}

async function readArtifact(
    cwd: string,
    plan: ArtifactPlanIdentity,
    name: EpicArtifactName,
): Promise<ArtifactRead | null> {
    if (managedPlanStoreActive()) {
        const context = await readManagedDocument(requirePlanId(plan), "context.md", cwd, "read");
        if (!context.documents.some((document) => document.name === name)) return null;
        const document = await readManagedDocument(requirePlanId(plan), name, cwd, "read");
        return { body: document.body, revision: document.revision };
    }
    return await readVersionedCheckoutEpicArtifact(cwd, plan.name, name, plan.revision);
}

async function saveArtifact(
    cwd: string,
    plan: ArtifactPlanIdentity,
    name: EpicArtifactName,
    body: string,
    expectedRevision?: string,
) {
    assertEpic(plan);
    if (managedPlanStoreActive()) {
        return await saveManagedEpicArtifact(cwd, requirePlanId(plan), name, body, plan.revision, expectedRevision);
    }
    return await withPlanLock(cwd, plan.name, async () => {
        const current = await loadPlan(cwd, plan.name);
        if (!current || current.attrs.planId !== plan.attrs.planId) throw new PlanNotFoundError(plan.name);
        assertEpic({ ...current, name: plan.name });
        return await saveVersionedCheckoutEpicArtifact(cwd, plan.name, name, current.revision, body, expectedRevision);
    });
}

function assertEpicFamily(parent: ArtifactPlanIdentity, child: ArtifactPlanIdentity): void {
    assertEpic(parent);
    if (child.attrs.parentPlan === parent.name) {
        const parentSegments = splitPlanName(parent.name);
        const childSegments = splitPlanName(child.name);
        if (
            managedPlanStoreActive() ||
            (parentSegments.length === 1 && childSegments.length === 2 && childSegments[0] === parentSegments[0])
        )
            return;
    }
    throw new Error(`Child Plan ${child.name} is not linked to Epic ${parent.name}.`);
}

function qaMarkerIdentity(child: ArtifactPlanIdentity): string {
    return managedPlanStoreActive() ? requirePlanId(child) : child.name;
}

async function findQa(cwd: string, epic: ArtifactPlanIdentity, child: ArtifactPlanIdentity): Promise<boolean> {
    assertEpicFamily(epic, child);
    const existing = await readArtifact(cwd, epic, EPIC_MANUAL_QA_FILE_NAME);
    return hasManualQaSection(existing?.body ?? null, qaMarkerIdentity(child));
}

async function appendQa(
    cwd: string,
    epic: ArtifactPlanIdentity,
    child: ArtifactPlanIdentity,
    section: ManualQaSection,
): Promise<"recorded" | "already_present"> {
    if (managedPlanStoreActive()) {
        assertEpicFamily(epic, child);
        return await appendManagedEpicQa(cwd, requirePlanId(epic), requirePlanId(child), section);
    }
    if (currentPackageProject())
        return await appendGeneratedManualQaSection(requirePlanId(epic), requirePlanId(child), section);

    const write = async (epic: ArtifactPlanIdentity, child: ArtifactPlanIdentity) => {
        assertEpicFamily(epic, child);
        const existing = await readArtifact(cwd, epic, EPIC_MANUAL_QA_FILE_NAME);
        const body = prepareManualQaSection(existing?.body ?? null, epic.name, child.name, child.name, section);
        if (body === null) return "already_present" as const;
        await writeCheckoutEpicArtifact(cwd, epic.name, EPIC_MANUAL_QA_FILE_NAME, body);
        return "recorded" as const;
    };

    async function reload(observed: ArtifactPlanIdentity): Promise<ArtifactPlanIdentity> {
        const current = await loadPlan(cwd, observed.name);
        if (
            !current ||
            current.attrs.planId !== observed.attrs.planId ||
            (!observed.attrs.planId && current.revision !== observed.revision)
        )
            throw new Error(`Plan ${observed.name} changed before QA preparation.`);
        return { ...current, name: observed.name };
    }
    return await withOrderedTransitionResources(
        cwd,
        [
            { kind: "plan", id: epic.name },
            { kind: "plan", id: child.name },
        ],
        async () => write(await reload(epic), await reload(child)),
    );
}

function localPackageOwner() {
    return managedPlanStoreActive() ? undefined : currentPackageProject();
}

export function projectPlanArtifacts(run: ReturnType<typeof bindProjectPlanStore>): ProjectPlanArtifacts {
    return {
        read: (planId, requested) =>
            run(async (cwd) => {
                const name = requireArtifactName(requested);
                const owner = localPackageOwner();
                if (owner) return await packageArtifactFiles(owner).read(planId, name);
                const plan = await planById(cwd, planId);
                assertEpic(plan);
                const content = await readArtifact(cwd, plan, name);
                return content ? epicArtifactDocument(planId, name, content) : null;
            }, "retained"),
        save: (planId, requested, body, expectedRevision) =>
            run(async (cwd) => {
                const name = requireArtifactName(requested);
                const owner = localPackageOwner();
                if (owner) return await packageArtifactFiles(owner).save(planId, name, body, expectedRevision);
                const content = await saveArtifact(cwd, await planById(cwd, planId), name, body, expectedRevision);
                return epicArtifactDocument(planId, name, content);
            }, "retained"),
        findManualQaSection: (epicId, childId) =>
            run(async (cwd) => {
                const owner = localPackageOwner();
                if (owner) return await packageArtifactFiles(owner).findManualQaSection(epicId, childId);
                const [epic, child] = await Promise.all([planById(cwd, epicId), planById(cwd, childId)]);
                return {
                    exists: await findQa(cwd, epic, child),
                    relativePath: planArtifactReference(epicId, EPIC_MANUAL_QA_FILE_NAME),
                };
            }, "retained"),
        appendManualQaSection: (epicId, childId, section) =>
            run(async (cwd) => {
                const [epic, child] = await Promise.all([planById(cwd, epicId), planById(cwd, childId)]);
                const append = () => appendQa(cwd, epic, child, section);
                const status =
                    currentPackageProject() && !currentPackageSelection()
                        ? await withLocalPlanWorkflow(cwd, child.name, append, childId)
                        : await append();
                return { status, relativePath: planArtifactReference(epicId, EPIC_MANUAL_QA_FILE_NAME) };
            }, "retained"),
    };
}

/** Workflow names and display paths survive for retained checkout attempts and existing metadata. */
export async function workflowEpicArtifacts(cwd: string, epicName: string) {
    const owner = inspectLocalHomeStore(cwd);
    const canonical = managedPlanStoreActive() || owner.kind === "local";
    if (!canonical && owner.kind !== "retained-checkout") throw new Error("Epic artifacts require the admitted Plan.");
    const epic = await loadPlan(cwd, epicName);
    if (!epic) throw new PlanNotFoundError(epicName);
    const { openPlanStoreForCheckout } = await import("./project-plans.ts");
    const epicId = plans.identity.parse(epic.attrs.planId);
    const store = canonical ? openPlanStoreForCheckout(cwd) : undefined;
    if (canonical && (!store || !epicId)) throw new Error("Epic artifacts require the admitted Plan.");
    const plan = { ...epic, name: epicName };
    const qaPath = relativeArtifactPath(
        cwd,
        canonical
            ? join(dirname(plan.path), EPIC_MANUAL_QA_FILE_NAME)
            : checkoutEpicArtifactPath(cwd, epicName, EPIC_MANUAL_QA_FILE_NAME),
    );
    async function childPlan(name: string): Promise<ArtifactPlanIdentity> {
        const child = await loadPlan(cwd, name);
        if (!child) throw new PlanNotFoundError(name);
        return { ...child, name };
    }
    return {
        integrationReportPath: canonical
            ? join(dirname(plan.path), EPIC_INTEGRATION_REPORT_FILE_NAME)
            : relativeArtifactPath(cwd, checkoutEpicArtifactPath(cwd, epicName, EPIC_INTEGRATION_REPORT_FILE_NAME)),
        async saveIntegrationReport(body: string) {
            if (store && epicId) await store.artifacts.save(epicId, EPIC_INTEGRATION_REPORT_FILE_NAME, body);
            else await saveArtifact(cwd, plan, EPIC_INTEGRATION_REPORT_FILE_NAME, body);
        },
        async findManualQaSection(name: string) {
            const child = await childPlan(name);
            const exists =
                store && epicId
                    ? (await store.artifacts.findManualQaSection(epicId, requirePlanId(child))).exists
                    : await findQa(cwd, plan, child);
            return { exists, relativePath: qaPath };
        },
        async appendManualQaSection(name: string, section: ManualQaSection) {
            const child = await childPlan(name);
            const status =
                store && epicId
                    ? (await store.artifacts.appendManualQaSection(epicId, requirePlanId(child), section)).status
                    : await appendQa(cwd, plan, child, section);
            return { status, relativePath: qaPath };
        },
    };
}
