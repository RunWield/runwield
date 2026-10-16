import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import {
    attachSessionEventSubscribers,
    buildAgentSession,
    runPrompt,
    runIsolatedAgentSession,
    runNonInteractiveAgentPrompt,
} from "./session.js";
import { HostedSession } from "./hosted-session.js";
import { createReplayEvents } from "./session-transcript-projection.js";
import { attachRunawayLoopGuard, RunawayLoopGuardStoppedError } from "./runaway-loop-guard.ts";

/** @typedef {{ type: string, message?: string }} ProviderNotice */

test("an interrupted provider response retries the same request and completes", async () => {
    await withRuntimeCommandFixture("provider-eof-retry-", async (fixture) => {
        const settings = JSON.parse(await fsReadFile(fixture.settingsPath, "utf8"));
        settings.retry = { enabled: true, maxRetries: 1, baseDelayMs: 1 };
        await fsWriteFile(fixture.settingsPath, JSON.stringify(settings));
        /** @type {import('@earendil-works/pi-ai').TranscriptContext[]} */
        const requests = [];
        fixture.setModelResponseFactories([
            (context) => {
                requests.push(context);
                return fauxAssistantMessage(fauxText("partial"), {
                    stopReason: "error",
                    errorMessage: "Unexpected EOF",
                });
            },
            (context) => {
                requests.push(context);
                return fauxAssistantMessage(fauxText("Recovered answer"));
            },
        ]);
        const manager = SessionManager.create(fixture.projectRoot, join(fixture.homeDir, "sessions"));
        const { session } = await buildAgentSession({
            agentName: "guide",
            cwd: fixture.projectRoot,
            toolNames: [],
            sessionManager: manager,
        });
        const retryEvents = [];
        const guard = attachRunawayLoopGuard({ session, requestId: "synthetic-provider-retry" });
        const unsubscribe = session.subscribe((event) => {
            if (event.type === "auto_retry_start") retryEvents.push(event);
        });
        try {
            await session.prompt("Keep this request");
            assertEquals(requests.length, 2);
            assertEquals(
                session.sessionManager.getBranch().flatMap((entry) =>
                    entry.type === "custom" && entry.customType === "runwield.loop_guard_turn" ? [entry.data] : [],
                ),
                [
                    { version: 1, requestId: "synthetic-provider-retry", turnCount: 1 },
                    { version: 1, requestId: "synthetic-provider-retry", turnCount: 2 },
                ],
            );
            assertEquals(retryEvents.length, 1);
            assertStringIncludes(JSON.stringify(requests[1].messages), "Keep this request");
            assertEquals(JSON.stringify(requests[1].messages).includes("partial"), false);
            assertStringIncludes(JSON.stringify(session.messages.at(-1)), "Recovered answer");
            const file = manager.getSessionFile();
            if (!file) throw new Error("Missing persisted transcript");
            const transcript = await fsReadFile(file, "utf8");
            assertStringIncludes(transcript, "Network error: Unexpected EOF");
            assertStringIncludes(transcript, "Recovered answer");
            const entries = transcript.trim().split("\n").map((line) => JSON.parse(line));
            const replay = createReplayEvents("eof-then-success", entries);
            const second = createReplayEvents("eof-then-success", entries);
            assertEquals(replay, second);
            assertEquals(await fsReadFile(file, "utf8"), transcript);
            assertEquals(replay.filter((event) => event.type === "terminal_error").length, 1);
            assertEquals(
                replay.filter((event) => event.type === "assistant_text_delta").at(-1)?.delta,
                "Recovered answer",
            );
            assertEquals(replay.some((event) => /retrying|currently stopped/i.test(event.message || "")), false);
        } finally {
            unsubscribe();
            guard.dispose();
            session.dispose();
        }
    });
});

test("default EOF retries wait 2, 4, and 8 seconds and stop after four requests", async () => {
    await withRuntimeCommandFixture("provider-default-backoff-", async (fixture) => {
        /** @type {number[]} */
        const starts = [];
        fixture.setModelResponseFactories(Array.from({ length: 4 }, () => () => {
            starts.push(Date.now());
            return fauxAssistantMessage(fauxText("interrupted"), {
                stopReason: "error",
                errorMessage: "Unexpected EOF",
            });
        }));
        const { session } = await buildAgentSession({ agentName: "guide", cwd: fixture.projectRoot, toolNames: [] });
        /** @type {number[]} */
        const schedules = [];
        /** @type {Array<{ attempt: number, success: boolean }>} */
        const endings = [];
        const unsubscribe = session.subscribe((event) => {
            if (event.type === "auto_retry_start") schedules.push(event.delayMs);
            if (event.type === "auto_retry_end") endings.push(event);
        });
        try {
            await session.prompt("Exhaust provider retries");
            assertEquals(starts.length, 4);
            assertEquals(schedules, [2000, 4000, 8000]);
            assertEquals(endings.map((event) => [event.attempt, event.success]), [[3, false]]);
            for (let index = 1; index < starts.length; index++) {
                assertEquals(starts[index] - starts[index - 1] >= schedules[index - 1], true);
            }
        } finally {
            unsubscribe();
            session.dispose();
        }
    });
});

test("disabled and zero retry budgets leave an EOF as one provider request", async () => {
    for (const retry of [{ enabled: false }, { enabled: true, maxRetries: 0, baseDelayMs: 1 }]) {
        await withRuntimeCommandFixture("provider-no-retry-", async (fixture) => {
            const settings = JSON.parse(await fsReadFile(fixture.settingsPath, "utf8"));
            settings.retry = retry;
            await fsWriteFile(fixture.settingsPath, JSON.stringify(settings));
            let calls = 0;
            fixture.setModelResponseFactories([() => {
                calls++;
                return fauxAssistantMessage(fauxText("partial"), {
                    stopReason: "error",
                    errorMessage: "Unexpected EOF",
                });
            }]);
            const { session } = await buildAgentSession({
                agentName: "guide",
                cwd: fixture.projectRoot,
                toolNames: [],
            });
            try {
                await session.prompt("Do not retry");
                assertEquals(calls, 1);
            } finally {
                session.dispose();
            }
        });
    }
});

test("Pi retains existing transient retry rules and exclusions", async () => {
    /** @type {Array<[string, boolean]>} */
    const diagnostics = [
        ["socket hang up", true],
        ["connection error", true],
        ["timeout", true],
        ["HTTP 429 throttling", true],
        ["HTTP 503 service unavailable", true],
        ["401 Unauthorized", false],
        ["insufficient_quota billing", false],
        ["invalid_request_error", false],
        ["exceeds the context window", false],
        ["surprise internal parser failure", false],
    ];
    for (const [diagnostic, shouldRetry] of diagnostics) {
        await withRuntimeCommandFixture("provider-error-matrix-", async (fixture) => {
            const settings = JSON.parse(await fsReadFile(fixture.settingsPath, "utf8"));
            settings.retry = { enabled: true, maxRetries: 1, baseDelayMs: 1 };
            if (diagnostic === "exceeds the context window") settings.compaction = { enabled: false };
            await fsWriteFile(fixture.settingsPath, JSON.stringify(settings));
            let calls = 0;
            fixture.setModelResponseFactories([
                () => {
                    calls++;
                    return fauxAssistantMessage(fauxText("partial"), { stopReason: "error", errorMessage: diagnostic });
                },
                () => {
                    calls++;
                    return fauxAssistantMessage(fauxText("recovered"));
                },
            ]);
            const { session } = await buildAgentSession({
                agentName: "guide",
                cwd: fixture.projectRoot,
                toolNames: [],
            });
            try {
                await session.prompt("Test provider classification");
                assertEquals(calls, shouldRetry ? 2 : 1, diagnostic);
            } finally {
                session.dispose();
            }
        });
    }
});

test("cancel during backoff stops requests and permits a later turn", async () => {
    await withRuntimeCommandFixture("provider-cancel-backoff-", async (fixture) => {
        const settings = JSON.parse(await fsReadFile(fixture.settingsPath, "utf8"));
        settings.retry = { enabled: true, maxRetries: 2, baseDelayMs: 500 };
        await fsWriteFile(fixture.settingsPath, JSON.stringify(settings));
        let calls = 0;
        fixture.setModelResponseFactories([
            () => {
                calls++;
                return fauxAssistantMessage(fauxText("partial"), {
                    stopReason: "error",
                    errorMessage: "Unexpected EOF",
                });
            },
            () => {
                calls++;
                return fauxAssistantMessage(fauxText("Later turn succeeded"));
            },
        ]);
        const { session } = await buildAgentSession({ agentName: "guide", cwd: fixture.projectRoot, toolNames: [] });
        const events = [];
        const unsubscribe = session.subscribe((event) => {
            if (event.type === "auto_retry_start") {
                events.push(event);
                queueMicrotask(() => {
                    void session.abort();
                });
            }
        });
        try {
            await session.prompt("Stop during backoff");
            assertEquals(calls, 1);
            assertEquals(events.length, 1);
            await session.prompt("Continue after cancellation");
            assertEquals(calls, 2);
            assertStringIncludes(JSON.stringify(session.messages.at(-1)), "Later turn succeeded");
        } finally {
            unsubscribe();
            session.dispose();
        }
    });
});

test("cancel an active provider response without retrying and continue later", async () => {
    await withRuntimeCommandFixture("provider-cancel-active-", async (fixture) => {
        let calls = 0;
        /** @type {() => void} */
        let notifyStart = () => {};
        const started = new Promise((resolve) => {
            notifyStart = () => resolve(undefined);
        });
        fixture.setModelResponseFactories([
            async () => {
                calls++;
                notifyStart();
                await new Promise((resolve) => setTimeout(resolve, 40));
                return fauxAssistantMessage(fauxText("active"), {
                    stopReason: "error",
                    errorMessage: "Unexpected EOF",
                });
            },
            () => {
                calls++;
                return fauxAssistantMessage(fauxText("Continued"));
            },
        ]);
        const { session } = await buildAgentSession({ agentName: "guide", cwd: fixture.projectRoot, toolNames: [] });
        try {
            const pending = session.prompt("Cancel response");
            await started;
            await session.abort();
            await pending;
            assertEquals(calls, 1);
            await session.prompt("Continue");
            assertEquals(calls, 2);
        } finally {
            session.dispose();
        }
    });
});

test("Pi summary retry recovers from EOF without a second policy", async () => {
    await withRuntimeCommandFixture("provider-summary-retry-", async (fixture) => {
        const settings = JSON.parse(await fsReadFile(fixture.settingsPath, "utf8"));
        settings.retry = { enabled: true, maxRetries: 1, baseDelayMs: 1 };
        settings.compaction = { enabled: true, reserveTokens: 16384, keepRecentTokens: 1 };
        await fsWriteFile(fixture.settingsPath, JSON.stringify(settings));
        const manager = SessionManager.create(fixture.projectRoot, join(fixture.homeDir, "sessions"));
        manager.appendMessage({
            role: "user",
            content: [{ type: "text", text: "Summarize this earlier request." }],
            timestamp: Date.now(),
        });
        manager.appendMessage(fauxAssistantMessage(fauxText("Earlier answer.")));
        manager.appendMessage({
            role: "user",
            content: [{ type: "text", text: "Keep this recent request." }],
            timestamp: Date.now(),
        });
        let calls = 0;
        fixture.setModelResponseFactories([
            () => {
                calls++;
                return fauxAssistantMessage(fauxText("partial"), {
                    stopReason: "error",
                    errorMessage: "Unexpected EOF",
                });
            },
            () => {
                calls++;
                return fauxAssistantMessage(fauxText("Recovered summary"));
            },
        ]);
        const hostedSession = new HostedSession({ id: "summary-retry", cwd: fixture.projectRoot });
        /** @type {ProviderNotice[]} */
        const notices = [];
        hostedSession.setEventSink({ emit: (/** @type {ProviderNotice} */ event) => notices.push(event) });
        const { session, agentDef } = await buildAgentSession({
            hostedSession,
            agentName: "guide",
            cwd: fixture.projectRoot,
            toolNames: [],
            sessionManager: manager,
        });
        const subscriber = attachSessionEventSubscribers(session, agentDef, undefined, hostedSession);
        /** @type {Array<{ attempt: number, maxAttempts: number, delayMs: number }>} */
        const scheduled = [];
        const unsubscribe = session.subscribe((event) => {
            if (event.type === "summarization_retry_scheduled") scheduled.push(event);
        });
        try {
            await session.compact();
            assertEquals(calls, 2);
            assertEquals(scheduled.map((event) => [event.attempt, event.maxAttempts, event.delayMs]), [[1, 1, 1]]);
            assertEquals(
                notices.some((event) => event.message?.includes("Retrying summary in 0.001 seconds (1 of 1)")),
                true,
            );
            const file = manager.getSessionFile();
            if (!file) throw new Error("Missing compaction transcript");
            assertStringIncludes(await fsReadFile(file, "utf8"), "Recovered summary");
        } finally {
            unsubscribe();
            subscriber.unsubscribe();
            session.dispose();
            hostedSession.dispose();
        }
    });
});

test("isolated Pi Session recovers EOF without repeating the user request", async () => {
    await withRuntimeCommandFixture("provider-isolated-retry-", async (fixture) => {
        const settings = JSON.parse(await fsReadFile(fixture.settingsPath, "utf8"));
        settings.retry = { enabled: true, maxRetries: 1, baseDelayMs: 1 };
        settings.agents = { guide: { temperature: 0.3 } };
        await fsWriteFile(fixture.settingsPath, JSON.stringify(settings));
        /** @type {import('@earendil-works/pi-ai').TranscriptContext[]} */
        const requests = [];
        /** @type {Array<number | undefined>} */
        const temperatures = [];
        fixture.setModelResponseFactories([
            (context, options) => {
                requests.push(context);
                temperatures.push(options?.temperature);
                return fauxAssistantMessage(fauxText("incomplete"), {
                    stopReason: "error",
                    errorMessage: "Unexpected EOF",
                });
            },
            (context, options) => {
                requests.push(context);
                temperatures.push(options?.temperature);
                return fauxAssistantMessage(fauxText("Isolated answer"));
            },
        ]);
        const hostedSession = new HostedSession({ id: "isolated-retry", cwd: fixture.projectRoot });
        try {
            const messages = await runIsolatedAgentSession({
                hostedSession,
                agentName: "guide",
                userRequest: "Keep isolated request",
                toolNames: [],
            });
            assertEquals(requests.length, 2);
            assertEquals(temperatures, [0.3, 0.3]);
            assertStringIncludes(JSON.stringify(requests[1].messages), "Keep isolated request");
            assertEquals(
                requests[1].messages.some((message) =>
                    message.role === "assistant" && JSON.stringify(message.content).includes("incomplete")
                ),
                false,
            );
            assertStringIncludes(JSON.stringify(messages.at(-1)), "Isolated answer");
        } finally {
            hostedSession.dispose();
        }
    });
});

test("a completed tool is not repeated after EOF and its result stays in retry context", async () => {
    await withRuntimeCommandFixture("provider-tool-retry-", async (fixture) => {
        const settings = JSON.parse(await fsReadFile(fixture.settingsPath, "utf8"));
        settings.retry = { enabled: true, maxRetries: 1, baseDelayMs: 1 };
        await fsWriteFile(fixture.settingsPath, JSON.stringify(settings));
        let executions = 0;
        const tool = {
            name: "record_once",
            label: "Record once",
            description: "Record a side effect",
            parameters: { type: "object", properties: {} },
            execute: () => {
                executions++;
                return Promise.resolve({
                    content: [{ type: /** @type {const} */ ("text"), text: "committed result" }],
                    details: null,
                });
            },
        };
        let retryContext = "";
        fixture.setModelResponseFactories([
            () => fauxAssistantMessage(fauxToolCall("record_once", {})),
            () =>
                fauxAssistantMessage(fauxText("failed draft"), { stopReason: "error", errorMessage: "Unexpected EOF" }),
            (context) => {
                retryContext = JSON.stringify(context.messages.filter((message) => message.role !== "system"));
                return fauxAssistantMessage(fauxText("Completed after retry"));
            },
        ]);
        const { session } = await buildAgentSession({
            agentName: "guide",
            cwd: fixture.projectRoot,
            customTools: [tool],
            toolNames: ["record_once"],
        });
        try {
            await session.prompt("Run the tool once");
            assertEquals(executions, 1);
            assertStringIncludes(retryContext, "committed result");
            assertEquals(retryContext.includes("failed draft"), false);
            assertStringIncludes(JSON.stringify(session.messages.at(-1)), "Completed after retry");
        } finally {
            session.dispose();
        }
    });
});

test("a repeated tool call and result stops before another model request", async () => {
    await withRuntimeCommandFixture("loop-guard-repeat-tool-", async (fixture) => {
        let executions = 0;
        let requests = 0;
        const tool = {
            name: "repeat_tool",
            label: "Repeat tool",
            description: "Returns one stable synthetic result",
            parameters: { type: "object", properties: {} },
            execute: () => {
                executions += 1;
                return Promise.resolve({
                    content: [{ type: /** @type {const} */ ("text"), text: "stable synthetic result" }],
                    details: null,
                });
            },
        };
        fixture.setModelResponseFactories(
            Array.from({ length: 4 }, () => () => {
                requests += 1;
                return fauxAssistantMessage(fauxToolCall("repeat_tool", {}));
            }),
        );
        const sessionManager = SessionManager.create(fixture.projectRoot, join(fixture.homeDir, "sessions"));
        const built = await buildAgentSession({
            agentName: "guide",
            cwd: fixture.projectRoot,
            customTools: [tool],
            toolNames: ["repeat_tool"],
            sessionManager,
        });
        try {
            await assertRejects(
                () =>
                    runPrompt({
                        session: built.session,
                        agentDef: built.agentDef,
                        agentName: "guide",
                        userRequest: "Use the synthetic tool",
                        finalSystemPrompt: built.promptState.text,
                        subscriberState: {
                            resetTurn() {},
                            drainInvokedToolNames: () => [],
                            endThinking() {},
                            unsubscribe() {},
                        },
                        requestId: "synthetic-repeat-request",
                    }),
                RunawayLoopGuardStoppedError,
                "repeated_tool_result",
            );
            const stops = sessionManager
                .getBranch()
                .filter((entry) => entry.type === "custom" && entry.customType === "runwield.loop_guard_stop");
            assertEquals(executions, 3);
            assertEquals(requests, 3);
            assertEquals(
                /** @type {import('@earendil-works/pi-coding-agent').CustomEntry<{reason?: string}> | undefined} */ (
                    stops.at(-1)
                )?.data?.reason,
                "repeated_tool_result",
            );
        } finally {
            built.session.dispose();
        }
    });
});

test("different tool calls with shared or changing results do not stop the request", async () => {
    const scenarios = [
        {
            name: "tool names vary",
            calls: [
                { toolName: "name_a", args: {}, result: "same synthetic output" },
                { toolName: "name_b", args: {}, result: "same synthetic output" },
                { toolName: "name_c", args: {}, result: "same synthetic output" },
            ],
        },
        {
            name: "arguments vary",
            calls: [
                { toolName: "argument_tool", args: { step: 1 }, result: "same synthetic output" },
                { toolName: "argument_tool", args: { step: 2 }, result: "same synthetic output" },
                { toolName: "argument_tool", args: { step: 3 }, result: "same synthetic output" },
            ],
        },
        {
            name: "results vary",
            calls: [
                { toolName: "result_tool", args: {}, result: "synthetic output one" },
                { toolName: "result_tool", args: {}, result: "synthetic output two" },
                { toolName: "result_tool", args: {}, result: "synthetic output three" },
            ],
        },
    ];

    for (const [scenarioIndex, scenario] of scenarios.entries()) {
        await withRuntimeCommandFixture(`loop-guard-distinct-calls-${scenarioIndex}-`, async (fixture) => {
            let executions = 0;
            let requests = 0;
            const toolNames = [...new Set(scenario.calls.map((call) => call.toolName))];
            const tools = toolNames.map((name) => ({
                name,
                label: name,
                description: "Returns a synthetic result for loop guard coverage",
                parameters: { type: "object", properties: { step: { type: "number" } } },
                /** @param {string} _toolCallId @param {{step?: number}} args */
                execute: (_toolCallId, args) => {
                    executions += 1;
                    const call = scenario.calls[executions - 1];
                    if (
                        !call ||
                        call.toolName !== name ||
                        ("step" in call.args ? call.args.step : undefined) !== args.step
                    ) {
                        throw new Error(`Unexpected synthetic call to ${name}`);
                    }
                    return Promise.resolve({
                        content: [{ type: /** @type {const} */ ("text"), text: call.result }],
                        details: null,
                    });
                },
            }));
            fixture.setModelResponseFactories([
                ...scenario.calls.map((call) => () => {
                    requests += 1;
                    return fauxAssistantMessage(fauxToolCall(call.toolName, call.args));
                }),
                () => {
                    requests += 1;
                    return fauxAssistantMessage(fauxText("Distinct synthetic calls completed"));
                },
            ]);
            const sessionManager = SessionManager.create(fixture.projectRoot, join(fixture.homeDir, "sessions"));
            const built = await buildAgentSession({
                agentName: "guide",
                cwd: fixture.projectRoot,
                customTools: tools,
                toolNames,
                sessionManager,
            });
            try {
                await runPrompt({
                    session: built.session,
                    agentDef: built.agentDef,
                    agentName: "guide",
                    userRequest: `Exercise ${scenario.name}`,
                    finalSystemPrompt: built.promptState.text,
                    subscriberState: {
                        resetTurn() {},
                        drainInvokedToolNames: () => [],
                        endThinking() {},
                        unsubscribe() {},
                    },
                    requestId: `synthetic-distinct-call-${scenarioIndex}`,
                });
                assertEquals(executions, 3, scenario.name);
                assertEquals(requests, 4, scenario.name);
                assertStringIncludes(
                    JSON.stringify(built.session.messages.at(-1)),
                    "Distinct synthetic calls completed",
                );
            } finally {
                built.session.dispose();
            }
        });
    }
});

test("a runaway isolated request rejects instead of returning successful messages", async () => {
    await withRuntimeCommandFixture("loop-guard-isolated-stop-", async (fixture) => {
        let executions = 0;
        let requests = 0;
        const tool = {
            name: "isolated_repeat_tool",
            label: "Repeat tool",
            description: "Returns a stable synthetic result",
            parameters: { type: "object", properties: {} },
            execute: () => {
                executions += 1;
                return Promise.resolve({
                    content: [{ type: /** @type {const} */ ("text"), text: "stable isolated result" }],
                    details: null,
                });
            },
        };
        fixture.setModelResponseFactories(
            Array.from({ length: 4 }, () => () => {
                requests += 1;
                return fauxAssistantMessage(fauxToolCall("isolated_repeat_tool", {}));
            }),
        );
        const hostedSession = new HostedSession({ id: "isolated-loop-guard", cwd: fixture.projectRoot });
        try {
            await assertRejects(
                () =>
                    runIsolatedAgentSession({
                        hostedSession,
                        agentName: "guide",
                        userRequest: "Use the synthetic isolated tool",
                        customTools: [tool],
                        toolNames: ["isolated_repeat_tool"],
                    }),
                RunawayLoopGuardStoppedError,
                "repeated_tool_result",
            );
            assertEquals(executions, 3);
            assertEquals(requests, 3);
            assertEquals(hostedSession.getSubAgentSessions().size, 0);
        } finally {
            hostedSession.dispose();
        }
    });
});

test("a repeated two-tool cycle stops after three cycles", async () => {
    await withRuntimeCommandFixture("loop-guard-tool-cycle-", async (fixture) => {
        let executions = 0;
        let requests = 0;
        /** @param {string} name @param {string} result */
        const makeTool = (name, result) => ({
            name,
            label: name,
            description: "Returns a stable synthetic cycle result",
            parameters: { type: "object", properties: {} },
            execute: () => {
                executions += 1;
                return Promise.resolve({
                    content: [{ type: /** @type {const} */ ("text"), text: result }],
                    details: null,
                });
            },
        });
        fixture.setModelResponseFactories(
            Array.from({ length: 7 }, (_, index) => () => {
                requests += 1;
                return fauxAssistantMessage(fauxToolCall(index % 2 === 0 ? "cycle_a" : "cycle_b", {}));
            }),
        );
        const sessionManager = SessionManager.create(fixture.projectRoot, join(fixture.homeDir, "sessions"));
        const built = await buildAgentSession({
            agentName: "guide",
            cwd: fixture.projectRoot,
            customTools: [makeTool("cycle_a", "result a"), makeTool("cycle_b", "result b")],
            toolNames: ["cycle_a", "cycle_b"],
            sessionManager,
        });
        try {
            await assertRejects(
                () =>
                    runPrompt({
                        session: built.session,
                        agentDef: built.agentDef,
                        agentName: "guide",
                        userRequest: "Use the synthetic tools",
                        finalSystemPrompt: built.promptState.text,
                        subscriberState: {
                            resetTurn() {},
                            drainInvokedToolNames: () => [],
                            endThinking() {},
                            unsubscribe() {},
                        },
                        requestId: "synthetic-cycle-request",
                    }),
                RunawayLoopGuardStoppedError,
                "repeating_tool_cycle",
            );
            const stops = sessionManager
                .getBranch()
                .filter((entry) => entry.type === "custom" && entry.customType === "runwield.loop_guard_stop");
            assertEquals(executions, 6);
            assertEquals(requests, 6);
            assertEquals(
                /** @type {import('@earendil-works/pi-coding-agent').CustomEntry<{reason?: string}> | undefined} */ (
                    stops.at(-1)
                )?.data?.reason,
                "repeating_tool_cycle",
            );
        } finally {
            built.session.dispose();
        }
    });
});

test("the model-turn budget survives a Session reopen for the same request", async () => {
    await withRuntimeCommandFixture("loop-guard-turn-budget-", async (fixture) => {
        let executions = 0;
        let requests = 0;
        const tool = {
            name: "counter_tool",
            label: "Counter tool",
            description: "Returns the distinct synthetic step number",
            parameters: { type: "object", properties: { step: { type: "number" } }, required: ["step"] },
            /** @param {string} _toolCallId @param {{step: number}} args */
            execute: (_toolCallId, args) => {
                executions += 1;
                return Promise.resolve({
                    content: [{ type: /** @type {const} */ ("text"), text: `synthetic step ${args.step}` }],
                    details: null,
                });
            },
        };
        fixture.setModelResponseFactories(
            Array.from({ length: 51 }, (_, index) => () => {
                requests += 1;
                if (index === 50) return fauxAssistantMessage(fauxText("First request segment complete"));
                return fauxAssistantMessage(fauxToolCall("counter_tool", { step: index + 1 }));
            }),
        );
        const sessionManager = SessionManager.create(fixture.projectRoot, join(fixture.homeDir, "sessions"));
        const firstBuilt = await buildAgentSession({
            agentName: "guide",
            cwd: fixture.projectRoot,
            customTools: [tool],
            toolNames: ["counter_tool"],
            sessionManager,
        });
        try {
            await runPrompt({
                session: firstBuilt.session,
                agentDef: firstBuilt.agentDef,
                agentName: "guide",
                userRequest: "Use the synthetic counter, first segment",
                finalSystemPrompt: firstBuilt.promptState.text,
                subscriberState: {
                    resetTurn() {},
                    drainInvokedToolNames: () => [],
                    endThinking() {},
                    unsubscribe() {},
                },
                requestId: "synthetic-budget-request",
            });
        } finally {
            firstBuilt.session.dispose();
        }

        const sessionPath = sessionManager.getSessionFile();
        if (!sessionPath) throw new Error("Missing synthetic session transcript");
        const reopenedManager = SessionManager.open(
            sessionPath,
            join(fixture.homeDir, "sessions"),
            fixture.projectRoot,
        );
        fixture.setModelResponseFactories(
            Array.from({ length: 50 }, (_, index) => () => {
                requests += 1;
                if (index === 49) return fauxAssistantMessage(fauxText("Should not be requested"));
                return fauxAssistantMessage(fauxToolCall("counter_tool", { step: index + 51 }));
            }),
        );
        const secondBuilt = await buildAgentSession({
            agentName: "guide",
            cwd: fixture.projectRoot,
            customTools: [tool],
            toolNames: ["counter_tool"],
            sessionManager: reopenedManager,
        });
        try {
            await assertRejects(
                () =>
                    runPrompt({
                        session: secondBuilt.session,
                        agentDef: secondBuilt.agentDef,
                        agentName: "guide",
                        userRequest: "Continue the synthetic counter request",
                        finalSystemPrompt: secondBuilt.promptState.text,
                        subscriberState: {
                            resetTurn() {},
                            drainInvokedToolNames: () => [],
                            endThinking() {},
                            unsubscribe() {},
                        },
                        requestId: "synthetic-budget-request",
                    }),
                RunawayLoopGuardStoppedError,
                "model_turn_limit",
            );
            const entries = reopenedManager.getBranch();
            const stops = entries.filter(
                (entry) => entry.type === "custom" && entry.customType === "runwield.loop_guard_stop",
            );
            const turns = entries.filter(
                (entry) => entry.type === "custom" && entry.customType === "runwield.loop_guard_turn",
            );
            assertEquals(executions, 99);
            assertEquals(requests, 100);
            assertEquals(turns.length, 100);
            assertEquals(
                /** @type {import('@earendil-works/pi-coding-agent').CustomEntry<{reason?: string}> | undefined} */ (
                    stops.at(-1)
                )?.data?.reason,
                "model_turn_limit",
            );
        } finally {
            secondBuilt.session.dispose();
        }

        const stoppedSessionPath = reopenedManager.getSessionFile();
        if (!stoppedSessionPath) throw new Error("Missing stopped synthetic session transcript");
        const stoppedManager = SessionManager.open(stoppedSessionPath, join(fixture.homeDir, "sessions"), fixture.projectRoot);
        const requestsBeforeStoppedReplay = requests;
        fixture.setModelResponseFactories([
            () => {
                requests += 1;
                return fauxAssistantMessage(fauxText("Unexpected stopped replay response"));
            },
        ]);
        const stoppedBuilt = await buildAgentSession({
            agentName: "guide",
            cwd: fixture.projectRoot,
            customTools: [tool],
            toolNames: ["counter_tool"],
            sessionManager: stoppedManager,
        });
        try {
            await assertRejects(
                () =>
                    runPrompt({
                        session: stoppedBuilt.session,
                        agentDef: stoppedBuilt.agentDef,
                        agentName: "guide",
                        userRequest: "Continue the stopped synthetic request",
                        finalSystemPrompt: stoppedBuilt.promptState.text,
                        subscriberState: {
                            resetTurn() {},
                            drainInvokedToolNames: () => [],
                            endThinking() {},
                            unsubscribe() {},
                        },
                        requestId: "synthetic-budget-request",
                    }),
                RunawayLoopGuardStoppedError,
                "model_turn_limit",
            );
            assertEquals(requests, requestsBeforeStoppedReplay);
        } finally {
            stoppedBuilt.session.dispose();
        }

        fixture.setModelResponseFactories([
            () => {
                requests += 1;
                return fauxAssistantMessage(fauxText("New instruction answered"));
            },
        ]);
        const freshBuilt = await buildAgentSession({
            agentName: "guide",
            cwd: fixture.projectRoot,
            customTools: [tool],
            toolNames: ["counter_tool"],
            sessionManager: stoppedManager,
        });
        try {
            await runPrompt({
                session: freshBuilt.session,
                agentDef: freshBuilt.agentDef,
                agentName: "guide",
                userRequest: "Start a new synthetic request",
                finalSystemPrompt: freshBuilt.promptState.text,
                subscriberState: {
                    resetTurn() {},
                    drainInvokedToolNames: () => [],
                    endThinking() {},
                    unsubscribe() {},
                },
                requestId: "synthetic-fresh-request",
            });
            assertStringIncludes(JSON.stringify(freshBuilt.session.messages.at(-1)), "New instruction answered");
            assertEquals(requests, requestsBeforeStoppedReplay + 1);
        } finally {
            freshBuilt.session.dispose();
        }
    });
});

test("failed response tool calls never execute on the retry", async () => {
    await withRuntimeCommandFixture("provider-incomplete-tool-", async (fixture) => {
        const settings = JSON.parse(await fsReadFile(fixture.settingsPath, "utf8"));
        settings.retry = { enabled: true, maxRetries: 1, baseDelayMs: 1 };
        await fsWriteFile(fixture.settingsPath, JSON.stringify(settings));
        let executions = 0;
        const tool = {
            name: "do_not_run",
            label: "Unsafe attempt",
            description: "Only for the failed response",
            parameters: { type: "object", properties: {} },
            execute: () => {
                executions++;
                return Promise.resolve({
                    content: [{ type: /** @type {const} */ ("text"), text: "ran" }],
                    details: null,
                });
            },
        };
        fixture.setModelResponseFactories([
            () =>
                fauxAssistantMessage(fauxToolCall("do_not_run", {}), {
                    stopReason: "error",
                    errorMessage: "Unexpected EOF",
                }),
            () => fauxAssistantMessage(fauxText("Recovered without tool")),
        ]);
        const { session } = await buildAgentSession({
            agentName: "guide",
            cwd: fixture.projectRoot,
            customTools: [tool],
            toolNames: ["do_not_run"],
        });
        try {
            await session.prompt("Recover safely");
            assertEquals(executions, 0);
            assertStringIncludes(JSON.stringify(session.messages.at(-1)), "Recovered without tool");
        } finally {
            session.dispose();
        }
    });
});

test("noninteractive Pi Session uses the same EOF retry policy", async () => {
    await withRuntimeCommandFixture("provider-noninteractive-retry-", async (fixture) => {
        const settings = JSON.parse(await fsReadFile(fixture.settingsPath, "utf8"));
        settings.retry = { enabled: true, maxRetries: 1, baseDelayMs: 1 };
        await fsWriteFile(fixture.settingsPath, JSON.stringify(settings));
        let calls = 0;
        fixture.setModelResponseFactories([
            () => {
                calls++;
                return fauxAssistantMessage(fauxText("partial"), {
                    stopReason: "error",
                    errorMessage: "Unexpected EOF",
                });
            },
            () => {
                calls++;
                return fauxAssistantMessage(fauxText("Noninteractive answer"));
            },
        ]);
        const messages = await runNonInteractiveAgentPrompt({
            cwd: fixture.projectRoot,
            agentName: "guide",
            userRequest: "Retry this request",
        });
        assertEquals(calls, 2);
        assertStringIncludes(JSON.stringify(messages.at(-1)), "Noninteractive answer");
    });
});
