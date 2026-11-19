import { seedPlan } from "../../shared/testing/plan-state-fixture.ts";

import { assertEquals } from "../../testing/assertions.ts";
import { getCwd } from "../../constants.ts";
import process from "node:process";
import { mkdtemp as fsMkdtemp, rm as fsRm } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getAgentCompletions } from "../agents/getArgumentCompletions.ts";
import { getModelCompletions } from "../models/getArgumentCompletions.ts";
import { getLoadPlanCompletions } from "../load-plan/getArgumentCompletions.ts";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";

test("getAgentCompletions includes router", async () => {
    const items = await getAgentCompletions("ro");
    assertEquals(
        items.some((i) => i.value === "router"),
        true,
    );
    assertEquals(await getAgentCompletions("not-an-agent"), []);
});

test("model completions filter hydrated fixture models by provider or model prefix", async () => {
    await withRuntimeCommandFixture("model-completions-", async () => {
        assertEquals(
            (await getModelCompletions("runtime-command-fixture")).map((item) => item.value),
            ["runtime-command-fixture/fixture-model"],
        );
        assertEquals(
            (await getModelCompletions("FIXTURE-M")).map((item) => item.value),
            ["runtime-command-fixture/fixture-model"],
        );
        assertEquals(await getModelCompletions("not-a-configured-provider"), []);
    });
});

test("getLoadPlanCompletions handles missing plans dir", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalCwd = getCwd();
        const tempDir = await fsMkdtemp(join(tmpdir(), "runwield-missing-plan-completions-"));
        try {
            process.chdir(tempDir);
            const items = await getLoadPlanCompletions("anything");
            assertEquals(items, []);
        } finally {
            process.chdir(originalCwd);
            await fsRm(tempDir, { recursive: true });
        }
    });
});

test("getLoadPlanCompletions sorts loadable plans by workflow priority", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalCwd = getCwd();
        const tempDir = await fsMkdtemp(join(tmpdir(), "runwield-load-plan-completions-"));
        try {
            const plans = [
                ["z-verified", "PLANNED_CHANGE", "verified"],
                ["b-ready-epic", "PROJECT", "ready_for_work"],
                ["a-ready-epic", "PROJECT", "ready_for_work"],
                ["ready-feature", "PLANNED_CHANGE", "ready_for_work"],
                ["draft-plan", "PLANNED_CHANGE", "draft"],
                ["failed-plan", "PLANNED_CHANGE", "failed"],
                ["implemented-plan", "PLANNED_CHANGE", "implemented"],
                ["held-plan", "PLANNED_CHANGE", "on_hold"],
                ["decompose-epic", "PROJECT", "ready_for_decomposition"],
            ] as const;
            for (const [name, classification, status] of plans) {
                await seedPlan(tempDir, name, `# ${name}\n`, {
                    classification,
                    status,
                    summary: name,
                    createdAt: "2026-01-01T00:00:00.000Z",
                });
            }

            process.chdir(tempDir);
            const items = await getLoadPlanCompletions("");
            assertEquals(
                items.map((item) => item.value),
                [
                    "failed-plan",
                    "implemented-plan",
                    "a-ready-epic",
                    "b-ready-epic",
                    "ready-feature",
                    "decompose-epic",
                    "draft-plan",
                    "z-verified",
                    "held-plan",
                ],
            );
        } finally {
            process.chdir(originalCwd);
            await fsRm(tempDir, { recursive: true });
        }
    });
});
