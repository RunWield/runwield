import { packageDocumentContent } from "./documents.ts";
import { join, dirname, relative } from "node:path";
import { createHash } from "node:crypto";
import { inspectLocalHomeStore, withLocalPlanWorkflow } from "./access.ts";
import { plans, type PlanId } from "@runwield/plans";
import {
    EPIC_MANUAL_QA_FILE_NAME,
    EPIC_INTEGRATION_REPORT_FILE_NAME,
    decodePackageMarkdown,
    planArtifactReference,
    isEpicArtifactName,
    splitPlanName,
    type EpicArtifactName,
} from "@runwield/plans/format";
import {
    checkoutEpicArtifactPath,
    hasManualQaSection,
    prepareManualQaSection,
    readCheckoutEpicArtifact,
    writeCheckoutEpicArtifact,
} from "@runwield/plans/artifact-files";
import type { ManualQaSection, ProjectPlanArtifact, ProjectPlanArtifacts } from "@runwield/plans/store";
import {
    appendManagedEpicQa,
    managedPlanStoreActive,
    readManagedActivePlanById,
    readManagedDocument,
    saveManagedEpicArtifact,
} from "./managed.ts";
import {
    currentPackageProject,
    currentPackageSelection,
    packageWorkflowLocks,
    packageWorkflowRevision,
    selectedPackage,
    saveGeneratedManualQaArtifact,
} from "./workflows.ts";
import { savePlanPackageDocument } from "./packages.ts";
import { findPlanById, loadPlan } from "./queries.ts";
import { PlanNotFoundError, StalePlanWriteError, withPlanLock } from "../plan-store.ts";
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

function checkoutArtifactRevision(planRevision: string, body: string | null): string {
    return body === null
        ? planRevision
        : createHash("sha256")
              .update(JSON.stringify([planRevision, body]))
              .digest("hex");
}

async function planById(cwd: string, planId: PlanId): Promise<ArtifactPlanIdentity> {
    if (!plans.identity.isValid(planId)) throw new Error("Plan artifact access requires a durable Plan ID.");
    if (currentPackageProject()) {
        const selected = await selectedPackage({ planId });
        if (selected.metadata.archive && !selected.metadata.archive.restoredAt) throw new PlanNotFoundError(planId);
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
    packageHash?: string;
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
    if (currentPackageProject()) {
        const selected = await selectedPackage({ planId: requirePlanId(plan) });
        return packageDocumentContent(selected, name);
    }
    const body = await readCheckoutEpicArtifact(cwd, plan.name, name);
    return body === null ? null : { body, revision: checkoutArtifactRevision(plan.revision, body) };
}

function ensureExpectedRevision(expected: string | undefined, actual: string) {
    if (expected !== undefined && expected !== actual) throw new StalePlanWriteError(expected, actual);
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
    const identity = currentPackageProject();
    if (identity) {
        const target = { planId: requirePlanId(plan) };
        return await packageWorkflowLocks([target], async () => {
            const current = await selectedPackage(target);
            if (current.metadata.archive && !current.metadata.archive.restoredAt)
                throw new PlanNotFoundError(target.planId);
            if (current.metadata.definition.classification !== "PROJECT")
                throw new Error(`${current.metadata.name} is not an Epic Plan.`);
            ensureExpectedRevision(expectedRevision, packageWorkflowRevision(current));
            const document = current.documents.find((entry) => entry.name === name);
            return await savePlanPackageDocument(identity, target.planId, name, document?.hash ?? null, body);
        });
    }
    return await withPlanLock(cwd, plan.name, async () => {
        const current = await loadPlan(cwd, plan.name);
        if (!current || current.attrs.planId !== plan.attrs.planId) throw new PlanNotFoundError(plan.name);
        assertEpic({ ...current, name: plan.name });
        if (expectedRevision !== undefined) {
            const before = await readCheckoutEpicArtifact(cwd, plan.name, name);
            ensureExpectedRevision(expectedRevision, checkoutArtifactRevision(current.revision, before));
        }
        const markdown = decodePackageMarkdown(new TextEncoder().encode(body));
        await writeCheckoutEpicArtifact(cwd, plan.name, name, markdown);
        return { body: markdown, revision: checkoutArtifactRevision(current.revision, markdown) };
    });
}

async function assertEpicFamily(parent: ArtifactPlanIdentity, child: ArtifactPlanIdentity): Promise<void> {
    assertEpic(parent);
    if (currentPackageProject()) {
        const loaded = await selectedPackage({ planId: requirePlanId(child) });
        if (loaded.metadata.parentPlanId === parent.attrs.planId) return;
    } else if (child.attrs.parentPlan === parent.name) {
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
    return currentPackageProject() || managedPlanStoreActive() ? requirePlanId(child) : child.name;
}

async function findQa(cwd: string, epic: ArtifactPlanIdentity, child: ArtifactPlanIdentity): Promise<boolean> {
    await assertEpicFamily(epic, child);
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
        await assertEpicFamily(epic, child);
        return await appendManagedEpicQa(cwd, requirePlanId(epic), requirePlanId(child), section);
    }
    const write = async (epic: ArtifactPlanIdentity, child: ArtifactPlanIdentity) => {
        await assertEpicFamily(epic, child);
        const existing = await readArtifact(cwd, epic, EPIC_MANUAL_QA_FILE_NAME);
        const body = prepareManualQaSection(
            existing?.body ?? null,
            epic.name,
            child.name,
            qaMarkerIdentity(child),
            section,
        );
        if (body === null) return "already_present" as const;
        if (currentPackageProject()) {
            const target = { planId: requirePlanId(epic) };
            await saveGeneratedManualQaArtifact(
                { planId: requirePlanId(child) },
                target,
                existing?.packageHash ?? null,
                body,
            );
        } else {
            await writeCheckoutEpicArtifact(cwd, epic.name, EPIC_MANUAL_QA_FILE_NAME, body);
        }
        return "recorded" as const;
    };
    if (currentPackageProject()) {
        const epicId = requirePlanId(epic);
        const childId = requirePlanId(child);
        return await packageWorkflowLocks([{ planId: epicId }, { planId: childId }], async () =>
            write(await planById(cwd, epicId), await planById(cwd, childId)),
        );
    }

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

function artifact(planId: PlanId, name: EpicArtifactName, content: Pick<ProjectPlanArtifact, "body" | "revision">) {
    return {
        planId,
        name,
        relativePath: planArtifactReference(planId, name),
        body: content.body,
        revision: content.revision,
    };
}

export function projectPlanArtifacts(run: ReturnType<typeof bindProjectPlanStore>): ProjectPlanArtifacts {
    return {
        read: (planId, requested) =>
            run(async (cwd) => {
                const name = requireArtifactName(requested);
                const plan = await planById(cwd, planId);
                assertEpic(plan);
                const content = await readArtifact(cwd, plan, name);
                return content ? artifact(planId, name, content) : null;
            }, "retained"),
        save: (planId, requested, body, expectedRevision) =>
            run(async (cwd) => {
                const name = requireArtifactName(requested);
                const content = await saveArtifact(cwd, await planById(cwd, planId), name, body, expectedRevision);
                return artifact(planId, name, content);
            }, "retained"),
        findManualQaSection: (epicId, childId) =>
            run(async (cwd) => {
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
