import { test } from "node:test";
import { assertEquals, assertInstanceOf, assertStringIncludes } from "../../testing/assertions.ts";
import { Container, Editor, Image, Spacer, Text, type TUI, TuiMainScreen } from "@earendil-works/pi-tui";
import { RunWieldModelSelectorComponent } from "./model-selector.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { getSettingsManager } from "../../shared/settings.js";
import { AgyCliMcpSetupApprovalError } from "../../shared/session/backends/agy-cli/mcp-setup.ts";
import { getEditorTheme, initRunWieldTheme } from "../theme/theme.js";
import { createUiApi } from "./api.js";
import { SpinnerBlock, ToolExecutionGroupBlock } from "./blocks.js";
import { VirtualTerminal } from "./testing/virtual-terminal.js";
import { installUiApiOverrides } from "./ui-api-overrides.ts";

import { createTuiInteractionAdapter } from "./runtime-interaction-adapter.js";
import { createScriptedReviewBrowser } from "../review/review-test-fixture.ts";
import { getStoredPlanPath, savePlan } from "../../plan-store.js";
import { NO_OPEN_BROWSER_PORT } from "../../shared/browser-port.ts";

interface OverridesHarness {
    container: Container;
    editor: Editor;
    messageList: Container;
    validationPanel: Container;
    terminal: VirtualTerminal;
    tui: TUI;
    uiAPI: import("./types.js").UiAPI;
}

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

class CompatibleVirtualTerminal extends VirtualTerminal {
    override drainInput(): Promise<void> {
        return Promise.resolve();
    }

    override moveBy(lines: number, columns?: number): void {
        super.moveBy(lines, columns ?? 0);
    }

    override setProgress(active: boolean | number | null): void {
        super.setProgress(typeof active === "boolean" ? (active ? 1 : null) : active);
    }
}

function makeHarness(projectRoot = "/fixture/project"): OverridesHarness {
    initRunWieldTheme();
    const terminal = new CompatibleVirtualTerminal({ columns: 100, rows: 30 });
    const tui = new TuiMainScreen(terminal);
    const container = new Container();
    const messageList = new Container();
    const activeInteraction = new Container();
    const validationPanel = new Container();
    const editor = new Editor(tui, getEditorTheme());
    container.addChild(messageList);
    container.addChild(activeInteraction);
    container.addChild(editor);
    tui.addChild(container);
    const uiAPI = createUiApi(
        null,
        tui,
        messageList,
        new SpinnerBlock(),
        undefined,
        validationPanel,
        activeInteraction,
    );
    installUiApiOverrides({
        uiAPI,
        tui,
        editor,
        container,
        getProjectRoot: () => projectRoot,
        setActiveModel: () => {},
    });
    return { container, editor, messageList, validationPanel, terminal, tui, uiAPI };
}

test("installUiApiOverrides disables and enables real editor submission", () => {
    const harness = makeHarness();
    try {
        harness.editor.disableSubmit = false;
        harness.uiAPI.disableInput?.();
        assertEquals(harness.editor.disableSubmit, true);
        harness.uiAPI.enableInput?.();
        assertEquals(harness.editor.disableSubmit, false);
    } finally {
        harness.tui.stop();
    }
});

test("installUiApiOverrides blocks the editor for real prompts and restores its prior state", async () => {
    const harness = makeHarness();
    try {
        harness.editor.disableSubmit = false;
        const selectPromise = harness.uiAPI.promptSelect("Review again?", [
            { value: "yes", label: "Yes" },
            { value: "no", label: "No" },
        ]);
        assertEquals(harness.editor.disableSubmit, true);
        harness.uiAPI.abortActivePrompt?.();
        assertEquals(await selectPromise, null);
        assertEquals(harness.editor.disableSubmit, false);

        harness.editor.disableSubmit = true;
        const textPromise = harness.uiAPI.promptText("Feedback");
        harness.uiAPI.abortActivePrompt?.();
        assertEquals(await textPromise, null);
        assertEquals(harness.editor.disableSubmit, true);
    } finally {
        harness.tui.stop();
    }
});

test("hidden input ignores typing and restores editor focus after the operation", async () => {
    const harness = makeHarness();
    try {
        harness.editor.setText("Keep this draft");
        harness.tui.start();
        await harness.uiAPI.withHiddenInput!(async () => {
            assertEquals(harness.container.children.includes(harness.editor), false);
            harness.terminal.typeText("hidden typing");
            harness.terminal.pressEnter();
            await harness.terminal.flush();
            assertEquals(harness.editor.getText(), "Keep this draft");
        });
        harness.terminal.typeText(" restored");
        await harness.terminal.flush();
        assertEquals(harness.editor.getText(), "Keep this draft restored");
    } finally {
        harness.tui.stop();
    }
});

test("a closing review keeps input hidden while a follow-up prompt is active", async () => {
    const harness = makeHarness();
    let finishReview = () => {};
    try {
        harness.editor.setText("Keep this draft");
        harness.tui.start();
        const review = harness.uiAPI.withHiddenInput!(
            () =>
                new Promise<void>((resolve) => {
                    finishReview = resolve;
                }),
        );
        const prompt = harness.uiAPI.promptSelect("Retry review?", [{ value: "retry", label: "Retry" }]);
        finishReview();
        await review;
        assertEquals(harness.container.children.includes(harness.editor), false);
        harness.terminal.typeText("Retry");
        harness.terminal.pressEnter();
        assertEquals(await prompt, "retry");
        assertEquals(harness.container.children.includes(harness.editor), true);
        assertEquals(harness.editor.getText(), "Keep this draft");
    } finally {
        finishReview();
        harness.uiAPI.abortActivePrompt();
        harness.tui.stop();
    }
});

for (const type of ["plan_review", "code_review"] as const) {
    for (const approved of [true, false]) {
        test(`${type} hides the input and restores the draft after ${approved ? "approval" : "cancellation"}`, async () => {
            await withRuntimeCommandFixture("hidden-review-input-", async ({ projectRoot }) => {
                const harness = makeHarness(projectRoot);
                const controller = new AbortController();
                const scripted = createScriptedReviewBrowser("decision", { approved: true, approvalAction: "later" });
                const adapter = createTuiInteractionAdapter(harness.uiAPI, {
                    browser: approved ? scripted.browser : NO_OPEN_BROWSER_PORT,
                });
                const originalChildren = [...harness.container.children];
                let surfaceReady = false;
                try {
                    await savePlan(projectRoot, "feature", "# Feature\n\nDo the work.\n", {
                        classification: "PLANNED_CHANGE",
                        status: "draft",
                    });
                    harness.editor.setText("Keep this draft");
                    harness.uiAPI.updateValidationProgress?.({
                        kind: "workflow",
                        outcome: "running",
                        stage: "human_review",
                        checks: { ci: "passed", semanticReview: "passed", humanReview: "pending", merge: "pending" },
                    });
                    harness.uiAPI.updateValidationReport?.("engineer", {
                        agentName: "Engineer",
                        markdown: "Completed implementation",
                    });
                    assertStringIncludes(harness.validationPanel.render(120).join("\n"), "Completed implementation");
                    const response = await adapter.requestInteraction(
                        {
                            type,
                            prompt: "Review",
                            _meta: {
                                cwd: projectRoot,
                                executionCwd: projectRoot,
                                planName: "feature",
                                planPath: getStoredPlanPath(projectRoot, "feature"),
                                diffText: "diff --git a/a b/a\n",
                                onSurfaceReady: () => {
                                    surfaceReady = true;
                                    assertEquals(harness.container.children.includes(harness.editor), false);
                                    assertEquals(harness.editor.disableSubmit, true);
                                    assertEquals(harness.validationPanel.children.length === 0, type === "code_review");
                                    harness.uiAPI.updateValidationReport?.("reviewer", {
                                        agentName: "Reviewer",
                                        markdown: "Review results retained",
                                        approved: true,
                                    });
                                    assertEquals(harness.validationPanel.children.length === 0, type === "code_review");
                                    if (!approved) controller.abort();
                                },
                            },
                        },
                        controller.signal,
                    );
                    assertEquals(surfaceReady, true);
                    assertEquals(response.outcome, approved ? "accepted" : "canceled");
                    assertEquals(harness.container.children, originalChildren);
                    assertEquals(harness.editor.disableSubmit, false);
                    assertEquals(harness.editor.getText(), "Keep this draft");
                    const restoredPanel = harness.validationPanel.render(120).join("\n");
                    assertStringIncludes(restoredPanel, "Completed implementation");
                    assertStringIncludes(restoredPanel, "Review results retained");
                } finally {
                    controller.abort();
                    harness.tui.stop();
                }
            });
        });
    }
}

test("feedback prompt edits one row below a transcript taller than the terminal", async () => {
    const harness = makeHarness();
    try {
        for (let index = 0; index < 40; index++) {
            harness.messageList.addChild(new Text(`history row ${index}`, 0, 0));
        }
        harness.tui.start();
        harness.tui.requestRender();
        await new Promise((resolve) => setTimeout(resolve, 20));
        await harness.terminal.flush();

        harness.uiAPI.setBusy?.(true);
        const prompt = harness.uiAPI.promptText("Tell the Validation Repair Engineer what to try next.");
        assertEquals(harness.container.children.includes(harness.editor), false);
        await new Promise((resolve) => setTimeout(resolve, 20));
        await harness.terminal.flush();
        harness.terminal.typeText("please merge main");
        await new Promise((resolve) => setTimeout(resolve, 20));
        await harness.terminal.flush();

        const viewport = harness.terminal.getScreenText();
        assertStringIncludes(viewport, "please merge main");
        assertEquals(viewport.match(/history row 39/g)?.length ?? 0, 1);

        harness.uiAPI.abortActivePrompt?.();
        assertEquals(await prompt, null);
        assertEquals(harness.container.children.includes(harness.editor), true);
        harness.uiAPI.setBusy?.(false);
    } finally {
        harness.tui.stop();
    }
});

test("installUiApiOverrides appends real images unless output is suppressed", () => {
    const harness = makeHarness();
    try {
        harness.uiAPI.appendImage?.(ONE_PIXEL_PNG, "image/png");
        assertEquals(harness.messageList.children.length, 2);
        assertInstanceOf(harness.messageList.children[0], Image);
        assertInstanceOf(harness.messageList.children[1], Spacer);

        harness.uiAPI.suppressOutput?.();
        harness.uiAPI.appendImage?.(ONE_PIXEL_PNG, "image/png");
        assertEquals(harness.messageList.children.length, 2);
    } finally {
        harness.tui.stop();
    }
});

test("installUiApiOverrides closes a visible tool group before appending an image", () => {
    const harness = makeHarness();
    try {
        harness.uiAPI.startToolExecution?.("tool-1", "read", "read before.png");
        harness.uiAPI.appendImage?.(ONE_PIXEL_PNG, "image/png");
        harness.uiAPI.startToolExecution?.("tool-2", "bash", "$ echo after");

        const groups = harness.messageList.children.filter((child) => child instanceof ToolExecutionGroupBlock);
        assertEquals(groups.length, 2);
        assertInstanceOf(harness.messageList.children[2], Image);
        assertEquals(
            groups.map((group) => group.children.length),
            [1, 1],
        );
    } finally {
        harness.tui.stop();
    }
});

test("installUiApiOverrides selects a configured fixture model through the real selector", async () => {
    await withRuntimeCommandFixture("ui-api-model-selector-", async ({ projectRoot }) => {
        const selectedModels: Array<{ model: string; provider?: string }> = [];
        const harness = makeHarness(projectRoot);
        installUiApiOverrides({
            ...harness,
            getProjectRoot: () => projectRoot,
            setActiveModel: (model: string, provider?: string) => {
                selectedModels.push({ model, provider });
                getSettingsManager(projectRoot).setDefaultModelAndProvider(provider || "", model);
                return { status: "active" };
            },
            getActiveModelState: () => ({
                model: "fixture-model",
                provider: "runtime-command-fixture",
            }),
        });
        try {
            const selectionPromise = harness.uiAPI.showModelSelector();
            let selector = harness.container.children.find((child) => child instanceof RunWieldModelSelectorComponent);
            for (let attempt = 0; !selector && attempt < 50; attempt++) {
                await new Promise((resolve) => setTimeout(resolve, 0));
                selector = harness.container.children.find((child) => child instanceof RunWieldModelSelectorComponent);
            }
            assertInstanceOf(selector, RunWieldModelSelectorComponent);
            selector.handleInput("\r");
            await selectionPromise;

            assertEquals(selectedModels, [
                {
                    model: "fixture-model",
                    provider: "runtime-command-fixture",
                },
            ]);
            assertEquals(getSettingsManager(projectRoot).getDefaultModel(), "fixture-model");
            assertEquals(getSettingsManager(projectRoot).getDefaultProvider(), "runtime-command-fixture");
            assertEquals(harness.container.children.includes(harness.editor), true);
            assertEquals(harness.editor.focused, true);
        } finally {
            harness.tui.stop();
        }
    });
});

test("installUiApiOverrides sends Claude selections through the runtime callback", async () => {
    await withRuntimeCommandFixture("ui-api-model-selector-claude-", async ({ projectRoot }) => {
        const selectedModels: Array<{ model: string; provider?: string }> = [];
        const harness = makeHarness(projectRoot);
        installUiApiOverrides({
            ...harness,
            getProjectRoot: () => projectRoot,
            setActiveModel: (model: string, provider?: string) => {
                selectedModels.push({ model, provider });
                return { status: "active" };
            },
        });
        try {
            const selectionPromise = harness.uiAPI.showModelSelector("claude-cli/sonnet");
            let selector = harness.container.children.find((child) => child instanceof RunWieldModelSelectorComponent);
            for (let attempt = 0; !selector && attempt < 50; attempt++) {
                await new Promise((resolve) => setTimeout(resolve, 0));
                selector = harness.container.children.find((child) => child instanceof RunWieldModelSelectorComponent);
            }
            assertInstanceOf(selector, RunWieldModelSelectorComponent);
            selector.handleInput("\r");
            await selectionPromise;
            assertEquals(selectedModels, [{ model: "sonnet", provider: "claude-cli" }]);
            assertEquals(harness.container.children.includes(harness.editor), true);
            assertEquals(harness.editor.focused, true);
        } finally {
            harness.tui.stop();
        }
    });
});

test("installUiApiOverrides reports Agy setup failures from model selection without rejecting", async () => {
    await withRuntimeCommandFixture("ui-api-model-selector-agy-setup-", async ({ projectRoot }) => {
        const harness = makeHarness(projectRoot);
        installUiApiOverrides({
            ...harness,
            getProjectRoot: () => projectRoot,
            setActiveModel: () => {
                throw new AgyCliMcpSetupApprovalError(
                    "Antigravity MCP setup needs approval. Run wld mcp agy-cli --setup.",
                );
            },
        });
        const messages: string[] = [];
        const appendSystemMessage = harness.uiAPI.appendSystemMessage;
        harness.uiAPI.appendSystemMessage = (message, isError, header, style) => {
            messages.push(message);
            appendSystemMessage(message, isError, header, style);
        };
        try {
            const selectionPromise = harness.uiAPI.showModelSelector("agy-cli/gemini-3.8-flash");
            let selector = harness.container.children.find((child) => child instanceof RunWieldModelSelectorComponent);
            for (let attempt = 0; !selector && attempt < 50; attempt++) {
                await new Promise((resolve) => setTimeout(resolve, 0));
                selector = harness.container.children.find((child) => child instanceof RunWieldModelSelectorComponent);
            }
            assertInstanceOf(selector, RunWieldModelSelectorComponent);
            selector.handleInput("\r");
            assertEquals(await selectionPromise, { selected: false });
            harness.tui.requestRender();
            assertStringIncludes(messages.join("\n"), "wld mcp agy-cli --setup");
            assertEquals(messages.join("\n").includes("at async"), false);
            assertEquals(harness.container.children.includes(harness.editor), true);
        } finally {
            harness.tui.stop();
        }
    });
});

test("installUiApiOverrides restores a missing editor after the real selector is cancelled", async () => {
    await withRuntimeCommandFixture("ui-api-model-cancel-", async ({ projectRoot }) => {
        const harness = makeHarness(projectRoot);
        harness.container.removeChild(harness.editor);
        try {
            const selectionPromise = harness.uiAPI.showModelSelector();
            let selector = harness.container.children.find((child) => child instanceof RunWieldModelSelectorComponent);
            for (let attempt = 0; !selector && attempt < 50; attempt++) {
                await new Promise((resolve) => setTimeout(resolve, 0));
                selector = harness.container.children.find((child) => child instanceof RunWieldModelSelectorComponent);
            }
            assertInstanceOf(selector, RunWieldModelSelectorComponent);
            selector.handleInput("\x1b");
            await selectionPromise;
            assertEquals(harness.container.children.includes(harness.editor), true);
        } finally {
            harness.tui.stop();
        }
    });
});
