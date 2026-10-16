import process from "node:process";
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { HostedSession } from "../session/hosted-session.js";
import { ensureRootAgentSession } from "../session/session.js";
import { attachRecorder, makeUi } from "./validation-test-helpers.js";
import type { LocalCIPort, LocalCIResult } from "./validation-local-ci.ts";
import { runLocalCI, runMechanicalValidation } from "./validation.ts";

interface MechanicalFixture {
    hostedSession: HostedSession;
    rootAgentSession: Awaited<ReturnType<typeof ensureRootAgentSession>>;
    sessionManager: SessionManager;
    ui: ValidationUi;
}

interface ValidationUi {
    messages: string[];
    systemCalls: Array<{ validationProgress?: { stage?: string } }>;
    toolCalls: Array<{ name: string; args: string }>;
    toolOutputs: string[];
    toolResults: Array<{ isError: boolean }>;
    promptText: () => Promise<string>;
}

interface LocalCIFixture {
    calls: string[];
    port: LocalCIPort;
}

function defineLocalCIFixture(results: LocalCIResult[]): LocalCIFixture {
    const remaining = [...results];
    const calls: string[] = [];
    return {
        calls,
        port: {
            run: ({ cwd }) => {
                calls.push(cwd);
                const result = remaining.shift();
                if (!result) throw new Error("Local CI fixture exhausted");
                return Promise.resolve(result);
            },
        },
    };
}

async function activateMechanicalFixture(projectRoot: string): Promise<MechanicalFixture> {
    const ui = makeUi() as ValidationUi;
    const sessionManager = SessionManager.inMemory(projectRoot);
    const hostedSession = attachRecorder(
        new HostedSession({
            id: `mechanical-validation-${crypto.randomUUID()}`,
            cwd: projectRoot,
        }),
        ui,
    );
    // HostedSession's legacy minimal-manager JSDoc widens appendMessage beyond
    // Pi's real SessionManager signature; the concrete manager is the runtime object.
    hostedSession.setRootSessionManager(sessionManager);
    const rootAgentSession = await ensureRootAgentSession({
        hostedSession,
        agentName: "engineer",
        sessionManager,
    });
    return { hostedSession, rootAgentSession, sessionManager, ui };
}

function taskCompletedMessage(summary: string) {
    return fauxAssistantMessage(fauxToolCall("task_completed", { message: summary }));
}

test("runLocalCI emits one semantic validation tool lifecycle", async () => {
    await withRuntimeCommandFixture("validation-local-ci-", async ({ projectRoot }) => {
        const ui = makeUi() as ValidationUi;
        const hostedSession = attachRecorder(new HostedSession({ id: "validation-local-ci", cwd: projectRoot }), ui);
        ui.promptText = () => Promise.resolve("printf validation-output");

        const result = await runLocalCI({ hostedSession, cwd: projectRoot });

        assertEquals(result.kind, "completed");
        if (result.kind !== "completed") throw new Error("CI should complete.");
        assertEquals(result.exitCode, 0);
        assertEquals(
            ui.toolCalls.some((call) => call.name === "bash" && call.args === "printf validation-output"),
            true,
        );
        assertEquals(
            ui.toolOutputs.some((output) => output.includes("validation-output")),
            true,
        );
        assertEquals(
            ui.toolResults.some((result) => !result.isError),
            true,
        );
        hostedSession.dispose();
    });
});

test("runLocalCI streams large validation output without failing the process buffer", async () => {
    await withRuntimeCommandFixture("validation-large-output-", async ({ projectRoot }) => {
        const ui = makeUi() as ValidationUi;
        const hostedSession = attachRecorder(
            new HostedSession({ id: "validation-large-output", cwd: projectRoot }),
            ui,
        );
        ui.promptText = () =>
            Promise.resolve(
                `${JSON.stringify(process.execPath)} ${"-e"} "console.log('x'.repeat(1200000)); console.error('tail-marker')"`,
            );

        const result = await runLocalCI({ hostedSession, cwd: projectRoot });

        assertEquals(result.kind, "completed");
        if (result.kind !== "completed") throw new Error("CI should complete.");
        assertEquals(result.exitCode, 0);
        assertStringIncludes(result.output, "tail-marker");
        assertStringIncludes(result.output, "stdout truncated; showing last");
        assertEquals(
            ui.toolResults.some((result) => !result.isError),
            true,
        );
        hostedSession.dispose();
    });
});

test("Mechanical Validation runs real checklist and session machinery after CI passes", async () => {
    await withRuntimeCommandFixture("mechanical-pass-", async ({ projectRoot, setModelMessages }) => {
        setModelMessages([
            fauxAssistantMessage(
                fauxToolCall("manual_qa_completed", {
                    checklistMarkdown: "Manual verification steps for small-fix\n- [ ] Save settings and reload.",
                }),
            ),
        ]);
        const fixture = await activateMechanicalFixture(projectRoot);
        const ci = defineLocalCIFixture([{ kind: "completed", exitCode: 0, output: "ok" }]);

        const result = await runMechanicalValidation(
            {
                hostedSession: fixture.hostedSession,
                sessionManager: fixture.sessionManager,
                cwd: projectRoot,
                manualQaName: "small-fix",
                manualQaContext: "Fix the settings save action.",
            },
            ci.port,
        );

        assertEquals(result, { passed: true, attempts: 0 });
        assertEquals(ci.calls, [projectRoot]);
        assertEquals(fixture.hostedSession.getRootAgentName(), "engineer");
        assertEquals(
            fixture.sessionManager
                .getBranch()
                .some((entry) => entry.type === "custom" && entry.customType === "runwield.manual_qa_checklist"),
            true,
        );
        assertEquals(fixture.ui.systemCalls.map((call) => call.validationProgress?.stage).filter(Boolean), [
            "ci",
            "ci",
            "ci",
            "manual_qa",
            "terminal",
        ]);
        fixture.hostedSession.dispose();
    });
});

test("Mechanical Validation repairs through the real Engineer turn and then passes", async () => {
    await withRuntimeCommandFixture("mechanical-repair-", async ({ projectRoot, setModelMessages }) => {
        setModelMessages([
            taskCompletedMessage("- Repaired the fixture failure."),
            fauxAssistantMessage(
                fauxToolCall("manual_qa_completed", {
                    checklistMarkdown: "Manual verification steps for quick-fix\n- [ ] Exercise the repair.",
                }),
            ),
        ]);
        const fixture = await activateMechanicalFixture(projectRoot);
        const ci = defineLocalCIFixture([
            { kind: "completed", exitCode: 1, output: "fixture failure" },
            { kind: "completed", exitCode: 0, output: "ok" },
        ]);

        const result = await runMechanicalValidation(
            {
                hostedSession: fixture.hostedSession,
                sessionManager: fixture.sessionManager,
                cwd: projectRoot,
            },
            ci.port,
        );

        assertEquals(result, { passed: true, attempts: 1 });
        assertEquals(ci.calls, [projectRoot, projectRoot]);
        assertEquals(fixture.hostedSession.getRootAgentName(), "engineer");
        fixture.hostedSession.dispose();
    });
});

test("Mechanical Validation ignores task completion from an earlier Engineer turn", async () => {
    await withRuntimeCommandFixture("mechanical-stale-completion-", async ({ projectRoot, setModelResponse }) => {
        setModelResponse("I stopped before completing the repair.");
        const fixture = await activateMechanicalFixture(projectRoot);
        fixture.rootAgentSession.agent.state.messages.push({
            role: "toolResult",
            toolCallId: "stale-task-completed",
            toolName: "task_completed",
            content: [{ type: "text", text: "Completed earlier work." }],
            isError: false,
            timestamp: Date.now(),
        });
        const ci = defineLocalCIFixture([{ kind: "completed", exitCode: 1, output: "still failing" }]);

        const result = await runMechanicalValidation(
            {
                hostedSession: fixture.hostedSession,
                sessionManager: fixture.sessionManager,
                cwd: projectRoot,
            },
            ci.port,
        );

        assertEquals(result.passed, false);
        assertEquals(
            result.reason,
            "Engineer stopped on a blocker during the QUICK_FIX repair. Its last message says what stopped it.",
        );
        assertEquals(fixture.hostedSession.getActiveExecutionWorkflow()?.validationContinuation, true);
        fixture.hostedSession.dispose();
    });
});

test("Mechanical Validation stops after three real Engineer repair completions", async () => {
    await withRuntimeCommandFixture("mechanical-exhausted-", async ({ projectRoot, setModelMessages }) => {
        setModelMessages([
            taskCompletedMessage("- First repair attempt."),
            taskCompletedMessage("- Second repair attempt."),
            taskCompletedMessage("- Third repair attempt."),
        ]);
        const fixture = await activateMechanicalFixture(projectRoot);
        const ci = defineLocalCIFixture(
            Array.from({ length: 4 }, () => ({
                kind: "completed" as const,
                exitCode: 1,
                output: "still broken",
            })),
        );

        const result = await runMechanicalValidation(
            {
                hostedSession: fixture.hostedSession,
                sessionManager: fixture.sessionManager,
                cwd: projectRoot,
            },
            ci.port,
        );

        assertEquals(result.passed, false);
        assertEquals(result.attempts, 3);
        assertEquals(ci.calls.length, 4);
        assertEquals(
            fixture.ui.messages.some((message) => message.includes("quick fix tests still fail after 3 tries")),
            true,
        );
        assertEquals(
            fixture.sessionManager
                .getBranch()
                .some((entry) => entry.type === "custom" && entry.customType === "runwield.manual_qa_checklist"),
            false,
        );
        fixture.hostedSession.dispose();
    });
});

test("Mechanical Validation preserves the Engineer session when local CI is canceled", async () => {
    await withRuntimeCommandFixture("mechanical-canceled-", async ({ projectRoot }) => {
        const fixture = await activateMechanicalFixture(projectRoot);
        const ci = defineLocalCIFixture([
            {
                kind: "canceled",
                output: "Validation canceled.",
            },
        ]);

        const result = await runMechanicalValidation(
            {
                hostedSession: fixture.hostedSession,
                sessionManager: fixture.sessionManager,
                cwd: projectRoot,
            },
            ci.port,
        );

        assertEquals(result, { passed: false, attempts: 0, reason: "canceled" });
        assertEquals(fixture.hostedSession.getRootAgentName(), "engineer");
        assertEquals(
            fixture.ui.messages.some((message) => message.includes("quick fix tests were stopped")),
            true,
        );
        fixture.hostedSession.dispose();
    });
});
