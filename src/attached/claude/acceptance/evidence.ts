/** Local-only evidence. Summaries must not embed file contents, HTTP bodies, or model output. */
export type Json = null | boolean | number | string | Json[] | JsonMap;
export interface JsonMap {
    [key: string]: Json | undefined;
}

export const PHASES = [
    "initial",
    "stale-adapter",
    "installed",
    "inactive-before",
    "activated",
    "triaged",
    "plan-review",
    "plan-chat",
    "plan-change",
    "plan-feedback",
    "plan-killed",
    "plan-restored",
    "plan-approved",
    "implemented",
    "disabled",
    "uninstalled",
    "reinstalled",
    "ci-started",
    "ci-killed",
    "ci-resumed",
    "review-blocked",
    "code-review",
    "code-chat",
    "code-change",
    "code-approved",
    "delivered",
    "inactive-after",
] as const;
export type Phase = (typeof PHASES)[number];
export const REQUIRED_HOST_RUNS = [
    "stale-adapter",
    "inactive-before",
    "request",
    "disabled",
    "uninstalled",
    "inactive-after",
];
export interface CapturedFile {
    path: string;
    sha256: string;
    text?: string;
}
export interface GitState {
    branch: string;
    head: string;
    status: string;
    refs: Record<string, string>;
    parents: Record<string, string[]>;
}
export interface Snapshot {
    hostRun: string | null;
    files: CapturedFile[];
    git: GitState | null;
    ciRuns: string[] | null;
    ciFinished: string[] | null;
    errors: string[];
}
export interface ToolUse {
    run: string;
    toolId: string;
    operation: string;
    operationId: string | null;
    /** Local-only MCP arguments, retained only for review_reply provenance. */
    input?: JsonMap;
}
export interface ToolResult {
    run: string;
    toolId: string;
    body: Json;
}
export interface HostResult {
    run: string;
    success: boolean;
}
export interface PrivacyEvidence {
    leaks: string[];
    errors: string[];
}
export interface AcceptanceEvidence {
    metadata: JsonMap;
    snapshots: Partial<Record<Phase, Snapshot>>;
    tools: ToolUse[];
    toolResults: ToolResult[];
    hostResults: HostResult[];
    hostRuns: string[];
    http: JsonMap[];
    processes: JsonMap[];
    plugins: JsonMap[];
    shimArgv: string[][];
    modelProcesses: string[];
    proxyHosts: string[];
    privacy: PrivacyEvidence;
    errors: string[];
}
export interface CheckResult {
    id: string;
    outcome: "pass" | "fail";
    evidence: string[];
}
export interface AcceptanceSummary {
    schemaVersion: 1;
    outcome: "pass" | "fail" | "blocked";
    blockedPrerequisite?: string;
    testDate: string | null;
    claudeVersion: string | null;
    coreVersion: string | null;
    coreCommit: string | null;
    coreSourceDigest: string | null;
    coreSourceDirty: boolean | null;
    adapterContract: number | null;
    adapterVersion: string | null;
    activationAssessment: string | null;
    permissions: "bypass-in-throwaway" | null;
    checks: CheckResult[];
    provenance: { acceptedOperations: number; matchedOperations: number; httpRequests: number; shimCalls: number };
    proposedMatrixEntry: JsonMap | null;
}

export function field(value: Json | undefined, ...keys: string[]): Json | undefined {
    for (const key of keys) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
        value = value[key];
    }
    return value;
}
export function jsonMap(value: Json | undefined): JsonMap | null {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
