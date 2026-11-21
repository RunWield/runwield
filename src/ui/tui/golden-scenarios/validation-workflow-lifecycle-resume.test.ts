import {
    validationTreeResumeImplementedScenario,
    validationTreeResumeValidatedCiScenario,
    validationTreeResumeValidatedReviewerScenario,
} from "./validation-workflow-tree-lifecycle.ts";
import { registerValidationWorkflowTests } from "./validation-workflow-test-runner.ts";

registerValidationWorkflowTests("src/ui/tui/golden-scenarios/validation-workflow-tree-lifecycle.ts", [
    {
        scenario: validationTreeResumeImplementedScenario,
        exportName: "validationTreeResumeImplementedScenario",
    },
    {
        scenario: validationTreeResumeValidatedCiScenario,
        exportName: "validationTreeResumeValidatedCiScenario",
    },
    {
        scenario: validationTreeResumeValidatedReviewerScenario,
        exportName: "validationTreeResumeValidatedReviewerScenario",
    },
]);
