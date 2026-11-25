import { dirname, posix, resolve } from "node:path";
import { plans } from "@runwield/plans";
import { readCheckoutEpicArtifact } from "@runwield/plans/artifact-files";
import {
    PLANS_DIR_NAME,
    isEpicArtifactName,
    parsePlanArtifactReference,
    planArtifactReference,
    type PlanArtifactResource,
} from "@runwield/plans/format";
import { parseProjectId, type ProjectRegistry } from "@runwield/projects";
import { loadArchivedPlan, readPlanResourceCatalog } from "./queries.ts";
import { managedPlanStoreActive, readManagedDocument } from "./managed.ts";
import { readPlanDocuments, readPlanResource } from "./documents.ts";
import { readLocalHomeStore } from "./access.ts";
import { currentPackageProject } from "./workflows.ts";
import { openPlanStoreForCheckout } from "./project-plans.ts";
import { bindProjectPlanStore } from "./project-binding.ts";

type PlanSessionArtifactKind = "plan" | "epic-artifact";

export interface RegisteredPlanSessionProject {
    projectId: string;
    registry: ProjectRegistry;
}

export function planSessionArtifactAlias(planName: string): string {
    const name = planName.replaceAll("\\", "/");
    if (!name || name.startsWith("/") || name.split("/").some((part) => !part || part === "." || part === ".."))
        throw new Error("Invalid Plan artifact name.");
    return `${PLANS_DIR_NAME}/${name}.md`;
}

function artifactResult(
    cwd: string,
    planName: string,
    planId: string,
    resource: PlanArtifactResource,
    markdown: string,
) {
    const relativePath =
        resource === "context.md" ? planSessionArtifactAlias(planName) : `${PLANS_DIR_NAME}/${planName}/${resource}`;
    return {
        relativePath,
        sessionPath: planId ? planArtifactReference(planId, resource) : relativePath,
        markdown,
        imageBaseDir: dirname(resolve(cwd, relativePath)),
    };
}

/** Persisted Sessions may also contain ordinary file paths with the same display kind. */
export function isPlanSessionArtifactReference(path: string, kind: PlanSessionArtifactKind): boolean {
    const normalized = posix.normalize(path.replaceAll("\\", "/"));
    return (
        normalized.startsWith(`${PLANS_DIR_NAME}/`) ||
        (normalized.startsWith("plans/") &&
            (kind === "plan" ? normalized.endsWith("/context.md") : isEpicArtifactName(posix.basename(normalized))))
    );
}

/** Resolve registration against the authoritative source, never a stale delivery copy. */
export async function readPlanSessionArtifact(
    cwd: string,
    requestedPath: string,
    kind: PlanSessionArtifactKind,
    registration?: RegisteredPlanSessionProject,
) {
    if (registration) {
        const projectId = parseProjectId(registration.projectId);
        if (!projectId) throw new Error("Project not found.");
        const run = bindProjectPlanStore(projectId, { registry: registration.registry });
        return await run((root) => readPlanSessionArtifactForCheckout(root, requestedPath, kind), "workflow-read");
    }
    return await readPlanSessionArtifactForCheckout(cwd, requestedPath, kind);
}

async function readPlanSessionArtifactForCheckout(cwd: string, requestedPath: string, kind: PlanSessionArtifactKind) {
    const path = requestedPath.replaceAll("\\", "/");
    if (path.startsWith("/") || path.split("/").some((part) => part === ".." || part === "."))
        throw new Error("Plan artifact path must be a relative Plan resource.");
    const fileName = posix.basename(path);
    const artifactName = kind === "epic-artifact" && isEpicArtifactName(fileName) ? fileName : undefined;
    if (kind === "epic-artifact" && !artifactName) throw new Error("Unknown Epic artifact.");
    const resource = artifactName ?? "context.md";
    const planId = parsePlanArtifactReference(path, resource);
    return await readLocalHomeStore(
        cwd,
        async () => {
            if (planId && (currentPackageProject() || managedPlanStoreActive())) {
                const document = managedPlanStoreActive()
                    ? await readManagedDocument(planId, resource, cwd, "read")
                    : await readPlanDocuments(planId, resource);
                return artifactResult(cwd, document.planName, planId, resource, document.body);
            }
            const catalog = await readPlanResourceCatalog(cwd);
            const plan = catalog.resources.find((entry) =>
                planId
                    ? entry.planId === planId
                    : path ===
                          (artifactName
                              ? `${PLANS_DIR_NAME}/${entry.name}/${resource}`
                              : planSessionArtifactAlias(entry.name)) || path === `plans/${entry.planId}/${resource}`,
            );
            if (!plan && planId) {
                const archived = await loadArchivedPlan(cwd, planId, true);
                if (archived) {
                    const markdown = artifactName
                        ? await readCheckoutEpicArtifact(cwd, archived.name, artifactName, true)
                        : archived.body;
                    if (markdown != null) return artifactResult(cwd, archived.name, planId, resource, markdown);
                }
            }
            if (!plan) throw new Error("Plan artifact is not available in the authoritative Plan store.");
            if (!artifactName) {
                const document = await readPlanResource(cwd, { planId: plan.planId, planName: plan.name });
                return artifactResult(cwd, plan.name, plan.planId, resource, document.body);
            }
            let markdown: string | null | undefined;
            if (currentPackageProject() || managedPlanStoreActive()) {
                const planId = plans.identity.parse(plan.planId);
                if (!planId) throw new Error("Epic artifacts require a durable Plan ID.");
                markdown = (await openPlanStoreForCheckout(cwd)?.artifacts.read(planId, artifactName))?.body;
            } else {
                markdown = await readCheckoutEpicArtifact(cwd, plan.name, artifactName);
            }
            if (markdown == null) throw new Error("Epic artifact is not available in the authoritative Plan store.");
            return artifactResult(cwd, plan.name, plan.planId, resource, markdown);
        },
        () => {
            throw new Error("Plan artifact is not available in the authoritative Plan store.");
        },
    );
}
