import { parseArgs } from "../../shared/cli-args.ts";
import { CLI_BIN, getCwd } from "../../constants.ts";
import {
    pendingPruneRequest,
    confirmPruneRequest,
    previewPlanRetention,
    type ArchivedPlanUnit,
} from "../../plan-store/index.ts";
function printPruneHelp(): void {
    console.log(`Usage:
  ${CLI_BIN} plans prune [--dry-run] [--yes] [--help]

Deletes confirmed archived Plan families with Work Record coverage under the Project retention policy.`);
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
    let approved = await pendingPruneRequest(cwd, "plans");
    if (approved) console.log(`[RunWield] Interrupted prune has ${approved.length} approved Plan unit(s) remaining.`);
    else {
        const selection = await previewPlanRetention(cwd);
        const policy = selection.policy;
        console.log(
            `[RunWield] Archived Plan prune policy: archiveRetentionDays=${policy.retentionDays}, archiveKeepLast=${policy.keepLast}`,
        );
        printGroup("Due", selection.due, true);
        printGroup("Spared by keepLast", selection.sparedByKeepLast);
        printGroup("Within retention", selection.withinRetention);
        printGroup("Ineligible", selection.ineligible);

        approved = selection.due.flatMap((unit) => (unit.token ? [{ token: unit.token, label: unit.name }] : []));
    }
    if (parsed["dry-run"]) {
        console.log("[RunWield] Dry run only. No archived Plans were deleted.");
        return;
    }
    if (approved.length === 0) {
        console.log("[RunWield] No archived Plans are due for pruning.");
        return;
    }
    if (!parsed.yes && !confirm(`Delete ${approved.length} archived Plan unit(s)?`)) {
        console.log("[RunWield] Archive prune canceled. No archived Plans were deleted.");
        return;
    }

    const { deleted, skipped } = await confirmPruneRequest(cwd, "plans", approved);
    for (const name of deleted) console.log(`[RunWield] Deleted ${name}`);
    console.log(`[RunWield] Pruned ${deleted.length} archived Plan unit(s); ${skipped.length} skipped; 0 failed.`);
}
