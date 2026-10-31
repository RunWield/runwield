import { listPlans } from "./store.ts";

export async function runCommand(root: string, args: string[]): Promise<string> {
    if (args.length === 1 && args[0] === "list") return JSON.stringify(await listPlans(root));
    throw new Error("Use list");
}
