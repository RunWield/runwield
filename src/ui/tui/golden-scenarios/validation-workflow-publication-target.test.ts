import {
    validationTreePublicationRemoteTargetAdvanceScenario,
    validationTreePublicationPrimaryPlanRestoredScenario,
    validationTreePublicationMissingTargetBranchScenario,
} from "./validation-workflow-tree-publication.ts";
import { registerValidationWorkflowTests } from "./validation-workflow-test-runner.ts";

registerValidationWorkflowTests("src/ui/tui/golden-scenarios/validation-workflow-tree-publication.ts", [
    {
        scenario: validationTreePublicationRemoteTargetAdvanceScenario,
        exportName: "validationTreePublicationRemoteTargetAdvanceScenario",
    },
    {
        scenario: validationTreePublicationPrimaryPlanRestoredScenario,
        exportName: "validationTreePublicationPrimaryPlanRestoredScenario",
    },
    {
        scenario: validationTreePublicationMissingTargetBranchScenario,
        exportName: "validationTreePublicationMissingTargetBranchScenario",
    },
]);
