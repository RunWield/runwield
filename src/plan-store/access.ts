import { hasRetainedCheckoutSource } from "./retained-source.ts";
import { remoteProjectOwner } from "../shared/remote/personal-resources.ts";
import { inspectProjectIdentity, type ProjectIdentity } from "../shared/project-identity.ts";
import { currentPackageProject, withPackageProject } from "./workflows.ts";
import { withMissingImportedExecutionRecovery } from "./legacy.ts";

interface LocalHomeStore {
    kind: "local";
    identity: ProjectIdentity;
}
interface EmptyHomeStore {
    kind: "empty";
}
interface ManagedRemoteStore {
    kind: "managed-remote";
}
interface RetainedCheckoutStore {
    kind: "retained-checkout";
}
export type HomeStoreInspection = LocalHomeStore | EmptyHomeStore | ManagedRemoteStore | RetainedCheckoutStore;

/** Inspect supported ownership without registering, migrating, repairing or importing a Project. */
export function inspectLocalHomeStore(cwd: string): HomeStoreInspection {
    if (hasRetainedCheckoutSource(cwd)) return { kind: "retained-checkout" };
    if (remoteProjectOwner()?.kind === "managed-remote") return { kind: "managed-remote" };
    const inspected = inspectProjectIdentity(cwd);
    if (inspected.kind === "invalid") throw new Error(inspected.message);
    if (inspected.kind !== "existing") return { kind: "empty" };
    if (inspected.identity.personalOwner.kind !== "execution-account") return { kind: "managed-remote" };
    return { kind: "local", identity: inspected.identity };
}

/** Whether this request still needs an admitted Plan workflow, without exposing storage selection. */
export function requiresPlanWorkflow(cwd: string): boolean {
    return !currentPackageSelection() && inspectLocalHomeStore(cwd).kind === "local";
}

/** A captured read context cannot grant access to another Project or owner. */
export class PlanAccessMismatchError extends Error {}

/** Local passive reads have exactly one authority. A missing home never enables checkout discovery. */
export async function readLocalHomeStore<T>(
    cwd: string,
    read: () => Promise<T>,
    empty: () => T | Promise<T>,
): Promise<T> {
    const current = currentPackageProject();
    const store = inspectLocalHomeStore(cwd);
    if (current) {
        if (
            store.kind !== "local" ||
            store.identity.projectId !== current.projectId ||
            store.identity.personalOwner.identity !== current.personalOwner.identity ||
            store.identity.executionAccountHome !== current.executionAccountHome
        )
            throw new PlanAccessMismatchError("Plan read belongs to a different Project or personal owner.");
        if (store.identity.repositoryId !== current.repositoryId) {
            if (currentPackageSelection())
                throw new PlanAccessMismatchError("Selected Plan read belongs to a different repository.");
            return await withPackageProject(cwd, store.identity, read);
        }
        return await read();
    }
    if (store.kind === "empty") return empty();
    if (store.kind !== "local") return await read();
    return await withPackageProject(cwd, store.identity, read);
}

export function missingHomePlan(path: string) {
    return { kind: "not_found" as const, path };
}

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
    commitPlanPackageBatch,
    listPlanPackages,
    readPlanPackage,
    withPlanPackageLocks,
    withPlanPackageCatalogDiscovery,
    packageDefinitionStrings,
    resolvePlanPackageReference,
    type PackageDefinition,
    type PackageDocuments,
} from "./packages.ts";
import { enterProjectRuntime } from "../shared/project-runtime-layout.ts";
import { packageWorkflowRevision, packageController } from "./workflows.ts";
import { assertSharedPlanWriteAllowed } from "../shared/collaboration/lock.ts";
import {
    injectFrontMatter,
    parsePlanFrontMatter,
    StalePlanWriteError,
    canonicalizeStoredPlanName,
    getStoredPlanPath,
    type PlanFrontMatterInput,
    type PlanFrontMatter,
} from "../plan-store.js";

/** A diagnostic/edit reference follows the selected storage owner even when loading the document failed. */
export async function planDocumentReference(cwd: string, reference: string): Promise<string> {
    const { name } = canonicalizeStoredPlanName(reference);
    const owner = inspectLocalHomeStore(cwd);
    if (owner.kind === "empty") return name;
    if (owner.kind !== "local") return getStoredPlanPath(cwd, name);
    const catalog = await listPlanPackages(owner.identity, true);
    const plan = catalog.packages.find((entry) => entry.metadata.name === name || entry.metadata.planId === reference);
    return plan
        ? join(plan.path, "context.md")
        : join(
              owner.identity.executionAccountHome,
              ".wld",
              "projects",
              owner.identity.projectId,
              "plans",
              name,
              "context.md",
          );
}

interface LocalPlanWriteOptions {
    definition?: PlanAuthoringDefinition;
    expectedRevision?: string;
    validationMarkdown?: string;
}

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

/** Canonical authoring keeps definition changes with Core and prose in editable Markdown. */
export async function saveLocalHomePlan(
    cwd: string,
    name: string,
    markdown: string,
    overrides: PlanFrontMatterInput,
    options: LocalPlanWriteOptions,
): Promise<string | null> {
    if (remoteProjectOwner()?.kind === "managed-remote" || hasRetainedCheckoutSource(cwd)) return null;
    await enterProjectRuntime(cwd);
    const store = inspectLocalHomeStore(cwd);
    if (store.kind !== "local") throw new Error("Local Plan authoring requires an admitted Project.");
    return await withPackageProject(cwd, store.identity, () =>
        withPlanPackageCatalogDiscovery(store.identity, async () => {
            const parsed = parsePlanFrontMatter(injectFrontMatter(markdown, overrides));
            const catalog = await listPlanPackages(store.identity, true);
            if (catalog.issues.length) throw new Error(catalog.issues[0].message);
            const existing = catalog.packages.find((plan) => plan.metadata.name === name);
            const planId = existing?.metadata.planId || parsed.attrs.planId || randomUUID();
            return await withPlanPackageLocks(store.identity, [planId], async () => {
                const current = existing ? await readPlanPackage(store.identity, { planId }) : null;
                if (current && current.kind !== "loaded") throw new Error(current.message);
                if (current) {
                    assertSharedPlanWriteAllowed(await packageController(current));
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
                        ? catalog.packages.find((plan) => plan.metadata.planId === current.metadata.parentPlanId)
                              ?.metadata.name
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
                const documents: PackageDocuments = {
                    "context.md": "",
                    "validation.md": "# Validation\n\nSee the Verification Plan in [context.md](context.md).\n",
                };
                for (const document of current?.documents || [])
                    documents[document.name] = new TextDecoder().decode(document.bytes);
                await commitPlanPackageBatch(store.identity, [
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
                            definition,
                            parentPlanId,
                            dependencyPlanIds,
                        },
                        documents: {
                            ...documents,
                            "context.md": parsed.body,
                            "validation.md": options.validationMarkdown ?? documents["validation.md"],
                        },
                    },
                ]);
                const saved = await readPlanPackage(store.identity, { planId });
                if (saved.kind !== "loaded") throw new Error(saved.message);
                return join(saved.path, "context.md");
            });
        }),
    );
}

import { currentPackageSelection, withPackageWorkflow, type PackageWorkflowSelection } from "./workflows.ts";

/** Resolve only canonical identity; requested names and paths never discover checkout documents. */
export async function selectLocalPlanWorkflow(
    cwd: string,
    reference: string,
): Promise<PackageWorkflowSelection | undefined> {
    const store = inspectLocalHomeStore(cwd);
    if (store.kind === "managed-remote" || store.kind === "retained-checkout") return undefined;
    if (store.kind === "empty") throw new Error("No saved Plans. Use wld plans import <file-or-folder> first.");
    const catalog = await listPlanPackages(store.identity, true);
    if (catalog.issues.length) throw new Error(catalog.issues[0].message);
    const plan = catalog.packages.find(
        (entry) =>
            entry.metadata.name === reference ||
            entry.metadata.planId === reference ||
            join(entry.path, "context.md") === reference,
    );
    if (!plan) throw new Error(`No canonical Plan named ${reference}. Import external Markdown explicitly.`);
    return { identity: store.identity, planId: plan.metadata.planId, expectedRevision: plan.metadata.revision };
}

export async function withLocalPlanWorkflow<T>(cwd: string, name: string, run: () => Promise<T>): Promise<T> {
    const selection = await selectLocalPlanWorkflow(cwd, name);
    if (selection?.planId === currentPackageSelection()?.planId) return await run();
    return selection ? await withPackageWorkflow(cwd, selection, run) : await run();
}

/** Resume a missing retained checkout only through the imported attempt's recorded owner. */
export async function continueMissingPlanExecution(
    cwd: string,
    reference: string,
    run: () => Promise<void>,
): Promise<boolean> {
    const owner = inspectLocalHomeStore(cwd);
    if (owner.kind !== "local") return false;
    const selection = await selectLocalPlanWorkflow(cwd, reference);
    const plan = await readPlanPackage(owner.identity, { planId: selection!.planId });
    if (plan.kind !== "loaded") throw new Error(plan.message);
    return await withMissingImportedExecutionRecovery(owner.identity, plan, run);
}

import { resolve } from "node:path";
import { stat, realpath } from "node:fs/promises";
import { importPlanPackages } from "./packages.ts";

/** A pathname is an explicit import request; a name never searches the checkout. */
export async function importLocalPlanReference(cwd: string, reference: string) {
    const store = inspectLocalHomeStore(cwd);
    if (store.kind !== "local") return undefined;
    let catalog = await listPlanPackages(store.identity, true);
    if (catalog.issues.length) throw new Error(catalog.issues[0].message);
    let plan = catalog.packages.find(
        (entry) =>
            entry.metadata.name === reference ||
            entry.metadata.planId === reference ||
            join(entry.path, "context.md") === resolve(cwd, reference),
    );
    if (!plan && reference.endsWith(".md")) {
        const canonicalReference = await realpath(resolve(cwd, reference)).catch(() => undefined);
        if (canonicalReference) {
            for (const entry of catalog.packages) {
                if ((await realpath(join(entry.path, "context.md"))) === canonicalReference) {
                    plan = entry;
                    break;
                }
            }
        }
    }
    if (!plan && reference.endsWith(".md")) {
        const path = resolve(cwd, reference);
        const info = await stat(path).catch((error) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
            throw error;
        });
        if (info?.isFile()) {
            const imported = await importPlanPackages(store.identity, path);
            if ("message" in imported) throw new Error(imported.message);
            if (imported.planIds.length !== 1) throw new Error("Load one Plan document at a time.");
            catalog = await listPlanPackages(store.identity, true);
            plan = catalog.packages.find((entry) => entry.metadata.planId === imported.planIds[0]);
        }
    }
    if (!plan) throw new Error(`No canonical Plan named ${reference}. Import external Markdown explicitly.`);
    return {
        name: plan.metadata.name,
        selection: { identity: store.identity, planId: plan.metadata.planId, expectedRevision: plan.metadata.revision },
    };
}

/** Mutation admission is shared by Project actions that have no selected Plan. */
export async function withLocalProjectAction<T>(cwd: string, action: () => Promise<T>): Promise<T> {
    const before = inspectLocalHomeStore(cwd);
    if (before.kind === "managed-remote" || before.kind === "retained-checkout") return await action();
    await enterProjectRuntime(cwd);
    const admitted = inspectLocalHomeStore(cwd);
    if (admitted.kind !== "local") throw new Error("Project action requires an admitted local owner.");
    return await withPackageProject(cwd, admitted.identity, action);
}

export interface PlanAuthoringDefinition {
    title?: string;
    classification?: "PLANNED_CHANGE" | "PROJECT";
    type?: "epic" | "sequence";
    summary?: string;
    tickets?: PlanFrontMatter["tickets"];
    supersedes?: string[];
    workKind?: PlanFrontMatter["workKind"];
    complexity?: PlanFrontMatter["complexity"];
    affectedPaths?: string[];
    executionAgent?: PlanFrontMatter["executionAgent"];
    collaborationRecommendation?: PlanFrontMatter["collaborationRecommendation"];
    targetBranch?: string;
    order?: number;
    frontend?: boolean;
    devServerCommand?: string;
    devServerUrl?: string;
    devServerHmr?: boolean;
}
export interface PlanAuthoringInput {
    planName: string;
    contextMarkdown: string;
    validationMarkdown?: string;
    expectedRevision?: string;
    definition?: PlanAuthoringDefinition;
    parentPlan?: string;
    dependencies?: string[];
}

/** Agent-facing authoring accepts prose and typed definition facts, never protected JSON or YAML. */
export async function authorLocalPlan(cwd: string, input: PlanAuthoringInput): Promise<void> {
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
    const path = await saveLocalHomePlan(
        cwd,
        input.planName,
        input.contextMarkdown,
        {
            ...definition,
            status: "draft",
            parentPlan: input.parentPlan,
            dependencies: input.dependencies,
        },
        { expectedRevision: input.expectedRevision, validationMarkdown: input.validationMarkdown, definition },
    );
    if (!path) throw new Error("This launch owner does not support local package authoring.");
}

/** Passive request context. Empty Projects remain empty and require no registration. */
export async function withPlanReadScope<T>(cwd: string, run: () => Promise<T>): Promise<T> {
    return await readLocalHomeStore(cwd, run, run);
}
