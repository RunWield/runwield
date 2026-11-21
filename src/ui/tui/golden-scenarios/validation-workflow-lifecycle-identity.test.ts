import {
    validationTreeMismatchedWorktreeIdentityScenario,
    validationTreeAheadStatusScenario,
    validationTreeUnsupportedStatusScenario,
} from "./validation-workflow-tree-lifecycle.ts";
import { registerValidationWorkflowTests } from "./validation-workflow-test-runner.ts";

registerValidationWorkflowTests("src/ui/tui/golden-scenarios/validation-workflow-tree-lifecycle.ts", [
    {
        scenario: validationTreeMismatchedWorktreeIdentityScenario,
        exportName: "validationTreeMismatchedWorktreeIdentityScenario",
    },
    {
        scenario: validationTreeAheadStatusScenario,
        exportName: "validationTreeAheadStatusScenario",
    },
    {
        scenario: validationTreeUnsupportedStatusScenario,
        exportName: "validationTreeUnsupportedStatusScenario",
    },
]);
