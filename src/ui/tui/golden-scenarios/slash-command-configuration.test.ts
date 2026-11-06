import { registerSlashCommandGoldenTests } from "./slash-command-test-runner.ts";
import {
    agentModelsAfterManualSelectionScenario,
    agentModelsAfterPresetReloadScenario,
    agentModelsAfterRestartScenario,
    agentModelsAfterSavedTurnsScenario,
    namedAgentModelsAfterSavedTurnsScenario,
    routerManualModelHandoffScenario,
    slashAgentBaseSettingScenario,
    slashAgentDefaultModelScenario,
    slashAgentFrontmatterModelScenario,
    slashAgentScenario,
    slashAgentUnavailablePresetRecoveryScenario,
    slashMcpScenario,
    slashModelScenario,
    slashModelUnavailableOverrideRecoveryScenario,
    slashThemeScenario,
} from "./slash-command-tree-configuration.ts";

registerSlashCommandGoldenTests("src/ui/tui/golden-scenarios/slash-command-tree-configuration.ts", [
    { scenario: agentModelsAfterManualSelectionScenario, exportName: "agentModelsAfterManualSelectionScenario" },
    { scenario: agentModelsAfterPresetReloadScenario, exportName: "agentModelsAfterPresetReloadScenario" },
    { scenario: agentModelsAfterSavedTurnsScenario, exportName: "agentModelsAfterSavedTurnsScenario" },
    { scenario: agentModelsAfterRestartScenario, exportName: "agentModelsAfterRestartScenario" },
    { scenario: namedAgentModelsAfterSavedTurnsScenario, exportName: "namedAgentModelsAfterSavedTurnsScenario" },
    { scenario: routerManualModelHandoffScenario, exportName: "routerManualModelHandoffScenario" },
    { scenario: slashAgentScenario, exportName: "slashAgentScenario" },
    {
        scenario: slashAgentUnavailablePresetRecoveryScenario,
        exportName: "slashAgentUnavailablePresetRecoveryScenario",
    },
    { scenario: slashAgentBaseSettingScenario, exportName: "slashAgentBaseSettingScenario" },
    { scenario: slashAgentDefaultModelScenario, exportName: "slashAgentDefaultModelScenario" },
    { scenario: slashAgentFrontmatterModelScenario, exportName: "slashAgentFrontmatterModelScenario" },
    { scenario: slashMcpScenario, exportName: "slashMcpScenario" },
    { scenario: slashModelScenario, exportName: "slashModelScenario" },
    {
        scenario: slashModelUnavailableOverrideRecoveryScenario,
        exportName: "slashModelUnavailableOverrideRecoveryScenario",
    },
    { scenario: slashThemeScenario, exportName: "slashThemeScenario" },
]);
