export const TUTORIAL_CONTEXT_CUSTOM_TYPE = "runwield.tutorial_context";
export const TUTORIAL_CONTEXT_VERSION = 1;

export type TutorialContext = {
    version: number;
    guidanceEnabled: boolean;
    shownExplanationIds: string[];
    recapShown: boolean;
    planId: string | null;
};

export type TutorialContextUpdate = Partial<TutorialContext>;

type TutorialContextCandidateValue = string | number | boolean | null | string[];

export type TutorialContextCandidate = {
    version?: TutorialContextCandidateValue;
    guidanceEnabled?: TutorialContextCandidateValue;
    shownExplanationIds?: TutorialContextCandidateValue;
    recapShown?: TutorialContextCandidateValue;
    planId?: TutorialContextCandidateValue;
};

type TutorialSessionEntry = {
    type?: string;
    customType?: string;
    data?: TutorialContextCandidate | null;
};

type TutorialSessionManager = Pick<
    import("./hosted-session.ts").MinimalSessionManagerLike,
    "getBranch" | "getEntries" | "appendCustomEntry"
>;

function isStringArray(value: TutorialContextCandidateValue | undefined): value is string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function normalizeTutorialContext(value: TutorialContextCandidate | null | undefined): TutorialContext | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (value.version !== TUTORIAL_CONTEXT_VERSION) return null;
    if (typeof value.guidanceEnabled !== "boolean" || typeof value.recapShown !== "boolean") return null;
    if (!isStringArray(value.shownExplanationIds)) return null;
    if (value.planId !== null && typeof value.planId !== "string") return null;

    const shownExplanationIds = [...new Set(value.shownExplanationIds.map((id) => id.trim()).filter(Boolean))];
    const planId = typeof value.planId === "string" && value.planId.trim() ? value.planId.trim() : null;
    return {
        version: TUTORIAL_CONTEXT_VERSION,
        guidanceEnabled: value.guidanceEnabled,
        shownExplanationIds,
        recapShown: value.recapShown,
        planId,
    };
}

function getEntries(sessionManager: TutorialSessionManager | null | undefined): TutorialSessionEntry[] {
    if (!sessionManager) return [];
    const entries = sessionManager.getBranch?.() || sessionManager.getEntries?.() || [];
    return Array.isArray(entries) ? entries as TutorialSessionEntry[] : [];
}

/** Latest matching entry is authoritative. An invalid latest entry fails closed. */
export function readPersistedTutorialContext(
    sessionManager: TutorialSessionManager | null | undefined,
): TutorialContext | null {
    try {
        const entries = getEntries(sessionManager);
        for (let index = entries.length - 1; index >= 0; index -= 1) {
            const entry = entries[index];
            if (entry.type !== "custom" || entry.customType !== TUTORIAL_CONTEXT_CUSTOM_TYPE) continue;
            return normalizeTutorialContext(entry.data);
        }
    } catch {
        // Tutorial context must not prevent Session reads.
    }
    return null;
}

export function recordTutorialContext(
    sessionManager: TutorialSessionManager | null | undefined,
    context: TutorialContextCandidate | null | undefined,
): TutorialContext | null {
    const normalized = normalizeTutorialContext(context);
    if (!normalized) return null;
    if (!sessionManager?.appendCustomEntry) return normalized;
    const current = readPersistedTutorialContext(sessionManager);
    if (tutorialContextsEqual(current, normalized)) return current;
    sessionManager.appendCustomEntry(TUTORIAL_CONTEXT_CUSTOM_TYPE, normalized);
    return normalized;
}

export function applyTutorialContextUpdate(
    current: TutorialContext | null,
    update: TutorialContextUpdate,
): TutorialContext | null {
    if (!update || typeof update !== "object" || Array.isArray(update)) return null;
    return normalizeTutorialContext({ ...(current || {}), ...update });
}

export function tutorialContextsEqual(left: TutorialContext | null, right: TutorialContext | null): boolean {
    return left?.version === right?.version &&
        left?.guidanceEnabled === right?.guidanceEnabled &&
        left?.recapShown === right?.recapShown &&
        left?.planId === right?.planId &&
        JSON.stringify(left?.shownExplanationIds || []) === JSON.stringify(right?.shownExplanationIds || []);
}
