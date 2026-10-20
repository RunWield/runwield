/**
 * @module shared/work-records/schema
 * Canonical Work Record schema constants and types.
 */

import type { TicketReference } from "../ticket-references.js";

export const WORK_RECORD_KIND = "work_record";

export const WORK_RECORD_STATUSES = Object.freeze(["pending_verification", "draft", "approved", "superseded"]);

export const WORK_RECORD_SCOPES = Object.freeze(["planned_change", "feature", "epic", "quick_fix"]);
export const WORK_RECORD_ORIGINS = Object.freeze(["internal", "external"]);
export const WORK_RECORD_COMPLETION_MODES = Object.freeze([
    "verified",
    "closed_without_verification",
    "user_verified",
    "done_enough",
]);

export const WORK_RECORD_OPTIONAL_SECTION_TITLES = Object.freeze([
    "Deviations from Plan",
    "Out of Scope",
    "Deferred Work",
    "Future Planning Notes",
    "Required Record Notes",
]);

export const WORK_RECORD_FRONT_MATTER_KEYS = Object.freeze({
    kind: "kind",
    recordId: "recordId",
    status: "status",
    scope: "scope",
    workKind: "workKind",
    origin: "origin",
    completionMode: "completionMode",
    createdAt: "createdAt",
    tickets: "tickets",
    archivedAt: "archivedAt",
    supersedes: "supersedes",
    supersededBy: "supersededBy",
    supersessionProposal: "supersessionProposal",
    provenance: "provenance",
});

export const WORK_RECORD_FRONT_MATTER_KEY_ORDER = Object.freeze(Object.values(WORK_RECORD_FRONT_MATTER_KEYS));

export type WorkRecordStatus = "pending_verification" | "draft" | "approved" | "superseded";
export type WorkRecordScope = "planned_change" | "feature" | "epic" | "quick_fix";
export type WorkRecordOrigin = "internal" | "external";
export type WorkRecordCompletionMode = "verified" | "closed_without_verification" | "user_verified" | "done_enough";
export type WorkRecordWorkKind = "BUG_FIX" | "FEATURE" | "REFACTOR" | "MAINTENANCE" | "DOCUMENTATION";

export interface WorkRecordEvidence {
    path: string;
    note: string;
}

export interface WorkRecordProvenance {
    sourcePlans?: string[];
    evidence?: WorkRecordEvidence[];
}

export interface WorkRecordSupersessionCandidate {
    recordId: string;
    reason: string;
}

export interface WorkRecordSupersessionProposal {
    candidates: WorkRecordSupersessionCandidate[];
}

export interface WorkRecordFrontMatter {
    kind: typeof WORK_RECORD_KIND;
    recordId: string;
    status: WorkRecordStatus;
    scope: WorkRecordScope;
    workKind?: WorkRecordWorkKind;
    origin: WorkRecordOrigin;
    completionMode: WorkRecordCompletionMode;
    createdAt: string;
    tickets?: TicketReference[];
    archivedAt?: string;
    supersedes?: string | string[];
    supersededBy?: string;
    supersessionProposal?: WorkRecordSupersessionProposal;
    provenance?: WorkRecordProvenance;
}

export interface WorkRecordSections {
    title: string;
    summary: string;
    optional: Record<string, string>;
}

export interface WorkRecordResource {
    attrs: WorkRecordFrontMatter;
    body: string;
    markdown: string;
    title: string;
    summary: string;
    sections: Record<string, string>;
    path: string;
    relativePath: string;
}

export function isWorkRecordStatus(value: string | null | undefined): value is WorkRecordStatus {
    return typeof value === "string" && WORK_RECORD_STATUSES.includes(value);
}

export function isWorkRecordScope(value: string | null | undefined): value is WorkRecordScope {
    return typeof value === "string" && WORK_RECORD_SCOPES.includes(value);
}

export function isWorkRecordOrigin(value: string | null | undefined): value is WorkRecordOrigin {
    return typeof value === "string" && WORK_RECORD_ORIGINS.includes(value);
}

export function isWorkRecordCompletionMode(value: string | null | undefined): value is WorkRecordCompletionMode {
    return typeof value === "string" && WORK_RECORD_COMPLETION_MODES.includes(value);
}
