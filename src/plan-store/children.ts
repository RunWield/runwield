import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
    loadPlan,
    resolveChildPlanNames,
    resolvePlanExecutionPolicy,
    parsePlanFrontMatter,
    injectFrontMatter,
    StalePlanWriteError,
    type ChildFeaturePlanDescriptor,
    type PlanWriteOptions,
    type SavedChildFeaturePlan,
} from "../plan-store.js";
import { authoredPackageDefinition, withLocalProjectAction } from "./access.ts";
import { assertSharedPlanWriteAllowed } from "../shared/collaboration/lock.ts";
import {
    commitPlanPackageBatch,
    listPlanPackages,
    type LoadedPlanPackage,
    type PackageDocuments,
    type PlanPackageBatchWrite,
} from "./packages.ts";
import { currentPackageProject, packageController, packageWorkflowRevision } from "./workflows.ts";
import { buildPlanEventUpdates } from "../shared/workflow/plan-lifecycle.js";
import { pickControllerState } from "../shared/workflow/controller-state.ts";
import { writePackageControllerEvidence } from "./controllers.ts";
import { isEpicPlan, isProjectPlan } from "../shared/project-plan.ts";

function documents(plan: LoadedPlanPackage): PackageDocuments {
    const result: PackageDocuments = { "context.md": "", "validation.md": "" };
    for (const document of plan.documents) result[document.name] = new TextDecoder().decode(document.bytes);
    return result;
}

/** Allocate the whole family before resolving relations, then publish one recoverable generation. */
export async function authorPackageChildren(
    cwd: string,
    parentName: string,
    children: ChildFeaturePlanDescriptor[],
    options: PlanWriteOptions = {},
    finalize = false,
): Promise<SavedChildFeaturePlan[]> {
    if (!currentPackageProject())
        return await withLocalProjectAction(cwd, () =>
            authorPackageChildren(cwd, parentName, children, options, finalize),
        );
    const identity = currentPackageProject()!;
    const names = await resolveChildPlanNames(cwd, parentName, children);
    const catalog = await listPlanPackages(identity, true);
    if (catalog.issues.length) throw new Error(catalog.issues[0].message);
    const active = await listPlanPackages(identity);
    if (active.issues.length) throw new Error(active.issues[0].message);
    const activeIds = new Set(active.packages.map((plan) => plan.metadata.planId));
    const parent = active.packages.find((plan) => plan.metadata.name === parentName);
    const parentView = await loadPlan(cwd, parentName);
    if (!parent || !parentView || !isProjectPlan(parentView.attrs) || (finalize && !isEpicPlan(parentView.attrs)))
        throw new Error(`Plan is not a PROJECT Epic: ${parentName}`);
    assertSharedPlanWriteAllowed(parentView.attrs, options);
    const allocated = names.map((name) => ({
        name,
        planId: catalog.packages.find((plan) => plan.metadata.name === name)?.metadata.planId || randomUUID(),
    }));
    const resolve = (reference: string) => {
        const found = [...allocated, ...active.packages.map((plan) => plan.metadata)].find(
            (plan) =>
                plan.name === reference || plan.planId === reference || plan.name === `${parentName}/${reference}`,
        );
        if (!found) throw new Error(`No canonical Plan named ${reference}; import or create it first.`);
        return found.planId;
    };
    const writes: PlanPackageBatchWrite[] = [];
    const results: SavedChildFeaturePlan[] = [];
    for (const [index, child] of children.entries()) {
        const { name, planId } = allocated[index];
        if (/^---\s*(?:\r?\n|$)/.test(child.content))
            throw new Error("Child content must be Markdown prose without YAML metadata.");
        const existing = catalog.packages.find((plan) => plan.metadata.planId === planId);
        if (existing) {
            if (!activeIds.has(planId) || existing.metadata.definition.status !== "draft")
                throw new Error(`Cannot regenerate non-draft child plan: ${name}`);
            assertSharedPlanWriteAllowed(await packageController(existing), options);
            const expected = options.expectedRevisions?.[name] || options.expectedRevision;
            if (expected && expected !== packageWorkflowRevision(existing))
                throw new StalePlanWriteError(expected, packageWorkflowRevision(existing));
        }
        const policy = resolvePlanExecutionPolicy({
            classification: "PLANNED_CHANGE",
            executionAgent: child.executionAgent,
            collaborationRecommendation: child.collaborationRecommendation,
            frontend: child.frontend,
        });
        if (!policy.ok) throw new Error(policy.error);
        const metadata: SavedChildFeaturePlan["metadata"] = {
            classification: "PLANNED_CHANGE",
            status: "draft",
            parentPlan: parentName,
            order: child.order ?? child.sequence,
            affectedPaths: child.affectedPaths,
            summary: child.summary,
            workKind: child.workKind,
            executionAgent: policy.policy.executionAgent,
            collaborationRecommendation: policy.policy.collaborationRecommendation,
            targetBranch: child.targetBranch ?? child.worktreeBaseBranch ?? parentView.attrs.targetBranch,
            devServerCommand: child.devServerCommand,
            devServerUrl: child.devServerUrl,
            devServerHmr: child.devServerHmr,
            tickets: child.tickets ?? existing?.metadata.definition.tickets,
            origin: "internal",
        };
        const attrs = parsePlanFrontMatter(injectFrontMatter(child.content, metadata)).attrs;
        const before = existing ? { metadata: existing.metadata, documents: documents(existing) } : null;
        writes.push({
            before,
            metadata: {
                ...(existing?.metadata || {
                    version: 1,
                    createdAt: new Date().toISOString(),
                    controller: {},
                    references: { sessionIds: [] },
                    archive: null,
                }),
                planId,
                name,
                revision: (existing?.metadata.revision || 0) + 1,
                parentPlanId: parent.metadata.planId,
                dependencyPlanIds: child.dependencies.map(resolve),
                definition: authoredPackageDefinition(attrs, "draft"),
            },
            documents: {
                ...(before?.documents || {
                    "validation.md": "# Validation\n\nSee the Verification Plan in [context.md](context.md).\n",
                }),
                "context.md": child.content,
            },
        });
        results.push({
            name,
            path: join(dirname(parent.path), name, "context.md"),
            title: child.title,
            action: existing ? "updated" : "created",
            dependencies: child.dependencies,
            metadata,
        });
    }
    if (finalize) {
        const total = new Set([
            ...active.packages
                .filter((plan) => plan.metadata.parentPlanId === parent.metadata.planId)
                .map((plan) => plan.metadata.planId),
            ...allocated.map((plan) => plan.planId),
        ]);
        if (!total.size)
            throw new Error("At least one child planned change plan is required to finalize decomposition.");
        if (parentView.attrs.status !== "ready_for_work") {
            const updates = buildPlanEventUpdates("decomposition_finalized", parentView.attrs.status, {
                triageMeta: parentView.attrs,
            });
            const state = { ...(await packageController(parent)), ...pickControllerState(updates) };
            const controller = await writePackageControllerEvidence(identity, parent.metadata.planId, state);
            writes.push({
                before: { metadata: parent.metadata, documents: documents(parent) },
                documents: documents(parent),
                metadata: {
                    ...parent.metadata,
                    revision: parent.metadata.revision + 1,
                    definition: authoredPackageDefinition({ ...parentView.attrs, ...updates }),
                    controller: {},
                    workflow: { ...parent.metadata.workflow, controller },
                },
            });
        } else if (writes.length) {
            writes.push({
                before: { metadata: parent.metadata, documents: documents(parent) },
                documents: documents(parent),
                metadata: { ...parent.metadata, revision: parent.metadata.revision + 1 },
            });
        }
    }
    await commitPlanPackageBatch(identity, writes);
    for (const result of results) await options.onChildPlanWritten?.(result);
    return results;
}
