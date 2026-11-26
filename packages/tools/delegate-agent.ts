import { Type } from "typebox";

/** Every delegation mode, in the order the tool schema lists them. */
export const DELEGATION_MODES = Object.freeze(["read", "write"] as const);
export type DelegationMode = (typeof DELEGATION_MODES)[number];

const MODE_DESCRIPTIONS: Readonly<Record<DelegationMode, string>> = Object.freeze({
    read: "read for investigation/review",
    write: "write for one exclusive implementation task",
});

/** Build the tool schema from the host's permitted modes and registered roles. */
export function createDelegateAgentDefinition<Role extends string>(
    permittedModes: readonly DelegationMode[],
    roleIds: readonly Role[],
) {
    const modes = DELEGATION_MODES.filter((mode) => permittedModes.includes(mode));
    if (!modes.length) throw new Error("createDelegateAgentTool: delegationModes must allow at least one mode");
    const parameters = Type.Object(
        {
            mode: Type.Enum(modes, {
                description: `Delegation authority. Use ${modes.map((mode) => MODE_DESCRIPTIONS[mode]).join(" and ")}.`,
            }),
            role: Type.Optional(
                Type.Enum([...roleIds], {
                    description:
                        "Optional Delegated Agent Role. Omit (or use 'general') for an unspecialized delegate. Use 'verification-adversary' to have a read-only delegate attack a draft Plan's outcomes, steps, and verification claims with the cheapest counterfeit implementation; a role's authority ceiling can reduce the requested mode.",
                }),
            ),
            background: Type.Optional(
                Type.Boolean({ description: "Run a read-only delegate without waiting for its result." }),
            ),
            brief: Type.String({
                minLength: 1,
                maxLength: 12000,
                description:
                    "Self-contained bounded brief for the Delegated Agent. Include all paths, goals, constraints, and expected handoff details.",
            }),
        },
        { additionalProperties: false },
    );
    const modeGuidance =
        modes.length === DELEGATION_MODES.length
            ? "Use mode 'read' for investigation/review and mode 'write' for one exclusive synchronous implementation task."
            : `Only mode '${modes[0]}' is available to this Agent.`;
    const backgroundGuidance = modes.includes("read")
        ? " Set background: true for independent read-only work and inspect its final task result before relying on it."
        : "";
    return {
        name: "delegate_agent" as const,
        label: "Delegate Agent",
        description: `Run a bounded context-isolated Delegated Agent Session. ${modeGuidance}${backgroundGuidance}`,
        parameters,
    };
}

interface DelegationInput {
    mode: DelegationMode;
    role?: string;
    brief: string;
    background?: boolean;
}

interface DelegationRequest {
    mode: DelegationMode;
    role: string;
}

export type PreparedDelegation =
    | (DelegationRequest & { ok: true; brief: string })
    | (DelegationRequest & { ok: false; error: "brief_required" | "background_write_denied"; message: string });

/** Validate the requested delegation before the caller applies its role and authority rules. */
export function prepareDelegation(params: DelegationInput): PreparedDelegation {
    const mode = params.mode === "write" ? "write" : "read";
    const role = typeof params.role === "string" && params.role ? params.role : "general";
    const brief = typeof params.brief === "string" ? params.brief.trim() : "";
    if (!brief) {
        return { ok: false, mode, role, error: "brief_required", message: "Delegation failed: brief is required." };
    }
    if (params.background && mode === "write") {
        return {
            ok: false,
            mode,
            role,
            error: "background_write_denied",
            message: "Background delegation requires requested read mode.",
        };
    }
    return { ok: true, mode, role, brief };
}
