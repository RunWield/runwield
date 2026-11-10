import { test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertEquals } from "../testing/assertions.ts";
import { withRuntimeCommandFixture } from "../cmd/testing/runtime-command-fixture.ts";
import {
    __resetSettingsForTests,
    getCustomSetting,
    getMergedCustomSetting,
    getSettingsManager,
    ONBOARDING_TUTORIAL_OFFER_HANDLED_SETTING_KEY,
    PLAN_SERVER_URL_SETTING_KEY,
    setCustomSetting,
} from "./settings.ts";

test("settings read JSONC and merge actual global/project values with project precedence", async () => {
    await withRuntimeCommandFixture("settings-merge-", async ({ homeDir, projectRoot }) => {
        await writeFile(
            join(homeDir, ".wld", "settings.json"),
            `{
            // Owner-maintained JSONC is supported.
            "agents": { "router": { "model": "global/router" }, "operator": { "model": "global/operator" }, },
            "codereview": "always",
        }`,
        );
        await mkdir(join(projectRoot, ".wld"), { recursive: true });
        await writeFile(
            join(projectRoot, ".wld", "settings.json"),
            `{
            "agents": { "router": { "model": "project/router" }, "planner": { "model": "project/planner" }, },
            "codereview": "none",
        }`,
        );
        __resetSettingsForTests();
        assertEquals(getCustomSetting("agents", "global", projectRoot), {
            router: { model: "global/router" },
            operator: { model: "global/operator" },
        });
        assertEquals(getMergedCustomSetting("agents", projectRoot), {
            router: { model: "project/router" },
            operator: { model: "global/operator" },
            planner: { model: "project/planner" },
        });
        assertEquals(getMergedCustomSetting("codereview", projectRoot), "none");
    });
});

test("theme and model changes preserve custom settings after reloading from disk", async () => {
    await withRuntimeCommandFixture("settings-write-preservation-", async ({ projectRoot }) => {
        const custom = {
            agents: {},
            activeModelPreset: "codex",
            modelPresets: { codex: { agents: { operator: { model: "crofai/deepseek-v4-pro" } } } },
            [ONBOARDING_TUTORIAL_OFFER_HANDLED_SETTING_KEY]: true,
            imageGeneration: { model: "openrouter/google/gemini-3.1-flash-image" },
            visionFallback: { model: "lmstudio/gemma" },
            codereview: "ask",
            guidedReview: "auto",
            notifications: { enabled: true, activation: "tab" },
            verification_command: "bun run ci",
            workRecords: { autoGenerateOnPlanCompletion: false },
            plans: { archiveRetentionDays: 14, archiveKeepLast: 10 },
            [PLAN_SERVER_URL_SETTING_KEY]: "https://plans.example.test",
            mascot: false,
        };
        for (const [key, value] of Object.entries(custom)) {
            await setCustomSetting(key, value, "global", projectRoot);
        }
        const manager = getSettingsManager(projectRoot);
        manager.setTheme("light");
        manager.setDefaultModel("model-a");
        await manager.flush();
        __resetSettingsForTests();
        assertEquals(getSettingsManager(projectRoot).getTheme(), "light");
        assertEquals(getSettingsManager(projectRoot).getDefaultModel(), "model-a");
        for (const [key, value] of Object.entries(custom)) {
            assertEquals(
                getCustomSetting(key, "global", projectRoot),
                value,
                `${key} must survive a Pi settings write`,
            );
        }
        await setCustomSetting("activeModelPreset", "crof.ai", "global", projectRoot);
        __resetSettingsForTests();
        assertEquals(getCustomSetting("activeModelPreset", "global", projectRoot), "crof.ai");
    });
});
