import {
    validationTreeHumanReviewAskCloseScenario,
    validationTreeHumanReviewAskSkipScenario,
    validationTreeHumanReviewNoneScenario,
} from "./validation-workflow-tree-human-review.ts";
import { registerValidationWorkflowTests } from "./validation-workflow-test-runner.ts";

registerValidationWorkflowTests("src/ui/tui/golden-scenarios/validation-workflow-tree-human-review.ts", [
    { scenario: validationTreeHumanReviewNoneScenario, exportName: "validationTreeHumanReviewNoneScenario" },
    { scenario: validationTreeHumanReviewAskSkipScenario, exportName: "validationTreeHumanReviewAskSkipScenario" },
    { scenario: validationTreeHumanReviewAskCloseScenario, exportName: "validationTreeHumanReviewAskCloseScenario" },
]);
