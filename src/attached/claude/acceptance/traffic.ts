import { field, jsonMap, type JsonMap, type ToolUse, type ToolResult } from "./evidence.ts";

interface HostTraffic {
    tools: ToolUse[];
    results: ToolResult[];
}

/** Parse actual host message blocks, never objects embedded inside tool arguments or prose. */
export function readHostTraffic(message: JsonMap, run: string): HostTraffic {
    const tools: ToolUse[] = [],
        results: ToolResult[] = [];
    const content = field(message, "message", "content");
    if (!Array.isArray(content)) return { tools, results };
    for (const block of content) {
        const row = jsonMap(block);
        if (!row) continue;
        const name =
            typeof row.name === "string" ? /^mcp__(?:plugin_runwield_)?runwield__([a-z_]+)$/.exec(row.name) : null;
        if (message.type === "assistant" && row.type === "tool_use" && name && typeof row.id === "string") {
            const operationId = field(row.input, "operationId");
            tools.push({
                run,
                toolId: row.id,
                operation: name[1],
                operationId: typeof operationId === "string" ? operationId : null,
            });
        }
        if (message.type === "user" && row.type === "tool_result" && typeof row.tool_use_id === "string") {
            const contents =
                typeof row.content === "string"
                    ? [row.content]
                    : Array.isArray(row.content)
                      ? row.content
                            .map((item) => field(item, "text"))
                            .filter((text): text is string => typeof text === "string")
                      : [];
            for (const text of contents) {
                try {
                    results.push({ run, toolId: row.tool_use_id, body: JSON.parse(text) });
                } catch {
                    /* Non-JSON tool output cannot prove a structured Core result. */
                }
            }
        }
    }
    return { tools, results };
}
