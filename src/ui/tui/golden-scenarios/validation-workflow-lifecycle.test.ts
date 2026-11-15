import {
    validationTreeMissingPlanScenario,
    validationTreeMalformedFrontMatterScenario,
    validationTreeMissingExecutionContextScenario,
} from "./validation-workflow-tree-lifecycle.ts";
import { registerValidationWorkflowTests } from "./validation-workflow-test-runner.ts";

registerValidationWorkflowTests("src/ui/tui/golden-scenarios/validation-workflow-tree-lifecycle.ts", [
    {
        scenario: validationTreeMissingPlanScenario,
        exportName: "validationTreeMissingPlanScenario",
    },
    {
        scenario: validationTreeMalformedFrontMatterScenario,
        exportName: "validationTreeMalformedFrontMatterScenario",
    },
    {
        scenario: validationTreeMissingExecutionContextScenario,
        exportName: "validationTreeMissingExecutionContextScenario",
    },
]);
