import {
    validationTreePublicationResumedRepairCompletionScenario,
    validationTreePublicationCommittedRepairCompletionScenario,
    validationTreePublicationRepairCompletionScenario,
} from "./validation-workflow-tree-publication.ts";
import { registerValidationWorkflowTests } from "./validation-workflow-test-runner.ts";

registerValidationWorkflowTests("src/ui/tui/golden-scenarios/validation-workflow-tree-publication.ts", [
    {
        scenario: validationTreePublicationResumedRepairCompletionScenario,
        exportName: "validationTreePublicationResumedRepairCompletionScenario",
    },
    {
        scenario: validationTreePublicationCommittedRepairCompletionScenario,
        exportName: "validationTreePublicationCommittedRepairCompletionScenario",
    },
    {
        scenario: validationTreePublicationRepairCompletionScenario,
        exportName: "validationTreePublicationRepairCompletionScenario",
    },
]);
