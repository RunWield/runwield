import { withRetainedPlanFixture } from "../../testing/retained-plan-fixture.ts";
import process from "node:process";
import { savePlanBodyById } from "../../../plan-store/index.ts";
import { loadPlanBodyById } from "../../testing/plan-query-fixture.ts";

await withRetainedPlanFixture(process.argv.slice(2)[0], async () => {
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
});
