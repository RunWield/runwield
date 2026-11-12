import process from "node:process";
import { getCwd } from "../../constants.js";
import { importPlans, importedPlanCopyChoice } from "../../plan-store/index.ts";
import { admitProjectWithIdentityChoice } from "../../ui/tui/project-identity-entry.ts";

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
            "Usage: wld plans import <file-or-folder>\nImport Plans into personal home storage without changing source files.",
        );
        return;
    }
    if (argv.length !== 1 || argv[0].startsWith("-")) throw new Error("Usage: wld plans import <file-or-folder>");
    const cwd = getCwd();
    if (!(await admitProjectWithIdentityChoice(cwd))) return;
    const selection = argv[0];
    const result = await importPlans(cwd, selection);
    console.log(
        `[RunWield] Imported ${result.importedPlanIds.length} Plans; ${result.existingPlanIds.length} already present.`,
    );
    await offerDeliveryCopies(cwd, selection);
}
