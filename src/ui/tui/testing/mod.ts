export type { GoldenChildOptions, GoldenChildResult } from "./subprocess-runner.ts";
export type {
    GoldenScenario,
    GoldenScenarioResult,
    PublicationBaseline,
    GoldenAction,
    GoldenScenarioState,
    GoldenScenarioOptions,
} from "./scenario-runner.ts";
export { GoldenScenarioActor } from "./scenario-actor.ts";
export { assertEventIncludes, assertScreenIncludes, runGoldenScenario } from "./scenario-runner.ts";
export { runGoldenChild, sanitizeGoldenChildEnv } from "./subprocess-runner.ts";
export { createGoldenIsolatedEnvironment } from "./isolated-environment.ts";
export type {
    GoldenEnvironmentOptions,
    GoldenIsolatedEnvironment,
    GoldenModelConfigOptions,
    GoldenModelDefinition,
} from "./isolated-environment.ts";
export { ScriptedReviewSurface } from "./scripted-review-surface.ts";
export type {
    VirtualTerminalOptions,
    VirtualTerminalSize,
    VirtualTerminalInputCallback,
    VirtualTerminalResizeCallback,
    VirtualTerminalProgress,
} from "./virtual-terminal.ts";
export { normalizeScreenText, VirtualTerminal } from "./virtual-terminal.ts";
export { runGoldenScenarioChildProcess } from "./child-protocol.ts";
export {
    assertGoldenScenarioCoverage,
    collectGoldenScenarioCoverage,
    GOLDEN_TUI_REQUIRED_CAPABILITIES,
    GOLDEN_TUI_REQUIRED_CAPABILITY_IDS,
} from "./coverage-matrix.ts";
export {
    assertValidationBranchEvidence,
    assertValidationBranchInventory,
    assertValidationEvidenceRejectsCounterfeits,
    EXPECTED_VALIDATION_WORKFLOW_BRANCH_IDS,
    VALIDATION_WORKFLOW_BRANCHES,
} from "./validation-workflow-coverage.ts";
export {
    assertCoverageWith,
    assertRuntimeEvent,
    assertsGoldenCoverage,
    assertStateStringIncludes,
    assertStateValue,
    assertVisibleText,
} from "./portfolio-assertions.ts";

export type { GoldenCoverageCallback } from "./portfolio-assertions.ts";

export type {
    GoldenScriptToolCall,
    GoldenScriptTurn,
    GoldenTurnRequest,
    GoldenTurnResolver,
} from "./scenario-actor.ts";

export type {
    ScriptedReviewDecision,
    ScriptedReviewAnnotation,
    ScriptedReviewImage,
    ScriptedHumanReviewDecision,
    ScriptedUserFix,
    ScriptedRuntimeInteraction,
    ScriptedSurfaceRequest,
    ConsumedScriptedReview,
    ConsumedScriptedHumanReview,
    ConsumedScriptedInteraction,
    ResolveExecutionCwd,
} from "./scripted-review-surface.ts";
