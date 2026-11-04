import { devDeliveryArtifact } from "./dev-delivery-fixture.ts";
/** @module ui/workspace/server/astro-owner-data */

import {
    DEV_OWNER_PROJECT,
    DEV_OWNER_WORKFLOW_PLAN,
    devOwnerPlanProgress,
    devOwnerProjects,
    devPlanCatalogVariant,
} from "./dev-owner-fixtures.ts";
import { currentWorkspaceCwd } from "./cwd.ts";
import { listOwnerProjects, requireOwnerProjectRoot, sessionBelongsToOwnerProject } from "./owner-projects.ts";
import { loadCanonicalBoard, loadCanonicalWorkspaceDetail, loadDevPlanCatalogBoard } from "./astro-canonical-data.js";
import { readSessionArtifact } from "../../../shared/session/read-session-artifact.ts";
import { isAstroDevelopmentMode } from "./astro-dev-mode.ts";

import type { OwnerCoordinationStore } from "../../../shared/owner-coordination/index.ts";
import type { createWorkspaceSessionContinuationService } from "./session-continuation.js";
import type { WorkspacePlanDetailOptions } from "./plan-adapter.js";

type OwnerPlanProgressLoader = (
    store: OwnerCoordinationStore,
    options: Parameters<typeof import("./owner-plan-progress.ts").loadOwnerPlanProgress>[1],
) => ReturnType<typeof import("./owner-plan-progress.ts").loadOwnerPlanProgress>;

type SessionContinuation = ReturnType<typeof createWorkspaceSessionContinuationService>;
type ProjectArtifactsModule = typeof import("./project-artifacts.ts");
type ProjectArtifactsImporter = (specifier: string) => Promise<ProjectArtifactsModule>;

interface OwnerWorkspaceGlobals {
    [OWNER_WORKSPACE_STORE_KEY]?: OwnerCoordinationStore | null;
    [OWNER_WORKSPACE_SESSION_CONTINUATION_KEY]?: SessionContinuation | null;
}

type OwnerWorkspaceRuntime = typeof globalThis & OwnerWorkspaceGlobals;

const BUNDLED_PLAN_ADAPTER_KEY = Symbol.for("runwield.workspace.plan-adapter-module");
// Production needs the bundled adapter; dev uses the canonical loader's native
// Deno import so Vite does not try to resolve Core's JSR imports through Node.
let bundledProjectArtifacts: Promise<ProjectArtifactsModule> | undefined;
if (!isAstroDevelopmentMode()) {
    Reflect.set(globalThis, BUNDLED_PLAN_ADAPTER_KEY, import("./plan-adapter.js"));
    bundledProjectArtifacts = import("./project-artifacts.ts");
}

export const OWNER_WORKSPACE_STORE_KEY = Symbol.for("runwield.workspace.owner-store");
export const OWNER_WORKSPACE_SESSION_CONTINUATION_KEY = Symbol.for("runwield.workspace.session-continuation");

export function setAstroOwnerWorkspaceStore(store: OwnerCoordinationStore | null) {
    (globalThis as OwnerWorkspaceRuntime)[OWNER_WORKSPACE_STORE_KEY] = store;
}

export function setAstroOwnerWorkspaceSessionContinuation(sessionContinuation: SessionContinuation | null) {
    (globalThis as OwnerWorkspaceRuntime)[OWNER_WORKSPACE_SESSION_CONTINUATION_KEY] = sessionContinuation;
}

export function getAstroOwnerWorkspaceStore() {
    return (globalThis as OwnerWorkspaceRuntime)[OWNER_WORKSPACE_STORE_KEY] || null;
}

export function getAstroOwnerWorkspaceSessionContinuation() {
    return (globalThis as OwnerWorkspaceRuntime)[OWNER_WORKSPACE_SESSION_CONTINUATION_KEY] || null;
}

export async function loadOwnerProjects() {
    const store = getAstroOwnerWorkspaceStore();
    if (!store && isAstroDevelopmentMode()) return devOwnerProjects();
    if (!store) throw new Error("Owner Workspace store is not available.");
    return await listOwnerProjects(store);
}

export async function loadOwnerProjectBoard(projectId: string, cookie: string | null = null) {
    const store = getAstroOwnerWorkspaceStore();
    if (!store && isAstroDevelopmentMode()) {
        const variant = devPlanCatalogVariant(cookie);
        if (variant && projectId === DEV_OWNER_PROJECT.projectId) return await loadDevPlanCatalogBoard(variant);
        return await loadCanonicalBoard(currentWorkspaceCwd());
    }
    if (!store) throw new Error("Owner Workspace store is not available.");
    const root = requireOwnerProjectRoot(store, projectId);
    return await loadCanonicalBoard(root);
}

export async function loadOwnerProjectPlanDetail(
    projectId: string,
    planId: string,
    options: WorkspacePlanDetailOptions = {},
) {
    const store = getAstroOwnerWorkspaceStore();
    if (!store && isAstroDevelopmentMode()) {
        return await loadCanonicalWorkspaceDetail(currentWorkspaceCwd(), planId, options);
    }
    if (!store) throw new Error("Owner Workspace store is not available.");
    const root = requireOwnerProjectRoot(store, projectId);
    return await loadCanonicalWorkspaceDetail(root, planId, options);
}

export async function loadOwnerProjectPlanProgress(
    projectId: string,
    planId: string,
    runwieldSessionId: string | null = null,
) {
    const store = getAstroOwnerWorkspaceStore();
    if (
        !store &&
        isAstroDevelopmentMode() &&
        projectId === DEV_OWNER_PROJECT.projectId &&
        planId === DEV_OWNER_WORKFLOW_PLAN.planId
    ) {
        return devOwnerPlanProgress();
    }
    if (!store) throw new Error("Owner Workspace store is not available.");
    const { loadOwnerPlanProgress } = await import("./owner-plan-progress.ts");
    return await (loadOwnerPlanProgress as OwnerPlanProgressLoader)(store, { projectId, planId, runwieldSessionId });
}

export async function loadOwnerProjectArtifact(projectId: string, artifactType: string, sourceId: string) {
    const store = getAstroOwnerWorkspaceStore();
    if (!store) throw new Error("Owner Workspace store is not available.");
    const root = requireOwnerProjectRoot(store, projectId);
    const module = isAstroDevelopmentMode()
        ? await (Function("specifier", "return import(specifier)") as ProjectArtifactsImporter)(
              new URL("./project-artifacts.ts", import.meta.url).href,
          )
        : await bundledProjectArtifacts;
    return await module!.readProjectArtifact(root, artifactType, sourceId);
}

export async function loadOwnerSessionArtifact(projectId: string, runwieldSessionId: string, artifactId: string) {
    const store = getAstroOwnerWorkspaceStore();
    if (
        !store &&
        isAstroDevelopmentMode() &&
        projectId === "dev-project" &&
        runwieldSessionId === "fix-plan-evidence"
    ) {
        return devDeliveryArtifact(artifactId);
    }
    if (!store) throw new Error("Owner Workspace store is not available.");
    const root = requireOwnerProjectRoot(store, projectId);
    const session = store.getSessionById(runwieldSessionId);
    if (!session || !sessionBelongsToOwnerProject(store, session, projectId)) throw new Error("Session not found.");
    const artifact = store
        .listSessionArtifacts(runwieldSessionId)
        .find((candidate) => candidate.artifactId === artifactId);
    if (!artifact) throw new Error("Session artifact not found.");
    return await readSessionArtifact(root, artifact);
}
