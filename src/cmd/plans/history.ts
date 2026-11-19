import { getCwd } from "../../constants.ts";
import { listPlanHistory, restorePlanMilestone, showPlanMilestone } from "../../plan-store/index.ts";

export async function runPlansHistoryCommand(args: string[]): Promise<void> {
    const usage =
        "wld plans history <plan-name-or-id>\nwld plans history show <plan-name-or-id> <version>\nwld plans history restore <plan-name-or-id> <version>";
    if (args.includes("--help") || args.includes("-h")) {
        console.log(usage);
        return;
    }
    const cwd = getCwd();
    if (args.length === 1) {
        const { milestones } = await listPlanHistory(cwd, args[0]);
        if (!milestones.length) console.log("No milestones recorded.");
        for (const entry of milestones)
            console.log([entry.version, entry.milestone, entry.at, entry.reason].filter(Boolean).join("\t"));
        return;
    }
    const [action, reference, version] = args;
    if (args.length !== 3 || !["show", "restore"].includes(action)) throw new Error(usage);
    if (action === "show") {
        const documents = await showPlanMilestone(cwd, reference, version);
        for (const [name, body] of Object.entries(documents)) console.log(`# ${name}\n\n${body}`);
        return;
    }
    const { planId, revision } = await listPlanHistory(cwd, reference);
    const result = await restorePlanMilestone(cwd, planId, version, revision);
    console.log(`Restored ${version} to Plan ${planId} at revision ${result}.`);
}
