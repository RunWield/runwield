import { withSessionViewFixture } from "./testing/session-view-fixture.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Container, Spacer, StdinBuffer, Text, TuiAltScreen } from "@earendil-works/pi-tui";
import { createChatView, findVisibleToolBlocks } from "./chat-view.ts";
import { ToolExecutionBlock, ToolExecutionGroupBlock, UserPromptBlock } from "./blocks.js";
import { VirtualTerminal } from "./testing/virtual-terminal.js";
import { RunWieldTui } from "./tui.ts";
import { installTerminalFocusState } from "./terminal-focus-state.ts";
import { installKeybindings } from "./keybindings.ts";
import { createGenerationGuard } from "./generation-guard.ts";

interface LongSessionFrameObservation {
    retainedCount: number;
    retainedBlockRenderCount: number;
    timerCallbacks: number;
    frameDurationsMs: number[];
    terminalOutputBytes: number;
}

Deno.test("TUI artifact shortcut opens the shared-reader picker without changing the draft", async () => {
    await withSessionViewFixture(async ({ runtime, sessionId, store }) => {
        const managed = runtime.getSessionSnapshot(sessionId)?.managed;
        assert(managed);
        const proof = store.acquireSessionActivation({
            runwieldSessionId: managed.runwieldSessionId,
            projectId: managed.projectId,
            ownerInstanceId: "artifact-fixture",
            ownerProcessKind: "test",
        });
        try {
            store.registerSessionArtifact(proof, {
                kind: "prd",
                title: "Reader requirements",
                path: "docs/prd/reader.md",
                registeredBy: "Ideator",
            });
        } finally {
            store.releaseUnchangedActivation(proof);
        }
        const terminal = new VirtualTerminal({ columns: 150, rows: 30 });
        const tui = new TuiAltScreen(terminal);
        const view = await createChatView({
            documentLinks: null,
            tui,
            suppressStartupHeader: true,
            getSessionId: () => sessionId,
            sessionRuntime: runtime,
            setActiveModel: () => Promise.resolve({ status: "active" }),
        });
        try {
            tui.start();
            view.editor.setText("Keep my draft");
            terminal.input("\x1b]");
            tui.renderNow(true);
            await terminal.flush();
            assertStringIncludes(terminal.getScreenText(), "Open artifact");
            assertStringIncludes(terminal.getScreenText(), "Reader requirements");
            terminal.input("\x1b");
            await terminal.flush();
            assertEquals(view.editor.getText(), "Keep my draft");
        } finally {
            view.dispose();
            tui.stop();
        }
    });
});

Deno.test("chat view reconstructs delayed mouse-wheel input without changing a draft or cancelling work", async () => {
    await withSessionViewFixture(async ({ runtime, sessionId }) => {
        const terminal = new VirtualTerminal({ columns: 80, rows: 12 });
        const tui = new RunWieldTui(terminal);
        const focus = installTerminalFocusState(terminal, () => tui.requestRender(true));
        const view = await createChatView({
            documentLinks: null,
            tui,
            suppressStartupHeader: true,
            getSessionId: () => sessionId,
            sessionRuntime: runtime,
            setActiveModel: () => Promise.resolve({ status: "active" }),
        });
        let cancellationCount = 0;
        let ctrlCPendingExit = false;
        const submissions: string[] = [];
        view.editor.onSubmit = (text) => submissions.push(text);
        installKeybindings({
            editor: view.editor,
            tui,
            uiAPI: view.uiAPI,
            pastedImages: view.pastedImages,
            previewImages: view.previewImages,
            generationGuard: createGenerationGuard(),
            dismissActivePrompt: () => {},
            dequeueLastSubmission: () => false,
            recallQueuedSubmissionsToEditor: () => {},
            forceResetUI: () => {},
            markCtrlCPendingExit: () => {
                ctrlCPendingExit = true;
            },
            isCtrlCPendingExit: () => ctrlCPendingExit,
            cycleThinkingLevel: () => {},
            readClipboardImage: () => Promise.resolve(null),
            cancelRuntimeSession: () => {
                cancellationCount++;
                return true;
            },
        });
        const mouseSequence = "\x1b[<64;1;1M";

        try {
            tui.start();
            for (let index = 0; index < 30; index++) {
                view.uiAPI.appendUserMessage?.(`retained message ${index}`);
            }
            view.uiAPI.setBusy?.(true);
            view.editor.setText("keep this draft");
            tui.renderNow(true);
            await terminal.flush();

            for (let split = 1; split < mouseSequence.length; split++) {
                tui.scrollToBottom();
                tui.renderNow();
                const beforeScroll = tui.viewportTop;
                const input = new StdinBuffer({ timeout: 80, escapeTimeout: 80 });
                input.on("data", (data: string) => terminal.input(data));
                input.process(mouseSequence.slice(0, split));
                input.process(mouseSequence.slice(split));
                tui.renderNow();
                await terminal.flush();
                assertEquals(tui.viewportTop < beforeScroll, true);
                assertEquals(view.editor.getText(), "keep this draft");
                assertEquals(cancellationCount, 0);
                assertEquals(submissions, []);
            }

            tui.scrollToBottom();
            tui.renderNow();
            const beforeDelayedScroll = tui.viewportTop;
            const delayedInput = new StdinBuffer({ timeout: 1, escapeTimeout: 1 });
            delayedInput.on("data", (data: string) => terminal.input(data));
            delayedInput.process("\x1b");
            await new Promise((resolve) => setTimeout(resolve, 10));
            delayedInput.process(mouseSequence.slice(1));
            tui.renderNow();
            await terminal.flush();

            assertEquals(tui.viewportTop < beforeDelayedScroll, true);
            assertEquals(view.editor.getText(), "keep this draft");
            assertEquals(cancellationCount, 0);
            assertEquals(submissions, []);

            const incompleteInput = new StdinBuffer({ timeout: 1, escapeTimeout: 1 });
            incompleteInput.on("data", (data: string) => terminal.input(data));
            incompleteInput.process("\x1b");
            await new Promise((resolve) => setTimeout(resolve, 10));
            incompleteInput.process(mouseSequence.slice(1, 6));
            await new Promise((resolve) => setTimeout(resolve, 70));
            incompleteInput.process(mouseSequence.slice(6));
            assertEquals(view.editor.getText(), "keep this draft");
            assertEquals(cancellationCount, 0);
            assertEquals(submissions, []);

            terminal.input("\x1b");
            await new Promise((resolve) => setTimeout(resolve, 70));
            assertEquals(cancellationCount, 1);
        } finally {
            view.uiAPI.setBusy?.(false);
            focus.dispose();
            view.dispose();
            tui.stop();
        }
    });
});

Deno.test("chat view shows messages appended after the first frame", async () => {
    await withSessionViewFixture(async ({ runtime, sessionId }) => {
        const terminal = new VirtualTerminal({ columns: 80, rows: 12 });
        const tui = new RunWieldTui(terminal);
        const view = await createChatView({
            documentLinks: null,
            tui,
            suppressStartupHeader: true,
            getSessionId: () => sessionId,
            sessionRuntime: runtime,
            setActiveModel: () => Promise.resolve({ status: "active" }),
        });
        try {
            tui.start();
            tui.renderNow(true);
            await terminal.flush();

            view.uiAPI.appendUserMessage?.("message after the first frame");
            tui.renderNow();
            await terminal.flush();

            assertStringIncludes(terminal.getScreenText(), "message after the first frame");
        } finally {
            view.dispose();
            tui.stop();
        }
    });
});

Deno.test("chat view keeps unchanged retained blocks out of live-update renders", async () => {
    await withSessionViewFixture(async ({ runtime, sessionId }) => {
        const retainedCounts = [100, 500, 1_000, 2_000];
        const terminalCaptureLimit = 16_384;
        const observations: LongSessionFrameObservation[] = [];

        for (const retainedCount of retainedCounts) {
            const terminal = new VirtualTerminal({ columns: 150, rows: 12 });
            const tui = new RunWieldTui(terminal);
            const view = await createChatView({
                documentLinks: null,
                tui,
                suppressStartupHeader: true,
                getSessionId: () => sessionId,
                sessionRuntime: runtime,
                setActiveModel: () => Promise.resolve({ status: "active" }),
            });
            const terminalSamples: string[] = [];
            const captureTerminalOutput = (): void => {
                terminalSamples.push(terminal.writes.slice(-terminalCaptureLimit));
                terminal.writes = "";
            };

            try {
                tui.start();
                view.editor.setText("draft stays ready");
                const tool = view.uiAPI.startToolExecution?.("live-tool", "bash", "! echo streaming");
                const thinking = view.uiAPI.appendThinkingStart?.();
                if (!thinking || !tool) throw new Error("TUI API is incomplete.");
                const liveChildren = [...view.messageList.children];
                for (let index = 0; index < retainedCount; index++) {
                    view.messageList.addChild(new UserPromptBlock(`retained marker ${index}`));
                }
                for (const child of liveChildren) {
                    view.messageList.removeChild(child);
                    view.messageList.addChild(child);
                }
                const retainedBlocks = view.messageList.children.filter((child) => child instanceof UserPromptBlock);
                assertEquals(retainedBlocks.length, retainedCount);
                const renderCounts = new Map<UserPromptBlock, number>();
                for (const block of retainedBlocks) {
                    const render = block.render.bind(block);
                    block.render = (width: number): string[] => {
                        renderCounts.set(block, (renderCounts.get(block) ?? 0) + 1);
                        return render(width);
                    };
                }
                thinking.appendDelta("live stream update one");
                tool.setOutput("live tool output one");
                view.uiAPI.setBusy?.(true);
                tui.renderNow(true);
                await terminal.flush();
                captureTerminalOutput();
                const initialRenderCounts = retainedBlocks.map((block) => renderCounts.get(block) ?? 0);
                assertEquals(initialRenderCounts.filter((count) => count === 0).length, 0);

                const spinnerFrame = view.runningTasksComponent.frame;
                await new Promise((resolve) => setTimeout(resolve, 130));
                await terminal.flush();
                const timerCallbacks = view.runningTasksComponent.frame - spinnerFrame;
                captureTerminalOutput();
                assertEquals(timerCallbacks > 0, true);

                tui.scrollToTop();
                tui.renderNow();
                await terminal.flush();
                captureTerminalOutput();
                const selectedViewportTop = tui.viewportTop;
                const selectedViewport = terminal.getScreenText();
                assertStringIncludes(selectedViewport, "retained marker 0");

                const streamFrameStart = performance.now();
                thinking.appendDelta(" live stream update two");
                tui.renderNow();
                await terminal.flush();
                const streamFrameDurationMs = performance.now() - streamFrameStart;
                captureTerminalOutput();
                assertEquals(retainedBlocks.map((block) => renderCounts.get(block) ?? 0), initialRenderCounts);
                assertEquals(tui.viewportTop, selectedViewportTop);
                assertEquals(terminal.getScreenText(), selectedViewport);

                terminal.typeText("!");
                tui.renderNow();
                await terminal.flush();
                captureTerminalOutput();
                assertEquals(view.editor.getText(), "draft stays ready!");
                assertEquals(retainedBlocks.map((block) => renderCounts.get(block) ?? 0), initialRenderCounts);

                tui.scrollToBottom();
                tui.renderNow();
                await terminal.flush();
                captureTerminalOutput();
                assertStringIncludes(terminal.getScreenText(), "live stream update two");

                const toolFrameStart = performance.now();
                tool.setOutput("live tool output two");
                tui.renderNow();
                await terminal.flush();
                const toolFrameDurationMs = performance.now() - toolFrameStart;
                captureTerminalOutput();
                assertEquals(retainedBlocks.map((block) => renderCounts.get(block) ?? 0), initialRenderCounts);
                assertStringIncludes(terminal.getScreenText(), "live tool output two");
                assertEquals(terminalSamples.every((sample) => sample.length <= terminalCaptureLimit), true);

                observations.push({
                    retainedCount,
                    retainedBlockRenderCount: initialRenderCounts.reduce((total, count) => total + count, 0),
                    timerCallbacks,
                    frameDurationsMs: [streamFrameDurationMs, toolFrameDurationMs],
                    terminalOutputBytes: terminalSamples.reduce((total, sample) => total + sample.length, 0),
                });
            } finally {
                view.uiAPI.setBusy?.(false);
                view.dispose();
                tui.stop();
            }
        }

        assertEquals(observations.map((observation) => observation.retainedCount), retainedCounts);
        assertEquals(observations.every((observation) => observation.retainedBlockRenderCount > 0), true);
        assertEquals(observations.every((observation) => observation.timerCallbacks > 0), true);
        assertEquals(
            observations.every((observation) =>
                observation.frameDurationsMs.every((duration) => Number.isFinite(duration))
            ),
            true,
        );
        assertEquals(observations.every((observation) => observation.terminalOutputBytes > 0), true);
    });
});

Deno.test("chat view refreshes an active tool without reformatting retained message blocks", async () => {
    await withSessionViewFixture(async ({ runtime, sessionId }) => {
        const terminal = new VirtualTerminal({ columns: 80, rows: 12 });
        const tui = new RunWieldTui(terminal);
        const view = await createChatView({
            documentLinks: null,
            tui,
            suppressStartupHeader: true,
            getSessionId: () => sessionId,
            sessionRuntime: runtime,
            setActiveModel: () => Promise.resolve({ status: "active" }),
        });
        try {
            tui.start();
            for (let index = 0; index < 20; index++) {
                view.uiAPI.appendUserMessage?.(`retained message ${index}`);
            }
            const tool = view.uiAPI.startToolExecution?.("tool-1", "bash", "! echo streaming");
            if (!tool) throw new Error("TUI API is incomplete.");
            tool.setOutput("first tool output");
            tui.renderNow(true);
            await terminal.flush();
            assertStringIncludes(terminal.getScreenText(), "first tool output");

            tool.setOutput("updated tool output");
            tui.renderNow();
            await terminal.flush();
            assertStringIncludes(terminal.getScreenText(), "updated tool output");
        } finally {
            view.uiAPI.setBusy?.(false);
            view.dispose();
            tui.stop();
        }
    });
});

Deno.test("chat view finds only tool groups intersecting the viewport", () => {
    const messageList = new Container();
    const firstGroup = new ToolExecutionGroupBlock();
    const secondGroup = new ToolExecutionGroupBlock();
    const containerLayout = [
        { component: new Text("header", 0, 0), height: 1 },
        { component: messageList, height: 7 },
    ];
    const messageLayout = [
        { component: firstGroup, height: 3 },
        { component: new Spacer(1), height: 1 },
        { component: secondGroup, height: 3 },
    ];

    const visibleBlocks = findVisibleToolBlocks(containerLayout, messageList, messageLayout, 5, 3);
    assertEquals(visibleBlocks.length, 1);
    assertEquals(visibleBlocks[0] === secondGroup, true);
});

Deno.test("chat view keeps sidebar tabs on the first row above a queued steering message", async () => {
    await withSessionViewFixture(async ({ runtime, sessionId }) => {
        const terminal = new VirtualTerminal({ columns: 150, rows: 20 });
        const tui = new TuiAltScreen(terminal);
        const view = await createChatView({
            documentLinks: null,
            tui,
            suppressStartupHeader: true,
            getSessionId: () => sessionId,
            sessionRuntime: runtime,
            setActiveModel: () => Promise.resolve({ status: "active" }),
        });

        try {
            tui.start();
            for (let index = 1; index <= 12; index++) {
                view.uiAPI.appendUserMessage?.(`message ${index}`);
            }
            view.uiAPI.appendQueuedMessage?.("steering-1", "Queued steering message");
            tui.renderNow(true);
            await terminal.flush();

            const tabs = "Workflow · Session · Artifacts";
            assertStringIncludes(terminal.getScreenText().split("\n")[0], tabs);

            tui.scrollBy(-5);
            tui.renderNow(true);
            await terminal.flush();
            assertStringIncludes(terminal.getScreenText().split("\n")[0], tabs);
        } finally {
            view.dispose();
            tui.stop();
        }
    });
});

Deno.test("chat view tracks quick fix validation in the workflow sidebar", async () => {
    await withSessionViewFixture(async ({ runtime, sessionId, session }) => {
        session.replaceWorkflowContext({ routingIntent: "QUICK_FIX", complexity: "LOW" });
        const terminal = new VirtualTerminal({ columns: 150, rows: 28 });
        const tui = new TuiAltScreen(terminal);
        const view = await createChatView({
            documentLinks: null,
            tui,
            suppressStartupHeader: true,
            getSessionId: () => sessionId,
            sessionRuntime: runtime,
            setActiveModel: () => Promise.resolve({ status: "active" }),
        });
        try {
            tui.start();
            view.uiAPI.updateValidationProgress?.({
                kind: "mechanical",
                outcome: "running",
                stage: "ci",
                checks: { ci: "running", semanticReview: "skipped", humanReview: "skipped", merge: "skipped" },
            });
            tui.renderNow(true);
            await terminal.flush();
            const screen = terminal.getScreenText();
            assertStringIncludes(screen, "● Tests and CI");
            assertEquals(screen.includes("● Planning"), false);
            assertEquals(screen.includes("Answer agent"), false);
        } finally {
            view.dispose();
            tui.stop();
        }
    });
});

Deno.test("chat view keeps block backgrounds out of the sidebar when the scrollbar is visible", async () => {
    await withSessionViewFixture(async ({ runtime, sessionId }) => {
        const terminal = new VirtualTerminal({ columns: 150, rows: 20 });
        const tui = new TuiAltScreen(terminal);
        const view = await createChatView({
            documentLinks: null,
            tui,
            suppressStartupHeader: true,
            getSessionId: () => sessionId,
            sessionRuntime: runtime,
            setActiveModel: () => Promise.resolve({ status: "active" }),
        });

        try {
            tui.start();
            for (let index = 1; index <= 20; index++) {
                view.uiAPI.appendUserMessage?.(`message ${index}`);
            }
            view.uiAPI.startToolExecution?.("tool-1", "bash", "$ echo boundary");
            tui.renderNow(true);
            tui.scrollBy(-2);
            tui.renderNow(true);
            await terminal.flush();

            const lines = terminal.getViewportLines();
            const toolRow = lines.findIndex((line) => line.includes("$ echo boundary"));
            assertEquals(toolRow >= 0, true);
            assertEquals(lines[toolRow].includes("┃"), true);
            assertEquals(terminal.hasDefaultBackground(toolRow, 116), true);
        } finally {
            view.dispose();
            tui.stop();
        }
    });
});

Deno.test("chat view keeps scrollback position during live thinking updates", async () => {
    await withSessionViewFixture(async ({ runtime, sessionId }) => {
        const terminal = new VirtualTerminal({ columns: 80, rows: 10 });
        const tui = new TuiAltScreen(terminal);
        const view = await createChatView({
            documentLinks: null,
            tui,
            suppressStartupHeader: true,
            getSessionId: () => sessionId,
            sessionRuntime: runtime,
            setActiveModel: () => Promise.resolve({ status: "active" }),
        });

        try {
            tui.start();
            const appendUserMessage = view.uiAPI.appendUserMessage;
            const appendThinkingStart = view.uiAPI.appendThinkingStart;
            if (!appendUserMessage || !appendThinkingStart) throw new Error("TUI API is incomplete.");
            for (let index = 1; index <= 12; index++) {
                appendUserMessage(`older message ${index}`);
            }
            const thinking = appendThinkingStart();
            thinking.appendDelta("live update before scroll");
            tui.renderNow(true);
            await terminal.flush();

            tui.scrollBy(-5);
            tui.renderNow(true);
            await terminal.flush();
            const before = terminal.getScreenText();
            assertStringIncludes(before, "older message");

            thinking.appendDelta(" and after scroll");
            tui.renderNow(true);
            await terminal.flush();

            assertEquals(terminal.getScreenText(), before);
        } finally {
            view.dispose();
            tui.stop();
        }
    });
});

Deno.test("chat view keeps settled tool lines cached across a keystroke", async () => {
    await withSessionViewFixture(async ({ runtime, sessionId }) => {
        const terminal = new VirtualTerminal({ columns: 100, rows: 20 });
        const tui = new TuiAltScreen(terminal);
        const view = await createChatView({
            documentLinks: null,
            tui,
            suppressStartupHeader: true,
            getSessionId: () => sessionId,
            sessionRuntime: runtime,
            setActiveModel: () => Promise.resolve({ status: "active" }),
        });
        try {
            tui.start();
            for (let index = 1; index <= 6; index++) {
                view.uiAPI.appendUserMessage?.(`settled message ${index}`);
            }
            const tool = view.uiAPI.startToolExecution?.("keystroke-tool", "bash", "run tests");
            if (!(tool instanceof ToolExecutionBlock)) throw new Error("Expected a tool block.");
            tool.setOutput("ok line one\nok line two");
            tool.endExecution(false, 120);
            tui.renderNow(true);
            await terminal.flush();

            const before = tool.render(100);
            terminal.input("x");
            tui.renderNow();
            await terminal.flush();
            const after = tool.render(100);
            assert(before === after, "a keystroke must not rebuild settled block lines");
            assertStringIncludes(terminal.getScreenText(), "run tests");
            assertStringIncludes(terminal.getScreenText(), "x");
        } finally {
            view.dispose();
            tui.stop();
        }
    });
});

for (const recovery of ["ctrl+l", "focus"] as const) {
    Deno.test(`chat view restores erased input on ${recovery} without losing draft or scroll position`, async () => {
        await withSessionViewFixture(async ({ runtime, sessionId }) => {
            const terminal = new VirtualTerminal({ columns: 80, rows: 12 });
            const tui = new RunWieldTui(terminal);
            const focus = installTerminalFocusState(terminal, () => tui.requestRender(true));
            const view = await createChatView({
                documentLinks: null,
                tui,
                suppressStartupHeader: true,
                getSessionId: () => sessionId,
                sessionRuntime: runtime,
                setActiveModel: () => Promise.resolve({ status: "active" }),
            });
            const submissions: string[] = [];
            view.editor.onSubmit = (text) => submissions.push(text);
            try {
                tui.start();
                for (let index = 1; index <= 12; index++) {
                    view.uiAPI.appendUserMessage?.(`older message ${index}`);
                }
                view.editor.setText("keep this draft");
                view.uiAPI.setBusy?.(true);
                tui.renderNow();
                tui.scrollBy(-5);
                tui.renderNow();
                await terminal.flush();
                const before = terminal.getScreenText();
                assertStringIncludes(before, "keep this draft");
                assertStringIncludes(before, "─".repeat(20));

                // Simulate screen damage outside the renderer. Its cached frame still
                // contains the input, so an ordinary render cannot restore it.
                terminal.write("\x1b[2J");
                tui.renderNow();
                await terminal.flush();
                assertEquals(terminal.getScreenText().trim(), "");

                if (recovery === "focus") {
                    terminal.input("\x1b[O");
                    terminal.input("\x1b[");
                    terminal.input("I");
                } else {
                    terminal.input("\x0c");
                }
                tui.renderNow();
                await terminal.flush();
                assertEquals(terminal.getScreenText(), before);
                assertEquals(view.editor.getText(), "keep this draft");
                assertEquals(submissions, []);
                assertEquals(view.runningTasksComponent.isBusy, true);
                terminal.pressEnter();
                assertEquals(submissions, ["keep this draft"]);
            } finally {
                view.uiAPI.setBusy?.(false);
                focus.dispose();
                view.dispose();
                tui.stop();
            }
        });
    });
}
