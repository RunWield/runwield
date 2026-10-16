import { delimiter } from "node:path";
import { test } from "node:test";
import {
    chmod as fsChmod,
    mkdir as fsMkdir,
    readdir as fsReaddir,
    readFile as fsReadFile,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { statSync as fsStatSync } from "node:fs";
import process from "node:process";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { NO_OPEN_BROWSER_PORT } from "../../shared/browser-port.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { getRunWieldSessionDir } from "../../shared/session/root-session.js";
import { getSettingsManager } from "../../shared/settings.js";
import { createInteractiveTuiComposition, type InteractiveTuiComposition } from "./interactive-tui-composition.ts";
import { type ChatInputRuntime, createChatInputController } from "./chat-input-controller.ts";
import { createInteractiveCompositionHarness } from "./testing/interactive-composition-fixture.ts";
import { VirtualTerminal } from "./testing/virtual-terminal.js";
import { ClaudeCliBackendError } from "../../shared/session/backends/claude-cli/failure.ts";
import { AgyCliBackendError } from "../../shared/session/backends/agy-cli/failure.ts";
import { AgyCliMcpSetupApprovalError } from "../../shared/session/backends/agy-cli/mcp-setup.ts";
import type { ImageAttachment } from "../../shared/session/types.js";

interface DeferredSignal {
    promise: Promise<void>;
    resolve(): void;
}

interface ResumeManagedFixture {
    runwieldSessionId: string;
    projectId: string;
}

interface ClipboardFixtureCommands {
    previousPath: string;
    imageReadMarkerPath: string;
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

async function installFakeClipboardCommands(projectRoot: string): Promise<ClipboardFixtureCommands> {
    const previousPath = process.env["PATH"] || "";
    const binDir = `${projectRoot}/clipboard-bin`;
    const imageReadMarkerPath = `${projectRoot}/clipboard-image-read`;
    await fsMkdir(binDir, { recursive: true });
    const osascriptPath = `${binDir}/osascript`;
    await fsWriteFile(
        osascriptPath,
        [
            "#!/bin/sh",
            'script="$2"',
            "if printf '%s' \"$script\" | grep -q 'return \"image\"'; then",
            "  echo image",
            "  exit 0",
            "fi",
            "temp_file=$(printf '%s' \"$script\" | sed -n 's/^[[:space:]]*set tempFile to \"\\(.*\\)\"$/\\1/p')",
            'printf fixture-png > "$temp_file"',
            "exit 0",
            "",
        ].join("\n"),
    );
    await fsChmod(osascriptPath, 0o755);
    const base64Path = `${binDir}/base64`;
    await fsWriteFile(
        base64Path,
        [
            "#!/bin/sh",
            "echo iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            `touch "${imageReadMarkerPath}"`,
            // Reading bytes is not paste completion: the process must exit and
            // RunWield must attach/render the image before the user can submit it.
            "sleep 0.2",
            "",
        ].join("\n"),
    );
    await fsChmod(base64Path, 0o755);
    process.env["PATH"] = `${binDir}${delimiter}${previousPath}`;
    return { previousPath, imageReadMarkerPath };
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
        setModelResponseFactory(async () => {
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

test("chat input controller preflights pasted image attachments through the composed TUI", async () => {
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
            } finally {
                process.env["PATH"] = clipboard.previousPath;
                await composition.dispose();
            }
        },
    );
});

test("chat input controller shows safe text when submit fails", async () => {
    await withRuntimeCommandFixture("chat-input-safe-submit-error-", async () => {
        const { composition, terminal } = await startComposition();
        try {
            const rawMessage = "Session Manager create is blocked: project_identity_unavailable";
            composition.runtime.promptUserTurn = () => Promise.reject(new Error(rawMessage));
            await submitText(terminal, "keep this draft");
            await waitFor(
                () => terminal.getScrollbackText().includes("RunWield could not send that message"),
                "safe submit failure message",
            );
            assertStringIncludes(terminal.getScrollbackText(), "RunWield could not send that message");
            await waitFor(() => terminal.getScreenText().includes("keep this draft"), "restored failed-submit draft");
            assertStringIncludes(terminal.getScreenText(), "keep this draft");
            assertEquals(terminal.getScrollbackText().includes("project_identity_unavailable"), false);
        } finally {
            await composition.dispose();
        }
    });
});

test("chat input controller does not replace a reported Claude failure", async () => {
    await withRuntimeCommandFixture("chat-input-claude-submit-error-", async () => {
        const { composition, terminal } = await startComposition();
        try {
            composition.runtime.promptUserTurn = () =>
                Promise.reject(
                    new ClaudeCliBackendError("non_zero_exit", {
                        message: "You've hit your monthly spend limit",
                    }),
                );
            await submitText(terminal, "keep this draft");
            await waitFor(() => terminal.getScreenText().includes("keep this draft"), "restored Claude-failure draft");
            assertEquals(terminal.getScrollbackText().includes("RunWield could not send that message"), false);
        } finally {
            await composition.dispose();
        }
    });
});

test("chat input controller does not replace or log a reported Agy backend failure", async () => {
    await withRuntimeCommandFixture("chat-input-agy-backend-error-", async () => {
        const { composition, terminal } = await startComposition();
        const originalConsoleError = console.error;
        const consoleErrors: unknown[][] = [];
        console.error = (...args: unknown[]) => {
            consoleErrors.push(args);
        };
        try {
            composition.runtime.promptUserTurn = () =>
                Promise.reject(
                    new AgyCliBackendError("custom_agent_invalid", {
                        message:
                            "Antigravity CLI works, but it did not load RunWield's temporary Agent. Restart this RunWield session, then retry. If it still fails, run `wld mcp agy-cli --setup`.",
                    }),
                );
            await submitText(terminal, "keep this draft");
            await waitFor(() => terminal.getScreenText().includes("keep this draft"), "restored Agy-failure draft");
            assertEquals(terminal.getScrollbackText().includes("RunWield could not send that message"), false);
            assertEquals(terminal.getScrollbackText().includes("at async"), false);
            assertEquals(consoleErrors.length, 0);
        } finally {
            console.error = originalConsoleError;
            await composition.dispose();
        }
    });
});

test("chat input controller shows Agy MCP setup approval action without spilling a stack", async () => {
    await withRuntimeCommandFixture("chat-input-agy-setup-error-", async () => {
        const { composition, terminal } = await startComposition();
        const originalConsoleError = console.error;
        const consoleErrors: unknown[][] = [];
        console.error = (...args: unknown[]) => {
            consoleErrors.push(args);
        };
        try {
            composition.runtime.promptUserTurn = () =>
                Promise.reject(
                    new AgyCliMcpSetupApprovalError(
                        "Antigravity MCP setup needs approval. Run wld mcp agy-cli --setup.",
                    ),
                );
            await submitText(terminal, "keep this draft");
            await waitFor(
                () =>
                    terminal.getScrollbackText().includes("wld mcp agy-cli") &&
                    terminal.getScrollbackText().includes("--setup"),
                "Agy setup action",
            );
            assertEquals(terminal.getScrollbackText().includes("RunWield could not send that message"), false);
            assertEquals(terminal.getScrollbackText().includes("at async"), false);
            assertEquals(consoleErrors.length, 0);
            await waitFor(() => terminal.getScreenText().includes("keep this draft"), "restored Agy setup draft");
            assertStringIncludes(terminal.getScreenText(), "keep this draft");
        } finally {
            console.error = originalConsoleError;
            await composition.dispose();
        }
    });
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

type ControllerRuntimeOverrides = Partial<
    Pick<
        ChatInputRuntime,
        "preflightUserTurnImages" | "promptUserTurn" | "steerSession" | "queueNextTurnMessage" | "getSessionSnapshot"
    >
>;

interface PreviewChild {
    id?: string;
}

function createControllerHarness(runtimeOverrides: ControllerRuntimeOverrides = {}) {
    const editor = {
        disableSubmit: false,
        text: "",
        expandedText: null as string | null,
        onSubmit: async (_text: string) => {},
        handleInput(_data: string) {},
        onChange: (_text: string) => {},
        setText(text: string) {
            this.text = text;
            this.expandedText = null;
            this.onChange(text);
        },
        setExpandedText(text: string, expandedText: string) {
            this.text = text;
            this.expandedText = expandedText;
            this.onChange(text);
        },
        getText() {
            return this.text;
        },
        getExpandedText() {
            return this.expandedText ?? this.text;
        },
        submitValue() {
            const result = this.getExpandedText().trim();
            this.text = "";
            this.expandedText = null;
            this.onChange("");
            return this.onSubmit(result);
        },
    };
    const pastedImages: ImageAttachment[] = [];
    const previewImages = {
        children: [] as PreviewChild[],
        addChild(child: PreviewChild) {
            this.children.push(child);
        },
        removeChild(child: PreviewChild) {
            const index = this.children.indexOf(child);
            if (index >= 0) this.children.splice(index, 1);
        },
    };
    const messages: string[] = [];
    const busyStates: boolean[] = [];
    const runtime = {
        preflightUserTurnImages: () => Promise.resolve({ ok: true, mode: "direct" }),
        persistSessionImage: (_sessionId: string, image: ImageAttachment) => Promise.resolve(image),
        getSessionSnapshot: () => null,
        getUserTurnSubmissionBlockMessage: () => null,
        promptUserTurn: () =>
            Promise.resolve({ ok: true, turns: 1, managed: false, submittedRequest: "", restoreDraft: false }),
        queueNextTurnMessage: () => ({ queued: true }),
        getQueuedMessages: () => [],
        takeNextTurnMessage: () => ({ message: null }),
        dequeueLastQueuedMessage: () => Promise.resolve({ ok: false }),
        steerSession: () => Promise.resolve({ ok: true, queued: true }),
        requestSessionHelp: () => ({ ok: true }),
        cycleSessionThinkingLevel: () => ({ ok: false }),
        cancelSession: () => ({ aborted: false }),
        synchronizeManagedSession: () => Promise.resolve(),
        ...runtimeOverrides,
    };
    const view = {
        editor,
        pastedImages,
        previewImages,
        tui: { requestRender() {} },
        focusEditor() {},
        requestRender() {},
        clearPastedImages() {
            pastedImages.length = 0;
            previewImages.children.length = 0;
        },
    };
    const uiAPI = {
        appendSystemMessage(message: string) {
            messages.push(message);
        },
        hideKeyboardHelp() {},
        setBusy(busy: boolean) {
            busyStates.push(busy);
        },
        enableInput() {},
        abortActivePrompt() {},
    };
    const controller = createChatInputController({
        view: view as never,
        uiAPI: uiAPI as never,
        runtime: runtime as never,
        getSessionId: () => "session-1",
        getProjectRoot: () => "/tmp/runwield-test",
        managedSyncController: { pause: () => Promise.resolve(), resume() {} },
        shouldBlockForModelSetup: () => false,
        isModelSetupRecoveryCommand: () => false,
        isInitCommandAvailable: () => false,
        getPromptTemplateByName: () => new Map(),
        getSkills: () => [],
        sessionStartedAt: "2026-01-01T00:00:00.000Z",
        chatPromptAgentName: "router",
        replaceRuntimeSession: () => {},
        markCtrlCPendingExit: () => {},
        isCtrlCPendingExit: () => false,
    });
    return { controller, editor, pastedImages, previewImages, messages, busyStates, runtime };
}

test("chat input steers a generated background turn and keeps runtime busy", async () => {
    let steered = "";
    let promptCalls = 0;
    const { controller, editor, busyStates } = createControllerHarness({
        getSessionSnapshot: () => ({ busy: true }) as ReturnType<ChatInputRuntime["getSessionSnapshot"]>,
        steerSession: (_sessionId, text) => {
            steered = text;
            return Promise.resolve({ ok: true, queued: true });
        },
        promptUserTurn: () => {
            promptCalls++;
            return Promise.resolve({ ok: true, turns: 1, managed: false, submittedRequest: "", restoreDraft: false });
        },
    });
    editor.setText("Use the result and keep working.");
    await editor.submitValue();
    assertEquals(steered, "Use the result and keep working.");
    assertEquals(promptCalls, 0);
    controller.forceResetUI();
    assertEquals(busyStates.at(-1), true);
});

test("chat input controller submits tutorial discovery as a normal Planner turn", async () => {
    let submitted: Parameters<ChatInputRuntime["promptUserTurn"]>[1] | null = null;
    const { controller } = createControllerHarness({
        promptUserTurn: (_sessionId, options) => {
            submitted = options;
            return Promise.resolve({ ok: true, turns: 1, managed: false, submittedRequest: "", restoreDraft: false });
        },
    });
    const context = {
        version: 1 as const,
        guidanceEnabled: true,
        shownExplanationIds: ["choose-improvement"],
        recapShown: false,
        planId: null,
    };

    await controller.submitTutorialRequest("Choose one small change.", context);

    assertEquals(submitted, {
        initialRequest: "Choose one small change.",
        initialImages: [],
        preparedModelOverride: undefined,
        agentName: "planner",
        initialTutorialContext: context,
    });
});

test("chat input explains resource limits and restores the draft without replaying it", async () => {
    let submissions = 0;
    const { controller, editor, messages } = createControllerHarness({
        promptUserTurn: () => {
            submissions++;
            return Promise.reject(Object.assign(new Error("Could not open socket"), { code: "EMFILE" }));
        },
    });
    try {
        await editor.onSubmit("keep this request");
        await waitFor(() => messages.length > 0, "resource-limit guidance");
        assertEquals(editor.getText(), "keep this request");
        assertEquals(submissions, 1);
        assertStringIncludes(messages[0], "open-file limit");
        assertEquals(messages[0].includes("at async"), false);
    } finally {
        await controller.dispose();
    }
});

test("chat input controller restores exact draft and previews after image preflight rejection", async () => {
    let promptCalled = false;
    const { editor, pastedImages, previewImages, messages } = createControllerHarness({
        preflightUserTurnImages: () => Promise.resolve({ ok: false, message: "Cannot attach image." }),
        promptUserTurn: () => {
            promptCalled = true;
            return Promise.resolve({ ok: true, turns: 1, managed: false, submittedRequest: "", restoreDraft: false });
        },
    });
    pastedImages.push({ base64: btoa("img"), mimeType: "image/png" });
    previewImages.children.push({});

    editor.setText("  keep exact draft  ");
    await editor.submitValue();

    assertEquals(promptCalled, false);
    assertEquals(editor.getText(), "  keep exact draft  ");
    assertEquals(pastedImages.length, 1);
    assertEquals(previewImages.children.length, 1);
    assertEquals(messages, ["Cannot attach image."]);
});

test("chat input controller restores an empty draft after an image-only preflight rejection", async () => {
    const { editor, pastedImages, previewImages } = createControllerHarness({
        preflightUserTurnImages: () => Promise.resolve({ ok: false, message: "Cannot attach image." }),
    });
    editor.setText("stale draft");
    editor.setText("");
    await Promise.resolve();
    pastedImages.push({ base64: btoa("img"), mimeType: "image/png" });
    previewImages.children.push({});

    await editor.submitValue();

    assertEquals(editor.getText(), "");
    assertEquals(pastedImages.length, 1);
});

test("chat input controller restores expanded pasted content after image preflight rejection", async () => {
    const { editor, pastedImages } = createControllerHarness({
        preflightUserTurnImages: () => Promise.resolve({ ok: false, message: "Cannot attach image." }),
    });
    pastedImages.push({ base64: btoa("img"), mimeType: "image/png" });

    editor.setExpandedText("before [[paste:1]] after", "before pasted content after");
    await editor.submitValue();

    assertEquals(editor.getText(), "before pasted content after");
});

test("chat input controller restores a whitespace-only image draft after Pi clears the editor", async () => {
    const { editor, pastedImages } = createControllerHarness({
        preflightUserTurnImages: () => Promise.resolve({ ok: false, message: "Cannot attach image." }),
    });
    pastedImages.push({ base64: btoa("img"), mimeType: "image/png" });

    editor.setText("   \t  ");
    await editor.submitValue();

    assertEquals(editor.getText(), "   \t  ");
});

test("chat input controller sends the model prepared by image preflight", async () => {
    let submittedModel = "";
    const { editor, pastedImages } = createControllerHarness({
        preflightUserTurnImages: () =>
            Promise.resolve({
                ok: true,
                mode: "direct",
                preparedModelOverride: "runtime-command-fixture/fixture-model",
            }),
        promptUserTurn: (_sessionId, options) => {
            submittedModel = options.preparedModelOverride || "";
            return Promise.resolve({ ok: true, turns: 1, managed: false, submittedRequest: "", restoreDraft: false });
        },
    });
    pastedImages.push({ base64: btoa("img"), mimeType: "image/png" });

    editor.setText("describe image");
    await editor.submitValue();

    assertEquals(submittedModel, "runtime-command-fixture/fixture-model");
});

test("chat input controller sends one corrected image draft after a rejection", async () => {
    let preflightCalls = 0;
    let promptCalls = 0;
    let submittedImage = "";
    const { editor, pastedImages } = createControllerHarness({
        preflightUserTurnImages: () => {
            preflightCalls += 1;
            return Promise.resolve(
                preflightCalls === 1 ? { ok: false, message: "Cannot attach image." } : { ok: true, mode: "direct" },
            );
        },
        promptUserTurn: (_sessionId, options) => {
            promptCalls += 1;
            submittedImage = options.initialImages?.[0]?.base64 || "";
            return Promise.resolve({ ok: true, turns: 1, managed: false, submittedRequest: "", restoreDraft: false });
        },
    });
    pastedImages.push({ base64: btoa("bad"), mimeType: "image/png" });
    editor.setText("describe image");
    await editor.submitValue();
    pastedImages.length = 0;
    pastedImages.push({ base64: btoa("good"), mimeType: "image/png" });
    editor.setText("describe corrected image");
    await editor.submitValue();

    assertEquals(promptCalls, 1);
    assertEquals(submittedImage, btoa("good"));
});

test("chat input controller does not queue image steering that runtime rejects", async () => {
    const release = deferredSignal();
    let queued = false;
    const { controller, editor, pastedImages, previewImages, messages } = createControllerHarness({
        promptUserTurn: () =>
            release.promise.then(() => ({
                ok: true,
                turns: 1,
                managed: false,
                submittedRequest: "",
                restoreDraft: false,
            })),
        steerSession: () => Promise.reject(new Error("Cannot attach image.")),
        queueNextTurnMessage: () => {
            queued = true;
            return { ok: true, queued: true };
        },
    });

    const firstSubmit = editor.onSubmit("first turn");
    await waitFor(() => controller.isProcessingSubmission(), "started first turn");
    pastedImages.push({ base64: btoa("img"), mimeType: "image/png" });
    previewImages.children.push({});
    await editor.onSubmit("steer with image");
    await waitFor(() => editor.getText().includes("steer with image"), "restored rejected steering");
    release.resolve();
    await firstSubmit;
    await waitFor(() => !controller.isProcessingSubmission(), "finished first turn");

    assertEquals(queued, false);
    assertEquals(editor.getText(), "steer with image");
    assertEquals(pastedImages.length, 1);
    assert(messages.some((message) => message.includes("RunWield could not send that message")));
});
