import { assert, assertEquals } from "@std/assert";
import type { GoldenScenario, GoldenScenarioResult } from "../testing/scenario-runner.js";
import { assertEventIncludes } from "../testing/scenario-runner.js";
import type { ScriptedInteractionSurface } from "../testing/scripted-review-surface.js";
import { plannedChangeCiRepairReentryScenario } from "./planned-change-workflow.js";
import { startupInitScenario } from "./slash-command-tree-lifecycle.ts";

const command = "test -f ci-fix.txt";
const repairedCommand = "test -f ci-fix.txt && printf repaired-command";
const base = {
    ...plannedChangeCiRepairReentryScenario,
    script: plannedChangeCiRepairReentryScenario.script.map((turn) =>
        turn.id === "engineer-repairs-failing-ci"
            ? {
                ...turn,
                toolCalls: [...(turn.toolCalls ?? []), {
                    name: "write",
                    arguments: {
                        path: ".wld/settings.json",
                        content: JSON.stringify({ verification_command: repairedCommand }) + "\n",
                    },
                }],
            }
            : turn.requiredTools?.includes("review_diff")
            ? {
                ...turn,
                toolCalls: [
                    ...turn.toolCalls,
                    {
                        name: "review_diff",
                        arguments: { command: "show", scope: "full", path: ".wld/settings.json" },
                    },
                ],
            }
            : turn
    ),
} satisfies GoldenScenario;

interface ValidationSettings {
    verification_command: string;
}

interface CommandPublication {
    deliveredText: string;
}
function assertCommandPrompts(result: GoldenScenarioResult, expected: number) {
    const interactions = result.state.scriptedInteractions as ScriptedInteractionSurface["consumed"];
    assertEquals(
        interactions.filter((entry) => String(entry.request.prompt).includes("runs this project's tests")).length,
        expected,
    );
    for (const key of ["settingsAtFailure", "savedSettings"]) {
        const savedSettings = JSON.parse(String(result.state[key])) as ValidationSettings;
        assertEquals(
            savedSettings.verification_command,
            command,
            `Project command must persist at ${key}.`,
        );
    }
    const publication = result.state.commandPublication as CommandPublication;
    const deliveredSettings = JSON.parse(publication.deliveredText) as ValidationSettings;
    assertEquals(
        deliveredSettings.verification_command,
        repairedCommand,
        "Repaired command must reach the remote target.",
    );
    assertEventIncludes(result, "runtime:validation-ci:failed");
    assertEventIncludes(result, "runtime:validation-ci:passed");
    assertEventIncludes(result, "runtime:tool:start:review_complete");
    assert(result.actor.consumed.includes("engineer-reports-ci-repair-complete"));
}

const deliveryActions = [
    ...base.actions.slice(0, 3),
    // Prove the answer is durable before repair/publication can incidentally
    // copy a settings file back from the execution worktree.
    { type: "waitForEvent", event: "runtime:validation-ci:failed", timeoutMs: 60000 },
    { type: "captureProjectFileText", path: ".wld/settings.json", key: "settingsAtFailure" },
    ...base.actions.slice(3, 9),
    { type: "captureProjectFileText", path: ".wld/settings.json", key: "savedSettings" },
    {
        type: "capturePublicationState",
        planName: "plan",
        deliveredPath: ".wld/settings.json",
        key: "commandPublication",
    },
];

export const routerValidationCommandRepairScenario: GoldenScenario = {
    ...base,
    name: "router-new-project-validation-command-survives-repair",
    initialAgentName: "router",
    coverage: [],
    committedProjectFiles: [],
    interactiveSelectPrompts: [],
    scriptedInteractions: [{
        type: "text",
        promptIncludes: "Enter the command that runs this project's tests",
        value: command,
    }],
    script: [
        {
            id: "router-routes-new-project-to-planner",
            agent: "router",
            phase: "triage",
            ordinal: 1,
            requiredTools: ["triage_report"],
            toolCalls: [{
                name: "triage_report",
                arguments: { routingIntent: "PLANNED_CHANGE", complexity: "LOW", summary: "Implement a small change." },
            }],
        },
        ...base.script,
    ],
    actions: deliveryActions,
    assertions: [
        ...base.assertions,
        (result) => {
            assertEventIncludes(result, "runtime:tool:start:triage_report");
            assertCommandPrompts(result, 1);
        },
    ],
};

export const initTutorialValidationCommandScenario: GoldenScenario = {
    ...base,
    name: "init-tutorial-reuses-uncommitted-validation-command",
    initialAgentName: "router",
    onboardingOfferHandled: false,
    coverage: [],
    committedProjectFiles: [],
    interactiveSelectPrompts: [],
    scriptedInteractions: [
        { type: "select", promptIncludes: "Would you like to run /init", value: "yes" },
        { type: "select", promptIncludes: "Init will create or update these project files", value: "yes" },
        { type: "select", promptIncludes: "Which command should RunWield use to verify this project?", value: command },
        { type: "select", promptIncludes: "This tutorial makes a real change", value: "start" },
        { type: "select", promptIncludes: "Tutorial guidance", value: "continue" },
    ],
    script: [
        {
            id: "init-confirms-validation-command-with-user",
            agent: "init",
            phase: "init",
            ordinal: 1,
            requiredTools: ["user_interview"],
            toolCalls: [{
                name: "user_interview",
                arguments: {
                    question: {
                        id: "verification_command",
                        type: "multiple_choice",
                        prompt: "Which command should RunWield use to verify this project?",
                        choices: [
                            { value: command, label: command },
                            { value: "no_verification", label: "No verification command" },
                        ],
                    },
                },
            }],
        },
        ...startupInitScenario.script.map((turn) => ({
            ...turn,
            ordinal: turn.ordinal + 1,
            toolCalls: turn.toolCalls?.map((call) =>
                call.name === "init_save_verification_command" ? { ...call, arguments: { command } } : call
            ),
        })),
        {
            id: "tutorial-planner-offers-small-change",
            agent: "planner",
            phase: "plan_review",
            ordinal: 1,
            text: "Choose a small improvement to the project documentation.",
        },
        ...base.script.map((turn) => {
            if (turn.agent === "planner") return { ...turn, ordinal: Number(turn.ordinal) + 1 };
            if (turn.requiredTools?.includes("review_diff")) {
                return {
                    ...turn,
                    toolCalls: [
                        ...turn.toolCalls,
                        {
                            name: "review_diff",
                            arguments: { command: "show", scope: "full", path: "docs/domain-language.md" },
                        },
                    ],
                };
            }
            return turn;
        }),
    ],
    actions: deliveryActions,
    assertions: [
        ...base.assertions,
        (result) => {
            assertEventIncludes(result, "model:faux-provider:init:init");
            assert(result.actor.consumed.includes("init-confirms-validation-command-with-user"));
            assertCommandPrompts(result, 0);
        },
    ],
};
