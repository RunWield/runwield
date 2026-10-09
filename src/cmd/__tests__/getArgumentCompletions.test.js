import { assertEquals } from "@std/assert";
import { getAgentCompletions } from "../agents/getArgumentCompletions.ts";
import { getModelCompletions } from "../models/getArgumentCompletions.ts";
import { getLoadPlanCompletions } from "../load-plan/getArgumentCompletions.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";

Deno.test("getAgentCompletions includes router", async () => {
    const items = await getAgentCompletions("ro");
    assertEquals(items.some((i) => i.value === "router"), true);
});

Deno.test("getModelCompletions can find by provider prefix", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = Deno.env.get("HOME");
        const originalOpenAiKey = Deno.env.get("OPENAI_API_KEY");
        const tempHome = await Deno.makeTempDir({ prefix: "runwield-model-completions-" });
        try {
            Deno.env.set("HOME", tempHome);
            Deno.env.set("OPENAI_API_KEY", "test-key");
            const items = await getModelCompletions("open");
            assertEquals(items.length > 0, true);
        } finally {
            if (originalHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", originalHome);
            if (originalOpenAiKey === undefined) Deno.env.delete("OPENAI_API_KEY");
            else Deno.env.set("OPENAI_API_KEY", originalOpenAiKey);
            await Deno.remove(tempHome, { recursive: true });
        }
    });
});

Deno.test("getLoadPlanCompletions handles missing plans dir", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalCwd = Deno.cwd();
        const tempDir = await Deno.makeTempDir({ prefix: "runwield-missing-plan-completions-" });
        try {
            Deno.chdir(tempDir);
            const items = await getLoadPlanCompletions("anything");
            assertEquals(Array.isArray(items), true);
        } finally {
            Deno.chdir(originalCwd);
            await Deno.remove(tempDir, { recursive: true });
        }
    });
});

Deno.test("getLoadPlanCompletions sorts loadable plans by workflow priority", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalCwd = Deno.cwd();
        const tempDir = await Deno.makeTempDir({ prefix: "runwield-load-plan-completions-" });
        try {
            await Deno.mkdir(`${tempDir}/docs/plans`, { recursive: true });
            const plans = [
                ["z-verified", "FEATURE", "verified"],
                ["b-ready-epic", "PROJECT", "ready_for_work"],
                ["a-ready-epic", "PROJECT", "ready_for_work"],
                ["ready-feature", "FEATURE", "ready_for_work"],
                ["draft-plan", "FEATURE", "draft"],
                ["failed-plan", "FEATURE", "failed"],
                ["implemented-plan", "FEATURE", "implemented"],
                ["held-plan", "FEATURE", "on_hold"],
                ["decompose-epic", "PROJECT", "ready_for_decomposition"],
            ];
            for (const [name, classification, status] of plans) {
                await Deno.writeTextFile(
                    `${tempDir}/docs/plans/${name}.md`,
                    `---\nclassification: "${classification}"\nstatus: "${status}"\nsummary: "${name}"\ncreatedAt: "2026-01-01T00:00:00.000Z"\n---\n\n# ${name}\n`,
                );
            }

            Deno.chdir(tempDir);
            const items = await getLoadPlanCompletions("");
            assertEquals(items.map((item) => item.value), [
                "failed-plan",
                "implemented-plan",
                "a-ready-epic",
                "b-ready-epic",
                "ready-feature",
                "decompose-epic",
                "draft-plan",
                "z-verified",
                "held-plan",
            ]);
        } finally {
            Deno.chdir(originalCwd);
            await Deno.remove(tempDir, { recursive: true });
        }
    });
});
