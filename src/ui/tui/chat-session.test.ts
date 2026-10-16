import { readdirSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";

import { stat as fsStat, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import process from "node:process";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { runResumeCommand } from "../../cmd/resume/index.ts";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { getRunWieldSessionsBaseDir } from "../../shared/session/root-session.js";
import {
    getCustomSetting,
    getSettingsManager,
    ONBOARDING_TUTORIAL_OFFER_HANDLED_SETTING_KEY,
    setCustomSetting,
} from "../../shared/settings.js";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { NO_OPEN_BROWSER_PORT } from "../../shared/browser-port.ts";
import { resolveTemplateModel } from "../../shared/models/model-validation.ts";
import { createInteractiveTuiComposition } from "./interactive-tui-composition.ts";
import { VirtualTerminal } from "./testing/virtual-terminal.js";
import { recordInitOffered } from "../../cmd/init/init-state.ts";
import { ONBOARDING_TUTORIAL_REQUEST, ONBOARDING_WARNING } from "./onboarding-content.ts";
import {
    getActiveModel,
    persistThinkingLevel,
    recordUserInputHistory,
    runScopedSubmitHandoffLoop,
    type SessionRuntime,
    setActiveModel,
    shouldReplaySessionHistory,
} from "./chat-session.ts";

test("recordUserInputHistory stores trimmed submitted input", () => {
    const history: string[] = [];
    recordUserInputHistory({ addToHistory: (text) => history.push(text) }, "  /skill:review branch  ");
    recordUserInputHistory({ addToHistory: (text) => history.push(text) }, "   ");
    assertEquals(history, ["/skill:review branch"]);
});

test("startup replays history only when continuing a persisted session", () => {
    assertEquals(shouldReplaySessionHistory("new"), false);
    assertEquals(shouldReplaySessionHistory(undefined), false);
    assertEquals(shouldReplaySessionHistory("continue"), true);
});

test("resolveTemplateModel validates provider/id lookup and auth", () => {
    const registry = {
        find: (provider: string, id: string) => (provider === "test" && id === "model" ? { provider, id } : null),
        hasConfiguredAuth: (model: { provider: string; id: string } | null) => Boolean(model),
    };
    assertEquals(resolveTemplateModel("not-strict", registry), { ok: false });
    assertEquals(resolveTemplateModel("test/missing", registry), { ok: false });
    assertEquals(resolveTemplateModel("test/model", registry), { ok: true, provider: "test", id: "model" });
});

test("setActiveModel delegates reconfiguration to SessionRuntime without persisting defaults", async () => {
    await withRuntimeCommandFixture("chat-session-model-persistence-", async ({ projectRoot }) => {
        const runtime = createSessionRuntime();
        try {
            const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            await runtime.switchAgent(sessionId, { agentName: "router" });
            await setActiveModel(runtime, sessionId, "fixture-model", "runtime-command-fixture");
            assertEquals(runtime.getSessionSnapshot(sessionId)?.activeModel, {
                model: "fixture-model",
                provider: "runtime-command-fixture",
            });
            assertEquals(getSettingsManager(projectRoot).getDefaultModel(), "fixture-model");
            assertEquals(getSettingsManager(projectRoot).getDefaultProvider(), "runtime-command-fixture");
        } finally {
            runtime.closeAllSessions();
        }
    });
});

test("setActiveModel rejects a missing real Runtime session", async () => {
    await withRuntimeCommandFixture("chat-session-missing-model-session-", async () => {
        const runtime = createSessionRuntime();
        await assertRejects(
            () => setActiveModel(runtime, "missing-session", "model", "test"),
            Error,
            "missing runtime session",
        );
    });
});

test("getActiveModel reads the real Runtime snapshot", async () => {
    await withRuntimeCommandFixture("chat-session-active-model-", async ({ projectRoot }) => {
        const runtime = createSessionRuntime();
        try {
            const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            await runtime.setSessionModel(sessionId, "model-a", "provider-a");
            assertEquals(getActiveModel(runtime, sessionId), "model-a");
        } finally {
            runtime.closeAllSessions();
        }
    });
});

test("persistThinkingLevel stores the selected level", async () => {
    await withRuntimeCommandFixture("chat-session-thinking-persistence-", async ({ projectRoot }) => {
        await persistThinkingLevel("high", projectRoot);
        assertEquals(getSettingsManager(projectRoot).getDefaultThinkingLevel(), "high");
    });
});

test("TUI resume preserves the Session thinking choice over the global default", async () => {
    await withRuntimeCommandFixture("chat-session-resume-thinking-", async ({ projectRoot }) => {
        process.chdir(projectRoot);
        await persistThinkingLevel("high", projectRoot);
        const runtime = createSessionRuntime();
        let resumeSessionId = "";
        try {
            const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            await runtime.switchAgent(created.sessionId, { agentName: "guide" });
            await runtime.setSessionThinkingLevel(created.sessionId, "low");
            resumeSessionId = runtime.getSessionSnapshot(created.sessionId)?.managed?.runwieldSessionId || "";
        } finally {
            await runtime.closeAllSessionsWhenIdle();
        }
        const composition = await createInteractiveTuiComposition(null, {
            browser: NO_OPEN_BROWSER_PORT,
            terminal: new VirtualTerminal({ columns: 100, rows: 30 }),
            skipModelWelcome: true,
            sessionStartMode: "continue",
            resumeSessionId,
        });
        try {
            await composition.waitForIdle();
            assertEquals(composition.runtime.getSessionSnapshot(composition.sessionId)?.thinkingLevel, "low");
        } finally {
            await composition.dispose();
        }
    });
});

test("TUI resume asks before restoring saved tutorial guidance", async () => {
    await withRuntimeCommandFixture("chat-session-resume-tutorial-", async ({ projectRoot, setModelResponse }) => {
        process.chdir(projectRoot);
        setModelResponse("Choose a small change.");
        const runtime = createSessionRuntime();
        let resumeSessionId = "";
        try {
            const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            await runtime.promptUserTurn(created.sessionId, {
                initialRequest: "Start tutorial",
                initialImages: [],
                agentName: "planner",
                initialTutorialContext: {
                    version: 1,
                    guidanceEnabled: true,
                    shownExplanationIds: ["choose-improvement"],
                    recapShown: false,
                    planId: null,
                },
            });
            resumeSessionId = runtime.getSessionSnapshot(created.sessionId)?.managed?.runwieldSessionId || "";
        } finally {
            await runtime.closeAllSessionsWhenIdle();
        }

        const prompts: string[] = [];
        const composition = await createInteractiveTuiComposition(null, {
            browser: NO_OPEN_BROWSER_PORT,
            terminal: new VirtualTerminal({ columns: 100, rows: 30 }),
            skipModelWelcome: true,
            sessionStartMode: "continue",
            resumeSessionId,
            configureUiAPI: (uiAPI) => {
                uiAPI.promptSelect = (title) => {
                    prompts.push(title);
                    return Promise.resolve(title.includes("Resume tutorial guidance") ? "without" : null);
                };
            },
        });
        try {
            await composition.waitForIdle();
            assertEquals(
                prompts.some((title) => title.includes("Resume tutorial guidance")),
                true,
            );
            assertEquals(
                composition.runtime.getSessionSnapshot(composition.sessionId)?.tutorialContext?.guidanceEnabled,
                false,
            );
        } finally {
            await composition.dispose();
        }
    });
});

test("chat session starts a real composed TUI through the public composition interface", async () => {
    await withRuntimeCommandFixture("chat-session-composed-startup-", async () => {
        const terminal = new VirtualTerminal({ columns: 100, rows: 30 });
        const readySessions: string[] = [];
        const composition = await createInteractiveTuiComposition(null, {
            browser: NO_OPEN_BROWSER_PORT,
            terminal,
            skipModelWelcome: true,
            sessionStartMode: "new",
            initialAgentName: "operator",
            onSessionReady: (sessionId) => readySessions.push(sessionId),
        });
        try {
            await composition.waitForIdle();
            assertEquals(readySessions, [composition.sessionId]);
            assertEquals(composition.runtime.getSessionSnapshot(composition.sessionId)?.busy, false);
            assertStringIncludes(terminal.getScreenText(), "RunWield");
        } finally {
            await composition.dispose();
        }
    });
});

test("chat session starts in a Project registered by Workspace", async () => {
    await withRuntimeCommandFixture("chat-session-managed-project-startup-", async ({ projectRoot }) => {
        const store = openOwnerCoordinationStore();
        const terminal = new VirtualTerminal({ columns: 100, rows: 30 });
        const readySessions: string[] = [];
        try {
            store.registerProject({ root: projectRoot, now: () => "2026-01-01T00:00:01.000Z" });
            process.chdir(projectRoot);
            const composition = await createInteractiveTuiComposition(null, {
                browser: NO_OPEN_BROWSER_PORT,
                terminal,
                skipModelWelcome: true,
                sessionStartMode: "new",
                initialAgentName: "operator",
                onSessionReady: (sessionId) => readySessions.push(sessionId),
            });
            try {
                await composition.waitForIdle();
                assertEquals(readySessions, [composition.sessionId]);
                const snapshot = composition.runtime.getSessionSnapshot(composition.sessionId);
                assertEquals(snapshot?.activeAgent, "operator");
                assertEquals(snapshot?.sessionManagerId, null);
                assertEquals(snapshot?.managed, null);
                const project = store.ensureRuntimeProject({ root: projectRoot });
                assertEquals((await store.listProjectSessions(project.projectId)).sessions, []);
                assertStringIncludes(terminal.getScreenText(), "RunWield");
            } finally {
                await composition.dispose();
            }
        } finally {
            store.close();
        }
    });
});

test("chat session startup does not show busy or thinking output before a turn", async () => {
    await withRuntimeCommandFixture("chat-session-no-phantom-startup-output-", async ({ projectRoot }) => {
        const terminal = new VirtualTerminal({ columns: 100, rows: 30 });
        const transientEvents: string[] = [];
        const busyStates: boolean[] = [];
        let thinkingBlocks = 0;
        let clearMessages = 0;
        process.chdir(projectRoot);
        await setCustomSetting(ONBOARDING_TUTORIAL_OFFER_HANDLED_SETTING_KEY, true, "global", projectRoot);
        const composition = await createInteractiveTuiComposition(null, {
            browser: NO_OPEN_BROWSER_PORT,
            terminal,
            sessionStartMode: "new",
            configureUiAPI: (uiAPI) => {
                const originalSetBusy = uiAPI.setBusy?.bind(uiAPI);
                uiAPI.setBusy = (busy) => {
                    busyStates.push(busy);
                    if (busy) transientEvents.push("busy:true");
                    originalSetBusy?.(busy);
                };
                const originalAppendThinkingStart = uiAPI.appendThinkingStart?.bind(uiAPI);
                uiAPI.appendThinkingStart = () => {
                    thinkingBlocks += 1;
                    transientEvents.push("thinking:start");
                    return originalAppendThinkingStart?.() || { appendDelta: () => {}, end: () => {} };
                };
                const originalClearMessages = uiAPI.clearMessages?.bind(uiAPI);
                uiAPI.clearMessages = () => {
                    clearMessages += 1;
                    transientEvents.push("messages:clear");
                    originalClearMessages?.();
                };
                const originalSetManagedSyncStatus = uiAPI.setManagedSyncStatus?.bind(uiAPI);
                uiAPI.setManagedSyncStatus = (status) => {
                    originalSetManagedSyncStatus?.(status);
                };
                const originalSetRunningTasks = uiAPI.setRunningTasks?.bind(uiAPI);
                uiAPI.setRunningTasks = (tasks) => {
                    if (tasks.length > 0) transientEvents.push("tasks:set");
                    originalSetRunningTasks?.(tasks);
                };
                const originalStartToolExecution = uiAPI.startToolExecution?.bind(uiAPI);
                uiAPI.startToolExecution = (id, toolName, title) => {
                    transientEvents.push(`tool:${toolName}`);
                    return (
                        originalStartToolExecution?.(id, toolName, title) || {
                            bodyText: "",
                            startTime: Date.now(),
                            setOutput: () => {},
                            endExecution: () => {},
                        }
                    );
                };
            },
        });
        try {
            await composition.waitForIdle();
            assertEquals(transientEvents, []);
            assertEquals(busyStates.includes(true), false);
            assertEquals(thinkingBlocks, 0);
            assertEquals(clearMessages, 0);
            const snapshot = composition.runtime.getSessionSnapshot(composition.sessionId);
            assertEquals(snapshot?.activeAgent, "router");
            assertEquals(snapshot?.sessionManagerId, null);
            assertEquals(snapshot?.managed, null);
            await assertRejects(() => fsStat(getRunWieldSessionsBaseDir()), Error, "ENOENT");
        } finally {
            await composition.dispose();
        }
    });
});

test("slash resume can list from an unpersisted new-session shell", async () => {
    await withRuntimeCommandFixture("chat-session-lazy-resume-", async ({ projectRoot }) => {
        process.chdir(projectRoot);
        const terminal = new VirtualTerminal({ columns: 100, rows: 30 });
        const composition = await createInteractiveTuiComposition(null, {
            browser: NO_OPEN_BROWSER_PORT,
            terminal,
            skipModelWelcome: true,
            sessionStartMode: "new",
        });
        const messages: string[] = [];
        try {
            await runResumeCommand([], {
                uiAPI: {
                    appendSystemMessage: (message) => messages.push(message),
                    promptSelect: () => Promise.resolve(null),
                },
                editor: { disableSubmit: false, setText: () => {} },
                sessionRuntime: composition.runtime,
                sessionId: composition.sessionId,
                replaceRuntimeSession: () => {},
            });

            assertEquals(messages, ["No recent sessions found to resume."]);
            const snapshot = composition.runtime.getSessionSnapshot(composition.sessionId);
            assertEquals(snapshot?.sessionManagerId, null);
            assertEquals(snapshot?.managed, null);
        } finally {
            await composition.dispose();
        }
    });
});

test("submit handoff loop invokes one Runtime prompt by opaque id", async () => {
    await withRuntimeCommandFixture("chat-session-handoff-", async ({ projectRoot }) => {
        const runtime = createSessionRuntime();
        try {
            const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            const calls: string[] = [];
            const originalPromptUserTurn = runtime.promptUserTurn.bind(runtime);
            runtime.promptUserTurn = (async (activeSessionId, options) => {
                calls.push(`${activeSessionId}:${options.initialRequest}:${(options.initialImages || []).length}`);
                return await originalPromptUserTurn(activeSessionId, options);
            }) as SessionRuntime["promptUserTurn"];
            await runScopedSubmitHandoffLoop({
                runtime,
                sessionId,
                uiAPI: {
                    appendSystemMessage: () => {},
                    appendAgentMessageStart: () => ({ appendText: () => {} }),
                    requestRender: () => {},
                    promptSelect: () => Promise.resolve(null),
                    promptText: () => Promise.resolve(null),
                    showModelSelector: () => {},
                    abortActivePrompt: () => {},
                },
                initialRequest: "first request",
                initialImages: [],
            });
            assertEquals(calls, [`${sessionId}:first request:0`]);
        } finally {
            runtime.closeAllSessions();
        }
    });
});

test("automatic onboarding Skip persists globally and creates no managed Session", async () => {
    await withRuntimeCommandFixture(
        "chat-session-onboarding-skip-",
        async ({ projectRoot, alternateRoot }) => {
            await fsWriteFile(`${projectRoot}/README.md`, "project\n");
            await fsWriteFile(`${alternateRoot}/README.md`, "alternate\n");
            await recordInitOffered(projectRoot);
            process.chdir(projectRoot);
            const prompts: string[] = [];
            const first = await createInteractiveTuiComposition(null, {
                browser: NO_OPEN_BROWSER_PORT,
                terminal: new VirtualTerminal({ columns: 100, rows: 30 }),
                configureUiAPI: (uiAPI) => {
                    uiAPI.promptSelect = (title) => {
                        prompts.push(title);
                        return Promise.resolve(title.includes(ONBOARDING_WARNING) ? "skip" : "no");
                    };
                },
            });
            try {
                assertEquals(
                    prompts.some((title) => title.includes(ONBOARDING_WARNING)),
                    true,
                );
                assertStringIncludes(prompts.find((title) => title.includes(ONBOARDING_WARNING)) || "", projectRoot);
                assertEquals(first.runtime.getSessionSnapshot(first.sessionId)?.managed, null);
                assertEquals(
                    getCustomSetting(ONBOARDING_TUTORIAL_OFFER_HANDLED_SETTING_KEY, "global", projectRoot),
                    true,
                );
            } finally {
                await first.dispose();
            }

            await recordInitOffered(alternateRoot);
            process.chdir(alternateRoot);
            let offeredAgain = false;
            const second = await createInteractiveTuiComposition(null, {
                browser: NO_OPEN_BROWSER_PORT,
                terminal: new VirtualTerminal({ columns: 100, rows: 30 }),
                configureUiAPI: (uiAPI) => {
                    uiAPI.promptSelect = (title) => {
                        if (title.includes(ONBOARDING_WARNING)) offeredAgain = true;
                        return Promise.resolve("no");
                    };
                },
            });
            try {
                assertEquals(offeredAgain, false);
                assertEquals(second.runtime.getSessionSnapshot(second.sessionId)?.managed, null);
            } finally {
                await second.dispose();
            }
        },
        { offerTutorial: true },
    );
});

test("automatic onboarding Start submits one real Planner turn after consent", async () => {
    await withRuntimeCommandFixture(
        "chat-session-onboarding-start-",
        async ({ projectRoot, setModelResponse }) => {
            await fsWriteFile(`${projectRoot}/README.md`, "project\n");
            await recordInitOffered(projectRoot);
            process.chdir(projectRoot);
            setModelResponse("Choose one of these small changes.");
            const submitted: string[] = [];
            const prompts: string[] = [];
            const composition = await createInteractiveTuiComposition(null, {
                browser: NO_OPEN_BROWSER_PORT,
                terminal: new VirtualTerminal({ columns: 100, rows: 30 }),
                onSessionReady: (sessionId, runtime) => {
                    runtime.subscribeSessionEvents(sessionId, (event) => {
                        if (event.type === "user_message") submitted.push(event.text);
                    });
                },
                configureUiAPI: (uiAPI) => {
                    uiAPI.promptSelect = (title) => {
                        prompts.push(title);
                        return Promise.resolve(title.includes(ONBOARDING_WARNING) ? "start" : "no");
                    };
                },
            });
            try {
                assertEquals(submitted, [ONBOARDING_TUTORIAL_REQUEST]);
                assertEquals(composition.runtime.getSessionSnapshot(composition.sessionId)?.activeAgent, "planner");
                assertEquals(composition.runtime.getSessionSnapshot(composition.sessionId)?.tutorialContext, {
                    version: 1,
                    guidanceEnabled: true,
                    shownExplanationIds: ["choose-improvement"],
                    recapShown: false,
                    planId: null,
                });
                assertStringIncludes(prompts.find((title) => title.includes(ONBOARDING_WARNING)) || "", projectRoot);
            } finally {
                await composition.dispose();
            }
        },
        { offerTutorial: true },
    );
});

test("automatic onboarding Start in an Empty Project Directory submits one real Planner turn", async () => {
    await withRuntimeCommandFixture(
        "chat-session-onboarding-empty-start-",
        async ({ projectRoot, setModelResponse }) => {
            await recordInitOffered(projectRoot);
            process.chdir(projectRoot);
            setModelResponse("Choose one of these small starter projects.");
            const submitted: string[] = [];
            const composition = await createInteractiveTuiComposition(null, {
                browser: NO_OPEN_BROWSER_PORT,
                terminal: new VirtualTerminal({ columns: 100, rows: 30 }),
                onSessionReady: (sessionId, runtime) => {
                    runtime.subscribeSessionEvents(sessionId, (event) => {
                        if (event.type === "user_message") submitted.push(event.text);
                    });
                },
                configureUiAPI: (uiAPI) => {
                    uiAPI.promptSelect = (title) =>
                        Promise.resolve(title.includes(ONBOARDING_WARNING) ? "start" : "no");
                },
            });
            try {
                assertEquals(submitted, [ONBOARDING_TUTORIAL_REQUEST]);
                assertEquals(composition.runtime.getSessionSnapshot(composition.sessionId)?.activeAgent, "planner");
                assertEquals(composition.runtime.getSessionSnapshot(composition.sessionId)?.tutorialContext, {
                    version: 1,
                    guidanceEnabled: true,
                    shownExplanationIds: ["choose-improvement"],
                    recapShown: false,
                    planId: null,
                });
            } finally {
                await composition.dispose();
            }
        },
        { offerTutorial: true },
    );
});

test("cancelled tutorial Init choice returns to input without discovery", async () => {
    await withRuntimeCommandFixture(
        "chat-session-onboarding-init-cancel-",
        async ({ projectRoot, setModelResponse }) => {
            await fsWriteFile(`${projectRoot}/README.md`, "project\n");
            process.chdir(projectRoot);
            setModelResponse("This Planner turn must not run.");
            const submitted: string[] = [];
            const composition = await createInteractiveTuiComposition(null, {
                browser: NO_OPEN_BROWSER_PORT,
                terminal: new VirtualTerminal({ columns: 100, rows: 30 }),
                startupIntent: "onboard",
                onSessionReady: (sessionId, runtime) => {
                    runtime.subscribeSessionEvents(sessionId, (event) => {
                        if (event.type === "user_message") submitted.push(event.text);
                    });
                },
                configureUiAPI: (uiAPI) => {
                    uiAPI.promptSelect = (title) => {
                        if (title.includes(ONBOARDING_WARNING)) return Promise.resolve("start");
                        if (title.includes("Run /init before the tutorial")) return Promise.resolve(null);
                        return Promise.resolve(null);
                    };
                },
            });
            try {
                await composition.waitForIdle();
                assertEquals(submitted, []);
                assertEquals(composition.runtime.getSessionSnapshot(composition.sessionId)?.tutorialContext, null);
            } finally {
                await composition.dispose();
            }
        },
    );
});

test("explicit onboarding shows consent before model setup or Init", async () => {
    await withRuntimeCommandFixture(
        "chat-session-explicit-onboarding-consent-",
        async ({ projectRoot }) => {
            await fsWriteFile(`${projectRoot}/README.md`, "project\n");
            process.chdir(projectRoot);
            const prompts: string[] = [];
            const composition = await createInteractiveTuiComposition(null, {
                browser: NO_OPEN_BROWSER_PORT,
                terminal: new VirtualTerminal({ columns: 100, rows: 30 }),
                startupIntent: "onboard",
                configureUiAPI: (uiAPI) => {
                    uiAPI.promptSelect = (title) => {
                        prompts.push(title);
                        return Promise.resolve("skip");
                    };
                },
            });
            try {
                assertEquals(prompts.length, 1);
                assertStringIncludes(prompts[0], ONBOARDING_WARNING);
                assertStringIncludes(prompts[0], projectRoot);
                const snapshot = composition.runtime.getSessionSnapshot(composition.sessionId);
                assertEquals(snapshot?.managed, null);
                assertEquals(snapshot?.activeAgent, null);
            } finally {
                await composition.dispose();
            }
        },
        { providerState: "none" },
    );
});

// Capture real storage and project artifacts, including transcript bytes and continuation metadata.
function startupFiles(root: string): Record<string, number[]> {
    const files: Record<string, number[]> = {};
    function visit(path: string) {
        for (const entry of readdirSync(path, { withFileTypes: true })) {
            const child = `${path}/${entry.name}`;
            if (entry.isDirectory()) {
                files[`${child}/`] = [];
                visit(child);
            } else if (entry.isFile()) files[child] = [...readFileSync(child)];
        }
    }
    visit(root);
    return files;
}

for (const cancel of ["quit", "escape", "ctrl-c", "end-input"]) {
    test(`home startup ${cancel} stops before Session creation`, async () => {
        await withRuntimeCommandFixture("home-startup-cancel-", async ({ homeDir }) => {
            process.chdir(homeDir); // Runtime fixture holds the process-global lock.
            const terminal = new VirtualTerminal({ columns: 100, rows: 30 });
            if (cancel === "quit") {
                const runtime = createSessionRuntime();
                try {
                    const created = await runtime.createInteractiveSession({ cwd: homeDir, mode: "new" });
                    await runtime.switchAgent(created.sessionId, { agentName: "operator" });
                } finally {
                    await runtime.closeAllSessionsWhenIdle();
                }
            }
            const before = startupFiles(homeDir);
            let sessionReady = false;
            let lifecycleReady = false;
            const pending = createInteractiveTuiComposition("do not submit", {
                browser: NO_OPEN_BROWSER_PORT,
                terminal,
                sessionStartMode: cancel === "quit" ? "continue" : "new",
                onLifecycleReady: () => {
                    lifecycleReady = true;
                },
                onSessionReady: () => {
                    sessionReady = true;
                },
            });
            // Attach the rejection handler before driving the selector.
            const rejected = assertRejects(() => pending, Error, "Project startup canceled");
            await new Promise((resolve) => setTimeout(resolve, 30));
            await terminal.flush();
            assertStringIncludes(terminal.getScreenText(), "System or home folder detected. Continue?");
            assertEquals(sessionReady, false);
            const pendingLifecycleReady = lifecycleReady;
            const pendingFiles = startupFiles(homeDir);
            if (cancel === "escape") terminal.pressEscape();
            else if (cancel === "ctrl-c") terminal.pressCtrlC();
            else if (cancel === "end-input") terminal.input("\x04");
            else terminal.pressEnter();
            await rejected;
            assertEquals(pendingLifecycleReady, false);
            assertEquals(pendingFiles, before);
            assertEquals(lifecycleReady, false);
            assertEquals(startupFiles(homeDir), before);
            assertEquals(sessionReady, false);
            assertEquals(terminal.stopped, true);
        });
    });
}
test("continued home suppresses automatic offers without persisting decisions and asks once", async () => {
    await withRuntimeCommandFixture(
        "home-startup-continue-",
        async ({ homeDir }) => {
            process.chdir(homeDir);
            const before = getCustomSetting(ONBOARDING_TUTORIAL_OFFER_HANDLED_SETTING_KEY, "global", homeDir);
            const { isInitOffered } = await import("../../cmd/init/init-state.ts");
            const offeredBefore = await isInitOffered();
            const terminal = new VirtualTerminal({ columns: 100, rows: 30 });
            const prompts: string[] = [];
            let ready = false;
            const pending = createInteractiveTuiComposition(null, {
                browser: NO_OPEN_BROWSER_PORT,
                terminal,
                onSessionReady: () => {
                    ready = true;
                },
                configureUiAPI: (uiAPI) => {
                    uiAPI.promptSelect = (title) => {
                        prompts.push(title);
                        return Promise.resolve(null);
                    };
                },
            });
            await new Promise((resolve) => setTimeout(resolve, 30));
            assertEquals(ready, false);
            terminal.input("\x1b[B");
            terminal.pressEnter();
            const composition = await pending;
            try {
                await composition.waitForIdle(10_000);
                assertEquals(prompts, []);
                assertEquals(await isInitOffered(), offeredBefore);
                assertEquals(
                    getCustomSetting(ONBOARDING_TUTORIAL_OFFER_HANDLED_SETTING_KEY, "global", homeDir),
                    before,
                );
                assertEquals(terminal.getScreenText().includes("Empty Project Directory"), false);
                const { confirmProjectDirectory } = await import("./directory-warning.ts");
                assertEquals(await confirmProjectDirectory(homeDir), true);
            } finally {
                await composition.dispose();
            }
        },
        { offerTutorial: true },
    );
});

test("home initial request reaches the real runtime only after Continue", async () => {
    await withRuntimeCommandFixture("home-startup-request-", async ({ homeDir, setModelResponse }) => {
        process.chdir(homeDir);
        setModelResponse("Confirmed folder request received.");
        const terminal = new VirtualTerminal({ columns: 100, rows: 30 });
        let ready = false;
        const pending = createInteractiveTuiComposition("Read this request after consent", {
            browser: NO_OPEN_BROWSER_PORT,
            terminal,
            initialAgentName: "operator",
            onSessionReady: () => {
                ready = true;
            },
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
        assertEquals(ready, false);
        terminal.input("\x1b[B");
        terminal.pressEnter();
        const composition = await pending;
        try {
            await composition.waitForIdle(10_000);
            assertStringIncludes(terminal.getScreenText(), "Confirmed folder request received.");
        } finally {
            await composition.dispose();
        }
    });
});

for (const explicit of ["init", "onboard"]) {
    test(`continued home keeps explicit ${explicit} operation consent`, async () => {
        await withRuntimeCommandFixture(
            `home-explicit-${explicit}-`,
            async ({ homeDir }) => {
                process.chdir(homeDir);
                await writeFile(`${homeDir}/README.md`, "Temporary test project.\n");
                const terminal = new VirtualTerminal({ columns: 100, rows: 30 });
                const prompts: string[] = [];
                const pending = createInteractiveTuiComposition(explicit === "init" ? "/init" : null, {
                    browser: NO_OPEN_BROWSER_PORT,
                    terminal,
                    ...(explicit === "onboard" ? { startupIntent: "onboard" as const } : {}),
                    configureUiAPI: (uiAPI) => {
                        uiAPI.promptSelect = (title) => {
                            prompts.push(title);
                            return Promise.resolve(null);
                        };
                    },
                });
                await new Promise((resolve) => setTimeout(resolve, 30));
                terminal.input("\x1b[B");
                terminal.pressEnter();
                const composition = await pending;
                try {
                    await composition.waitForIdle(10_000);
                    assertEquals(prompts.length, 1);
                    if (explicit === "onboard") assertStringIncludes(prompts[0], ONBOARDING_WARNING);
                    else assertStringIncludes(prompts[0], "Init");
                } finally {
                    await composition.dispose();
                }
            },
            { offerTutorial: true },
        );
    });
}

test("resuming a home Session from an ordinary cwd requires consent for the selected root", async () => {
    await withRuntimeCommandFixture("home-resume-selected-root-", async ({ homeDir, projectRoot }) => {
        const runtime = createSessionRuntime();
        let resumeSessionId = "";
        try {
            const created = await runtime.createInteractiveSession({ cwd: homeDir, mode: "new" });
            await runtime.switchAgent(created.sessionId, { agentName: "operator" });
            resumeSessionId = runtime.getSessionSnapshot(created.sessionId)?.managed?.runwieldSessionId || "";
        } finally {
            await runtime.closeAllSessionsWhenIdle();
        }
        assertEquals(Boolean(resumeSessionId), true);
        process.chdir(projectRoot);
        const terminal = new VirtualTerminal({ columns: 100, rows: 30 });
        let ready = false;
        const pending = createInteractiveTuiComposition(null, {
            browser: NO_OPEN_BROWSER_PORT,
            terminal,
            sessionStartMode: "continue",
            resumeSessionId,
            onSessionReady: () => {
                ready = true;
            },
        });
        const rejected = assertRejects(() => pending, Error, "Project startup canceled");
        await new Promise((resolve) => setTimeout(resolve, 50));
        await terminal.flush();
        assertEquals(ready, false);
        assertStringIncludes(terminal.getScreenText(), "System or home folder detected. Continue?");
        terminal.pressEnter();
        await rejected;
        assertEquals(terminal.stopped, true);
    });
});

for (const explicit of [true, false]) {
    test(`multisegment ${explicit ? "explicit resume" : "implicit continue"} checks the current segment root`, async () => {
        await withRuntimeCommandFixture("segment-root-consent-", async ({ homeDir, projectRoot }) => {
            const { openFileSessionStore } = await import("../../shared/session/file-session-store.ts");
            const { getRunWieldSessionDir } = await import("../../shared/session/root-session.js");
            const { join } = await import("node:path");
            const runtime = createSessionRuntime();
            let id = "";
            try {
                const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
                await runtime.switchAgent(created.sessionId, { agentName: "operator" });
                id = runtime.getSessionSnapshot(created.sessionId)?.managed?.runwieldSessionId || "";
            } finally {
                await runtime.closeAllSessionsWhenIdle();
            }
            const store = openFileSessionStore();
            try {
                const saved = store.getSessionById(id)!;
                const previous = store.getCurrentSessionSegment(id)!;
                const dir = getRunWieldSessionDir(homeDir);
                mkdirSync(dir, { recursive: true });
                const timestamp = new Date().toISOString();
                const path = join(dir, `${timestamp.replace(/[:.]/g, "-")}_pi-successor.jsonl`);
                writeText(
                    path,
                    JSON.stringify({ type: "session", version: 3, id: "pi-successor", cwd: homeDir, timestamp }) + "\n",
                );
                const { readTranscriptEvidence } = await import("../../testing/managed-session-fixture.ts");
                store.sealSessionTranscriptSegment({
                    runwieldSessionId: id,
                    segmentId: previous.segmentId,
                    evidence: await readTranscriptEvidence(previous.transcriptPath),
                });
                await store.appendSessionTranscriptSegment({
                    runwieldSessionId: id,
                    projectId: saved.projectId,
                    piSessionId: "pi-successor",
                    transcriptPath: path,
                    transcriptCwd: homeDir,
                    kind: "execution",
                });
                assertEquals(store.getSessionById(id)?.transcriptCwd, projectRoot);
                assertEquals(store.getCurrentSessionSegment(id)?.transcriptCwd, homeDir);
            } finally {
                store.close();
            }
            process.chdir(projectRoot);
            const terminal = new VirtualTerminal({ columns: 100, rows: 30 });
            let ready = false;
            const pending = createInteractiveTuiComposition(null, {
                browser: NO_OPEN_BROWSER_PORT,
                terminal,
                sessionStartMode: "continue",
                ...(explicit ? { resumeSessionId: id } : {}),
                onSessionReady: () => {
                    ready = true;
                },
            });
            const rejected = assertRejects(() => pending, Error, "Project startup canceled");
            await new Promise((resolve) => setTimeout(resolve, 50));
            await terminal.flush();
            assertStringIncludes(terminal.getScreenText(), "System or home folder detected. Continue?");
            terminal.pressEnter();
            await rejected;
            assertEquals(ready, false);
            assertEquals(terminal.stopped, true);
        });
    });
}

test("implicit continuation catalogs and resumes an uncataloged transcript in an ordinary folder", async () => {
    await withRuntimeCommandFixture("uncataloged-chat-continue-", async ({ projectRoot }) => {
        process.chdir(projectRoot);
        const { getRunWieldSessionDir } = await import("../../shared/session/root-session.js");
        const dir = getRunWieldSessionDir(projectRoot);
        mkdirSync(dir, { recursive: true });
        const timestamp = new Date().toISOString();
        const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        const path = `${dir}/${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`;
        writeText(path, JSON.stringify({ type: "session", version: 3, id, cwd: projectRoot, timestamp }) + "\n");
        const composition = await createInteractiveTuiComposition(null, {
            browser: NO_OPEN_BROWSER_PORT,
            terminal: new VirtualTerminal({ columns: 100, rows: 30 }),
            sessionStartMode: "continue",
        });
        try {
            await composition.waitForIdle(10_000);
            const snapshot = composition.runtime.getSessionSnapshot(composition.sessionId);
            assertEquals(snapshot?.sessionManagerId, id);
            assertEquals(Boolean(snapshot?.managed?.runwieldSessionId), true);
        } finally {
            await composition.dispose();
        }
    });
});

function writeText(path: string, text: string): void {
    writeFileSync(path, text);
}
