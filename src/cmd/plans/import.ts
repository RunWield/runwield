import process from "node:process";
import { relative } from "node:path";
import { getCwd } from "../../constants.ts";
import { importPlans, importedPlanCopyChoice, PlanImportRefusedError } from "../../plan-store/index.ts";
import { admitProjectWithIdentityChoice } from "../../ui/tui/project-identity-entry.ts";

const usage = "Usage: wld plans import <file-or-folder> [--include-archived]";

async function offerDeliveryCopies(cwd: string, selection: string): Promise<void> {
    if (!(await importedPlanCopyChoice(cwd, selection))) return;
    if (!process.stdin.isTTY) {
        console.log(
            "[RunWield] Plans imported. Delivery copies remain unchanged; choose them on a later interactive folder import.",
        );
        return;
    }
    const answer = prompt("Keep delivered Plan copies in docs/plans/? [Y/n]");
    if (answer === null) return;
    const normalized = answer.trim().toLowerCase();
    if (!["", "y", "yes", "n", "no"].includes(normalized)) return;
    await importedPlanCopyChoice(cwd, selection, normalized === "" || normalized === "y" || normalized === "yes");
}

export async function runPlansImportCommand(argv: string[]): Promise<void> {
    if (argv.includes("--help") || argv.includes("-h")) {
        console.log(
            `${usage}\nFolder imports skip archived Plans by default. Select an archive directly or pass --include-archived.`,
        );
        return;
    }
    const selectionArgs = argv.filter((arg) => arg !== "--include-archived");
    if (selectionArgs.length !== 1 || selectionArgs[0].startsWith("-") || argv.length > 2) throw new Error(usage);
    const cwd = getCwd();
    console.error(
        "[RunWield] Preparing project storage for Plan import. This can take time if another Session is active or older storage needs to be moved.",
    );
    if (!(await admitProjectWithIdentityChoice(cwd))) return;
    const selection = selectionArgs[0];
    try {
        const result = await importPlans(
            cwd,
            selection,
            argv.includes("--include-archived") ? { includeArchived: true } : {},
        );
        const imported = result.importedPlanIds.length;
        console.log(
            `[RunWield] Imported ${imported} ${imported === 1 ? "Plan" : "Plans"} (${result.existingPlanIds.length} already present).`,
        );
        if (result.archiveExcluded)
            console.log("[RunWield] Archived Plans were outside this import. Use --include-archived to include them.");
        try {
            if (result.planIds.length) await offerDeliveryCopies(cwd, selection);
        } finally {
            if (result.skipped?.length) {
                const skipped = result.skipped.length;
                console.log(`\n[RunWield] Skipped ${skipped} ${skipped === 1 ? "file" : "files"}`);
                for (const item of result.skipped.toSorted((a, b) => a.path.localeCompare(b.path))) {
                    console.log(`- ${relative(cwd, item.path)}\n  ${item.reason}\n  ${item.action}`);
                }
                if (!result.planIds.length) process.exitCode = 1;
            }
        }
    } catch (error) {
        if (!(error instanceof PlanImportRefusedError)) throw error;
        console.error(`[RunWield] Plan import stopped. ${error.message}`);
        if (error.issue.kind === "pending" || error.issue.kind === "conflict")
            console.error("Run `wld plans doctor --check` to inspect saved Plan and worktree state.");
        if (error.issue.kind !== "unavailable")
            console.error("To import other Plans, retry with a file or folder that excludes the affected source.");
        process.exitCode = 1;
        return;
    }
}
