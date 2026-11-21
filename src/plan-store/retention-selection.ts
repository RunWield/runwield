import type { ArchivedPlanUnit } from "./archive-retention.ts";
export type ArchiveRetentionPolicy = {
    retentionDays: number;
    keepLast: number;
};

export type ArchivePruneSelection = {
    due: ArchivedPlanUnit[];
    sparedByKeepLast: ArchivedPlanUnit[];
    withinRetention: ArchivedPlanUnit[];
    ineligible: ArchivedPlanUnit[];
};

type SelectArchivedPlansForPruneArgs = {
    units: ArchivedPlanUnit[];
    workRecordPlanIds: Set<string>;
    policy: ArchiveRetentionPolicy;
    now: Date;
};

function archiveTime(unit: ArchivedPlanUnit): number {
    if (!unit.archivedAt) return Number.NEGATIVE_INFINITY;
    const timestamp = Date.parse(unit.archivedAt);
    return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function isPastRetention(unit: ArchivedPlanUnit, policy: ArchiveRetentionPolicy, now: Date): boolean {
    if (policy.retentionDays === 0) return true;
    const timestamp = archiveTime(unit);
    if (timestamp === Number.NEGATIVE_INFINITY) return true;
    return now.getTime() - timestamp >= policy.retentionDays * 24 * 60 * 60 * 1000;
}

export function selectArchivedPlansForPrune(args: SelectArchivedPlansForPruneArgs): ArchivePruneSelection {
    const ineligible: ArchivedPlanUnit[] = [];
    const eligible: ArchivedPlanUnit[] = [];
    for (const unit of args.units) {
        if (!unit.planId || !args.workRecordPlanIds.has(unit.planId)) {
            ineligible.push(unit);
            continue;
        }
        eligible.push(unit);
    }

    const newestFirst = eligible.toSorted((a, b) => {
        const byTime = archiveTime(b) - archiveTime(a);
        return byTime || a.name.localeCompare(b.name);
    });
    const sparedByKeepLast = newestFirst.slice(0, args.policy.keepLast);
    const candidates = newestFirst.slice(args.policy.keepLast);
    const pastRetention = candidates.filter((unit) => isPastRetention(unit, args.policy, args.now));
    const due = pastRetention.filter((unit) => !unit.protected);
    ineligible.push(...pastRetention.filter((unit) => unit.protected));
    const withinRetention = candidates.filter((unit) => !isPastRetention(unit, args.policy, args.now));
    return { due, sparedByKeepLast, withinRetention, ineligible };
}
