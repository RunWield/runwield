import {
    validationTreePublicationDirtyCheckoutScenario,
    validationTreePublicationLocalOnlyScenario,
    validationTreePublicationIsolatedDirtyPrimaryScenario,
} from "./validation-workflow-tree-publication.ts";
import { registerValidationWorkflowTests } from "./validation-workflow-test-runner.ts";

registerValidationWorkflowTests("src/ui/tui/golden-scenarios/validation-workflow-tree-publication.ts", [
    {
        scenario: validationTreePublicationDirtyCheckoutScenario,
        exportName: "validationTreePublicationDirtyCheckoutScenario",
    },
    {
        scenario: validationTreePublicationLocalOnlyScenario,
        exportName: "validationTreePublicationLocalOnlyScenario",
    },
    {
        scenario: validationTreePublicationIsolatedDirtyPrimaryScenario,
        exportName: "validationTreePublicationIsolatedDirtyPrimaryScenario",
    },
]);
