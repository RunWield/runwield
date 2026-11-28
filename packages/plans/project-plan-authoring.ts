import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { projects, type ProjectIdentity, type ProjectStoreIdentity } from "@runwield/projects";
import { enter } from "@runwield/project-runtime";
import { enterProjectRuntime } from "@runwield/project-runtime/layout";
import { remoteProjectOwner } from "@runwield/resources/personal";
import { assertSharedPlanWriteAllowed } from "./collaboration-lock.ts";
import type { PlanFrontMatter, PlanFrontMatterInput } from "./document.ts";
import { injectFrontMatter, parsePlanFrontMatter } from "./format.ts";
import {
    operationDigest,
    operationHash,
    planOperationReceiptDirectory,
    runReceiptedPlanAuthoring,
    type OperationOutcome,
} from "./operation-receipts.ts";
import { packageDocumentText } from "./package-data.ts";
import {
    commitPlanPackageBatch,
    listPlanPackages,
    packageDefinitionStrings,
    packageWorkflowRevision,
    readPlanPackage,
    resolvePlanPackageReference,
    withPlanPackageCatalogDiscovery,
    withPlanPackageLocks,
    type PackageDefinition,
} from "./package-storage.ts";
import { projectPlanFiles } from "./project-plan-files.ts";
import type {
    LegacyManagedPlanAuthoring,
    ManagedPlanCreation,
    ManagedPlanRevision,
    ProjectStoreBinding,
} from "./project-store-wire.ts";
import { hasRetainedCheckoutSource } from "./retained-checkout.ts";
import { PlanNotFoundError, StalePlanWriteError } from "./store-errors.ts";
import type { PlanAuthoringDefinition, PlanAuthoringInput } from "./store.ts";
import type { PackageDocuments } from "./history.ts";

interface CanonicalPlanWriteOptions {
    authoredPlanId?: string;
    definition?: PlanAuthoringDefinition;
    expectedRevision?: string;
    validationMarkdown?: string;
}

/** Trusted local adapters can still save legacy Markdown and front-matter fields to the canonical package. */
export interface CanonicalPlanWrite {
    name: string;
    markdown: string;
    overrides: PlanFrontMatterInput;
    options: CanonicalPlanWriteOptions;
}

interface CanonicalPlanWriteResult {
    contextPath: string;
    revision: string;
}

type ManagedPlanCreateRequest = ManagedPlanCreation | LegacyManagedPlanAuthoring;
type ManagedPlanReviseRequest = ManagedPlanRevision | LegacyManagedPlanAuthoring;

interface ManagedPlanAuthoringFiles {
    /** Reserve a fresh Plan ID once or use the ID in an authenticated historical creation request. */
    createPlan(request: ManagedPlanCreateRequest): Promise<OperationOutcome>;
    /** Write the existing Plan at the expected revision or return its original completed outcome. */
    revisePlan(request: ManagedPlanReviseRequest): Promise<OperationOutcome>;
}

/** Project authored front matter into the canonical Plan definition used by family writes. */
export function authoredPackageDefinition(attrs: PlanFrontMatter, status: string = attrs.status): PackageDefinition {
    const definition: PackageDefinition = {
        classification: attrs.classification === "PROJECT" ? "PROJECT" : "PLANNED_CHANGE",
        status,
    };
    for (const key of [
        ...packageDefinitionStrings,
        "affectedPaths",
        "order",
        "frontend",
        "devServerHmr",
        "tickets",
        "supersedes",
        "planDeviations",
    ]) {
        const value = attrs[key as keyof PlanFrontMatter];
        if (value !== undefined && value !== null) Object.assign(definition, { [key]: value });
    }
    return definition;
}

/** Validate typed authoring before the caller prepares any checkout for the write. */
export function canonicalPlanAuthoring(input: PlanAuthoringInput, authoredPlanId?: string): CanonicalPlanWrite {
    if (
        /^\ufeff?---\s*\r?\n/.test(input.contextMarkdown) ||
        (input.validationMarkdown && /^\ufeff?---\s*\r?\n/.test(input.validationMarkdown))
    )
        throw new Error("Live Plan documents contain Markdown only. Supply definition facts through the tool fields.");
    const definition = input.definition || {};
    const allowedDefinitionFields = new Set<string>([
        "classification",
        "type",
        "summary",
        "title",
        "tickets",
        "supersedes",
        "workKind",
        "complexity",
        "affectedPaths",
        "executionAgent",
        "collaborationRecommendation",
        "targetBranch",
        "order",
        "frontend",
        "devServerCommand",
        "devServerUrl",
        "devServerHmr",
    ]);
    for (const field of Object.keys(definition))
        if (!allowedDefinitionFields.has(field))
            throw new Error(`Plan authoring cannot change protected field: ${field}`);
    return {
        name: input.planName,
        markdown: input.contextMarkdown,
        overrides: {
            ...definition,
            status: "draft",
            parentPlan: input.parentPlan,
            dependencies: input.dependencies,
        },
        options: {
            expectedRevision: input.expectedRevision,
            validationMarkdown: input.validationMarkdown,
            definition,
            authoredPlanId,
        },
    };
}

/** Commit definition, prose, and review state together under the canonical package locks. */
export async function saveCanonicalPlan(
    identity: ProjectStoreIdentity,
    { name, markdown, overrides, options }: CanonicalPlanWrite,
): Promise<CanonicalPlanWriteResult> {
    const files = projectPlanFiles.forOwner(identity);
    return await withPlanPackageCatalogDiscovery(identity, async () => {
        const parsed = parsePlanFrontMatter(injectFrontMatter(markdown, overrides));
        const catalog = await listPlanPackages(identity, true);
        if (catalog.issues.length) throw new Error(catalog.issues[0].message);
        const existing = catalog.packages.find((plan) => plan.metadata.name === name);
        if (!existing && options.expectedRevision !== undefined)
            throw new StalePlanWriteError(options.expectedRevision, "missing");
        const planId = existing?.metadata.planId || options.authoredPlanId || parsed.attrs.planId || randomUUID();
        if (existing && options.authoredPlanId && options.expectedRevision === undefined)
            throw new StalePlanWriteError("absent", packageWorkflowRevision(existing));
        if (options.authoredPlanId && options.authoredPlanId !== planId) throw new Error("Authoring identity changed.");
        return await withPlanPackageLocks(identity, [planId], async () => {
            const current = existing ? await readPlanPackage(identity, { planId }) : null;
            if (current && current.kind !== "loaded") throw new Error(current.message);
            if (current) {
                if (current.metadata.archive && !current.metadata.archive.restoredAt)
                    throw new Error("This Plan package is archived.");
                assertSharedPlanWriteAllowed(await files.readController(current));
                const revision = packageWorkflowRevision(current);
                if (options.expectedRevision !== revision)
                    throw new StalePlanWriteError(options.expectedRevision || "required", revision);
            }
            const definition =
                options.definition && current
                    ? { ...current.metadata.definition }
                    : authoredPackageDefinition(parsed.attrs, current?.metadata.definition.status);
            if (options.definition) {
                for (const [key, value] of Object.entries(options.definition)) {
                    if (value !== undefined) Object.assign(definition, { [key]: value });
                }
            }
            const parentReference =
                parsed.attrs.parentPlan ??
                (options.definition && current
                    ? catalog.packages.find((plan) => plan.metadata.planId === current.metadata.parentPlanId)?.metadata
                          .name
                    : undefined);
            const related = (reference: string) =>
                resolvePlanPackageReference(catalog.packages, reference, parentReference);
            const parentPlanId =
                overrides.parentPlan === undefined && options.definition && current
                    ? current.metadata.parentPlanId
                    : parsed.attrs.parentPlan
                      ? related(parsed.attrs.parentPlan)
                      : null;
            const dependencyPlanIds =
                overrides.dependencies === undefined && options.definition && current
                    ? current.metadata.dependencyPlanIds
                    : (parsed.attrs.dependencies || []).map(related);
            const documents: PackageDocuments = current
                ? packageDocumentText(current.documents)
                : {
                      "context.md": "",
                      "validation.md": "# Validation\n\nSee the Verification Plan in [context.md](context.md).\n",
                  };
            const nextValidation = options.validationMarkdown ?? documents["validation.md"];
            const review =
                current &&
                (await files.prepareReviewInvalidation(current, {
                    kind: "edit",
                    definition: { definition, parentPlanId, dependencyPlanIds },
                    documents: [
                        { previous: documents["context.md"], next: parsed.body },
                        { previous: documents["validation.md"], next: nextValidation },
                    ],
                }));
            await commitPlanPackageBatch(identity, [
                {
                    before: current ? { metadata: current.metadata, documents } : null,
                    metadata: {
                        ...(current?.metadata || {
                            version: 1,
                            createdAt: new Date().toISOString(),
                            controller: {},
                            references: { sessionIds: [] },
                            archive: null,
                        }),
                        name,
                        planId,
                        revision: (current?.metadata.revision || 0) + 1,
                        ...review,
                        definition: review ? { ...definition, status: review.definition.status } : definition,
                        parentPlanId,
                        dependencyPlanIds,
                    },
                    documents: {
                        ...documents,
                        "context.md": parsed.body,
                        "validation.md": nextValidation,
                    },
                },
            ]);
            const saved = await readPlanPackage(identity, { planId });
            if (saved.kind !== "loaded") throw new Error(saved.message);
            return { contextPath: join(saved.path, "context.md"), revision: packageWorkflowRevision(saved) };
        });
    });
}

function assertCheckoutRegistration(owner: ProjectIdentity, registrationPath: string): void {
    const inspected = projects.checkout.inspect(registrationPath);
    if (
        inspected.kind !== "existing" ||
        inspected.identity.projectId !== owner.projectId ||
        inspected.identity.repositoryId !== owner.repositoryId ||
        inspected.identity.checkoutId !== owner.checkoutId ||
        inspected.identity.checkoutRoot !== owner.checkoutRoot ||
        inspected.identity.personalOwner.kind !== owner.personalOwner.kind ||
        inspected.identity.personalOwner.identity !== owner.personalOwner.identity ||
        inspected.identity.executionAccountHome !== owner.executionAccountHome
    )
        throw new Error("Project store authority changed.");
}

async function prepareManagedAuthoring(owner: ProjectStoreIdentity, registrationPath: string): Promise<void> {
    if (remoteProjectOwner()?.kind === "managed-remote" || hasRetainedCheckoutSource(registrationPath))
        throw new Error("This launch owner does not support local package authoring.");
    if (projects.home.isOwner(owner)) return;
    // The host's original path can change while the writer is waiting for the catalog lock.
    assertCheckoutRegistration(owner, registrationPath);
    // An admitted checkout can still need its home registration restored before writing.
    if (owner.checkoutRoot === registrationPath && projects.checkout.historicalRoots(owner)[0] === registrationPath)
        await enter(owner);
    else await enterProjectRuntime(registrationPath);
    assertCheckoutRegistration(owner, registrationPath);
}

/** Retain the trusted host registration path separately from wire authoring requests. */
function forOwner(owner: ProjectStoreIdentity, registrationPath: string): ManagedPlanAuthoringFiles {
    const binding: ProjectStoreBinding = {
        projectId: owner.projectId,
        repositoryId: owner.repositoryId,
        ownerId: operationHash(owner.personalOwner.identity),
    };

    async function withAuthoringReceipt(
        command: ManagedPlanCreateRequest | ManagedPlanReviseRequest,
        existingPlanId: string | undefined,
        write: (planId: string) => Promise<string>,
    ): Promise<OperationOutcome> {
        // Hash the original wire command. Historical commands keep the same digest and receipt files.
        return await withPlanPackageCatalogDiscovery(owner, () =>
            runReceiptedPlanAuthoring(
                planOperationReceiptDirectory(owner),
                command.operationId,
                operationDigest(JSON.stringify({ binding, command })),
                existingPlanId,
                write,
            ),
        );
    }

    async function writePlan(input: PlanAuthoringInput, planId: string): Promise<string> {
        const write = canonicalPlanAuthoring(input, planId);
        await prepareManagedAuthoring(owner, registrationPath);
        return (await saveCanonicalPlan(owner, write)).revision;
    }

    return {
        async createPlan(request) {
            if (request.kind === "author-plan" && request.input.expectedRevision !== undefined)
                throw new Error("Historical creation cannot carry an expected revision.");
            const planId = request.kind === "author-plan" ? request.planId : undefined;
            return await withAuthoringReceipt(request, planId, (chosenPlanId) =>
                writePlan({ ...request.input, expectedRevision: undefined }, chosenPlanId),
            );
        },
        async revisePlan(request) {
            if (request.kind === "author-plan" && request.input.expectedRevision === undefined)
                throw new Error("Historical revision requires an expected revision.");
            return await withAuthoringReceipt(request, request.planId, async (planId) => {
                // Historical requests retain their saved name as well as the Plan ID.
                if (request.kind === "author-plan") return await writePlan(request.input, planId);
                const target = await readPlanPackage(owner, { planId });
                if (target.kind === "missing") throw new PlanNotFoundError(planId);
                if (target.kind !== "loaded") throw new Error(target.message);
                if (target.metadata.archive && !target.metadata.archive.restoredAt) throw new PlanNotFoundError(planId);
                return await writePlan(
                    { ...request.input, planName: target.metadata.name, expectedRevision: request.expectedRevision },
                    planId,
                );
            });
        },
    };
}

/** Canonical authoring and receipt recovery for an authenticated SSH host's admitted Project. */
export const projectPlanAuthoring = { forOwner };
