// @ts-nocheck: shared from JS command code; JSDoc documents the public shape.
import { AGENTS } from "../../constants.ts";
import { getModelRegistry } from "../models/model-registry.ts";
import { parseProviderModel } from "../models/model-validation.ts";
import { getSettingsManager } from "../settings.js";
import { buildWorkflowOnlyAgentMessage, isWorkflowOnlyAgent, listAvailableAgents } from "./agents.ts";
import { getConfiguredAgentModel, getConfiguredAgentThinkingLevel } from "./session-runtime.ts";
import { setActiveSessionModel } from "./model-selection.ts";

/**
 * @typedef {Object} UserAgentOption
 * @property {string} name
 * @property {string} displayName
 * @property {string} description
 * @property {{ model: string, provider: string, thinkingLevel: string }} defaults
 */

/**
 * @typedef {Object} UserModelOption
 * @property {string} id
 * @property {string} name
 * @property {string} provider
 * @property {string} providerName
 * @property {string} executionBackend
 * @property {boolean} reasoning
 * @property {number} contextWindow
 */

/** @param {string | undefined} projectRoot @returns {Promise<UserAgentOption[]>} */
export async function listUserAgentOptions(projectRoot) {
    const settings = getSettingsManager(projectRoot);
    const defaultProvider = settings.getDefaultProvider?.() || "";
    const defaultModel = settings.getDefaultModel?.() || "";
    const defaultThinkingLevel = settings.getDefaultThinkingLevel?.() || "default";
    const root = projectRoot || "";
    const fallbackModel = getConfiguredAgentModel(AGENTS.ENGINEER, root) ||
        (defaultModel ? `${defaultProvider}/${defaultModel}` : "");
    const agents = await listAvailableAgents(projectRoot);
    return agents.map((agent) => {
        const reference = getConfiguredAgentModel(agent.name, root) || fallbackModel || agent.model || "";
        const parsed = parseProviderModel(reference);
        return {
            name: agent.name,
            displayName: agent.displayName || agent.name,
            description: agent.description || "",
            defaults: {
                model: parsed.ok ? parsed.id : "",
                provider: parsed.ok ? parsed.provider : "",
                thinkingLevel: getConfiguredAgentThinkingLevel(agent.name, root) ||
                    defaultThinkingLevel || agent.thinkingLevel || "default",
            },
        };
    });
}

/** @param {string | undefined} projectRoot @returns {Promise<UserAgentOption>} */
export async function getDefaultUserAgentOption(projectRoot) {
    const options = await listUserAgentOptions(projectRoot);
    const router = options.find((agent) => agent.name === AGENTS.ROUTER);
    if (router) return router;
    const first = options[0];
    if (first) return first;
    throw new Error("No user-selectable Agents are available for this Project.");
}

/** @param {string} agentName @param {string | undefined} projectRoot @returns {Promise<UserAgentOption>} */
export async function requireUserAgentOption(agentName, projectRoot) {
    const options = await listUserAgentOptions(projectRoot);
    const match = options.find((agent) => agent.name === agentName);
    if (match) return match;
    if (await isWorkflowOnlyAgent(agentName, projectRoot)) {
        throw new Error(buildWorkflowOnlyAgentMessage(agentName, projectRoot));
    }
    throw new Error(`Agent "${agentName}" not found`);
}

/**
 * @param {import('./session-runtime.ts').SessionRuntime} runtime
 * @param {string} sessionId
 * @param {string} agentName
 * @returns {Promise<{ ok: true, agentName: string } | { ok: false, error: string }>}
 */
export async function applyUserAgentSelection(runtime, sessionId, agentName) {
    const projectRoot = runtime.getSessionSnapshot(sessionId)?.cwd;
    let option;
    try {
        option = await requireUserAgentOption(agentName, projectRoot);
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    try {
        const result = await runtime.switchAgent(sessionId, {
            agentName: option.name,
            releaseActiveWorkflow: true,
        });
        if (!result?.ok) return { ok: false, error: result?.error || "Agent switch failed" };
        return { ok: true, agentName: option.name };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

/** @returns {Promise<UserModelOption[]>} */
export async function listUserModelOptions() {
    const registry = getModelRegistry();
    await registry.getRuntime();
    return registry.getSelectable().map((model) => ({
        id: model.id,
        name: model.name || model.id,
        provider: model.provider || "",
        providerName: registry.getProviderDisplayName(model.provider || ""),
        executionBackend: model.executionBackend || "pi",
        reasoning: model.reasoning === true,
        contextWindow: model.contextWindow,
    }));
}

/** @param {string} model @param {string | undefined} provider @returns {Promise<UserModelOption>} */
export async function requireUserModelOption(model, provider) {
    const selectedProvider = provider || "";
    const options = await listUserModelOptions();
    const match = options.find((item) => item.id === model && item.provider === selectedProvider);
    if (match) return match;
    throw new Error("Selected model is not available.");
}

/** @param {string} value @returns {{ provider: string, model: string }} */
export function parseUserModelSelection(value) {
    const parsed = parseProviderModel(value);
    if (!parsed.ok) throw new Error("Invalid model format. Use /model to switch.");
    return { provider: parsed.provider, model: parsed.id };
}

/**
 * @param {import('./session-runtime.ts').SessionRuntime} runtime
 * @param {string} sessionId
 * @param {string} model
 * @param {string} provider
 * @returns {Promise<{ ok: true, model: string, provider: string } | { ok: false, error: string }>}
 */
export async function applyUserModelSelection(runtime, sessionId, model, provider) {
    try {
        await requireUserModelOption(model, provider);
        const result = await setActiveSessionModel(runtime, sessionId, model, provider || "", {
            persistUnactivatedDefault: false,
        });
        if (result.status === "deferred") {
            return { ok: false, error: result.message || "Selected model could not be applied." };
        }
        return { ok: true, model, provider: provider || "" };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
