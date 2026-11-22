import { toolRegistry, type CodeBatchOperation, type CodeBatchParams } from "@runwield/tools";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HelperBinaryExec } from "../helper-binary-exec.ts";

const codeBatch = toolRegistry.get("code_batch");

export interface CymbalToolHost {
    cwd: string;
    exec: HelperBinaryExec;
}

export const MAX_CODE_BATCH_OUTPUT_CHARS = 50_000;

interface CymbalSourceLine {
    line: number;
    content: string;
}

interface CymbalOutlineSymbol {
    name: string;
    kind: string;
    start_line: number;
    end_line: number;
    depth?: number;
}

interface CymbalShowResult {
    error?: string;
    file?: string;
    lines?: CymbalSourceLine[];
    match_count?: number;
    also?: CymbalSymbolLocation[];
}

interface CymbalSymbolLocation extends CymbalOutlineSymbol {
    file: string;
    rel_path?: string;
}

type CymbalBatchEntry = CymbalShowResult | CymbalOutlineSymbol[] | null;

interface CymbalBatchResponse {
    results: Record<string, CymbalBatchEntry>;
}

interface CymbalReadResult {
    text: string;
    isError: boolean;
}

interface CodeBatchItemDetails {
    operation: CodeBatchOperation;
    status: "success" | "error";
    truncated: boolean;
}

interface CodeBatchSection {
    text: string;
    details: CodeBatchItemDetails;
}

function codeBatchTarget(operation: CodeBatchOperation): string {
    return operation.op === "show" ? operation.target : operation.file;
}

function formatNativeBatchEntry(entry: CymbalBatchEntry, op: CodeBatchOperation["op"]): string {
    if (entry === null) return "No results found.";
    if (typeof entry !== "object") throw new Error("Invalid result entry");
    if (!Array.isArray(entry) && typeof entry.error === "string") return `Error: ${entry.error}`;
    if (op === "outline" && Array.isArray(entry)) {
        return (
            entry
                .map((symbol) => {
                    if (
                        !symbol ||
                        typeof symbol.name !== "string" ||
                        typeof symbol.kind !== "string" ||
                        !Number.isInteger(symbol.start_line) ||
                        !Number.isInteger(symbol.end_line)
                    )
                        throw new Error("Invalid outline symbol");
                    const depth = Number.isInteger(symbol.depth) ? Math.max(0, Math.min(symbol.depth ?? 0, 20)) : 0;
                    return `${"  ".repeat(depth)}${symbol.kind} ${symbol.name} (L${symbol.start_line}-${symbol.end_line})`;
                })
                .join("\n") || "No results found."
        );
    }
    if (op === "show" && !Array.isArray(entry) && typeof entry.file === "string" && Array.isArray(entry.lines)) {
        const lines = entry.lines.map((line) => {
            if (!line || !Number.isInteger(line.line) || typeof line.content !== "string") {
                throw new Error("Invalid source line");
            }
            return `${line.line}: ${line.content}`;
        });
        const result = [`file: ${entry.file}`, ...lines];
        if (typeof entry.match_count === "number" && entry.match_count > 1) {
            result.push(
                `\n${entry.match_count} matching definitions; showing the first. Use a file-qualified target to disambiguate.`,
            );
        }
        if (Array.isArray(entry.also)) {
            for (const symbol of entry.also) {
                if (!symbol || typeof symbol.file !== "string" || !Number.isInteger(symbol.start_line)) {
                    throw new Error("Invalid alternative definition");
                }
                result.push(`Also: ${symbol.rel_path || symbol.file}:${symbol.start_line}`);
            }
        }
        return result.join("\n");
    }
    throw new Error("Unexpected result shape");
}

function parseNativeBatchResults(
    output: CymbalReadResult,
    targets: string[],
    op: CodeBatchOperation["op"],
): Map<string, CymbalReadResult> {
    if (output.isError) return new Map(targets.map((target) => [target, output]));
    const results = new Map<string, CymbalReadResult>();
    let response: CymbalBatchResponse;
    try {
        response = JSON.parse(output.text);
        if (
            !response ||
            typeof response !== "object" ||
            !response.results ||
            typeof response.results !== "object" ||
            Array.isArray(response.results)
        )
            throw new Error("Missing results map");
    } catch {
        return new Map(
            targets.map((target) => [
                target,
                {
                    text: "Error: Cymbal returned invalid batch JSON.",
                    isError: true,
                },
            ]),
        );
    }
    for (const target of targets) {
        if (!Object.hasOwn(response.results, target)) {
            results.set(target, { text: "Error: Cymbal omitted this target from its batch response.", isError: true });
            continue;
        }
        try {
            const entry = response.results[target];
            results.set(target, {
                text: formatNativeBatchEntry(entry, op),
                isError: entry !== null && !Array.isArray(entry) && typeof entry.error === "string",
            });
        } catch {
            results.set(target, { text: "Error: Cymbal returned an invalid result for this target.", isError: true });
        }
    }
    return results;
}

export function validateCodeBatchParams(params: CodeBatchParams): string | null {
    if (!params || typeof params !== "object") return "code_batch requires an operations array.";
    if (!Array.isArray(params.operations)) return "code_batch requires an operations array.";
    if (params.operations.length === 0) return "code_batch requires at least one operation.";
    if (params.operations.length > codeBatch.maxOperations) {
        return `code_batch supports at most ${codeBatch.maxOperations} operations per call.`;
    }
    for (let i = 0; i < params.operations.length; i++) {
        const operation = params.operations[i];
        if (!operation || typeof operation !== "object") return `operations[${i}] must be an object.`;
        if (operation.op === "show") {
            if (typeof operation.target !== "string" || operation.target.trim().length === 0) {
                return `operations[${i}].target must be a non-empty string for show.`;
            }
            continue;
        }
        if (operation.op === "outline") {
            if (typeof operation.file !== "string" || operation.file.trim().length === 0) {
                return `operations[${i}].file must be a non-empty string for outline.`;
            }
            continue;
        }
        return `operations[${i}].op must be "show" or "outline".`;
    }
    return null;
}

export function getCodeBatchCymbalArgs(operation: CodeBatchOperation): string[] {
    return operation.op === "show" ? ["show", operation.target] : ["outline", operation.file];
}
export function getCodeBatchOperationLabel(operation: CodeBatchOperation): string {
    return operation.op === "show" ? `show ${operation.target}` : `outline ${operation.file}`;
}
function formatCodeBatchSection(
    index: number,
    operation: CodeBatchOperation,
    result: CymbalReadResult,
    budget: number,
): CodeBatchSection {
    const status = result.isError ? "error" : "success";
    const label = getCodeBatchOperationLabel(operation);
    // Keep unusually long targets from consuming the space reserved for status and content.
    const heading = label.length > 512 ? `${label.slice(0, 511)}…` : label;
    const prefix = `## ${index + 1}. ${heading}\nStatus: ${status}\n\n`;
    const body = result.text.trim() || "No results found.";
    const available = budget - prefix.length;
    const truncated = body.length > available;
    const marker = "\n\n[Result truncated. Use a narrower code_show or code_outline request.]";
    const text = prefix + (truncated ? body.slice(0, available - marker.length) + marker : body);
    return { text, details: { operation, status, truncated } };
}

export function createCymbalTools(host: CymbalToolHost): ToolDefinition[] {
    async function runCymbal(args: string[], signal?: AbortSignal): Promise<CymbalReadResult> {
        signal?.throwIfAborted();
        try {
            const result = await host.exec("cymbal", ["--no-federate", ...args], { cwd: host.cwd, signal });
            signal?.throwIfAborted();
            if (result.code !== 0) {
                const errText = result.stderr.trim() || result.stdout.trim();
                const cleanErr = errText.split("\nUsage:")[0].trim();
                return { text: `Error (exit ${result.code}): ${cleanErr}`, isError: true };
            }
            return { text: result.stdout || result.stderr || "", isError: false };
        } catch (error) {
            signal?.throwIfAborted();
            return {
                text: `Error running cymbal: ${error instanceof Error ? error.message : String(error)}`,
                isError: true,
            };
        }
    }
    async function runTool<Details>(args: string[], details: Details, signal?: AbortSignal) {
        const result = await runCymbal(args, signal);
        return {
            content: [{ type: "text" as const, text: result.text.trim() || "No results found." }],
            details,
            isError: result.isError,
        };
    }
    return [
        defineTool({
            ...toolRegistry.get("code_search").definition,
            async execute(_id, params, signal) {
                const args = ["search"];
                if (params.textSearch) args.push("--text");
                args.push(params.query);
                return await runTool(args, params, signal);
            },
        }),
        defineTool({
            ...toolRegistry.get("code_structure").definition,
            async execute(_id, params, signal) {
                return await runTool(["structure"], params, signal);
            },
        }),
        defineTool({
            ...toolRegistry.get("code_impls").definition,
            async execute(_id, params, signal) {
                return await runTool(["impls", params.symbol], params, signal);
            },
        }),
        defineTool({
            ...toolRegistry.get("code_importers").definition,
            async execute(_id, params, signal) {
                return await runTool(["importers", params.target], params, signal);
            },
        }),
        defineTool({
            ...toolRegistry.get("code_show").definition,
            async execute(_id, params, signal) {
                return await runTool(["show", params.target], params, signal);
            },
        }),
        defineTool({
            ...toolRegistry.get("code_outline").definition,
            async execute(_id, params, signal) {
                return await runTool(["outline", params.file], params, signal);
            },
        }),
        defineTool({
            ...codeBatch.definition,
            async execute(_id, params, signal) {
                const validationError = validateCodeBatchParams(params);
                if (validationError) {
                    return {
                        content: [{ type: "text" as const, text: validationError }],
                        details: { operationCount: 0, truncated: false, results: [] },
                        isError: true,
                    };
                }
                const groups = new Map<CodeBatchOperation["op"], CodeBatchOperation[]>();
                for (const operation of params.operations) {
                    const group = groups.get(operation.op) ?? [];
                    group.push(operation);
                    groups.set(operation.op, group);
                }
                const results = new Map<CodeBatchOperation["op"], Map<string, CymbalReadResult>>();
                for (const [op, operations] of groups) {
                    signal?.throwIfAborted();
                    const targets = [...new Set(operations.map(codeBatchTarget))];
                    if (targets.length === 1) {
                        results.set(
                            op,
                            new Map([[targets[0], await runCymbal(getCodeBatchCymbalArgs(operations[0]), signal)]]),
                        );
                    } else {
                        const output = await runCymbal(["--json", op, "--", ...targets], signal);
                        results.set(op, parseNativeBatchResults(output, targets, op));
                    }
                    signal?.throwIfAborted();
                }
                const separator = "\n\n---\n\n";
                const sectionBudget = Math.floor(
                    (MAX_CODE_BATCH_OUTPUT_CHARS - separator.length * (params.operations.length - 1)) /
                        params.operations.length,
                );
                const sections = params.operations.map((operation, index) =>
                    formatCodeBatchSection(
                        index,
                        operation,
                        results.get(operation.op)!.get(codeBatchTarget(operation))!,
                        sectionBudget,
                    ),
                );
                return {
                    content: [{ type: "text" as const, text: sections.map((section) => section.text).join(separator) }],
                    details: {
                        operationCount: params.operations.length,
                        truncated: sections.some((section) => section.details.truncated),
                        results: sections.map((section) => section.details),
                    },
                    isError: sections.every((section) => section.details.status === "error"),
                };
            },
        }),
        defineTool({
            ...toolRegistry.get("code_refs").definition,
            async execute(_id, params, signal) {
                return await runTool(["refs", params.symbol], params, signal);
            },
        }),
        defineTool({
            ...toolRegistry.get("code_impact").definition,
            async execute(_id, params, signal) {
                return await runTool(["impact", params.symbol], params, signal);
            },
        }),
        defineTool({
            ...toolRegistry.get("code_trace").definition,
            async execute(_id, params, signal) {
                return await runTool(["trace", params.symbol], params, signal);
            },
        }),
        defineTool({
            ...toolRegistry.get("code_investigate").definition,
            async execute(_id, params, signal) {
                return await runTool(["investigate", params.symbol], params, signal);
            },
        }),
    ];
}
