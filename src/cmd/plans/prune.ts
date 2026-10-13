import { parseArgs } from "../../shared/cli-args.ts";
import { CLI_BIN, getCwd } from "../../constants.js";
import { deleteArchivedPlanUnit } from "../../plan-store.js";
import {
    type ArchivedPlanUnit,
    collectArchivedPlanUnits,
    collectWorkRecordPlanIds,
    selectArchivedPlansForPrune,
} from "../../shared/plan-archive-retention.ts";
import { getPlanArchiveRetentionPolicy } from "../../shared/settings.js";

function printPruneHelp(): void {
    console.log(`Usage:
  ${CLI_BIN} plans prune [--dry-run] [--yes] [--help]

Deletes archived Plans that are covered by a Work Record and past the repository archive retention policy.`);
}

function confirm(message: string): boolean {
    const answer = globalThis.prompt(`${message}\nType yes to continue: `) || "";
    return /^(?:y|yes)$/i.test(answer.trim());
}

function printGroup(label: string, units: ArchivedPlanUnit[], includePaths = false): void {
    console.log(`${label}: ${units.length}`);
    for (const unit of units) {
        console.log(`  - ${unit.name}`);
        if (includePaths) {
            for (const path of unit.paths) console.log(`      ${path}`);
        }
    }
}

function isNotFoundPruneError(error: Error): boolean {
    return /Archived Plan not found/i.test(error.message);
}

export async function runPlansPruneCommand(argv: string[]): Promise<void> {
    const parsed = parseArgs(argv, {
        boolean: ["help", "dry-run", "yes"],
        alias: { h: "help" },
    });
    if (parsed.help) {
        printPruneHelp();
        return;
    }
    if (parsed._.length > 0) throw new Error(`Unexpected plans prune argument: ${String(parsed._[0])}`);

    const cwd = getCwd();
    const policy = getPlanArchiveRetentionPolicy(cwd);
    const selection = selectArchivedPlansForPrune({
        units: await collectArchivedPlanUnits(cwd),
        workRecordPlanIds: await collectWorkRecordPlanIds(cwd),
        policy,
        now: new Date(),
    });

    console.log(
        `[RunWield] Archived Plan prune policy: archiveRetentionDays=${policy.retentionDays}, archiveKeepLast=${policy.keepLast}`,
    );
    printGroup("Due", selection.due, true);
    printGroup("Spared by keepLast", selection.sparedByKeepLast);
    printGroup("Within retention", selection.withinRetention);
    printGroup("Ineligible", selection.ineligible);

    if (parsed["dry-run"]) {
        console.log("[RunWield] Dry run only. No archived Plans were deleted.");
        return;
    }
    if (selection.due.length === 0) {
        console.log("[RunWield] No archived Plans are due for pruning.");
        return;
    }
    if (!parsed.yes && !confirm(`Delete ${selection.due.length} archived Plan unit(s)?`)) {
        console.log("[RunWield] Archive prune canceled. No archived Plans were deleted.");
        return;
    }

    const failures: string[] = [];
    let deleted = 0;
    let skipped = 0;
    for (const unit of selection.due) {
        try {
            const removed = await deleteArchivedPlanUnit(cwd, unit.name);
            deleted += 1;
            console.log(`[RunWield] Deleted ${unit.name}`);
            for (const path of removed) console.log(`  ${path}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (error instanceof Error && isNotFoundPruneError(error)) {
                skipped += 1;
                console.log(`[RunWield] Skipped ${unit.name}: ${message}`);
                continue;
            }
            failures.push(`${unit.name}: ${message}`);
            console.error(`[RunWield] Failed ${unit.name}: ${message}`);
        }
    }
    console.log(`[RunWield] Pruned ${deleted} archived Plan unit(s); ${skipped} skipped; ${failures.length} failed.`);
    if (failures.length > 0) {
        throw new Error(`Archive prune failed for ${failures.length} unit(s): ${failures.join("; ")}`);
    }
}
