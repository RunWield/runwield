import { mkdir as fsMkdir, readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
/**
 * @module tools/plan-safe-file-tools
 * Safety wrappers for Agent file tools that touch canonical Plan markdown.
 */

import { dirname, isAbsolute, join, relative } from "node:path";
import {
    atomicWriteTextFileIfAbsent,
    getPlanRevisionForText,
    withPlanCatalogLock,
    withPlanLock,
    writePlanMarkdownWithRevisionLocked,
} from "../plan-store.js";

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

export function isCanonicalPlanMarkdownPath(cwd: string, path: string): boolean {
    const absolute = isAbsolute(path) ? path : join(cwd, path);
    const rel = relative(cwd, absolute).replaceAll("\\", "/");
    return rel.startsWith("docs/plans/") && rel.endsWith(".md") && !rel.startsWith("docs/plans/archived/");
}

function planNameFromCanonicalMarkdownPath(cwd: string, path: string): string {
    const absolute = isAbsolute(path) ? path : join(cwd, path);
    const rel = relative(cwd, absolute).replaceAll("\\", "/");
    if (!rel.startsWith("docs/plans/") || !rel.endsWith(".md") || rel.startsWith("docs/plans/archived/")) {
        throw new Error(`Not a canonical Plan markdown path: ${path}`);
    }
    return rel.slice("docs/plans/".length, -".md".length);
}

function applySingleExactEdit(content: string, oldText: string, newText: string, path: string): string {
    if (!oldText) throw new Error(`oldText must not be empty for ${path}.`);
    const first = content.indexOf(oldText);
    if (first === -1) throw new Error(`oldText was not found in ${path}. It must match exactly.`);
    if (content.indexOf(oldText, first + 1) !== -1) {
        throw new Error(`oldText was found multiple times in ${path}. Add more context.`);
    }
    const next = content.slice(0, first) + newText + content.slice(first + oldText.length);
    if (next === content) throw new Error(`No changes made to ${path}. The replacement produced identical content.`);
    return next;
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
            if (path && isCanonicalPlanMarkdownPath(cwd, path)) {
                const absolute = isAbsolute(path) ? path : join(cwd, path);
                if (mode === "write") {
                    try {
                        const stat = await fsStat(absolute);
                        if (stat.isFile()) {
                            return {
                                content: [{
                                    type: "text",
                                    text:
                                        "Refusing to overwrite an existing Plan with the write tool. Re-read the Plan and use exact-text edit or multi_file_edit so RunWield can preserve concurrent Plan changes.",
                                }],
                                isError: true,
                            };
                        }
                    } catch (error) {
                        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
                    }
                    const content = typeof params?.content === "string"
                        ? params.content
                        : typeof params?.text === "string"
                        ? params.text
                        : undefined;
                    if (content === undefined) {
                        return {
                            content: [{ type: "text", text: "Plan creation requires string content." }],
                            isError: true,
                        };
                    }
                    try {
                        await withPlanCatalogLock(
                            cwd,
                            async () =>
                                await withPlanLock(cwd, planNameFromCanonicalMarkdownPath(cwd, path), async () => {
                                    try {
                                        await fsStat(absolute);
                                        throw new Error(`Plan already exists: ${path}`);
                                    } catch (error) {
                                        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
                                            throw error;
                                        }
                                    }
                                    await fsMkdir(dirname(absolute), { recursive: true });
                                    await atomicWriteTextFileIfAbsent(absolute, content);
                                }),
                        );
                        return {
                            content: [{ type: "text", text: `Successfully created Plan ${path}.` }],
                            details: null,
                        };
                    } catch (error) {
                        return {
                            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
                            isError: true,
                        };
                    }
                }
                if (mode === "edit") {
                    try {
                        const oldText = typeof params?.oldText === "string" ? params.oldText : undefined;
                        const newText = typeof params?.newText === "string" ? params.newText : undefined;
                        if (oldText === undefined || newText === undefined) {
                            throw new Error("Plan edit requires path, oldText, and newText.");
                        }
                        const current = await fsReadFile(absolute, "utf8");
                        const expectedRevision = await getPlanRevisionForText(current);
                        const next = applySingleExactEdit(current, oldText, newText, path);
                        await writePlanMarkdownWithRevisionLocked(
                            cwd,
                            planNameFromCanonicalMarkdownPath(cwd, path),
                            absolute,
                            next,
                            expectedRevision,
                        );
                        return {
                            content: [{ type: "text", text: `Successfully edited Plan ${path}.` }],
                            details: null,
                        };
                    } catch (error) {
                        return {
                            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
                            isError: true,
                        };
                    }
                }
            }
            return await originalExecute.call(tool, toolCallId, params, signal, onUpdate, ctx);
        },
    };
    // The wrapper adds guard results (`isError`) that the wrapped tool's own
    // narrow result type does not describe, so restore the tool's declared shape
    // for callers that register it alongside unwrapped Pi tools.
    return wrapped as unknown as T;
}
