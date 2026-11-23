import type { DelegationMode } from "@runwield/tools";
import type { FrontMatterValue } from "@runwield/parsing/front-matter";

/**
 * Tools present for every user-facing Agent and protected from runtime narrowing.
 * Isolated Subagent definitions do not receive this list.
 */
const UNIVERSAL_AGENT_TOOL_NAMES: readonly string[] = Object.freeze(["set_session_name"]);

/**
 * Tools protected from removal when they are present in an agent's bundled frontmatter.
 */
const PROTECTED_TOOL_NAMES: readonly string[] = Object.freeze([
    // memory
    "memory",
    // codebase exploration
    "code_search",
    "code_show",
    "code_outline",
    "code_batch",
    "code_refs",
    "code_impact",
    "code_trace",
    "code_investigate",
    "code_structure",
    "code_impls",
    "code_importers",
    // web access
    "web_search",
    "web_fetch",
    "web_code_search",
    "web_docs_search",
    // workflow tools
    "triage_report",
    "plan_written",
    "artifact_written",
    "review_complete",
    "qa_checklist_generated",
    "task_completed",
    "user_interview",
    "work_record_search",
    "work_record_read",
]);

/**
 * Agent-definition tool names that grant `delegate_agent` limited to one mode. Plain `delegate_agent` allows both.
 */
const DELEGATE_AGENT_MODE_TOOL_NAMES = Object.freeze({
    delegate_agent_read: "read",
    delegate_agent_write: "write",
} as const);

/**
 * Named tool groups an Agent definition can request with `toolSets` instead of
 * listing each tool. Keep these in sync when a tool is added to a family.
 */
const AGENT_TOOL_SETS: Readonly<Record<string, readonly string[]>> = Object.freeze({
    read: Object.freeze([
        "read",
        "grep",
        "find",
        "ls",
        "code_search",
        "code_show",
        "code_outline",
        "code_batch",
        "code_refs",
        "code_impact",
        "code_trace",
        "code_investigate",
        "code_structure",
        "code_impls",
        "code_importers",
        "memory",
        "user_interview",
        "work_record_search",
        "work_record_read",
        "delegate_agent_read",
    ]),
    write: Object.freeze(["edit", "write", "multi_file_edit", "delegate_agent_write"]),
    docs: Object.freeze(["write_docs", "edit_docs"]),
    shell: Object.freeze(["bash", "background_task"]),
    web: Object.freeze(["web_search", "web_fetch", "web_code_search", "web_docs_search"]),
});

/**
 * Expand `toolSets` front matter into the tool names of each named set.
 * Unknown names fail so a typo can't silently drop an Agent's tools.
 */
export function expandToolSets(value: FrontMatterValue | undefined, source: string): string[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || !value.every((name) => typeof name === "string")) {
        throw new Error(`${source}: toolSets must be a list of set names.`);
    }
    return value.flatMap((name) => {
        const setName = name.trim();
        if (!Object.hasOwn(AGENT_TOOL_SETS, setName)) {
            throw new Error(
                `${source}: unknown toolSets entry "${name}". Expected one of: ${Object.keys(AGENT_TOOL_SETS).join(", ")}.`,
            );
        }
        return AGENT_TOOL_SETS[setName];
    });
}

/** Trim and deduplicate non-empty tool names. */
export function normalizeToolNames(tools: FrontMatterValue | undefined): string[] {
    if (!Array.isArray(tools)) return [];

    const normalized: string[] = [];

    for (const tool of tools) {
        const toolName = typeof tool === "string" ? tool.trim() : "";
        if (!toolName) continue;
        if (!normalized.includes(toolName)) normalized.push(toolName);
    }

    return normalized;
}

/**
 * Resolve final requested tool names for a session while enforcing agent policy.
 *
 * - `toolNames` may narrow the agent's tool set but cannot add tools outside `agentTools`.
 * - `customToolNames` are always added (for user-provided dynamic/extension tools).
 */
export function selectTools(
    agentTools: readonly string[],
    toolNames?: readonly string[],
    customToolNames?: readonly string[],
): string[] {
    const normalizedAgentTools = normalizeToolNames(agentTools);
    const selectedToolNames = normalizeToolNames(toolNames || normalizedAgentTools);
    const normalizedCustomToolNames = normalizeToolNames(customToolNames);
    const allowedToolNames = new Set(normalizedAgentTools);
    const universalAgentToolNames = normalizedAgentTools.filter((toolName) =>
        UNIVERSAL_AGENT_TOOL_NAMES.includes(toolName),
    );

    const tools: string[] = [];
    for (const toolName of selectedToolNames) {
        if (!allowedToolNames.has(toolName)) continue;
        if (!tools.includes(toolName)) tools.push(toolName);
    }
    for (const toolName of universalAgentToolNames) {
        if (!tools.includes(toolName)) tools.push(toolName);
    }
    for (const toolName of normalizedCustomToolNames) {
        if (!tools.includes(toolName)) tools.push(toolName);
    }

    return tools;
}

interface ResolvedDelegationTools {
    /** Tool names with mode-limited delegation names folded into `delegate_agent`. */
    tools: string[];
    /** Allowed modes. An absent value allows all modes. */
    delegationModes: DelegationMode[] | undefined;
}

/**
 * Fold `delegate_agent_read` and `delegate_agent_write` into the one `delegate_agent` tool and record which modes
 * they allow. Plain `delegate_agent` keeps every mode.
 */
export function resolveRoleTools(merged: string[], bundled: string[]): ResolvedDelegationTools {
    const protectedTools = bundled.filter((toolName) => PROTECTED_TOOL_NAMES.includes(toolName));
    const tools = [...merged, ...protectedTools];
    const modes: DelegationMode[] = [];

    const resolved: string[] = [];
    for (const toolName of tools) {
        const mode = Object.hasOwn(DELEGATE_AGENT_MODE_TOOL_NAMES, toolName)
            ? DELEGATE_AGENT_MODE_TOOL_NAMES[toolName as keyof typeof DELEGATE_AGENT_MODE_TOOL_NAMES]
            : undefined;
        if (mode && !modes.includes(mode)) modes.push(mode);
        const name = mode ? "delegate_agent" : toolName;
        if (!resolved.includes(name)) resolved.push(name);
    }
    const unlimited = tools.includes("delegate_agent") || !modes.length;
    return { tools: resolved, delegationModes: unlimited ? undefined : modes };
}

export function addUniversalTools(tools: string[]): string[] {
    return [...new Set([...tools, ...UNIVERSAL_AGENT_TOOL_NAMES])];
}
