/**
 * @module shared/session/active-agent-session
 *
 * Persists RunWield-specific root-agent state in Pi's append-only session stream.
 * Pi records model changes, but RunWield owns root-agent switching, so we store a
 * small custom marker that `/resume` can use for newer sessions.
 */

import { AGENTS } from "../../constants.ts";
import { loadAgentDef, normalizeAgentInternalName } from "./agents.ts";

export const ACTIVE_AGENT_CUSTOM_TYPE = "runwield.active_agent";
export const MANUAL_MODEL_CUSTOM_TYPE = "runwield.manual_model";

import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { MinimalSessionManagerLike } from "./hosted-session.js";

export type SessionEntryReader = Pick<MinimalSessionManagerLike, "getBranch" | "getEntries">;

export interface PersistedModelState {
    provider: string;
    model: string;
}

export interface ModelChangeEntry {
    type?: string;
    provider?: string;
    modelId?: string;
}

export interface PersistedActiveAgentState {
    agentName: string;
    displayName?: string;
}

/** Persisted custom data remains opaque until the existing field checks validate it. */
interface RawManualModelData {
    provider?: unknown;
    model?: unknown;
}

interface RawManualModelEntry {
    type?: string;
    customType?: string;
    data?: RawManualModelData;
}

interface RawActiveAgentData {
    agentName?: unknown;
    displayName?: unknown;
}

interface RawActiveAgentEntry {
    type?: string;
    customType?: string;
    data?: RawActiveAgentData;
}

export function recordManualModelSelection(
    sessionManager: SessionManager | undefined,
    provider: string,
    model: string,
) {
    if (!sessionManager?.appendCustomEntry || !model?.trim()) return;

    try {
        sessionManager.appendCustomEntry(MANUAL_MODEL_CUSTOM_TYPE, {
            provider: provider?.trim() || "",
            model: model.trim(),
        });
    } catch (_e) {
        // Manual-model persistence should never block model activation.
    }
}

/** When agentName is supplied, only return a choice owned by that active Agent. */
export function readPersistedManualModelState(
    sessionManager: SessionEntryReader | undefined,
    agentName?: string,
): PersistedModelState | null {
    const entries = getSessionEntries(sessionManager);
    let activeAgent = "";
    let selection: PersistedModelState | null = null;
    for (const entry of entries) {
        const recordedAgent = readAgentNameFromEntry(entry);
        if (recordedAgent) {
            const nextAgent = normalizeAgentInternalName(recordedAgent);
            // A manual choice belongs to one activation, not to the whole
            // transcript. Switching away and back must not resurrect it.
            if (activeAgent && nextAgent !== activeAgent) selection = null;
            activeAgent = nextAgent;
            continue;
        }
        if (!entry || typeof entry !== "object") continue;
        const typed = entry as RawManualModelEntry;
        if (typed.type !== "custom" || typed.customType !== MANUAL_MODEL_CUSTOM_TYPE) continue;
        if (typeof typed.data?.model !== "string" || !typed.data.model.trim()) continue;
        selection = {
            provider: typeof typed.data.provider === "string" ? typed.data.provider.trim() : "",
            model: typed.data.model.trim(),
        };
    }
    if (agentName && activeAgent && normalizeAgentInternalName(agentName) !== activeAgent) return null;
    return selection;
}

export function recordActiveAgent(sessionManager: SessionManager | undefined, agentName: string, displayName?: string) {
    if (!sessionManager?.appendCustomEntry || !agentName) return;

    try {
        const canonicalName = normalizeAgentInternalName(agentName);
        const latest = readPersistedActiveAgentName(sessionManager);
        if (latest && normalizeAgentInternalName(latest) === canonicalName) return;
        const trimmedDisplayName = typeof displayName === "string" ? displayName.trim() : "";
        sessionManager.appendCustomEntry(ACTIVE_AGENT_CUSTOM_TYPE, {
            agentName: canonicalName,
            ...(trimmedDisplayName ? { displayName: trimmedDisplayName } : {}),
        });
    } catch (_e) {
        // Active-agent persistence should never block session construction.
    }
}

export function readPersistedActiveAgentName(sessionManager: SessionEntryReader | null | undefined): string | null {
    const entries = getSessionEntries(sessionManager);

    for (let i = entries.length - 1; i >= 0; i--) {
        const agentName = readAgentNameFromEntry(entries[i]);
        if (agentName) return agentName;
    }

    return null;
}

export function readPersistedModelState(sessionManager: SessionManager | undefined): PersistedModelState | null {
    const entries = getSessionEntries(sessionManager);
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (!entry || typeof entry !== "object") continue;
        const typed = entry as ModelChangeEntry;
        if (typed.type !== "model_change" || !typed.modelId?.trim()) continue;
        return {
            provider: typed.provider?.trim() || "",
            model: typed.modelId.trim(),
        };
    }
    return null;
}

export async function resolveResumeAgentName(sessionManager: SessionManager | undefined): Promise<string> {
    const entries = getSessionEntries(sessionManager);
    const projectRoot = sessionManager?.getCwd?.();

    for (let i = entries.length - 1; i >= 0; i--) {
        const agentName = readAgentNameFromEntry(entries[i]);
        if (!agentName) continue;

        // Slicer is a persistent interactive workflow phase, but its definition
        // intentionally lives outside top-level Agent discovery. The Runtime
        // reconstructs its Epic-scoped definition and tools when this marker is
        // resumed, so do not skip back to the preceding Architect marker here.
        if (agentName.trim().toLowerCase() === AGENTS.SLICER) return AGENTS.SLICER;

        try {
            const agentDefinition = await loadAgentDef(agentName, projectRoot || undefined);
            return agentDefinition.name;
        } catch (_e) {
            // Keep scanning so a corrupt/stale marker does not hide the last
            // valid active agent recorded in this session.
        }
    }

    return AGENTS.ROUTER;
}

function getSessionEntries(sessionManager: SessionEntryReader | null | undefined): unknown[] {
    const entries = sessionManager?.getBranch?.() || sessionManager?.getEntries?.() || [];
    return Array.isArray(entries) ? entries : [];
}

export function readActiveAgentFromEntry(entry: unknown): PersistedActiveAgentState | null {
    if (!entry || typeof entry !== "object") return null;
    if ((entry as RawActiveAgentEntry).type !== "custom") return null;
    const customType = (entry as RawActiveAgentEntry).customType;
    if (customType !== ACTIVE_AGENT_CUSTOM_TYPE) return null;

    const data = (entry as RawActiveAgentEntry).data;
    const agentName = typeof data?.agentName === "string" ? data.agentName.trim() : "";
    if (!agentName) return null;
    const displayName = typeof data?.displayName === "string" ? data.displayName.trim() : "";
    return { agentName, ...(displayName ? { displayName } : {}) };
}

function readAgentNameFromEntry(entry: unknown): string {
    return readActiveAgentFromEntry(entry)?.agentName || "";
}
