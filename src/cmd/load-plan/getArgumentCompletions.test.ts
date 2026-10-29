import process from "node:process";
import { rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import { getCwd } from "../../constants.js";
import { savePlan, getStoredPlanPath, loadPlan, PlanFrontMatterParseError } from "../../plan-store.js";
import { defineCommittedGitFixture } from "../../shared/git-test-fixture.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { getLoadPlanCompletions } from "./getArgumentCompletions.ts";

const repository = defineCommittedGitFixture();

test("Plan completion suggests partial names and leaves an exact name ready to submit", async () => {
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
            process.chdir(root);
            assertEquals((await getLoadPlanCompletions("shi")).map((item) => item.value).sort(), ["ship", "ship-next"]);
            assertEquals(await getLoadPlanCompletions("ship"), []);
            assertEquals(await getLoadPlanCompletions("ship-next"), []);
            assertEquals(await getLoadPlanCompletions("missing"), []);
        } finally {
            process.chdir(previousCwd);
            await fsRm(root, { recursive: true });
        }
    });
});

test("malformed Plan autocomplete stays quiet while loading still reports the parse error", async () => {
    await withProcessGlobalTestLock(async () => {
        const root = await repository.checkout();
        const previousCwd = getCwd();
        try {
            await savePlan(root, "broken", "# Broken\n", { status: "draft", classification: "PLANNED_CHANGE" });
            await fsWriteFile(
                await getStoredPlanPath(root, "broken"),
                "---\nsummary: [broken\nstatus: draft\n---\n# Broken\n",
            );
            process.chdir(root);
            assertEquals(await getLoadPlanCompletions("bro"), []);
            await assertRejects(() => loadPlan(root, "broken"), PlanFrontMatterParseError);
        } finally {
            process.chdir(previousCwd);
            await fsRm(root, { recursive: true });
        }
    });
});

test("child completions use numeric order across mixed names and statuses", async () => {
    await withProcessGlobalTestLock(async () => {
        const root = await repository.checkout();
        const previousCwd = getCwd();
        try {
            for (const [name, order, status] of [
                ["99-first", 1, "draft"],
                ["middle", 2, "ready_for_work"],
                ["01-last", 10, "failed"],
            ] as const) {
                await savePlan(root, `epic/${name}`, `# ${name}`, { parentPlan: "epic", order, status });
            }
            process.chdir(root);
            assertEquals(
                (await getLoadPlanCompletions("epic/")).map((item) => item.value),
                ["epic/99-first", "epic/middle", "epic/01-last"],
            );
        } finally {
            process.chdir(previousCwd);
            await fsRm(root, { recursive: true });
        }
    });
});
