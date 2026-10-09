import { assertEquals } from "@std/assert";
import { getCwd } from "../../constants.js";
import { savePlan } from "../../plan-store.js";
import { defineCommittedGitFixture } from "../../shared/git-test-fixture.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { getLoadPlanCompletions } from "./getArgumentCompletions.ts";

const repository = defineCommittedGitFixture();

Deno.test("Plan completion suggests partial names and leaves an exact name ready to submit", async () => {
    await withProcessGlobalTestLock(async () => {
        const root = await repository.checkout();
        const previousCwd = getCwd();
        try {
            for (const name of ["ship", "ship-next"]) {
                await savePlan(root, name, `# ${name}\n`, {
                    classification: "PLANNED_CHANGE",
                    status: "draft",
                });
            }
            Deno.chdir(root);
            assertEquals((await getLoadPlanCompletions("shi")).map((item) => item.value).sort(), ["ship", "ship-next"]);
            assertEquals(await getLoadPlanCompletions("ship"), []);
            assertEquals(await getLoadPlanCompletions("ship-next"), []);
            assertEquals(await getLoadPlanCompletions("missing"), []);
        } finally {
            Deno.chdir(previousCwd);
            await Deno.remove(root, { recursive: true });
        }
    });
});
