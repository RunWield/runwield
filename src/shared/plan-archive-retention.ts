import { opendir as fsOpendir } from "node:fs/promises";
import { stat as fsStat } from "node:fs/promises";
import { join } from "node:path";
import { listArchivedPlans } from "../plan-store.js";
import { EPIC_ARTIFACT_FILE_NAMES, getArchivedEpicArtifactPath } from "./epic-artifacts.ts";
import { getPlanArchiveRetentionPolicy } from "./settings.js";
import { listWorkRecords } from "./work-records/store.js";

export type ArchiveRetentionPolicy = {
    retentionDays: number;
    keepLast: number;
};

export type ArchivedPlanUnit = {
    name: string;
    planId: string | undefined;
    archivedAt: string | null | undefined;
    paths: string[];
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
        return byTime === 0 ? a.name.localeCompare(b.name) : byTime;
    });
    const sparedByKeepLast = newestFirst.slice(0, args.policy.keepLast);
    const candidates = newestFirst.slice(args.policy.keepLast);
    const due = candidates.filter((unit) => isPastRetention(unit, args.policy, args.now));
    const withinRetention = candidates.filter((unit) => !isPastRetention(unit, args.policy, args.now));
    return { due, sparedByKeepLast, withinRetention, ineligible };
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await fsStat(path);
        return true;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
    }
}

function projectRelativePath(projectRoot: string, path: string): string {
    return path.startsWith(projectRoot) ? path.slice(projectRoot.length + 1).replaceAll("\\", "/") : path;
}

export async function collectArchivedPlanUnits(cwd: string): Promise<ArchivedPlanUnit[]> {
    const archivedPlans = await listArchivedPlans(cwd);
    const topLevelPlans = new Map(
        archivedPlans.filter((plan) => !plan.name.includes("/")).map((plan) => [
            plan.name,
            plan,
        ]),
    );
    const names = new Set<string>(topLevelPlans.keys());
    const archivedDir = join(cwd, "docs", "plans", "archived");
    try {
        for await (const entry of await fsOpendir(archivedDir)) {
            if (entry.isFile() && entry.name.endsWith(".md")) names.add(entry.name.slice(0, -3));
            if (entry.isDirectory()) names.add(entry.name);
        }
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
    }

    const units: ArchivedPlanUnit[] = [];
    for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
        const parent = topLevelPlans.get(name);
        const paths = new Set<string>();
        const parentPath = join(archivedDir, `${name}.md`);
        if (await pathExists(parentPath)) paths.add(projectRelativePath(cwd, parentPath));
        const childDir = join(archivedDir, name);
        try {
            for await (const entry of await fsOpendir(childDir)) {
                if (entry.isFile() && entry.name.endsWith(".md")) {
                    paths.add(projectRelativePath(cwd, join(childDir, entry.name)));
                }
            }
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        for (const artifactName of EPIC_ARTIFACT_FILE_NAMES) {
            const artifactPath = getArchivedEpicArtifactPath(cwd, name, artifactName);
            if (await pathExists(artifactPath)) paths.add(projectRelativePath(cwd, artifactPath));
        }
        units.push({
            name,
            planId: parent?.planId,
            archivedAt: parent?.attrs.archivedAt,
            paths: [...paths].sort((a, b) => a.localeCompare(b)),
        });
    }
    return units;
}

export async function collectWorkRecordPlanIds(cwd: string): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const record of await listWorkRecords(cwd, { createDir: false })) {
        for (const planId of record.attrs.provenance?.sourcePlans || []) ids.add(planId);
    }
    return ids;
}

export async function formatArchiveRetentionNudge(cwd: string): Promise<string | null> {
    try {
        const selection = selectArchivedPlansForPrune({
            units: await collectArchivedPlanUnits(cwd),
            workRecordPlanIds: await collectWorkRecordPlanIds(cwd),
            policy: getPlanArchiveRetentionPolicy(cwd),
            now: new Date(),
        });
        if (selection.due.length === 0) return null;
        const noun = selection.due.length === 1 ? "Plan is" : "Plans are";
        return `${selection.due.length} archived ${noun} past retention · run \`wld plans prune\``;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `Archive retention policy warning: ${message}`;
    }
}
