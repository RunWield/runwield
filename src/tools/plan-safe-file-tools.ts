import { operatePlanFile } from "../plan-store/index.ts";
export { isCanonicalPlanMarkdownPath } from "../plan-store/index.ts";

/** Result shape the wrapper returns for both its own guards and the wrapped tool. */
interface PlanSafeToolResult {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    details?: unknown;
}

/** Signature of the Pi file-tool `execute` this wrapper delegates to. */
type PlanFileToolExecute = (
    this: unknown,
    toolCallId: string,
    params: PlanFileToolParams,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
) => Promise<PlanSafeToolResult>;

/** The subset of Pi file-tool params these wrappers inspect. */
interface PlanFileToolParams {
    path?: unknown;
    file_path?: unknown;
    content?: unknown;
    text?: unknown;
    oldText?: unknown;
    newText?: unknown;
}

function stringValue(value: unknown): string {
    return typeof value === "string" && value.trim() ? value.trim() : "";
}

/**
 * Wrap a Pi file tool with conservative Plan-file overwrite protection.
 * Exact-text edit tools for canonical Plans are applied through Plan CAS so an
 * edit loaded from stale bytes cannot silently overwrite concurrent metadata.
 * Whole-file write must create a new Plan rather than overwrite an existing one.
 */
export function wrapPlanSafeFileTool<T extends { execute: unknown }>(
    tool: T,
    { cwd, mode }: { cwd: string; mode: "write" | "edit" },
): T {
    const originalExecute = tool.execute as PlanFileToolExecute;
    const wrapped = {
        ...tool,
        async execute(
            toolCallId: string,
            params: PlanFileToolParams,
            signal?: AbortSignal,
            onUpdate?: unknown,
            ctx?: unknown,
        ) {
            const path = stringValue(params?.path ?? params?.file_path);
            try {
                const result = await operatePlanFile(cwd, {
                    path,
                    mode,
                    content:
                        typeof params.content === "string"
                            ? params.content
                            : typeof params.text === "string"
                              ? params.text
                              : undefined,
                    oldText: typeof params.oldText === "string" ? params.oldText : undefined,
                    newText: typeof params.newText === "string" ? params.newText : undefined,
                });
                if (result) return { content: [{ type: "text", text: result.message }], details: null };
            } catch (error) {
                return {
                    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
                    isError: true,
                };
            }
            return await originalExecute.call(tool, toolCallId, params, signal, onUpdate, ctx);
        },
    };
    // The wrapper adds guard results (`isError`) that the wrapped tool's own
    // narrow result type does not describe, so restore the tool's declared shape
    // for callers that register it alongside unwrapped Pi tools.
    return wrapped as unknown as T;
}
