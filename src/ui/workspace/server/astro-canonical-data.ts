// Compiled Workspace injects its bundled adapter. Astro dev can fall back to a native dynamic import
import { stat } from "node:fs/promises";
import { getCwd } from "../../../constants.js";
// so both surfaces use the canonical adapter without reimplementing it.

import { isAstroDevelopmentMode } from "./astro-dev-mode.ts";

import type { PlanBodyResource, PlanResource } from "../../../plan-store.js";
import type { DevPlanCatalogVariant } from "./dev-owner-fixtures.ts";
import type { WorkspacePlanDetailOptions } from "./plan-adapter.js";

type WorkspaceAdapter = typeof import("./plan-adapter.js");
type WorkspaceAdapterImporter = (specifier: string) => Promise<WorkspaceAdapter>;
type WorkspaceCatalog = Awaited<ReturnType<WorkspaceAdapter["loadPlanSummaryCatalog"]>>;
type DevPlanSummary = Pick<PlanResource, "planId" | "attrs">;

interface DevPlanCapabilities {
    bodyEditing?: boolean;
}

interface DevPlanDetail extends Pick<PlanBodyResource, "attrs" | "body" | "markdown" | "bodyHash"> {
    frontMatter: PlanResource["attrs"];
    workspaceKey: string;
    capabilities?: DevPlanCapabilities;
}

interface DevWorkspaceState {
    plans: DevPlanSummary[];
    diagnostics: WorkspaceCatalog["diagnostics"];
    details: Map<string, DevPlanDetail>;
    workspaceKey: string;
}

interface CanonicalWorkspaceGlobals {
    [ADAPTER_URL_KEY]?: string;
    [ADAPTER_MODULE_KEY]?: WorkspaceAdapter | Promise<WorkspaceAdapter>;
    [DEV_WORKSPACES_KEY]?: Map<string, DevWorkspaceState>;
}

type CanonicalWorkspaceRuntime = typeof globalThis & CanonicalWorkspaceGlobals;

const ADAPTER_URL_KEY = Symbol.for("runwield.workspace.plan-adapter-url");
const ADAPTER_MODULE_KEY = Symbol.for("runwield.workspace.plan-adapter-module");
const DEV_WORKSPACES_KEY = Symbol.for("runwield.workspace.dev-memory-state");
const runtime: CanonicalWorkspaceRuntime = globalThis;
const ADAPTER_URL = runtime[ADAPTER_URL_KEY] || new URL("./plan-adapter.js", import.meta.url).href;
const devWorkspaces = (runtime[DEV_WORKSPACES_KEY] ||= new Map<string, DevWorkspaceState>());

async function workspaceAdapter(): Promise<WorkspaceAdapter> {
    if (runtime[ADAPTER_MODULE_KEY]) return runtime[ADAPTER_MODULE_KEY];
    const nativeImport = Function("specifier", "return import(specifier)") as WorkspaceAdapterImporter;
    try {
        return await nativeImport(await devVersionedAdapterUrl(ADAPTER_URL));
    } catch (error) {
        const cwd = getCwd();
        if (!cwd) throw error;
        const sourceAdapterUrl = new URL("src/ui/workspace/server/plan-adapter.js", `file://${cwd}/`).href;
        return await nativeImport(await devVersionedAdapterUrl(sourceAdapterUrl));
    }
}

async function devVersionedAdapterUrl(url: string) {
    if (!devMode() || !url.startsWith("file:")) return url;
    try {
        const info = await stat(new URL(url));
        const next = new URL(url);
        next.searchParams.set("workspace-dev-mtime", String(info.mtime?.getTime() || 0));
        return next.href;
    } catch {
        return url;
    }
}

function devMode() {
    return isAstroDevelopmentMode();
}

async function sha256Hex(value: string) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function loadDevWorkspace(cwd: string) {
    let state = devWorkspaces.get(cwd);
    if (state) return state;
    const adapter = await workspaceAdapter();
    const catalog = await adapter.loadPlanSummaryCatalog(cwd);
    state = {
        plans: structuredClone(catalog.plans),
        diagnostics: structuredClone(catalog.diagnostics),
        details: new Map<string, DevPlanDetail>(),
        workspaceKey: await sha256Hex(cwd),
    };
    devWorkspaces.set(cwd, state);
    return state;
}

async function loadDevDetail(cwd: string, planId: string): Promise<DevPlanDetail> {
    const adapter = await workspaceAdapter();
    const state = await loadDevWorkspace(cwd);
    const summary = state.plans.find((plan) => plan.planId === planId);
    if (!summary) throw new Error(`Plan not found for planId: ${planId}`);
    let resource = state.details.get(planId);
    if (!resource) {
        const loaded: DevPlanDetail = await adapter.loadWorkspaceDetail(cwd, planId);
        resource = {
            ...loaded,
            attrs: summary.attrs,
            frontMatter: summary.attrs,
            workspaceKey: state.workspaceKey,
        };
        state.details.set(planId, resource);
    }
    return adapter.projectWorkspaceDetail(resource, state.plans);
}

/** Fixture-only Board projection. Production and detail readers do not use it.
 */
export async function loadDevPlanCatalogBoard(variant: DevPlanCatalogVariant) {
    if (!devMode()) throw new Error("Development fixture is not available.");
    if (variant === "project-failure") throw new Error("Plans could not be loaded. Open Project settings.");
    const { devPlanCatalog } = await import("./dev-owner-fixtures.ts");
    const adapter = await workspaceAdapter();
    const catalog = devPlanCatalog(variant);
    return {
        ...catalog,
        groups: adapter.buildBoardGroups(catalog.plans),
        screens: adapter.buildWorkspaceBoard(catalog.plans),
    };
}

export async function loadCanonicalBoard(cwd: string) {
    const adapter = await workspaceAdapter();
    if (devMode()) {
        const state = await loadDevWorkspace(cwd);
        return {
            plans: state.plans,
            diagnostics: state.diagnostics,
            groups: adapter.buildBoardGroups(state.plans),
            screens: adapter.buildWorkspaceBoard(state.plans),
        };
    }
    return await adapter.loadBoard(cwd);
}

export async function loadCanonicalWorkspaceDetail(
    cwd: string,
    planId: string,
    options: WorkspacePlanDetailOptions = {},
) {
    const adapter = await workspaceAdapter();
    if (devMode() && !options.reviewOnly) return await loadDevDetail(cwd, planId);
    return await adapter.loadWorkspaceDetail(cwd, planId, options);
}

export async function applyCanonicalDevLifecycleAction<TPayload>(cwd: string, planId: string, payload: TPayload) {
    if (!devMode()) throw new Error("In-memory lifecycle actions are only available in Workspace dev mode.");
    const adapter = await workspaceAdapter();
    const state = await loadDevWorkspace(cwd);
    const index = state.plans.findIndex((plan) => plan.planId === planId);
    if (index < 0) throw new Error(`Plan not found for planId: ${planId}`);
    const result = adapter.applyWorkspaceLifecycleActionInMemory(state.plans[index], payload);
    state.plans[index] = result.plan;
    const cachedDetail = state.details.get(planId);
    if (cachedDetail) {
        state.details.set(planId, {
            ...cachedDetail,
            ...result.plan,
            attrs: result.plan.attrs,
            frontMatter: result.plan.attrs,
        });
    }
    return {
        plan: await loadDevDetail(cwd, planId),
        board: await loadCanonicalBoard(cwd),
        actions: adapter.ACTION_META,
        message: result.message,
    };
}

export async function saveCanonicalDevPlanBody(cwd: string, planId: string, body: string, expectedBodyHash: string) {
    if (!devMode()) throw new Error("In-memory body editing is only available in Workspace dev mode.");
    const adapter = await workspaceAdapter();
    const state = await loadDevWorkspace(cwd);
    const plan = await loadDevDetail(cwd, planId);
    if (plan.capabilities?.bodyEditing === false) {
        throw new Error("Epic Plan bodies are not editable in the workspace body editor.");
    }
    if (plan.bodyHash !== expectedBodyHash) throw new adapter.StalePlanBodyError(expectedBodyHash, plan.bodyHash);
    const bodyHash = await sha256Hex(body);
    const resource = {
        ...plan,
        body,
        bodyHash,
        markdown: body,
        attrs: plan.attrs,
        frontMatter: plan.attrs,
        workspaceKey: state.workspaceKey,
    };
    state.details.set(planId, resource);
    return adapter.projectWorkspaceDetail(resource, state.plans);
}

export async function serializeCanonicalPlanError<TError>(error: TError) {
    const adapter = await workspaceAdapter();
    return adapter.serializePlanError(error);
}
