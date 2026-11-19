import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { mcpAliasFor } from "./mcp-bridge.ts";

/**
 * Maps a RunWield capability to a host-native tool name.
 * @typedef ToolMapEntry
 * @property {string[]} rwNames  RunWield canonical names displayed in the mapping.
 * @property {string}   nativeName  Corresponding host-native tool name.
 */
interface ToolMapEntry {
    rwNames: string[];
    nativeName: string;
}

const AGY_TOOL_MAP: ToolMapEntry[] = [
    { rwNames: ["bash"], nativeName: "run_command" },
    { rwNames: ["write", "write_docs"], nativeName: "write_to_file" },
    { rwNames: ["edit", "edit_docs"], nativeName: "replace_file_content" },
    { rwNames: ["read", "view"], nativeName: "view_file" },
];

const CLAUDE_TOOL_MAP: ToolMapEntry[] = [
    { rwNames: ["bash"], nativeName: "Bash" },
    { rwNames: ["write", "write_docs"], nativeName: "Write" },
    { rwNames: ["edit", "edit_docs"], nativeName: "Edit" },
    { rwNames: ["read", "view"], nativeName: "Read" },
];

const CODEX_TOOL_MAP: ToolMapEntry[] = [
    { rwNames: ["bash"], nativeName: "exec_command" },
    { rwNames: ["write", "write_docs", "edit", "edit_docs"], nativeName: "apply_patch" },
    { rwNames: ["read", "view"], nativeName: "exec_command" },
];

/** True when the entry is relevant to the declared tool set. */
function entryMatchesDeclared(entry: ToolMapEntry, declared: Set<string>): boolean {
    if (entry.rwNames.some((n) => declared.has(n))) return true;
    if (declared.has(entry.nativeName)) return true;
    // multi_file_edit is a bridged MCP tool, but its presence in declared tools
    // also signals that the agent can edit files natively.
    if (entry.rwNames.includes("edit") && declared.has("multi_file_edit")) return true;
    return false;
}

function buildToolMappingSection(map: ToolMapEntry[], declaredTools?: string[]): string {
    let entries = map;
    if (declaredTools) {
        const declared = new Set(declaredTools);
        entries = map.filter((entry) => entryMatchesDeclared(entry, declared));
        // Every agent can at minimum read files.
        if (entries.length === 0) {
            const readEntry = map.find((e) => e.rwNames.includes("read"));
            if (readEntry) entries = [readEntry];
        }
    }
    if (entries.length === 0) return "";
    return [
        "",
        "## Tool Name Mapping",
        "When RunWield prompts reference these names, use the corresponding native tool:",
        ...entries.map((entry) => {
            const rwLabel = entry.rwNames.map((n) => `\`${n}\``).join(", ");
            return `- ${rwLabel} -> \`${entry.nativeName}\``;
        }),
    ].join("\n");
}

export function buildBridgedToolPromptAppendix(
    bridgedTools: ToolDefinition[],
    hostName: "Claude Code" | "Codex" | "Antigravity CLI",
    declaredTools?: string[],
): string {
    const map = hostName === "Antigravity CLI" ? AGY_TOOL_MAP : hostName === "Codex" ? CODEX_TOOL_MAP : CLAUDE_TOOL_MAP;
    const toolMapping = buildToolMappingSection(map, declaredTools);

    const eligibleAliases = bridgedTools.map((tool) => mcpAliasFor(tool.name));
    if (eligibleAliases.length === 0) return toolMapping;

    const lines = [
        "",
        "## RunWield Bridged Tools (MCP)",
        "",
        "This session exposes these RunWield tools through the RunWield MCP server:",
        ...eligibleAliases.map((alias) => `- ${alias}`),
        "",
        `Use ${hostName} native tools for file, search, and shell work. Use RunWield Bridged Tools for memory, code intelligence, Work Record, user interview, and lifecycle work.`,
        "",
        "Calling a lifecycle tool is the only way to advance RunWield workflow state. Plain-text questions, " +
            'statements such as "done", or text that resembles a tool call have no workflow effect.',
        "",
        "If a task is blocked by missing credentials, permissions, or unavailable services, report the blocker in text " +
            "instead of calling a lifecycle completion tool.",
    ];
    if (eligibleAliases.includes("runwield_review_complete")) {
        const inspectionTools = eligibleAliases.includes("review_diff")
            ? "review_diff and the host's native file tools"
            : `${hostName} native file, search, and shell tools`;
        lines.push("", `Before calling runwield_review_complete, inspect the implementation with ${inspectionTools}.`);
    }
    return lines.join("\n") + toolMapping;
}
