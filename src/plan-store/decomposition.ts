import { rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import {
    loadPlan,
    findPlansByParent,
    saveChildFeaturePlans,
    resolveChildPlanNames,
    withPlanCatalogLock,
    writePlanMarkdownWithRevision,
    type SavedChildFeaturePlan,
    type ChildFeaturePlanDescriptor,
    type PlanWriteOptions,
} from "../plan-store.js";
import { isPlannedChangeClassification } from "../plan-format/classification.ts";
import { isEpicPlan } from "../shared/project-plan.ts";
import { recordPlanEvent } from "./events.ts";
import { inspectLocalHomeStore, withLocalProjectAction } from "./access.ts";
import { authorPackageChildren } from "./children.ts";
import { runEpicDecompositionFinalizeTransition } from "./transitions.ts";
interface PlanChildSnapshot {
    name: string;
    path: string;
    markdown: string;
    revision: string;
}
export interface MaterializePlanChildrenOptions {
    cwd: string;
    epicPlanName: string;
    children: ChildFeaturePlanDescriptor[];
    parentTargetBranch?: string;
}
export async function materializePlanChildren(options: MaterializePlanChildrenOptions) {
    return await materializePlanChildrenWithOptions(options);
}
async function materializePlanChildrenWithOptions(
    { cwd, epicPlanName, children, parentTargetBranch }: MaterializePlanChildrenOptions,
    writeOptions?: PlanWriteOptions,
) {
    const inheritedChildren = parentTargetBranch
        ? children.map((child) =>
              Object.hasOwn(child, "targetBranch") ? child : { ...child, targetBranch: parentTargetBranch },
          )
        : children;
    return await saveChildFeaturePlans(cwd, epicPlanName, inheritedChildren, writeOptions);
}
/** Validate and persist a whole decomposition, including legacy compensation, under the owner locks. */
export async function finalizePlanDecomposition(
    cwd: string,
    planName: string,
    descriptors: ChildFeaturePlanDescriptor[] = [],
) {
    const runFinalizeBody = async () => {
        const epic = await loadPlan(cwd, planName);
        if (!epic) throw new Error(`Epic plan not found: ${planName}`);
        if (!isEpicPlan(epic.attrs)) throw new Error(`Plan is not a PROJECT Epic: ${planName}`);
        if (epic.attrs.status === "draft") throw new Error("Draft Epics cannot be finalized.");
        if (
            epic.attrs.status !== "approved" &&
            epic.attrs.status !== "ready_for_decomposition" &&
            epic.attrs.status !== "ready_for_work"
        ) {
            throw new Error(
                `Cannot finalize Epic from status "${epic.attrs.status}". Expected approved or ready_for_decomposition.`,
            );
        }
        const childDescriptors = descriptors;
        const beforeChildren = await findPlansByParent(cwd, planName);

        const beforeSnapshots: PlanChildSnapshot[] = [];
        for (const child of beforeChildren) {
            const loadedChild = await loadPlan(cwd, child.name);
            if (
                loadedChild?.path &&
                typeof loadedChild.markdown === "string" &&
                typeof loadedChild.revision === "string"
            ) {
                beforeSnapshots.push({
                    name: child.name,
                    path: loadedChild.path,
                    markdown: loadedChild.markdown,
                    revision: loadedChild.revision,
                });
            }
        }

        const writeResults: SavedChildFeaturePlan[] = [];

        const stagedWriteRevisions = new Map<string, string>();
        try {
            const plannedChildNames = await resolveChildPlanNames(cwd, planName, childDescriptors);
            return await (async () => {
                const lockedEpic = await loadPlan(cwd, planName);
                if (!lockedEpic) throw new Error(`Epic plan not found while finalizing: ${planName}`);
                if (lockedEpic.revision !== epic.revision) {
                    throw new Error(`Epic plan changed while finalizing decomposition: ${planName}`);
                }
                const beforeNames = new Set(beforeSnapshots.map((snapshot) => snapshot.name));
                const expectedRevisions = Object.fromEntries(
                    beforeSnapshots.map((snapshot) => [snapshot.name, snapshot.revision]),
                );
                for (const snapshot of beforeSnapshots) {
                    const lockedChild = await loadPlan(cwd, snapshot.name);
                    if (!lockedChild || lockedChild.revision !== snapshot.revision) {
                        throw new Error(`Child plan changed while finalizing decomposition: ${snapshot.name}`);
                    }
                }
                for (const childName of plannedChildNames) {
                    if (beforeNames.has(childName)) continue;
                    const unexpectedChild = await loadPlan(cwd, childName);
                    if (unexpectedChild) {
                        throw new Error(
                            `Child plan was created concurrently while finalizing decomposition: ${childName}`,
                        );
                    }
                }

                const captureWrittenChild = async (writeResult: SavedChildFeaturePlan) => {
                    writeResults.push(writeResult);
                    const staged = await loadPlan(cwd, writeResult.name);
                    if (staged?.revision) stagedWriteRevisions.set(writeResult.name, staged.revision);
                };
                if (childDescriptors.length > 0) {
                    const returnedWriteResults = await materializePlanChildrenWithOptions(
                        {
                            cwd,
                            epicPlanName: planName,
                            children: childDescriptors,
                            parentTargetBranch: epic.attrs.targetBranch || undefined,
                        },
                        { expectedRevisions, onChildPlanWritten: captureWrittenChild },
                    );
                    for (const writeResult of returnedWriteResults) {
                        if (writeResults.some((captured) => captured.name === writeResult.name)) continue;
                        writeResults.push(writeResult);
                        const staged = await loadPlan(cwd, writeResult.name);
                        if (staged?.revision) stagedWriteRevisions.set(writeResult.name, staged.revision);
                    }
                }

                const children = (await findPlansByParent(cwd, planName)).filter((child) =>
                    isPlannedChangeClassification(child.attrs.classification),
                );
                if (children.length === 0) {
                    throw new Error("At least one child planned change plan is required to finalize decomposition.");
                }

                const childNames = children.map((child) => child.name);
                const writeSummary =
                    writeResults.length === 0
                        ? "No child planned change drafts were written."
                        : writeResults.map((writeResult) => `${writeResult.action}: ${writeResult.name}`).join("\n");

                if (epic.attrs.status === "ready_for_work") {
                    return {
                        updated: epic.attrs,
                        children,
                        childNames,
                        writeResults,
                        writeSummary,
                        alreadyReady: true,
                    };
                }

                const updated = await recordPlanEvent({
                    cwd,
                    planName,
                    event: "decomposition_finalized",
                    currentStatus: epic.attrs.status,
                    details: { triageMeta: epic.attrs },
                });
                return { updated, children, childNames, writeResults, writeSummary, alreadyReady: false };
            })();
        } catch (error) {
            const createdResults = writeResults.filter(
                (writeResult) => writeResult.action === "created" && typeof writeResult.path === "string",
            );
            for (const writeResult of createdResults) {
                const stagedRevision = stagedWriteRevisions.get(writeResult.name);
                const current = await loadPlan(cwd, writeResult.name).catch(() => null);
                if (!stagedRevision || !current || current.revision !== stagedRevision) continue;
                await fsRm(writeResult.path).catch(() => {});
            }
            for (const snapshot of beforeSnapshots) {
                const stagedRevision = stagedWriteRevisions.get(snapshot.name);
                const current = await loadPlan(cwd, snapshot.name).catch(() => null);
                if (!current) {
                    await fsWriteFile(snapshot.path, snapshot.markdown, { flag: "wx" });
                    continue;
                }
                if (!stagedRevision) continue;
                await writePlanMarkdownWithRevision(snapshot.path, snapshot.markdown, stagedRevision);
            }
            throw error;
        }
    };
    const localOwner = inspectLocalHomeStore(cwd);
    const canonicalFinalize = async () => {
        const before = await loadPlan(cwd, planName);
        const writeResults = await authorPackageChildren(cwd, planName, descriptors, {}, true);
        const children = await findPlansByParent(cwd, planName);
        const updated = await loadPlan(cwd, planName);
        return {
            updated: updated!.attrs,
            children,
            childNames: children.map((child) => child.name),
            writeResults,
            writeSummary: writeResults.length
                ? writeResults.map((result) => `${result.action}: ${result.name}`).join("\n")
                : "No child planned change drafts were written.",
            alreadyReady: before?.attrs.status === "ready_for_work",
        };
    };
    return localOwner.kind === "local" || localOwner.kind === "empty"
        ? await withLocalProjectAction(cwd, canonicalFinalize)
        : await withPlanCatalogLock(cwd, async () => {
              const childDescriptors = descriptors;
              const plannedChildNames = await resolveChildPlanNames(cwd, planName, childDescriptors);
              const existingChildNames = (await findPlansByParent(cwd, planName)).map((child) => child.name);
              const transition = await runEpicDecompositionFinalizeTransition({
                  projectRoot: cwd,
                  planName,
                  resources: [
                      { kind: "catalog" },
                      { kind: "plan", id: planName },
                      ...existingChildNames.map((name) => ({
                          kind: "plan" as const,
                          id: name,
                      })),
                      ...plannedChildNames.map((name) => ({
                          kind: "plan" as const,
                          id: name,
                      })),
                  ],
                  finalize: async () => await runFinalizeBody(),
              });
              if (transition.status !== "committed") {
                  throw new Error(transition.message || `Epic decomposition transaction failed for ${planName}.`);
              }
              return transition.value as Awaited<ReturnType<typeof runFinalizeBody>>;
          });
}
