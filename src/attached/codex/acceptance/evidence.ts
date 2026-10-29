/** Acceptance evidence never contains conversation text, credentials, or complete tool arguments. */
export type Json = null | boolean | number | string | Json[] | JsonMap;
export interface JsonMap {
    [key: string]: Json | undefined;
}
export type Surface = "cli" | "desktop-runtime";
export type EvidenceScope = "installed-protocol" | "source-skill";
export interface Check {
    id: string;
    outcome: "pass" | "fail" | "unproven";
    detail: string;
}
export interface HostObservation {
    run: string;
    kind: "start" | "exit" | "tool" | "worker" | "turn";
    threadId?: string;
    toolId?: string;
    operation?: string;
    workflowId?: string;
    revision?: number;
    actionId?: string;
    submittedActionId?: string;
    actionKind?: string;
    requestKind?: string;
    accepted?: boolean;
    rejection?: string;
    workerIds?: string[];
    workerOperation?: string;
    workerStatus?: string;
    freshContext?: boolean;
    requiredScope?: string;
    diffFileCount?: number;
    diffScope?: string;
    diffRead?: DiffRead;
    exitCode?: number | null;
}
export interface DiffRead {
    scope: string;
    path: string;
    start: number;
    end: number;
    totalBytes: number;
}
export interface SourceEvidence {
    commit: string;
    digest: string;
    dirty: boolean;
}
export interface AcceptanceSummary {
    schemaVersion: 1;
    outcome: "pass" | "fail" | "blocked";
    scope: EvidenceScope;
    surface: Surface;
    hostVersion: string | null;
    permissions: "protocol-tools-in-disposable-world" | "full-access-in-disposable-world";
    testDate: string;
    source: SourceEvidence | null;
    adapterVersion: string | null;
    adapterContract: number | null;
    blockedPrerequisite: string | null;
    checks: Check[];
    limitations: string[];
    /** Neither a metadata probe nor a direct-MCP journey qualifies a whole host version. */
    proposedMatrixEntry: null;
}
export function map(value: Json | undefined): JsonMap | null {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
export function field(value: Json | undefined, ...path: string[]): Json | undefined {
    for (const key of path) value = map(value)?.[key];
    return value;
}
export function text(value: Json | undefined): string | null {
    return typeof value === "string" && value.length ? value : null;
}
export function coreResult(result: JsonMap): JsonMap | null {
    const structured = map(result.structuredContent);
    if (structured) return structured;
    if (Array.isArray(result.content)) {
        for (const entry of result.content) {
            const content = field(entry, "text");
            if (typeof content !== "string") continue;
            try {
                const parsed = map(JSON.parse(content));
                if (parsed) return parsed;
            } catch {
                // Ordinary tool text is not workflow evidence.
            }
        }
    }
    return null;
}
/** Only the real transport's completed MCP item can supply lifecycle observations. */
export function toolObservation(run: string, threadId: string, item: JsonMap): HostObservation | null {
    if (!["mcp_tool_call", "mcpToolCall"].includes(String(item.type)) || item.server !== "runwield") return null;
    const operation = text(item.tool),
        toolId = text(item.id),
        result = map(item.result);
    if (!operation || !toolId || !result) return null;
    const body = coreResult(result);
    if (!body || typeof body.ok !== "boolean") return null;
    const action = map(field(body, "workflow", "nextAction"));
    const revision = body.revision ?? field(body, "workflow", "revision");
    const workflowId = text(body.workflowId) ?? text(field(body, "workflow", "workflowId"));
    const actionId = text(body.actionId) ?? text(action?.actionId);
    const submittedActionId = text(field(item, "arguments", "payload", "actionId"));
    const coverage = map(field(body, "diff", "coverage"));
    const remainingBytes = field(body, "diff", "details", "remainingBytes");
    const requiredScope = text(field(action, "request", "requiredScope"));
    const diffFileCount = field(body, "diff", "details", "fileCount");
    const diffScope = text(field(body, "diff", "details", "scope"));
    return {
        run,
        kind: "tool",
        threadId,
        toolId,
        operation,
        accepted: body.ok,
        ...(workflowId ? { workflowId } : {}),
        ...(typeof revision === "number" ? { revision } : {}),
        ...(actionId ? { actionId } : {}),
        ...(submittedActionId ? { submittedActionId } : {}),
        ...(requiredScope ? { requiredScope } : {}),
        ...(typeof diffFileCount === "number" ? { diffFileCount } : {}),
        ...(diffScope ? { diffScope } : {}),
        ...(coverage &&
        typeof coverage.scope === "string" &&
        typeof coverage.path === "string" &&
        typeof coverage.start === "number" &&
        typeof coverage.end === "number" &&
        typeof remainingBytes === "number"
            ? {
                  diffRead: {
                      scope: coverage.scope,
                      path: coverage.path,
                      start: coverage.start,
                      end: coverage.end,
                      totalBytes: coverage.end + remainingBytes,
                  },
              }
            : {}),
        ...(text(action?.kind) ? { actionKind: String(action?.kind) } : {}),
        ...(text(field(action, "request", "kind")) ? { requestKind: String(field(action, "request", "kind")) } : {}),
        ...(text(field(body, "rejection", "code")) ? { rejection: String(field(body, "rejection", "code")) } : {}),
    };
}
