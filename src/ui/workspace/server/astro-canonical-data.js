// @ts-nocheck: Compiled Workspace injects its bundled adapter. Astro dev can fall back to a native dynamic import
import { stat } from "node:fs/promises";
import { getCwd } from "../../../constants.js";
// so both surfaces use the canonical adapter without reimplementing it.

import { isAstroDevelopmentMode } from "./astro-dev-mode.ts";

const ADAPTER_URL_KEY = Symbol.for("runwield.workspace.plan-adapter-url");
const ADAPTER_MODULE_KEY = Symbol.for("runwield.workspace.plan-adapter-module");
const DEV_WORKSPACES_KEY = Symbol.for("runwield.workspace.dev-memory-state");
const runtime = globalThis;
const ADAPTER_URL = runtime[ADAPTER_URL_KEY] || new URL("./plan-adapter.js", import.meta.url).href;
const devWorkspaces = runtime[DEV_WORKSPACES_KEY] ||= new Map();

async function workspaceAdapter() {
    if (runtime[ADAPTER_MODULE_KEY]) return runtime[ADAPTER_MODULE_KEY];
    const nativeImport = Function("specifier", "return import(specifier)");
    try {
        return await nativeImport(await devVersionedAdapterUrl(ADAPTER_URL));
    } catch (error) {
        const cwd = getCwd();
        if (!cwd) throw error;
        const sourceAdapterUrl = new URL("src/ui/workspace/server/plan-adapter.js", `file://${cwd}/`).href;
        return await nativeImport(await devVersionedAdapterUrl(sourceAdapterUrl));
    }
}

/** @param {string} url */
async function devVersionedAdapterUrl(url) {
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

/** @param {string} value */
async function sha256Hex(value) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** @param {string} cwd */
async function loadDevWorkspace(cwd) {
    let state = devWorkspaces.get(cwd);
    if (state) return state;
    const adapter = await workspaceAdapter();
    state = {
        plans: structuredClone(await adapter.loadPlanSummaries(cwd)),
        details: new Map(),
        workspaceKey: await sha256Hex(cwd),
    };
    devWorkspaces.set(cwd, state);
    return state;
}

/** @param {string} cwd @param {string} planId */
async function loadDevDetail(cwd, planId) {
    const adapter = await workspaceAdapter();
    const state = await loadDevWorkspace(cwd);
    const summary = state.plans.find((plan) => plan.planId === planId);
    if (!summary) throw new Error(`Plan not found for planId: ${planId}`);
    let resource = state.details.get(planId);
    if (!resource) {
        const loaded = await adapter.loadWorkspaceDetail(cwd, planId);
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

/** @param {string} cwd */
export async function loadCanonicalBoard(cwd) {
    const adapter = await workspaceAdapter();
    if (devMode()) {
        const state = await loadDevWorkspace(cwd);
        return {
            plans: state.plans,
            groups: adapter.buildBoardGroups(state.plans),
            screens: adapter.buildWorkspaceBoard(state.plans),
        };
    }
    return await adapter.loadBoard(cwd);
}

/** @param {string} cwd @param {string} planId @param {import('./plan-adapter.js').WorkspacePlanDetailOptions} [options] */
export async function loadCanonicalWorkspaceDetail(cwd, planId, options = {}) {
    const adapter = await workspaceAdapter();
    if (devMode() && !options.reviewOnly) return await loadDevDetail(cwd, planId);
    return await adapter.loadWorkspaceDetail(cwd, planId, options);
}

/**
 * @param {string} cwd
 * @param {string} planId
 * @param {unknown} payload
 */
export async function applyCanonicalDevLifecycleAction(cwd, planId, payload) {
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

/**
 * @param {string} cwd
 * @param {string} planId
 * @param {string} body
 * @param {string} expectedBodyHash
 */
export async function saveCanonicalDevPlanBody(cwd, planId, body, expectedBodyHash) {
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

/** @param {unknown} error */
export async function serializeCanonicalPlanError(error) {
    const adapter = await workspaceAdapter();
    return adapter.serializePlanError(error);
}
