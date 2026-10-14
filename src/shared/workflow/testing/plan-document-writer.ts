import process from "node:process";
import { loadPlanBodyById, savePlanBodyById } from "../../../plan-store.js";

const plan = await loadPlanBodyById(process.argv.slice(2)[0], process.argv.slice(2)[1]);
console.log("ready");
await savePlanBodyById(
    process.argv.slice(2)[0],
    process.argv.slice(2)[1],
    "# Demo\n\n## Context\n\nWorkspace edit.\n",
    plan.bodyHash,
    {
        expectedRevision: plan.revision,
    },
);
