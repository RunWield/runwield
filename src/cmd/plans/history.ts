import { getCwd } from "../../constants.ts";
import { openPlanStoreForCheckout } from "../../plan-store/index.ts";

export async function runPlansHistoryCommand(args: string[]): Promise<void> {
    const usage =
        "wld plans history <plan-name-or-id>\nwld plans history show <plan-name-or-id> <version>\nwld plans history restore <plan-name-or-id> <version>";
    if (args.includes("--help") || args.includes("-h")) {
        console.log(usage);
        return;
    }
    const [action, reference, version] = args;
    if (args.length !== 1 && (args.length !== 3 || !["show", "restore"].includes(action))) throw new Error(usage);
    const store = openPlanStoreForCheckout(getCwd());
    if (!store) throw new Error("Plan history requires an admitted Plan.");
    const planId = await store.resolveHistoryPlan(args.length === 1 ? action : reference);
    if (args.length === 1) {
        const { milestones } = await store.history.list(planId);
        if (!milestones.length) console.log("No milestones recorded.");
        for (const entry of milestones)
            console.log([entry.version, entry.milestone, entry.at, entry.reason].filter(Boolean).join("\t"));
        return;
    }
    if (action === "show") {
        const documents = await store.history.read(planId, version);
        for (const [name, body] of Object.entries(documents)) console.log(`# ${name}\n\n${body}`);
        return;
    }
    const { revision } = await store.history.list(planId);
    const result = await store.history.restore(planId, version, revision);
    console.log(`Restored ${version} to Plan ${planId} at revision ${result}.`);
}
