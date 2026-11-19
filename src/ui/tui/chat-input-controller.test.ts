import * as fs from "node:fs";
import { mock } from "bun:test";
import { rename, rm } from "node:fs/promises";
import { test } from "node:test";
import { installFakeClipboardCommands } from "./testing/clipboard-command-fixture.ts";
import { readdir as fsReaddir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { statSync as fsStatSync } from "node:fs";
import process from "node:process";
import { ok as assert, throws as assertThrows } from "node:assert/strict";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { NO_OPEN_BROWSER_PORT } from "../../shared/browser-port.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.ts";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { getRunWieldSessionDir } from "../../shared/session/root-session.ts";
import { RuntimeEventTypes } from "../../shared/session/session-runtime-events.ts";
import { savePlan } from "../../plan-store.ts";
import { getSettingsManager } from "../../shared/settings.ts";
import { createInteractiveTuiComposition, type InteractiveTuiComposition } from "./interactive-tui-composition.ts";
import { createInteractiveCompositionHarness } from "./testing/interactive-composition-fixture.ts";
import { VirtualTerminal } from "./testing/virtual-terminal.ts";

interface DeferredSignal {
    promise: Promise<void>;
    resolve(): void;
}

interface ResumeManagedFixture {
    runwieldSessionId: string;
    projectId: string;
}

function deferredSignal(): DeferredSignal {
    let resolvePromise: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
        resolvePromise = resolve;
    });
    return { promise, resolve: resolvePromise };
}

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 5_000): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for ${description}.`);
}

async function waitForPath(path: string, description: string, timeoutMs = 5_000): Promise<void> {
    await waitFor(
        () => {
            try {
                fsStatSync(path);
                return true;
            } catch (error) {
                if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
                throw error;
            }
        },
        description,
        timeoutMs,
    );
}

async function submitText(terminal: VirtualTerminal, text: string): Promise<void> {
    terminal.typeText(text);
    terminal.pressEnter();
    await terminal.flush();
}

async function countSessionTranscripts(projectRoot: string): Promise<number> {
    let count = 0;
    try {
        for await (const entry of await fsReaddir(getRunWieldSessionDir(projectRoot), { withFileTypes: true })) {
            if (entry.isFile() && entry.name.endsWith(".jsonl")) count++;
        }
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
        throw error;
    }
    return count;
}

async function startComposition(
    sessionStartMode: "new" | "continue" = "new",
): Promise<{ composition: InteractiveTuiComposition; terminal: VirtualTerminal }> {
    const terminal = new VirtualTerminal({ columns: 100, rows: 30 });
    const composition = await createInteractiveTuiComposition(null, {
        browser: NO_OPEN_BROWSER_PORT,
        terminal,
        skipModelWelcome: false,
        sessionStartMode,
        initialAgentName: "operator",
    });
    await composition.waitForIdle();
    return { composition, terminal };
}

test("composition idle waits for a real slash-command interaction to finish", async () => {
    await withRuntimeCommandFixture("chat-input-pending-slash-", async () => {
        const { composition, terminal } = await startComposition();
        try {
            await submitText(terminal, "/theme");
            await waitFor(() => terminal.getScreenText().includes("Select Theme"), "theme selection");
            assertEquals(composition.runtime.getSessionSnapshot(composition.sessionId)?.busy, false);
            await assertRejects(
                () => composition.waitForIdle(200),
                Error,
                "Timed out waiting for TUI composition idle",
            );
            terminal.pressEscape();
            await terminal.flush();
            await composition.waitForIdle(5_000);
        } finally {
            terminal.pressEscape();
            await composition.dispose();
        }
    });
});

test("composed TUI keeps /plan-review reachable during the original browser review", async () => {
    await withRuntimeCommandFixture(
        "chat-input-live-plan-review-",
        async ({ alternateRoot: projectRoot, setModelResponseFactory }) => {
            let modelTurns = 0;
            setModelResponseFactory(() => {
                modelTurns++;
                return fauxAssistantMessage(fauxText("Queued response."));
            });
            const urls: string[] = [];
            const terminal = new VirtualTerminal({ columns: 180, rows: 50 });
            const composition = await createInteractiveTuiComposition(null, {
                browser: {
                    open: (url: string) => {
                        urls.push(url);
                        return Promise.resolve(false);
                    },
                },
                terminal,
                initialAgentName: "operator",
            });
            try {
                await composition.waitForIdle();
                await savePlan(projectRoot, "target", "# Target\n\nReview this saved Plan.\n", {
                    classification: "PLANNED_CHANGE",
                    status: "draft",
                    executionAgent: "engineer",
                    collaborationRecommendation: "autonomous",
                    affectedPaths: [],
                });

                await submitText(terminal, "/load-plan target");
                await waitFor(
                    () => terminal.getScreenText().includes("What would you like to do?"),
                    "loaded Plan actions",
                );
                terminal.input("\x1b[B");
                terminal.pressEnter();
                await terminal.flush();
                await waitFor(() => urls.length === 1, "original browser review");

                const reviewChanges: string[] = [];
                const unsubscribe = composition.runtime.subscribeSessionEvents(composition.sessionId, (event) => {
                    if (
                        event.type === RuntimeEventTypes.INTERACTION_REQUESTED ||
                        event.type === RuntimeEventTypes.CANCELLATION
                    ) {
                        reviewChanges.push(event.type);
                    }
                });
                await submitText(terminal, "/plan-review");
                // Autocomplete can consume the first Enter; the second submits the command.
                terminal.pressEnter();
                await terminal.flush();
                await waitFor(
                    () => terminal.getScreenText().includes("The current Plan review is open."),
                    "live review command result",
                );
                assertStringIncludes(terminal.getScreenText(), urls[0]);
                assertEquals(urls.length, 1);
                await submitText(terminal, "Queue this until review ends");
                await waitFor(
                    () => composition.runtime.getQueuedMessages(composition.sessionId).length === 1,
                    "queued ordinary input",
                );
                assertEquals(modelTurns, 0);
                assertEquals(urls.length, 1);
                assertEquals(reviewChanges, []);
                unsubscribe();
                const reviewUrl = new URL(urls[0]);
                const token = reviewUrl.searchParams.get("token") || "";
                const response = await fetch(
                    new URL(`/api/review/decision?token=${encodeURIComponent(token)}`, reviewUrl.origin),
                    {
                        method: "POST",
                        headers: { "content-type": "application/json", "x-runwield-review-token": token },
                        body: JSON.stringify({ approved: true, approvalAction: "later" }),
                    },
                );
                assertEquals(response.ok, true);
                await waitFor(() => modelTurns > 0, "queued turn after review decision");
            } finally {
                composition.runtime.cancelSession(composition.sessionId);
                terminal.pressEscape();
                await composition.dispose();
            }
        },
    );
});

async function seedActiveElsewhereManagedSession(
    projectRoot: string,
): Promise<ReturnType<typeof openOwnerCoordinationStore>> {
    const store = openOwnerCoordinationStore();
    try {
        store.registerProject({ root: projectRoot, now: () => "2026-01-01T00:00:01.000Z" });
        const runtime = createSessionRuntime({
            sessionStore: store,
            ownerProcessKind: "test",
            ownerInstanceId: "chat-input-managed-seed",
        });
        try {
            const created = await runtime.createInteractiveSession({
                cwd: projectRoot,
                mode: "new",
            });
            await runtime.switchAgent(created.sessionId, { agentName: "operator" });
            const managed = runtime.getSessionSnapshot(created.sessionId)?.managed;
            if (!managed) throw new Error("Managed Session seed did not create managed metadata.");
            store.acquireSessionActivation({
                runwieldSessionId: managed.runwieldSessionId,
                projectId: managed.projectId,
                ownerInstanceId: "chat-input-workspace-owner",
                ownerProcessKind: "workspace",
                expectedGeneration: managed.generation,
                phase: "turning",
            });
        } finally {
            await runtime.closeAllSessionsWhenIdle?.();
        }
        return store;
    } catch (error) {
        store.close();
        throw error;
    }
}

test("chat input controller sends accepted editor input through the real composed Runtime", async () => {
    await withRuntimeCommandFixture("chat-input-real-submit-", async ({ setModelResponseFactory }) => {
        const modelRequests: string[] = [];
        setModelResponseFactory((context) => {
            modelRequests.push(JSON.stringify(context.messages));
            return fauxAssistantMessage(fauxText("Fixture response."));
        });
        const { composition, terminal } = await startComposition();
        try {
            await submitText(terminal, "hello from tui");
            await waitFor(() => modelRequests.some((request) => request.includes("hello from tui")), "model request");
            await composition.waitForIdle();
            assert(modelRequests.some((request) => request.includes("hello from tui")));
        } finally {
            await composition.dispose();
        }
    });
});

test("Shift+Tab updates thinking level immediately and persists it later", async () => {
    await withRuntimeCommandFixture("chat-input-thinking-level-", async ({ setModelResponseFactory, settingsPath }) => {
        setModelResponseFactory(() => fauxAssistantMessage(fauxText("Fixture response.")));
        const { composition, terminal } = await startComposition();
        try {
            const projectRoot = composition.runtime.getSessionSnapshot(composition.sessionId)?.cwd;
            if (!projectRoot) throw new Error("Composed Session root is unavailable");
            const settingsManager = getSettingsManager(projectRoot);
            assertEquals(settingsManager.getDefaultThinkingLevel(), undefined);

            terminal.input("\x1b[Z");

            assertEquals(composition.runtime.getSessionSnapshot(composition.sessionId)?.thinkingLevel, "minimal");
            assertEquals(settingsManager.getDefaultThinkingLevel(), undefined);
            await waitFor(
                () => settingsManager.getDefaultThinkingLevel() === "minimal",
                "deferred thinking-level persistence",
            );
            await settingsManager.flush();
            const persistedSettings = JSON.parse(await fsReadFile(settingsPath, "utf8"));
            assertEquals(persistedSettings.defaultThinkingLevel, "minimal");
        } finally {
            await composition.dispose();
        }
    });
});

test("slash new replaces the TUI with an unpersisted shell until its first message", async () => {
    await withRuntimeCommandFixture("chat-input-slash-new-lazy-", async ({ setModelResponseFactory }) => {
        const modelRequests: string[] = [];
        const releaseModel = deferredSignal();
        setModelResponseFactory(async (context) => {
            modelRequests.push(JSON.stringify(context.messages));
            await releaseModel.promise;
            return fauxAssistantMessage(fauxText("New Session response."));
        });
        const { composition, terminal } = await startComposition();
        try {
            const originalSessionId = composition.sessionId;
            const sessionRoot = composition.runtime.getSessionSnapshot(originalSessionId)?.cwd;
            if (!sessionRoot) throw new Error("Composed Session root is unavailable");
            assertEquals(await countSessionTranscripts(sessionRoot), 0);

            await submitText(terminal, "/new quick notes");
            await waitFor(() => composition.sessionId !== originalSessionId, "new in-memory Session replacement");

            const replacement = composition.runtime.getSessionSnapshot(composition.sessionId);
            assertEquals(replacement?.name, "quick notes");
            assertEquals(replacement?.activeAgent, "router");
            assertEquals(replacement?.sessionManagerId, null);
            assertEquals(replacement?.managed, null);
            assertEquals(await countSessionTranscripts(sessionRoot), 0);

            await submitText(terminal, "persist this Session now");
            await waitFor(
                () => modelRequests.some((request) => request.includes("persist this Session now")),
                "new Session model request",
            );
            await waitFor(
                () =>
                    terminal.getScreenText().includes("persist this Session now") &&
                    /Routing\.\.\.|Figuring out what you need\.\.\./.test(terminal.getScreenText()),
                "first message and thinking frame",
            );
            assertStringIncludes(terminal.getScreenText(), "persist this Session now");
            assertEquals(/Routing\.\.\.|Figuring out what you need\.\.\./.test(terminal.getScreenText()), true);
            releaseModel.resolve();
            await composition.waitForIdle();
            assertEquals(
                typeof composition.runtime.getSessionSnapshot(composition.sessionId)?.sessionManagerId,
                "string",
            );
            assertEquals(await countSessionTranscripts(sessionRoot), 1);
        } finally {
            releaseModel.resolve();
            await composition.dispose();
        }
    });
});

test("slash resume restores conversation after an interrupted checkpoint", async () => {
    await withRuntimeCommandFixture("chat-input-slash-resume-recovery-", async ({ setModelResponse }) => {
        setModelResponse("Persisted answer restored in the TUI.");
        const seeded = await startComposition();
        let managed: ResumeManagedFixture;
        let expectedModel = "";
        try {
            await submitText(seeded.terminal, "restore this conversation");
            await seeded.composition.waitForIdle(10_000);
            const snapshot = seeded.composition.runtime.getSessionSnapshot(seeded.composition.sessionId);
            if (!snapshot?.managed) throw new Error("Seeded Session was not persisted");
            managed = snapshot.managed;
            expectedModel = snapshot.activeModel.model || "";
        } finally {
            await seeded.composition.dispose();
        }

        const store = openOwnerCoordinationStore();
        try {
            const state = store.inspectSessionActivation(managed.runwieldSessionId);
            const segment = store.getCurrentSessionSegment(managed.runwieldSessionId);
            if (!segment) throw new Error("Seeded Session segment is unavailable");
            const proof = store.acquireSessionActivation({
                runwieldSessionId: managed.runwieldSessionId,
                projectId: managed.projectId,
                ownerInstanceId: "slash-resume-interrupted-fixture",
                ownerProcessKind: "test",
                expectedGeneration: state.generation?.generation ?? null,
                expectedCurrentSegmentId: segment.segmentId,
            });
            await fsWriteFile(
                segment.transcriptPath,
                `${JSON.stringify({
                    type: "custom",
                    id: crypto.randomUUID(),
                    customType: "runwield.request_attempt",
                    data: { status: "failed" },
                })}\n`,
                { flag: "a" },
            );
            store.markSessionUncertain(proof, { reason: "interrupted after a failed request" });
        } finally {
            store.close();
        }

        const resumed = await startComposition();
        try {
            await submitText(resumed.terminal, "/resume");
            await waitFor(
                () => resumed.terminal.getScreenText().includes("Select a session to resume:"),
                "resume selector",
            );
            resumed.terminal.pressEnter();
            await waitFor(
                () =>
                    resumed.terminal.getScreenText().includes("restore this conversation") &&
                    resumed.terminal.getScreenText().includes("Persisted answer restored in the TUI."),
                "restored conversation",
            );
            assertStringIncludes(resumed.terminal.getScreenText(), "restore this conversation");
            assertStringIncludes(resumed.terminal.getScreenText(), "Persisted answer restored in the TUI.");
            const resumedSnapshot = resumed.composition.runtime.getSessionSnapshot(resumed.composition.sessionId);
            assertEquals(resumedSnapshot?.activeAgent, "operator");
            assertEquals(resumedSnapshot?.activeModel.model, expectedModel);
        } finally {
            await resumed.composition.dispose();
        }
    });
});

test("chat input controller runs local commands while a real Runtime turn is active", async () => {
    await withRuntimeCommandFixture("chat-input-real-bash-", async ({ setModelResponseFactory }) => {
        const releaseModel = deferredSignal();
        let modelStarted = false;
        const requests: string[] = [];
        setModelResponseFactory(async (context) => {
            requests.push(JSON.stringify(context.messages));
            modelStarted = true;
            await releaseModel.promise;
            return fauxAssistantMessage(fauxText("Delayed response."));
        });
        const { composition, terminal } = await startComposition();
        try {
            await submitText(terminal, "hold turn");
            await waitFor(() => modelStarted, "active model turn");
            await submitText(terminal, "!printf local-output");
            await waitFor(() => terminal.getScrollbackText().includes("local-output"), "local command output");
            assertStringIncludes(terminal.getScrollbackText(), "local-output");
            assertEquals(composition.runtime.getQueuedMessages(composition.sessionId).length, 0);
            releaseModel.resolve();
            await composition.waitForIdle();
            setModelResponseFactory((context) => {
                requests.push(JSON.stringify(context.messages));
                return fauxAssistantMessage(fauxText("Follow-up complete."));
            });
            await submitText(terminal, "Continue without transient command output");
            await composition.waitForIdle();
            assertEquals(requests.length, 2);
            assertEquals(requests[1].includes("local-output"), false);
        } finally {
            releaseModel.resolve();
            await composition.dispose();
        }
    });
});

test("chat input controller queues deferred slash input for the next turn during a real Runtime turn", async () => {
    await withRuntimeCommandFixture("chat-input-real-slash-queue-", async ({ setModelResponseFactory }) => {
        const releaseModel = deferredSignal();
        let modelStarted = false;
        setModelResponseFactory(async () => {
            modelStarted = true;
            await releaseModel.promise;
            return fauxAssistantMessage(fauxText("Delayed response."));
        });
        const { composition, terminal } = await startComposition();
        try {
            await submitText(terminal, "hold turn");
            await waitFor(() => modelStarted, "active model turn");
            await submitText(terminal, "/not-a-command args");
            await waitFor(
                () =>
                    composition.runtime
                        .getQueuedMessages(composition.sessionId)
                        .some((item) => item.text === "/not-a-command args" && item.delivery === "next_turn"),
                "queued deferred slash message",
            );
            assertEquals(
                composition.runtime.getQueuedMessages(composition.sessionId).map((item) => item.text),
                ["/not-a-command args"],
            );
            assertEquals(composition.runtime.getQueuedMessages(composition.sessionId)[0]?.delivery, "next_turn");
            releaseModel.resolve();
            await composition.waitForIdle();
        } finally {
            releaseModel.resolve();
            await composition.dispose();
        }
    });
});

test("chat input controller restores the last queued draft through real keybindings", async () => {
    await withRuntimeCommandFixture("chat-input-real-restore-", async () => {
        const { composition, terminal } = await startComposition();
        try {
            composition.runtime.queueNextTurnMessage(composition.sessionId, "restore me", []);
            terminal.input("\x1b[A");
            await terminal.flush();
            await waitFor(() => terminal.getScreenText().includes("restore me"), "restored draft");
            assertStringIncludes(terminal.getScreenText(), "restore me");
            assertEquals(composition.runtime.getQueuedMessages(composition.sessionId).length, 0);
        } finally {
            await composition.dispose();
        }
    });
});

test("chat input controller recalls queued steering into the editor oldest to newest on Escape", async () => {
    await withRuntimeCommandFixture("chat-input-real-escape-steering-", async ({ setModelResponseFactory }) => {
        const releaseModel = deferredSignal();
        let modelStarted = false;
        setModelResponseFactory(async () => {
            modelStarted = true;
            await releaseModel.promise;
            return fauxAssistantMessage(fauxText("Delayed response."));
        });
        const { composition, terminal } = await startComposition();
        try {
            await submitText(terminal, "hold turn");
            await waitFor(() => modelStarted, "active model turn");
            await submitText(terminal, "oldest steering");
            await submitText(terminal, "newest steering");
            await waitFor(
                () => composition.runtime.getQueuedMessages(composition.sessionId).length === 2,
                "two queued steering messages",
            );

            terminal.pressEscape();
            await terminal.flush();
            await waitFor(() => terminal.getScreenText().includes("oldest steering"), "recalled steering");

            const screen = terminal.getScreenText();
            assert(screen.indexOf("oldest steering") < screen.indexOf("newest steering"));
            assertEquals(composition.runtime.getQueuedMessages(composition.sessionId).length, 0);
        } finally {
            releaseModel.resolve();
            await composition.dispose();
        }
    });
});

test("composed TUI reads clipboard only for explicit paste, preserving text and image submission ordering", async () => {
    await withRuntimeCommandFixture(
        "chat-input-real-image-preflight-",
        async ({ projectRoot, setModelResponseFactory }) => {
            if (process.platform !== "darwin") return;
            const clipboard = await installFakeClipboardCommands(projectRoot);
            const modelRequests: string[] = [];
            setModelResponseFactory((context) => {
                modelRequests.push(JSON.stringify(context.messages));
                return fauxAssistantMessage(fauxText("Saw image."));
            });
            const { composition, terminal } = await startComposition();
            try {
                await new Promise((resolve) => setTimeout(resolve, 3300));
                terminal.input("\x1b[200~pasted text\x1b[201~");
                await terminal.flush();
                await waitFor(() => terminal.getScreenText().includes("pasted text"), "bracketed text paste");
                terminal.input("\x03");
                const oldSessionId = composition.sessionId;
                await submitText(terminal, "/new");
                await waitFor(() => composition.sessionId !== oldSessionId, "Session replacement");
                await composition.waitForIdle();
                assertEquals(await clipboard.invocations(), []);
                terminal.input("\x16");
                await waitForPath(clipboard.imageReadMarkerPath, "clipboard image read");
                // Submit while the clipboard process is still running. The input handler must
                // await that read before it sends the text and attached image to the model.
                await submitText(terminal, "describe pasted image");
                await waitFor(
                    () =>
                        modelRequests.some(
                            (request) =>
                                request.includes("describe pasted image") &&
                                (request.includes("image/png") || request.includes("attachment:")),
                        ),
                    "model request with pasted image",
                );
                assert(
                    modelRequests.some(
                        (request) =>
                            request.includes("describe pasted image") &&
                            (request.includes("image/png") || request.includes("attachment:")),
                    ),
                );
                const calls = await clipboard.invocations();
                assertEquals(
                    calls.map(({ operation }) => operation),
                    ["probe", "extract", "encode"],
                );
                const tempPath = calls[1]!.tempPath;
                assert(tempPath.includes("runwield-clipboard-") && tempPath.endsWith(".png"));
                assertThrows(() => fsStatSync(tempPath), { code: "ENOENT" });
                await new Promise((resolve) => setTimeout(resolve, 1600));
                assertEquals(await clipboard.invocations(), calls);
            } finally {
                clipboard.restore();
                await composition.dispose();
            }
        },
    );
});

test("chat input controller preserves input while model setup blocks through the composed TUI", async () => {
    await withRuntimeCommandFixture(
        "chat-input-real-model-block-",
        async () => {
            const harness = createInteractiveCompositionHarness({});
            try {
                await harness.waitForScreen("Only showing models from configured providers");
                await harness.pressKey("escape");
                await harness.waitForScreen("No model was selected");
                await harness.waitForComposition(20_000);
                await harness.type("keep me");
                await waitFor(() => harness.terminal.getScreenText().includes("keep me"), "typed blocked draft");
                await harness.type("\r");
                await waitFor(
                    () => harness.terminal.getScrollbackText().includes("Choose a default model"),
                    "model setup block message",
                );
                assertStringIncludes(harness.terminal.getScreenText(), "keep me");
                assertStringIncludes(harness.terminal.getScrollbackText(), "Choose a default model");
            } finally {
                await harness.dispose();
            }
        },
        { providerState: "provider-no-model" },
    );
});

test("chat input controller queues input while another surface is active", async () => {
    await withRuntimeCommandFixture("chat-input-real-managed-block-", async ({ alternateRoot }) => {
        const activeStore = await seedActiveElsewhereManagedSession(alternateRoot);
        const { composition, terminal } = await startComposition("continue");
        try {
            await composition.runtime.synchronizeManagedSession(composition.sessionId);
            assertEquals(
                composition.runtime.getUserTurnSubmissionBlockMessage(composition.sessionId),
                "This conversation is still running in RunWield Workspace. Continue there, or wait for its current turn to finish before sending here.",
            );
            await submitText(terminal, "keep managed draft");
            await waitFor(() => terminal.getScreenText().includes("keep managed draft"), "typed managed draft");
            assertStringIncludes(terminal.getScreenText(), "This conversation is running in RunWield Workspace.");
            assertStringIncludes(terminal.getScreenText(), "keep managed draft");
            assertEquals(
                composition.runtime.getQueuedMessages(composition.sessionId).map((message) => message.text),
                ["keep managed draft"],
            );
        } finally {
            await composition.dispose();
            activeStore.close();
        }
    });
});

test("chat input controller connects Ctrl+C pending-exit state through real keybindings", async () => {
    await withRuntimeCommandFixture("chat-input-real-ctrl-c-", async () => {
        const { composition, terminal } = await startComposition();
        try {
            terminal.pressCtrlC();
            await terminal.flush();
            await waitFor(
                () => terminal.getScreenText().includes("Ctrl+C - Press again to exit"),
                "pending exit notice",
            );
            assertStringIncludes(terminal.getScreenText(), "Ctrl+C - Press again to exit");
        } finally {
            await composition.dispose();
        }
    });
});

test("composed TUI reports an explicit paste with no image until the next input", async () => {
    if (process.platform !== "darwin") return;
    await withRuntimeCommandFixture("chat-input-empty-clipboard-", async ({ projectRoot }) => {
        const clipboard = await installFakeClipboardCommands(projectRoot);
        await clipboard.setHasImage(false);
        const { composition, terminal } = await startComposition();
        try {
            terminal.input("\x16");
            await waitFor(() => terminal.getScreenText().includes("No image in clipboard"), "missing image notice");
            assertEquals(
                (await clipboard.invocations()).map(({ operation }) => operation),
                ["probe"],
            );
            terminal.typeText("keep typing");
            await waitFor(() => terminal.getScreenText().includes("keep typing"), "responsive editor");
            assertEquals(terminal.getScreenText().includes("No image in clipboard"), false);
            assertEquals(
                (await clipboard.invocations()).map(({ operation }) => operation),
                ["probe"],
            );
        } finally {
            await composition.dispose();
            clipboard.restore();
        }
    });
});

test("single-bang commands survive into the next turn while double-bang output stays local", async () => {
    await withRuntimeCommandFixture("chat-input-shell-context-", async ({ setModelResponseFactory }) => {
        const requests: string[] = [];
        setModelResponseFactory((context) => {
            requests.push(JSON.stringify(context.messages));
            return fauxAssistantMessage(fauxText("Shell context inspected."));
        });
        const { composition, terminal } = await startComposition();
        const completedOutputs: string[] = [];
        const unsubscribe = composition.runtime.subscribeSessionEvents(composition.sessionId, (event) => {
            if (event.type === RuntimeEventTypes.TOOL_END && event.toolName === "bash" && !event.isError) {
                completedOutputs.push(event.output || "");
            }
        });
        try {
            await submitText(terminal, "!printf 'persistent-%s-marker' shell");
            await waitFor(
                () => completedOutputs.includes("persistent-shell-marker"),
                "completed persistent shell command",
            );
            await composition.waitForIdle();
            assertStringIncludes(terminal.getScrollbackText(), "persistent-shell-marker");
            await submitText(terminal, "!!printf 'ephemeral-%s-marker' shell");
            await waitFor(
                () => completedOutputs.includes("ephemeral-shell-marker"),
                "completed ephemeral shell command",
            );
            await composition.waitForIdle();
            assertStringIncludes(terminal.getScrollbackText(), "ephemeral-shell-marker");
            await submitText(terminal, "Use the saved shell result");
            await composition.waitForIdle();
            assertEquals(requests.length, 1);
            assertStringIncludes(requests[0], "persistent-shell-marker");
            assertEquals(requests[0].includes("ephemeral-shell-marker"), false);
        } finally {
            unsubscribe();
            await composition.dispose();
        }
    });
});

for (const failure of ["missing-project", "file-limit"] as const) {
    test(`real submission ${failure} keeps the draft and permits an explicit retry`, async () => {
        await withRuntimeCommandFixture(
            "chat-input-filesystem-failure-",
            async ({ alternateRoot, homeDir, setModelResponseFactory }) => {
                const requests: string[] = [];
                setModelResponseFactory((context) => {
                    requests.push(JSON.stringify(context.messages));
                    return fauxAssistantMessage(fauxText("Retried request accepted."));
                });
                const { composition, terminal } = await startComposition();
                const originalOpen = fs.openSync;
                const canonicalHome = fs.realpathSync(homeDir);
                const canonicalRoot = fs.realpathSync(alternateRoot);
                const originalFs = { ...fs };
                let failedFilesystemCalls = 0;
                let moved = false;
                const backup = alternateRoot + "-held";
                try {
                    if (failure === "missing-project") {
                        await rename(alternateRoot, backup);
                        moved = true;
                        await fsWriteFile(alternateRoot, "project_identity_unavailable private fixture sentinel");
                    } else {
                        // Simulate OS descriptor exhaustion while keeping Session storage real.
                        mock.module("node:fs", () => ({
                            ...originalFs,
                            openSync: (...args: Parameters<typeof fs.openSync>) => {
                                const path = String(args[0]);
                                if (
                                    path.startsWith(homeDir) ||
                                    path.startsWith(alternateRoot) ||
                                    path.startsWith(canonicalHome) ||
                                    path.startsWith(canonicalRoot)
                                ) {
                                    failedFilesystemCalls++;
                                    throw Object.assign(new Error("private filesystem details"), { code: "EMFILE" });
                                }
                                return originalOpen(...args);
                            },
                        }));
                    }

                    await submitText(terminal, "keep this failed request");
                    const expected =
                        failure === "file-limit" ? "open-file limit" : "RunWield could not send that message";
                    await waitFor(
                        () => terminal.getScrollbackText().includes(expected),
                        "safe actual filesystem failure",
                    ).catch((error) => {
                        throw new Error(
                            `${error.message}: ${JSON.stringify({ failedFilesystemCalls, requestCount: requests.length, screen: terminal.getScrollbackText() })}`,
                        );
                    });
                    await composition.waitForIdle();
                    assertStringIncludes(terminal.getScreenText(), "keep this failed request");
                    assertEquals(terminal.getScrollbackText().includes("project_identity_unavailable"), false);
                    assertEquals(terminal.getScrollbackText().includes("private filesystem details"), false);
                    assertEquals(terminal.getScrollbackText().includes("at async"), false);
                    assertEquals(requests.length, 0);
                    if (failure === "file-limit") assert(failedFilesystemCalls > 0);
                    mock.module("node:fs", () => originalFs);

                    if (moved) {
                        await rm(alternateRoot);
                        await rename(backup, alternateRoot);
                        moved = false;
                    }
                    terminal.pressEnter();
                    await terminal.flush();
                    await waitFor(() => requests.length === 1, "explicit retry model request");
                    await composition.waitForIdle();
                    assertStringIncludes(requests[0], "keep this failed request");
                    assertEquals(requests.length, 1);
                } finally {
                    mock.module("node:fs", () => originalFs);

                    if (moved) {
                        await rm(alternateRoot, { force: true });
                        await rename(backup, alternateRoot);
                    }
                    await composition.dispose();
                }
            },
        );
    });
}
