/** Read-only submission and owned-work settlement evidence shared by local adapters. */
export interface OwnedWorkSettlement {
    status: "settled" | "unsettled";
    sessions: OwnedSessionSettlement[];
}
export interface OwnedSessionSettlement {
    sessionId: string;
    state: string;
    generation: number | null;
}
export type SubmissionKind = "prompt" | "bootstrap" | "steering";
export interface SubmissionLookup {
    projectId: string;
    runwieldSessionId?: string;
    requestId: string;
    kind: SubmissionKind;
    expectedGeneration: number;
}
export interface SubmissionRecordedResult {
    ok: boolean;
    queued?: boolean;
}
export interface SubmissionResolution {
    result: SubmissionRecordedResult | null;
    status: "no_receipt" | "accepted" | "unknown";
    sessionId: string | null;
    operationId: string | null;
    outcome: string | null;
    generation: number | null;
}
