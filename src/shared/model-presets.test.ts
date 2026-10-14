import { assertEquals } from "../testing/assertions.ts";
import { readdirSync } from "node:fs";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { ok as assert } from "node:assert/strict";
import { join } from "node:path";
import { withRuntimeCommandFixture } from "../cmd/testing/runtime-command-fixture.ts";
import { getBundledModelPresets, type ModelPresetsMap } from "./model-presets.ts";
import { RunWieldCredentialStore, RunWieldModelRegistry } from "./models/model-registry.ts";
import { getCustomSetting, getMergedCustomSetting, setCustomSetting } from "./settings.js";
import { getConfiguredAgentModel, getConfiguredAgentThinkingLevel } from "./session/session.js";

test("bundled presets refresh disposable files and preserve personal settings", async () => {
    await withRuntimeCommandFixture("bundled-presets-", async ({ homeDir, projectRoot, settingsPath }) => {
        const before = await fsReadFile(settingsPath, "utf8");
        const directory = join(homeDir, ".wld", "bundled-model-presets");
        await fsMkdir(directory, { recursive: true });
        await fsWriteFile(join(directory, "codex.json"), "stale");
        await fsWriteFile(join(directory, "retired.json"), "{}");

        const presets = getMergedCustomSetting("modelPresets", projectRoot) as ModelPresetsMap;
        assertEquals(Object.keys(presets).sort(), [
            "agy",
            "claude-mixed",
            "claude-opus",
            "codex",
            "codex-claude",
            "opencode",
        ]);
        assertEquals(JSON.parse(await fsReadFile(join(directory, "codex.json"), "utf8")), presets.codex);
        assertEquals(
            Array.from(readdirSync(directory, { withFileTypes: true })).map((entry) => entry.name).sort(),
            Object.keys(presets).map((name) => `${name}.json`).sort(),
        );
        assertEquals(await fsReadFile(settingsPath, "utf8"), before);
        assertEquals(getCustomSetting("modelPresets", "global", projectRoot), undefined);

        // Callers and cache edits cannot mutate the bundled source of truth.
        presets.codex.agents = {};
        await fsWriteFile(join(directory, "codex.json"), "{}");
        assertEquals(getBundledModelPresets().codex.agents?.engineer.model, "openai-codex/gpt-6.1-sol");
    });
});

test("bundled presets remain usable when the extraction cache cannot be created", async () => {
    await withRuntimeCommandFixture("bundled-presets-no-cache-", async ({ homeDir }) => {
        await fsWriteFile(join(homeDir, ".wld", "bundled-model-presets"), "occupied");
        assertEquals(getBundledModelPresets()["claude-opus"].agents?.router.model, "claude-cli/opus");
    });
});

test("preset names layer project over personal over bundled without inheriting replaced presets", async () => {
    await withRuntimeCommandFixture("bundled-presets-layers-", async ({ projectRoot }) => {
        await setCustomSetting("activeModelPreset", "codex", "global", projectRoot);
        assertEquals(getConfiguredAgentModel("engineer", projectRoot), "openai-codex/gpt-6.1-sol");
        assertEquals(getConfiguredAgentThinkingLevel("planner", projectRoot), "high");

        await setCustomSetting("agents", { router: { model: "base/router" } }, "global", projectRoot);
        await setCustomSetting(
            "modelPresets",
            {
                codex: { agents: { engineer: { model: "personal/engineer" } } },
                custom: { agents: { engineer: { model: "personal/custom" } } },
            },
            "global",
            projectRoot,
        );
        assertEquals(getConfiguredAgentModel("engineer", projectRoot), "personal/engineer");
        assertEquals(getConfiguredAgentModel("router", projectRoot), "base/router");

        await setCustomSetting(
            "modelPresets",
            {
                codex: { agents: { engineer: { model: "project/engineer" } } },
            },
            "project",
            projectRoot,
        );
        assertEquals(getConfiguredAgentModel("engineer", projectRoot), "project/engineer");
        const presets = getMergedCustomSetting("modelPresets", projectRoot) as ModelPresetsMap;
        assertEquals(presets.custom.agents?.engineer.model, "personal/custom");
        assertEquals(presets["claude-mixed"].agents?.router.model, "claude-cli/sonnet");

        await setCustomSetting("activeModelPreset", null, "global", projectRoot);
        assertEquals(getConfiguredAgentModel("router", projectRoot), "base/router");
        await setCustomSetting("activeModelPreset", "missing", "global", projectRoot);
        assertEquals(getConfiguredAgentModel("router", projectRoot), "base/router");
    });
});

test("bundled presets cover shipped roles using registered models from their advertised providers", async () => {
    const providers: Record<string, string[]> = {
        codex: ["openai-codex"],
        agy: ["agy-cli"],
        opencode: ["opencode"],
        "claude-mixed": ["claude-cli"],
        "claude-opus": ["claude-cli"],
        "codex-claude": ["openai-codex", "claude-cli"],
    };
    const roles = [
        "architect",
        "engineer",
        "frontend-engineer",
        "guide",
        "ideator",
        "init",
        "operator",
        "planner",
        "reviewer",
        "router",
        "slicer",
    ];
    const directory = await fsMkdtemp(join(tmpdir(), "preset-model-registry-"));
    const registry = new RunWieldModelRegistry({
        configDir: directory,
        credentialStore: new RunWieldCredentialStore(join(directory, "auth.json")),
    });
    try {
        for (const [name, preset] of Object.entries(getBundledModelPresets())) {
            assert(preset.description);
            assertEquals(Object.keys(preset.agents ?? {}).sort(), roles);
            for (const [role, config] of Object.entries(preset.agents ?? {})) {
                assert(config.model && providers[name].includes(config.model.split("/")[0]), `${name}: ${role}`);
                const [provider, model] = config.model.split("/");
                assert(registry.find(provider, model), `${name}: unregistered model ${config.model}`);
                if (name === "claude-opus") assertEquals(config.model, "claude-cli/opus");
            }
        }
    } finally {
        await fsRm(directory, { recursive: true });
    }
});
