/**
 * @module shared/work-records/list
 * Filtering and CLI formatting for canonical Work Records.
 */

import { currentWorkRecordOwner } from "./owner.ts";
import { formatPlannedWorkLabel } from "../../constants.js";
import type { WorkRecordResource } from "./schema.ts";

interface WorkRecordListOptions {
    includeAll?: boolean;
}

export function formatWorkRecordScopeLabel(scope: string, workKind?: string): string {
    if (scope === "planned_change" || scope === "feature") return formatPlannedWorkLabel(workKind);
    if (scope === "quick_fix") return "Quick fix";
    if (scope === "epic") return "Epic";
    return String(scope || "unknown");
}

export function isCurrentWorkRecord(record: WorkRecordResource): boolean {
    return record.attrs.status === "approved" && !record.attrs.archivedAt && !record.attrs.supersededBy;
}

export function filterWorkRecordsForList(
    records: WorkRecordResource[],
    options: WorkRecordListOptions = {},
): WorkRecordResource[] {
    const filtered = options.includeAll ? records : records.filter(isCurrentWorkRecord);
    return filtered.sort(
        (a, b) => b.attrs.createdAt.localeCompare(a.attrs.createdAt) || a.title.localeCompare(b.title),
    );
}

export function workRecordNotices(record: WorkRecordResource): string[] {
    const notices: string[] = [];
    if (record.attrs.completionMode === "closed_without_verification") {
        notices.push("WARNING: RunWield verification was skipped.");
    }
    if (record.attrs.completionMode === "user_verified") {
        notices.push("NOTICE: verification was attested by the user, not RunWield Workflow Validation.");
    }
    if (record.attrs.completionMode === "done_enough") {
        notices.push("NOTICE: PROJECT Epic was closed as done enough; deferred scope may remain.");
    }
    if (record.attrs.status !== "approved") notices.push(`WARNING: status is ${record.attrs.status}.`);
    if (record.attrs.archivedAt) notices.push(`WARNING: archived at ${record.attrs.archivedAt}.`);
    if (record.attrs.status === "superseded" || record.attrs.supersededBy) {
        notices.push(`WARNING: superseded${record.attrs.supersededBy ? ` by ${record.attrs.supersededBy}` : ""}.`);
    }
    if (record.attrs.supersessionProposal?.candidates.length) {
        notices.push(
            `NOTICE: supersession proposal pending for ${record.attrs.supersessionProposal.candidates
                .map((candidate) => candidate.recordId)
                .join(", ")}.`,
        );
    }
    return notices;
}

export function formatWorkRecordListEntry(record: WorkRecordResource): string {
    const sourcePlans = record.attrs.provenance?.sourcePlans || [];
    const evidence = record.attrs.provenance?.evidence || [];
    const lines = [
        `- ${record.title}`,
        `  recordId: ${record.attrs.recordId}`,
        `  status: ${record.attrs.status}`,
        `  work: ${formatWorkRecordScopeLabel(record.attrs.scope, record.attrs.workKind)}`,
        `  scope: ${record.attrs.scope}`,
        ...(record.attrs.workKind ? [`  workKind: ${record.attrs.workKind}`] : []),
        `  origin: ${record.attrs.origin}`,
        `  completionMode: ${record.attrs.completionMode}`,
    ];
    if (sourcePlans.length) lines.push(`  sourcePlans: ${sourcePlans.join(", ")}`);
    if (evidence.length) lines.push(`  evidence: ${evidence.map((entry) => entry.path).join(", ")}`);
    lines.push(`  path: ${currentWorkRecordOwner() ? record.path : record.relativePath}`);
    for (const notice of workRecordNotices(record)) lines.push(`  ${notice}`);
    return lines.join("\n");
}

export function formatWorkRecordList(records: WorkRecordResource[], options: WorkRecordListOptions = {}): string {
    const listed = filterWorkRecordsForList(records, options);
    if (!listed.length) {
        return options.includeAll ? "[RunWield] No Work Records found." : "[RunWield] No current Work Records found.";
    }
    const heading = options.includeAll ? "[RunWield] Work Records:" : "[RunWield] Current Work Records:";
    return [heading, "", ...listed.map(formatWorkRecordListEntry)].join("\n");
}
