/**
 * @module shared/work-records/lifecycle
 * V1 final-state-only Work Record lifecycle helpers.
 */

import type { WorkRecordFrontMatter } from "@runwield/plans/work-records";

export interface ArchiveWorkRecordOptions {
    now?: Date | string;
}

function iso(value: Date | string) {
    return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * @param attrs
 * @param options
 */
export function archiveWorkRecord(
    attrs: WorkRecordFrontMatter,
    options: ArchiveWorkRecordOptions = {},
): WorkRecordFrontMatter {
    return { ...attrs, archivedAt: iso(options.now || new Date()) };
}

export function restoreWorkRecord(attrs: WorkRecordFrontMatter): WorkRecordFrontMatter {
    const next = { ...attrs };
    delete next.archivedAt;
    return next;
}

/**
 * @param attrs
 * @param supersededBy
 */
export function supersedeWorkRecord(attrs: WorkRecordFrontMatter, supersededBy: string): WorkRecordFrontMatter {
    if (typeof supersededBy !== "string" || !supersededBy.trim()) {
        throw new Error("supersededBy must be a non-blank string to supersede a Work Record.");
    }
    const id = supersededBy.trim();
    if (id.toLowerCase() === attrs.recordId.toLowerCase()) throw new Error("A Work Record cannot supersede itself.");
    if (attrs.supersededBy && attrs.supersededBy.toLowerCase() !== id.toLowerCase()) {
        throw new Error(`Work Record ${attrs.recordId} is already superseded by ${attrs.supersededBy}.`);
    }
    return {
        ...attrs,
        status: "superseded",
        supersededBy: attrs.supersededBy || id,
    };
}

export function approveWorkRecord(attrs: WorkRecordFrontMatter): WorkRecordFrontMatter {
    return { ...attrs, status: "approved" };
}

export function markDraftWorkRecord(attrs: WorkRecordFrontMatter): WorkRecordFrontMatter {
    return { ...attrs, status: "draft" };
}

export function markPendingVerificationWorkRecord(attrs: WorkRecordFrontMatter): WorkRecordFrontMatter {
    return { ...attrs, status: "pending_verification" };
}
