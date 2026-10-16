import { assertEquals } from "../../../testing/assertions.ts";
import { writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
/**
 * @module shared/session/__tests__/agent-model-override
 * Tests for per-agent model override logic in session.js.
 *
 * Every assertion reads real settings through the production resolver.
 * The fixture isolates HOME and restores process-global state after each read.
 */

import { withRuntimeCommandFixture } from "../../../cmd/testing/runtime-command-fixture.ts";
import { getConfiguredAgentModel } from "../session.js";

/** @typedef {{ model?: string }} AgentModelSetting */
/** @typedef {{ agents?: Record<string, AgentModelSetting> }} ModelPresetSetting */

/**
 * @param {string} agentName
 * @param {Record<string, AgentModelSetting> | undefined} agents
 * @param {string | undefined} activeModelPreset
 * @param {Record<string, ModelPresetSetting> | undefined} modelPresets
 * @returns {Promise<string | undefined>}
 */
async function readConfiguredAgentModel(agentName, agents, activeModelPreset, modelPresets) {
    return await withRuntimeCommandFixture("agent-model-settings-", async ({ projectRoot, settingsPath }) => {
        await fsWriteFile(settingsPath, JSON.stringify({ agents, activeModelPreset, modelPresets }));
        return getConfiguredAgentModel(agentName, projectRoot);
    });
}

test("getConfiguredAgentModel returns undefined when no agents config", async () => {
    const result = await readConfiguredAgentModel("router", undefined, undefined, undefined);
    assertEquals(result, undefined);
});

test("getConfiguredAgentModel returns agent model from base config", async () => {
    const agents = {
        router: { model: "openai/gpt-4" },
        operator: { model: "anthropic/claude-3" },
    };
    const result = await readConfiguredAgentModel("router", agents, undefined, undefined);
    assertEquals(result, "openai/gpt-4");
});

test("getConfiguredAgentModel returns undefined for unknown agent", async () => {
    const agents = {
        router: { model: "openai/gpt-4" },
    };
    const result = await readConfiguredAgentModel("nonexistent", agents, undefined, undefined);
    assertEquals(result, undefined);
});

test("getConfiguredAgentModel returns preset model when active preset is set", async () => {
    const agents = {
        router: { model: "openai/gpt-4" },
        operator: { model: "anthropic/claude-3" },
    };
    const modelPresets = {
        fast: {
            agents: {
                router: { model: "openai/gpt-4o-mini" },
                operator: { model: "anthropic/claude-3-haiku" },
            },
        },
        quality: {
            agents: {
                router: { model: "openai/gpt-4o" },
            },
        },
    };

    // Active preset 'fast' overrides base
    const result = await readConfiguredAgentModel("router", agents, "fast", modelPresets);
    assertEquals(result, "openai/gpt-4o-mini");

    // Active preset 'quality' overrides base for router
    const resultQuality = await readConfiguredAgentModel("router", agents, "quality", modelPresets);
    assertEquals(resultQuality, "openai/gpt-4o");

    // Preset doesn't have operator -> falls back to base config
    const resultOperator = await readConfiguredAgentModel("operator", agents, "quality", modelPresets);
    assertEquals(resultOperator, "anthropic/claude-3");
});

test("getConfiguredAgentModel returns preset model without base agents config", async () => {
    const modelPresets = {
        codex: {
            agents: {
                operator: { model: "crofai/deepseek-v4-pro" },
            },
        },
    };

    const result = await readConfiguredAgentModel("operator", undefined, "codex", modelPresets);
    assertEquals(result, "crofai/deepseek-v4-pro");
});

test("getConfiguredAgentModel ignores missing preset gracefully", async () => {
    const agents = {
        router: { model: "openai/gpt-4" },
    };
    const modelPresets = {
        fast: {
            agents: {
                router: { model: "openai/gpt-4o-mini" },
            },
        },
    };

    // Unknown preset name -> fall back to base config
    const result = await readConfiguredAgentModel("router", agents, "nonexistent", modelPresets);
    assertEquals(result, "openai/gpt-4");
});

test("getConfiguredAgentModel ignores preset with no agents field", async () => {
    const agents = {
        router: { model: "openai/gpt-4" },
    };
    const modelPresets = {
        empty: {},
    };

    const result = await readConfiguredAgentModel("router", agents, "empty", modelPresets);
    assertEquals(result, "openai/gpt-4");
});

test("getConfiguredAgentModel - agent without model field in base config", async () => {
    const agents = {
        router: { model: "openai/gpt-4" },
        operator: {}, // no model field
    };
    const result = await readConfiguredAgentModel("operator", agents, undefined, undefined);
    assertEquals(result, undefined);
});

test("getConfiguredAgentModel - preset partial override merges correctly", async () => {
    const agents = {
        router: { model: "openai/gpt-4" },
        planner: { model: "anthropic/claude-3-opus" },
        operator: { model: "openai/gpt-4o" },
    };
    const modelPresets = {
        fast: {
            agents: {
                router: { model: "openai/gpt-4o-mini" },
                // planner and operator NOT in preset -> inherited from base
            },
        },
    };

    // Router overridden by preset
    assertEquals(await readConfiguredAgentModel("router", agents, "fast", modelPresets), "openai/gpt-4o-mini");
    // Planner NOT in preset -> falls through to base
    assertEquals(await readConfiguredAgentModel("planner", agents, "fast", modelPresets), "anthropic/claude-3-opus");
    // Operator NOT in preset -> falls through to base
    assertEquals(await readConfiguredAgentModel("operator", agents, "fast", modelPresets), "openai/gpt-4o");
});
