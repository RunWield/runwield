/**
 * @module ui/tui/golden-scenarios/catalog
 * Central catalog for Golden TUI scenario portfolio metadata.
 */

import { concurrentWorkflowScenarios } from "./concurrent-workflow.ts";
import { initialGoldenScenarios } from "./initial-scenarios.js";
import { loadPlanWorkflowScenarios } from "./load-plan-workflow.ts";
import { loadPlanEpicWorkflowScenarios } from "./load-plan-epic-workflow.ts";
import { plannedChangeWorkflowScenarios } from "./planned-change-workflow.js";
import { presentationAndTerminalScenarios } from "./presentation-and-terminal.js";
import { projectWorkflowScenarios } from "./project-workflow.js";
import { projectRoutingWorkflowScenarios } from "./project-routing-workflow.ts";
import { roleJourneyScenarios } from "./role-journeys.js";
import { sessionResumeWorkflowScenarios } from "./session-resume-workflow.ts";
import { slashCommandConfigurationScenarios } from "./slash-command-tree-configuration.ts";
import { slashCommandAuthScenarios } from "./slash-command-tree-auth.ts";
import { slashCommandLifecycleScenarios } from "./slash-command-tree-lifecycle.ts";
import { slashCommandTerminalScenarios } from "./slash-command-tree-terminal.ts";
import { slashCommandSessionScenarios } from "./slash-command-tree-session.ts";
import { slashCommandUtilityScenarios } from "./slash-command-tree-utility.ts";
import { validationWorkflowTreeScenarios } from "./validation-workflow-tree.ts";
import {
    initTutorialValidationCommandScenario,
    routerValidationCommandRepairScenario,
} from "./validation-command-persistence.ts";

export const goldenTuiPortfolioScenarios = [
    ...initialGoldenScenarios,
    ...roleJourneyScenarios,
    ...plannedChangeWorkflowScenarios,
    ...projectWorkflowScenarios,
    ...projectRoutingWorkflowScenarios,
    ...loadPlanWorkflowScenarios,
    ...loadPlanEpicWorkflowScenarios,
    ...validationWorkflowTreeScenarios,
    initTutorialValidationCommandScenario,
    routerValidationCommandRepairScenario,
    ...concurrentWorkflowScenarios,
    ...presentationAndTerminalScenarios,
    ...sessionResumeWorkflowScenarios,
    ...slashCommandConfigurationScenarios,
    ...slashCommandAuthScenarios,
    ...slashCommandLifecycleScenarios,
    ...slashCommandTerminalScenarios,
    ...slashCommandSessionScenarios,
    ...slashCommandUtilityScenarios,
];

export const goldenTuiExtensiveScenarios = goldenTuiPortfolioScenarios;
