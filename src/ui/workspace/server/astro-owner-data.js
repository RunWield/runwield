import { devDeliveryArtifact } from "./dev-delivery-fixture.ts";
/** @module ui/workspace/server/astro-owner-data */

import {
    DEV_OWNER_PROJECT,
    DEV_OWNER_WORKFLOW_PLAN,
    devOwnerPlanProgress,
    devOwnerProjects,
} from "./dev-owner-fixtures.ts";
import { currentWorkspaceCwd } from "./cwd.js";
import { listOwnerProjects, requireOwnerProjectRoot, sessionBelongsToOwnerProject } from "./owner-projects.ts";
import { loadCanonicalBoard, loadCanonicalWorkspaceDetail } from "./astro-canonical-data.js";
import { readSessionArtifact } from "../../../shared/session/read-session-artifact.ts";
import { isAstroDevelopmentMode } from "./astro-dev-mode.ts";

const BUNDLED_PLAN_ADAPTER_KEY = Symbol.for("runwield.workspace.plan-adapter-module");
// Production needs the bundled adapter; dev uses the canonical loader's native
// Deno import so Vite does not try to resolve Core's JSR imports through Node.
/** @type {Promise<typeof import("./project-artifacts.ts")> | undefined} */
let bundledProjectArtifacts;
if (!isAstroDevelopmentMode()) {
    Reflect.set(globalThis, BUNDLED_PLAN_ADAPTER_KEY, import("./plan-adapter.js"));
    bundledProjectArtifacts = import("./project-artifacts.ts");
}

export const OWNER_WORKSPACE_STORE_KEY = Symbol.for("runwield.workspace.owner-store");
export const OWNER_WORKSPACE_SESSION_CONTINUATION_KEY = Symbol.for("runwield.workspace.session-continuation");

/** @param {any} store */
export function setAstroOwnerWorkspaceStore(store) {
    /** @type {any} */ (globalThis)[OWNER_WORKSPACE_STORE_KEY] = store;
}

/** @param {any} sessionContinuation */
export function setAstroOwnerWorkspaceSessionContinuation(sessionContinuation) {
    /** @type {any} */ (globalThis)[OWNER_WORKSPACE_SESSION_CONTINUATION_KEY] = sessionContinuation;
}

/** @returns {any} */
export function getAstroOwnerWorkspaceStore() {
    return /** @type {any} */ (globalThis)[OWNER_WORKSPACE_STORE_KEY] || null;
}

/** @returns {any} */
export function getAstroOwnerWorkspaceSessionContinuation() {
    return /** @type {any} */ (globalThis)[OWNER_WORKSPACE_SESSION_CONTINUATION_KEY] || null;
}

export async function loadOwnerProjects() {
    const store = getAstroOwnerWorkspaceStore();
    if (!store && isAstroDevelopmentMode()) return devOwnerProjects();
    if (!store) throw new Error("Owner Workspace store is not available.");
    return await listOwnerProjects(store);
}

/** @param {string} projectId */
export async function loadOwnerProjectBoard(projectId) {
    const store = getAstroOwnerWorkspaceStore();
    if (!store && isAstroDevelopmentMode()) {
        return await loadCanonicalBoard(currentWorkspaceCwd());
    }
    if (!store) throw new Error("Owner Workspace store is not available.");
    const root = requireOwnerProjectRoot(store, projectId);
    return await loadCanonicalBoard(root);
}

/** @param {string} projectId @param {string} planId @param {import('./plan-adapter.js').WorkspacePlanDetailOptions} [options] */
export async function loadOwnerProjectPlanDetail(projectId, planId, options = {}) {
    const store = getAstroOwnerWorkspaceStore();
    if (!store && isAstroDevelopmentMode()) {
        return await loadCanonicalWorkspaceDetail(currentWorkspaceCwd(), planId, options);
    }
    if (!store) throw new Error("Owner Workspace store is not available.");
    const root = requireOwnerProjectRoot(store, projectId);
    return await loadCanonicalWorkspaceDetail(root, planId, options);
}

/** @param {string} projectId @param {string} planId @param {string | null} runwieldSessionId */
export async function loadOwnerProjectPlanProgress(projectId, planId, runwieldSessionId = null) {
    const store = getAstroOwnerWorkspaceStore();
    if (
        !store && isAstroDevelopmentMode() && projectId === DEV_OWNER_PROJECT.projectId &&
        planId === DEV_OWNER_WORKFLOW_PLAN.planId
    ) {
        return devOwnerPlanProgress();
    }
    if (!store) throw new Error("Owner Workspace store is not available.");
    const { loadOwnerPlanProgress } = await import("./owner-plan-progress.ts");
    return await loadOwnerPlanProgress(store, { projectId, planId, runwieldSessionId });
}

/** @param {string} projectId @param {string} artifactType @param {string} sourceId */
export async function loadOwnerProjectArtifact(projectId, artifactType, sourceId) {
    const store = getAstroOwnerWorkspaceStore();
    if (!store) throw new Error("Owner Workspace store is not available.");
    const root = requireOwnerProjectRoot(store, projectId);
    const module = isAstroDevelopmentMode()
        ? await Function("specifier", "return import(specifier)")(
            new URL("./project-artifacts.ts", import.meta.url).href,
        )
        : await bundledProjectArtifacts;
    return await module.readProjectArtifact(root, artifactType, sourceId);
}

/** @param {string} projectId @param {string} runwieldSessionId @param {string} artifactId */
export async function loadOwnerSessionArtifact(projectId, runwieldSessionId, artifactId) {
    const store = getAstroOwnerWorkspaceStore();
    if (
        !store && isAstroDevelopmentMode() && projectId === "dev-project" && runwieldSessionId === "fix-plan-evidence"
    ) {
        return devDeliveryArtifact(artifactId);
    }
    if (!store) throw new Error("Owner Workspace store is not available.");
    const root = requireOwnerProjectRoot(store, projectId);
    const session = store.getSessionById(runwieldSessionId);
    if (!session || !sessionBelongsToOwnerProject(store, session, projectId)) throw new Error("Session not found.");
    const artifact = store.listSessionArtifacts(runwieldSessionId)
        .find(
            /** @param {import('../../../shared/session/file-session-store-types.ts').SessionArtifactReference} candidate */
            (candidate) => candidate.artifactId === artifactId,
        );
    if (!artifact) throw new Error("Session artifact not found.");
    return await readSessionArtifact(root, artifact);
}
