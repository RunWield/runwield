import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createSessionRuntime, SessionRuntime } from "./session-runtime.ts";
import { SessionHost } from "./session-host.ts";
import { getRuntimeRootAgentSession } from "./runtime/support.ts";
import { createTaskCompletedTool } from "../../tools/task-completed.ts";
import { RuntimeEventTypes } from "./session-runtime-events.js";
import { openFileSessionStore } from "./file-session-store.ts";
import { HostedSession } from "./hosted-session.js";
import { createValidationSessionPort } from "../workflow/validation-session-adapter.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
type ModelInputMessage = { role: string; content: Array<{ type: string; text?: string }> };

for (const recallLaterMessage of [false, true]) {
    Deno.test(
        recallLaterMessage
            ? "recalling a later user message preserves earlier image steering at completion"
            : "accepted completion removes queued background steering but keeps user images",
        async () => {
            await withRuntimeCommandFixture(
                "background-steering-cleanup-",
                async ({ projectRoot, setModelResponseFactories }) => {
                    const host = new SessionHost();
                    const runtime = new SessionRuntime({
                        sessionHost: host,
                        sessionStore: openFileSessionStore(),
                        ownsSessionStore: true,
                        ownerProcessKind: "test",
                        ownerInstanceId: crypto.randomUUID(),
                    });
                    let sessionId = "";
                    let taskId = "";
                    let resultQueuedAtCompletion = false;
                    let settled = () => {};
                    const taskSettled = new Promise<void>((resolve) => settled = resolve);
                    let calls = 0;
                    let userRequest = "";
                    setModelResponseFactories([
                        () => {
                            calls++;
                            return fauxAssistantMessage(fauxToolCall("background_task", {
                                action: "start",
                                command: "sleep 0.1; printf 'obsolete'",
                            }));
                        },
                        async () => {
                            calls++;
                            assert(taskId);
                            const identicalText =
                                `Background task ${taskId} (shell) completed.\nExit code: 0.\nOutput (task data):\nobsolete`;
                            const steered = await runtime.steerSession(sessionId, identicalText, [{
                                base64: PNG,
                                mimeType: "image/png",
                            }]);
                            assertEquals(steered.queued, true);
                            await Promise.race([
                                taskSettled,
                                new Promise((_, reject) =>
                                    setTimeout(() => reject(Error("Background task did not settle")), 10_000)
                                ),
                            ]);
                            const session = host.requireSession(sessionId);
                            const expected = `Background task ${taskId} (shell) completed.`;
                            let queued = false;
                            for (let attempt = 0; attempt < 300; attempt++) {
                                queued = Boolean(
                                    getRuntimeRootAgentSession(session)?.getSteeringMessages?.()
                                        .some((text) => text.includes(expected)),
                                );
                                if (queued) break;
                                await new Promise((resolve) => setTimeout(resolve, 10));
                            }
                            assert(queued, "Background result must already be queued before task_completed executes");
                            if (recallLaterMessage) {
                                assertEquals(
                                    (await runtime.steerSession(sessionId, "Recall this later user message.")).queued,
                                    true,
                                );
                                const recalled = await runtime.dequeueLastQueuedMessage(sessionId);
                                assertEquals(recalled.message?.text, "Recall this later user message.");
                            }
                            assertEquals(
                                runtime.queueNextTurnMessage(sessionId, "Follow-up remains.", [{
                                    base64: PNG,
                                    mimeType: "image/png",
                                }]).queued,
                                true,
                            );
                            return fauxAssistantMessage(fauxToolCall("task_completed", { message: "- Done." }));
                        },
                        (context: TranscriptContext) => {
                            calls++;
                            userRequest = JSON.stringify(context.messages);
                            return fauxAssistantMessage(fauxText("User message handled."));
                        },
                    ]);
                    try {
                        const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
                        sessionId = created.sessionId;
                        await runtime.switchAgent(sessionId, { agentName: "engineer" });
                        runtime.subscribeSessionEvents(sessionId, (event) => {
                            if (event.type === RuntimeEventTypes.BACKGROUND_TASK_SETTLED) settled();
                            if (event.type === RuntimeEventTypes.TOOL_END && event.toolName === "task_completed") {
                                resultQueuedAtCompletion = (getRuntimeRootAgentSession(host.requireSession(sessionId))
                                    ?.getSteeringMessages?.().filter((text) =>
                                        text.includes(`Background task ${taskId} (shell) completed.`)
                                    ).length || 0) > 1;
                            }
                            if (
                                event.type === RuntimeEventTypes.TOOL_END && event.toolName === "background_task" &&
                                event.details && typeof event.details === "object" && "task_id" in event.details &&
                                typeof event.details.task_id === "string"
                            ) taskId = event.details.task_id;
                        });
                        assertEquals((await runtime.promptUserTurn(sessionId, { initialRequest: "Finish." })).ok, true);
                        assertEquals(calls, 3);
                        assertEquals(resultQueuedAtCompletion, false);
                        assertStringIncludes(userRequest, "image/png");
                        const messages = JSON.parse(userRequest) as ModelInputMessage[];
                        const matching = messages.filter((message) =>
                            message.role === "user" &&
                            message.content.some((block) =>
                                block.text?.includes(`Background task ${taskId} (shell) completed.`)
                            )
                        );
                        assertEquals(matching.length, 1);
                        assertEquals(matching[0].content.some((block) => block.type === "image"), true);
                        assertEquals(runtime.getSessionBackgroundTaskState(sessionId)?.pending, 0);
                        const followUp = runtime.takeNextTurnMessage(sessionId);
                        assertEquals(followUp.message?.text, "Follow-up remains.");
                        assertEquals(followUp.message?.images?.[0]?.base64, PNG);
                        const store = openFileSessionStore();
                        try {
                            const session = store.getSessionById(
                                runtime.getSessionSnapshot(sessionId)?.managed?.runwieldSessionId || "",
                            );
                            assert(session);
                            assertStringIncludes(
                                await Deno.readTextFile(session.transcriptPath),
                                "runwield.background_task_steering",
                            );
                        } finally {
                            store.close();
                        }
                    } finally {
                        await runtime.closeAllSessionsWhenIdle();
                    }
                },
            );
        },
    );
}

Deno.test("completion during generated result acquisition prevents model dispatch", async () => {
    await withRuntimeCommandFixture("background-dispatch-race-", async ({ projectRoot, setModelResponseFactories }) => {
        let calls = 0;
        setModelResponseFactories([
            () => {
                calls++;
                return fauxAssistantMessage(fauxToolCall("background_task", {
                    action: "start",
                    command: "sleep 0.2; printf 'old result'",
                }));
            },
            () => {
                calls++;
                return fauxAssistantMessage(fauxText("Parent finished."));
            },
            () => {
                calls++;
                return fauxAssistantMessage(fauxText("Unexpected old result."));
            },
        ]);
        const host = new SessionHost();
        const runtime = new SessionRuntime({
            sessionHost: host,
            sessionStore: openFileSessionStore(),
            ownsSessionStore: true,
            ownerProcessKind: "test",
            ownerInstanceId: crypto.randomUUID(),
        });
        try {
            const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            await runtime.switchAgent(created.sessionId, { agentName: "engineer" });
            const completions: Array<Promise<{ details: { outcome: string } }>> = [];
            let parentEnded = false;
            runtime.subscribeSessionEvents(created.sessionId, (event) => {
                if (event.type === RuntimeEventTypes.TURN_END) parentEnded = true;
                if (
                    event.type !== RuntimeEventTypes.BUSY_CHANGED || !event.busy || !parentEnded ||
                    completions.length
                ) return;
                const session = host.requireSession(created.sessionId);
                // Suppress while the generated result is being acquired.
                void session.backgroundTasks.cancelAllAndSuppress();
                const tool = createTaskCompletedTool({ hostedSession: session, agentName: "engineer" });
                // @ts-expect-error The tool ignores the unused extension context in this direct execution.
                completions.push(tool.execute("completion", { message: "- Done." }));
            });
            assertEquals((await runtime.promptUserTurn(created.sessionId, { initialRequest: "Start work." })).ok, true);
            for (let index = 0; index < 300 && !completions.length; index++) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert(completions.length);
            assertEquals((await completions[0]).details.outcome, "task_completed");
            assertEquals(calls, 2);
            assertEquals(runtime.getSessionBackgroundTaskState(created.sessionId)?.pending, 0);
        } finally {
            await runtime.closeAllSessionsWhenIdle();
        }
    });
});

Deno.test("completion during generated result owner alignment rejects the stale turn", async () => {
    await withRuntimeCommandFixture(
        "background-alignment-race-",
        async ({ projectRoot, setModelResponseFactories }) => {
            let calls = 0;
            setModelResponseFactories([
                () => {
                    calls++;
                    return fauxAssistantMessage(fauxToolCall("background_task", {
                        action: "start",
                        command: "sleep 0.8; printf 'stale'",
                    }));
                },
                () => {
                    calls++;
                    return fauxAssistantMessage(fauxText("Parent finished."));
                },
                () => {
                    calls++;
                    return fauxAssistantMessage(fauxText("Unexpected stale result."));
                },
            ]);
            const host = new SessionHost();
            const runtime = new SessionRuntime({
                sessionHost: host,
                sessionStore: openFileSessionStore(),
                ownsSessionStore: true,
                ownerProcessKind: "test",
                ownerInstanceId: crypto.randomUUID(),
            });
            try {
                const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
                await runtime.switchAgent(created.sessionId, { agentName: "engineer" });
                assertEquals(
                    (await runtime.promptUserTurn(created.sessionId, { initialRequest: "Start task." })).ok,
                    true,
                );
                await runtime.switchAgent(created.sessionId, { agentName: "planner" });
                assertEquals(
                    (await runtime.setActiveExecutionWorkflow(created.sessionId, {
                        planName: "alignment-plan",
                        triageMeta: { classification: "PLANNED_CHANGE" },
                        executionAgent: "engineer",
                        executionStarted: true,
                    })).ok,
                    true,
                );
                const completions: Array<Promise<{ details: { outcome: string } }>> = [];
                const session = host.requireSession(created.sessionId);
                const beginTurn = session.beginTurn.bind(session);
                let staleTurnAccepted = false;
                session.beginTurn = (turnId: string) => {
                    staleTurnAccepted = true;
                    return beginTurn(turnId);
                };
                runtime.subscribeSessionEvents(created.sessionId, (event) => {
                    if (
                        event.type !== RuntimeEventTypes.AGENT_CHANGED || event.agentName !== "plan-engineer" ||
                        completions.length
                    ) return;
                    const tool = createTaskCompletedTool({
                        hostedSession: host.requireSession(created.sessionId),
                        agentName: "Plan Engineer",
                    });
                    // @ts-expect-error Direct execution ignores extension context.
                    completions.push(tool.execute("alignment", { message: "- Done." }));
                });
                for (let index = 0; index < 300 && !completions.length; index++) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
                assert(completions.length, "Generated turn did not align its owner");
                assertEquals((await completions[0]).details.outcome, "task_completed");
                assertEquals(staleTurnAccepted, false);
                assertEquals(calls, 2);
                assertEquals(runtime.getSessionBackgroundTaskState(created.sessionId)?.pending, 0);
            } finally {
                await runtime.closeAllSessionsWhenIdle();
            }
        },
    );
});

Deno.test("completion after generated turn acceptance prevents final model dispatch", async () => {
    await withRuntimeCommandFixture(
        "background-final-dispatch-",
        async ({ projectRoot, setModelResponseFactories }) => {
            let calls = 0;
            setModelResponseFactories([
                () => {
                    calls++;
                    return fauxAssistantMessage(fauxToolCall("background_task", {
                        action: "start",
                        command:
                            `while [ ! -f '${projectRoot}/release-result' ]; do sleep 0.01; done; printf 'stale output'`,
                    }));
                },
                () => {
                    calls++;
                    return fauxAssistantMessage(fauxText("Parent finished."));
                },
                () => {
                    calls++;
                    return fauxAssistantMessage(fauxText("Unexpected stale result."));
                },
            ]);
            const host = new SessionHost();
            const runtime = new SessionRuntime({
                sessionHost: host,
                sessionStore: openFileSessionStore(),
                ownsSessionStore: true,
                ownerProcessKind: "test",
                ownerInstanceId: crypto.randomUUID(),
            });
            let releasePreparation = () => {};
            try {
                const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
                await runtime.switchAgent(created.sessionId, { agentName: "engineer" });
                const session = host.requireSession(created.sessionId);
                releasePreparation = () => session.completeAgentSteeringPreparation("hold-generated-prompt");
                const completions: Array<Promise<{ details: { outcome: string } }>> = [];
                let armed = false;
                let preparationHeld = false;
                let enteredPreparationWait = () => {};
                const preparationWaitEntered = new Promise<void>((resolve) => enteredPreparationWait = resolve);
                const waitForPreparation = session.waitForAgentSteeringPreparations.bind(session);
                session.waitForAgentSteeringPreparations = () => {
                    if (preparationHeld) enteredPreparationWait();
                    return waitForPreparation();
                };
                let endGeneratedTurn = () => {};
                const generatedTurnEnded = new Promise<void>((resolve) => endGeneratedTurn = resolve);
                runtime.subscribeSessionEvents(created.sessionId, (event) => {
                    if (event.type === RuntimeEventTypes.TURN_END && armed && preparationHeld) endGeneratedTurn();
                    if (event.type !== RuntimeEventTypes.TURN_START || !armed || preparationHeld) return;
                    preparationHeld = true;
                    session.beginAgentSteeringPreparation("hold-generated-prompt");
                });
                assertEquals(
                    (await runtime.promptUserTurn(created.sessionId, { initialRequest: "Start work." })).ok,
                    true,
                );
                armed = true;
                await Deno.writeTextFile(`${projectRoot}/release-result`, "release\n");
                for (let attempt = 0; attempt < 300 && !preparationHeld; attempt++) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
                assert(preparationHeld, "Generated turn did not reach prompt preparation");
                // TURN_START also marks managed acquisition. Wait for the accepted
                // generated turn before completing work, while preparation blocks dispatch.
                for (let attempt = 0; attempt < 300 && !session.generatedTaskTurnId; attempt++) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
                assert(session.generatedTaskTurnId, "Generated turn was not accepted");
                // Observe the real wait instead of assuming prompt preparation finishes within a fixed delay.
                await Promise.race([
                    preparationWaitEntered,
                    new Promise((_, reject) =>
                        setTimeout(() => reject(Error("Generated turn did not enter preparation wait")), 10_000)
                    ),
                ]);
                const tool = createTaskCompletedTool({ hostedSession: session, agentName: "engineer" });
                // @ts-expect-error Direct execution ignores extension context.
                completions.push(tool.execute("final", { message: "- Done." }));
                assertEquals((await completions[0]).details.outcome, "task_completed");
                session.completeAgentSteeringPreparation("hold-generated-prompt");
                let settlementTimeout;
                try {
                    await Promise.race([
                        generatedTurnEnded,
                        new Promise((_, reject) => {
                            settlementTimeout = setTimeout(
                                () => reject(Error("Generated turn did not settle")),
                                60_000,
                            );
                        }),
                    ]);
                } finally {
                    clearTimeout(settlementTimeout);
                }
                assertEquals(calls, 2);
            } finally {
                releasePreparation();
                await runtime.closeAllSessionsWhenIdle();
            }
        },
    );
});

Deno.test("automatic validation repair can start fresh background work after completion", async () => {
    await withRuntimeCommandFixture("background-repair-", async ({ projectRoot }) => {
        const session = new HostedSession({ id: crypto.randomUUID(), cwd: projectRoot });
        try {
            const completed = createTaskCompletedTool({ hostedSession: session, agentName: "engineer" });
            // @ts-expect-error Direct execution ignores extension context.
            assertEquals((await completed.execute("old", { message: "- Done." })).details.outcome, "task_completed");
            const port = createValidationSessionPort(session, {
                semanticReviewPort: {
                    runIsolatedAgentSession: async () => {
                        const task = session.backgroundTasks.startShell({
                            command: "printf 'fresh repair'",
                            cwd: projectRoot,
                        });
                        await session.backgroundTasks.wait(task.task_id);
                        assertEquals(session.backgroundTasks.canDeliver(task.task_id), true);
                        return [];
                    },
                },
            });
            await port.runIndependentRepairTurn({
                kind: "validation",
                agentName: "reviewer-feedback-engineer",
                userRequest: "Repair.",
                cwd: projectRoot,
            });
            assertEquals(session.backgroundTasks.pendingCompletions().length, 1);
        } finally {
            await session.dispose();
        }
    });
});

Deno.test("fresh work in the same Session receives new background results after completion", async () => {
    await withRuntimeCommandFixture("background-next-work-", async ({ projectRoot, setModelResponseFactories }) => {
        let generatedRequest = "";
        let received = () => {};
        const delivered = new Promise<void>((resolve) => received = resolve);
        setModelResponseFactories([
            () => fauxAssistantMessage(fauxToolCall("task_completed", { message: "- Previous work complete." })),
            () =>
                fauxAssistantMessage(fauxToolCall("background_task", {
                    action: "start",
                    command: "sleep 0.2; printf 'fresh result'",
                })),
            () => fauxAssistantMessage(fauxText("New parent finished.")),
            (context: TranscriptContext) => {
                generatedRequest = JSON.stringify(context.messages);
                received();
                return fauxAssistantMessage(fauxText("Fresh result received."));
            },
        ]);
        const runtime = createSessionRuntime({ ownerProcessKind: "test" });
        try {
            const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            await runtime.switchAgent(created.sessionId, { agentName: "engineer" });
            assertEquals(
                (await runtime.promptUserTurn(created.sessionId, { initialRequest: "Complete old work." })).ok,
                true,
            );
            assertEquals(
                (await runtime.promptUserTurn(created.sessionId, { initialRequest: "Start new work." })).ok,
                true,
            );
            await Promise.race([
                delivered,
                new Promise((_, reject) => setTimeout(() => reject(Error("Fresh result did not arrive")), 10_000)),
            ]);
            assertStringIncludes(generatedRequest, "fresh result");
        } finally {
            await runtime.closeAllSessionsWhenIdle();
        }
    });
});

Deno.test("task_completed warns before cancelling a running shell task and does not deliver its late result", async () => {
    await withRuntimeCommandFixture("background-completion-", async ({ projectRoot, setModelResponseFactories }) => {
        let calls = 0;
        const outcomes: string[] = [];
        let taskId = "";
        setModelResponseFactories([
            () => {
                calls++;
                return fauxAssistantMessage(fauxToolCall("background_task", {
                    action: "start",
                    command: "sleep 8; printf 'late result'",
                }));
            },
            () => {
                calls++;
                return fauxAssistantMessage(fauxToolCall("task_completed", { message: "- Done." }));
            },
            () => {
                calls++;
                return fauxAssistantMessage(fauxToolCall("task_completed", { message: "- Done." }));
            },
            () => {
                calls++;
                return fauxAssistantMessage(fauxText("Unexpected model request."));
            },
        ]);
        const runtime = createSessionRuntime({ ownerProcessKind: "test" });
        try {
            const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            await runtime.switchAgent(created.sessionId, { agentName: "engineer" });
            runtime.subscribeSessionEvents(created.sessionId, (event) => {
                if (event.type !== RuntimeEventTypes.TOOL_END) return;
                if (
                    event.toolName === "background_task" && event.details && typeof event.details === "object" &&
                    "task_id" in event.details && typeof event.details.task_id === "string"
                ) {
                    taskId = event.details.task_id;
                }
                if (
                    event.toolName === "task_completed" && event.details && typeof event.details === "object" &&
                    "outcome" in event.details && typeof event.details.outcome === "string"
                ) {
                    outcomes.push(event.details.outcome);
                }
            });
            assertEquals(
                (await runtime.promptUserTurn(created.sessionId, { initialRequest: "Finish the task." })).ok,
                true,
            );
            assert(taskId);
            assertEquals(outcomes, ["rejected", "task_completed"]);
            assertEquals(calls, 3);
            const state = runtime.getSessionBackgroundTaskState(created.sessionId);
            assertEquals(state?.active, 0);
            assertEquals(state?.pending, 0);
            assertStringIncludes(JSON.stringify(runtime.getSessionSnapshot(created.sessionId)), "engineer");
        } finally {
            await runtime.closeAllSessionsWhenIdle();
        }
    });
});
