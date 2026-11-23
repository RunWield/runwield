export type PlanDeviation = {
    id: string;
    supersededRequirement: string;
    replacementRequirement: string;
    reason?: string;
    approvedAt: string;
};

export type PlanDeviationInput = Partial<PlanDeviation> & { extra?: string };

export type PlanDeviationProposal = {
    id: string;
    supersededRequirement: string;
    replacementRequirement: string;
    reason?: string;
    approvedAt: string;
};

export type PlanDeviationAppendResult = {
    entry: PlanDeviation;
    entries: PlanDeviation[];
    alreadyCommitted: boolean;
};

const PLAN_DEVIATION_KEYS = ["id", "supersededRequirement", "replacementRequirement", "reason", "approvedAt"] as const;

function concreteText(value: string | undefined, fieldName: string): string {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`planDeviations ${fieldName} must be a non-blank string.`);
    }
    return value.trim();
}

function optionalReason(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw new Error("planDeviations reason must be a string when present.");
    const reason = value.trim();
    return reason ? reason : undefined;
}

function normalizePlanDeviationEntry(entry: PlanDeviationInput, index: number): PlanDeviation {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`planDeviations[${index}] must be an object.`);
    }
    const keys = Object.keys(entry);
    for (const key of keys) {
        if (!PLAN_DEVIATION_KEYS.includes(key as (typeof PLAN_DEVIATION_KEYS)[number])) {
            throw new Error(`planDeviations[${index}] has unsupported field ${key}.`);
        }
    }
    return {
        id: concreteText(entry.id, `[${index}].id`),
        supersededRequirement: concreteText(entry.supersededRequirement, `[${index}].supersededRequirement`),
        replacementRequirement: concreteText(entry.replacementRequirement, `[${index}].replacementRequirement`),
        ...(() => {
            const reason = optionalReason(entry.reason);
            return reason ? { reason } : {};
        })(),
        approvedAt: concreteText(entry.approvedAt, `[${index}].approvedAt`),
    };
}

export function normalizePlanDeviations(value: PlanDeviationInput[] | null | undefined): PlanDeviation[] | undefined {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value)) throw new Error("planDeviations must be an array.");
    return value.map((entry, index) => normalizePlanDeviationEntry(entry, index));
}

export function readPlanDeviations(value: PlanDeviationInput[] | null | undefined): PlanDeviation[] {
    return normalizePlanDeviations(value) || [];
}

export function appendPlanDeviation(
    current: PlanDeviationInput[] | null | undefined,
    proposal: PlanDeviationProposal,
): PlanDeviationAppendResult {
    const entries = readPlanDeviations(current);
    const existing = entries.find((entry) => entry.id === proposal.id);
    if (existing) return { entry: existing, entries, alreadyCommitted: true };
    const entry = normalizePlanDeviationEntry(proposal, entries.length);
    return { entry, entries: [...entries, entry], alreadyCommitted: false };
}

export function formatPlanDeviationForPrompt(entry: PlanDeviation, index: number): string {
    const lines = [
        `${index}. Superseded requirement: ${entry.supersededRequirement}`,
        `   Replacement requirement: ${entry.replacementRequirement}`,
    ];
    if (entry.reason) lines.push(`   Reason: ${entry.reason}`);
    lines.push(`   Approved at: ${entry.approvedAt}`);
    return lines.join("\n");
}

export function renderApprovedPlanDeviations(value: PlanDeviationInput[] | null | undefined): string {
    const entries = readPlanDeviations(value);
    if (!entries.length) return "";
    return [
        "## Approved Plan Deviations",
        "",
        "These user-confirmed replacements supersede conflicting original Plan text. The latest conflicting entry wins; all other Plan requirements remain active.",
        "",
        ...entries.map((entry, index) => formatPlanDeviationForPrompt(entry, index + 1)),
    ].join("\n");
}

export function renderPlanDeviationsForWorkRecord(value: PlanDeviationInput[] | null | undefined): string {
    const entries = readPlanDeviations(value);
    if (!entries.length) return "";
    return entries
        .map((entry, index) => {
            const lines = [
                `${index + 1}. Superseded requirement: ${entry.supersededRequirement}`,
                `   Replacement requirement: ${entry.replacementRequirement}`,
            ];
            if (entry.reason) lines.push(`   Reason: ${entry.reason}`);
            return lines.join("\n");
        })
        .join("\n");
}
