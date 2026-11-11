import { hasRetainedCheckoutSource } from "./legacy-plan-source.ts";
import { remoteProjectOwner } from "./remote/personal-resources.ts";
import { inspectProjectIdentity, type ProjectIdentity } from "./project-identity.ts";
import { currentPackageProject, withPackageProject } from "./workflow/package-workflow.ts";

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

/** Local passive reads have exactly one authority. A missing home never enables checkout discovery. */
export async function readLocalHomeStore<T>(cwd: string, read: () => Promise<T>, empty: () => T): Promise<T> {
    const current = currentPackageProject();
    const store = inspectLocalHomeStore(cwd);
    if (current) {
        if (
            store.kind !== "local" ||
            store.identity.projectId !== current.projectId ||
            store.identity.repositoryId !== current.repositoryId ||
            store.identity.personalOwner.identity !== current.personalOwner.identity ||
            store.identity.executionAccountHome !== current.executionAccountHome
        )
            throw new Error("Plan read belongs to a different Project or personal owner.");
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
    createPlanPackage,
    listPlanPackages,
    readPlanPackage,
    savePlanPackageDocument,
    updatePlanPackageMetadata,
    withPlanPackageLocks,
    packageDefinitionStrings,
    resolvePlanPackageReference,
    type PackageDefinition,
} from "./plan-package-store.ts";
import { enterProjectRuntime } from "./project-runtime-layout.ts";
import { packageWorkflowRevision, packageController } from "./workflow/package-workflow.ts";
import { assertSharedPlanWriteAllowed } from "./collaboration/lock.ts";
import {
    injectFrontMatter,
    parsePlanFrontMatter,
    StalePlanWriteError,
    type PlanFrontMatterInput,
    type PlanFrontMatter,
} from "../plan-store.js";

interface LocalPlanWriteOptions {
    expectedRevision?: string;
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
    return await withPackageProject(cwd, store.identity, async () => {
        const parsed = parsePlanFrontMatter(injectFrontMatter(markdown, overrides));
        const catalog = await listPlanPackages(store.identity, true);
        if (catalog.issues.length) throw new Error(catalog.issues[0].message);
        const existing = catalog.packages.find((plan) => plan.metadata.name === name);
        const planId = existing?.metadata.planId || parsed.attrs.planId || randomUUID();
        const related = (reference: string) =>
            resolvePlanPackageReference(catalog.packages, reference, parsed.attrs.parentPlan);
        const parentPlanId = parsed.attrs.parentPlan ? related(parsed.attrs.parentPlan) : null;
        const dependencyPlanIds = (parsed.attrs.dependencies || []).map(related);
        const definition = authoredPackageDefinition(parsed.attrs, existing?.metadata.definition.status);
        return await withPlanPackageLocks(store.identity, [planId], async () => {
            if (!existing) {
                const created = await createPlanPackage(store.identity, {
                    name,
                    planId,
                    definition,
                    parentPlanId,
                    dependencyPlanIds,
                    documents: {
                        "context.md": parsed.body,
                        "validation.md": "# Validation\n\nSee the Verification Plan in [context.md](context.md).\n",
                    },
                });
                return join(created.path, "context.md");
            }
            const current = await readPlanPackage(store.identity, { planId });
            if (current.kind !== "loaded") throw new Error(current.message);
            assertSharedPlanWriteAllowed(await packageController(current));
            const revision = packageWorkflowRevision(current);
            if (options.expectedRevision !== revision)
                throw new StalePlanWriteError(options.expectedRevision || "required", revision);
            const context = current.documents.find((document) => document.name === "context.md")!;
            await savePlanPackageDocument(store.identity, planId, "context.md", context.hash, parsed.body);
            await updatePlanPackageMetadata(store.identity, planId, current.metadata.revision, {
                definition,
                parentPlanId,
                dependencyPlanIds,
            });
            return join(existing.path, "context.md");
        });
    });
}

import {
    currentPackageSelection,
    withPackageWorkflow,
    type PackageWorkflowSelection,
} from "./workflow/package-workflow.ts";

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

import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { importPlanPackages } from "./plan-package-store.ts";

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
        { expectedRevision: input.expectedRevision },
    );
    if (!path) throw new Error("This launch owner does not support local package authoring.");
    if (input.validationMarkdown !== undefined) {
        const store = inspectLocalHomeStore(cwd);
        if (store.kind !== "local") throw new Error("Plan authoring owner changed.");
        const plan = await readPlanPackage(store.identity, { name: input.planName });
        if (plan.kind !== "loaded") throw new Error(plan.message);
        const document = plan.documents.find((entry) => entry.name === "validation.md")!;
        await savePlanPackageDocument(
            store.identity,
            plan.metadata.planId,
            "validation.md",
            document.hash,
            input.validationMarkdown,
        );
    }
}
