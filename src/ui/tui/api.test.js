import { assertEquals, assertInstanceOf, assertNotEquals } from "@std/assert";
import { Spacer } from "@earendil-works/pi-tui";
import { createFooterOnlyUiApi, createSilentUiApi, createUiApi } from "./api.js";
import {
    KeyboardHelpBlock,
    ManagedSyncStatusBlock,
    PromptSelectBlock,
    SpinnerBlock,
    SystemMessageBlock,
    ThinkingBlock,
    ToolExecutionBlock,
    ToolExecutionGroupBlock,
    UserPromptBlock,
    ValidationHandoffBlock,
} from "./blocks.js";
import stripAnsi from "strip-ansi";
import { initRunWieldTheme } from "../theme/theme.js";

initRunWieldTheme();

/**
 * @returns {{ children: any[], addChild: (child: any) => void, removeChild: (child: any) => void, clear: () => void }}
 */
function makeContainer() {
    return {
        children: /** @type {any[]} */ ([]),
        /** @param {any} child */
        addChild(child) {
            this.children.push(child);
        },
        /** @param {any} child */
        removeChild(child) {
            const index = this.children.indexOf(child);
            if (index >= 0) this.children.splice(index, 1);
        },
        clear() {
            this.children = [];
        },
    };
}

/**
 * @returns {{ tui: any, messageList: ReturnType<typeof makeContainer>, renders: () => number, focus: () => any }}
 */
function makeTuiHarness() {
    let renderCount = 0;
    let focused = /** @type {any} */ (null);
    const messageList = makeContainer();
    const tui = /** @type {any} */ ({
        focusedComponent: null,
        requestRender() {
            renderCount++;
        },
        /** @param {any} block */
        setFocus(block) {
            if (this.focusedComponent && "focused" in this.focusedComponent) {
                this.focusedComponent.focused = false;
            }
            focused = block;
            this.focusedComponent = block;
            if (block && "focused" in block) {
                block.focused = true;
            }
        },
    });
    return { tui, messageList, renders: () => renderCount, focus: () => focused };
}

Deno.test("createSilentUiApi implements the full no-op surface", async () => {
    const ui = /** @type {any} */ (createSilentUiApi());
    ui.appendThinkingStart().appendDelta("ignored");
    ui.appendThinkingStart().end();
    ui.appendUserMessage("ignored");
    ui.appendAgentMessageStart("Agent").appendText("ignored");
    ui.appendImage("abc", "image/png");
    ui.appendQueuedMessage("queued-1", "ignored");
    ui.removeQueuedMessage("queued-1");
    ui.appendSystemMessage("ignored");
    const tool = ui.startToolExecution("1", "bash", "$ echo hi");
    tool.setOutput("ignored");
    tool.endExecution(false, 1);
    ui.toggleToolOutputsExpanded();
    ui.showKeyboardHelp({ title: "Keyboard shortcuts", items: [{ key: "?", description: "show help" }] });
    ui.hideKeyboardHelp();
    ui.requestRender();
    ui.advanceSpinner();
    ui.setBusy(true);
    ui.setRunningTasks([{ task: 1, assignee: "Tester", description: "Check" }]);
    ui.clearMessages();
    ui.showModelSelector();
    ui.disableInput();
    ui.enableInput();
    ui.suppressOutput();
    ui.abortActivePrompt();

    assertEquals(ui.getActiveToolBlock("1"), undefined);
    assertEquals(await ui.promptSelect("Pick", []), null);
    assertEquals(await ui.promptText("Text"), null);
    assertEquals(ui.isOutputSuppressed(), true);
});

Deno.test("createFooterOnlyUiApi suppresses message bodies but forwards footer renders", () => {
    let renders = 0;
    const ui = createFooterOnlyUiApi({ requestRender: () => renders++ });

    ui.appendSystemMessage("hidden");
    ui.appendAgentMessageStart("Agent").appendText("hidden");
    ui.requestRender();

    assertEquals(ui.isOutputSuppressed?.(), false);
    assertEquals(renders, 1);
});

Deno.test("ThinkingBlock hides markdown comments and unwraps emphasis markers", () => {
    const block = new ThinkingBlock();
    block.appendText(
        "**Planning page layout and token guard**\n\n<!-- -->\n\n**Inspecting server for static theme assets**",
    );

    const rendered = block.render(120).map((line) => stripAnsi(line).trimEnd()).join("\n").trimEnd();

    assertEquals(rendered, "Planning page layout and token guard\n\nInspecting server for static theme assets");
});

Deno.test("thinking ends with one blank row before the next thinking block or tool call", () => {
    const { tui, messageList } = makeTuiHarness();
    const ui = createUiApi(null, tui, messageList, new SpinnerBlock());
    if (!ui.appendThinkingStart || !ui.startToolExecution) throw new Error("TUI API is incomplete.");
    const first = ui.appendThinkingStart();
    first.appendDelta("First thought.\n\n");
    first.end();
    const second = ui.appendThinkingStart();
    second.appendDelta("Second thought.\n\n");
    second.end();
    ui.startToolExecution("tool-1", "bash", "$ echo done");

    const lines = messageList.children.flatMap((child) => child.render(80)).map((line) => stripAnsi(line).trimEnd());
    const firstLine = lines.findIndex((line) => line.includes("First thought."));
    const secondLine = lines.findIndex((line) => line.includes("Second thought."));
    const toolLine = lines.findIndex((line) => line.includes("echo done"));
    assertEquals(secondLine - firstLine, 2);
    assertEquals(toolLine - secondLine, 2);
});

Deno.test("createUiApi appends visible blocks, merges compatible system messages, and controls tools", () => {
    const { tui, messageList, renders } = makeTuiHarness();
    const spinner = new SpinnerBlock();
    const ui = /** @type {any} */ (createUiApi(null, tui, messageList, spinner));

    const thinking = ui.appendThinkingStart();
    thinking.appendDelta("thinking");
    thinking.end();
    ui.appendUserMessage("hello");
    const agent = ui.appendAgentMessageStart("Tester");
    agent.appendText("hi");
    ui.appendSystemMessage("one");
    ui.appendSystemMessage("two");
    messageList.addChild(new Spacer(1));
    ui.appendSystemMessage("three");
    assertEquals(messageList.children.filter((child) => child instanceof SystemMessageBlock).length, 1);
    assertEquals(messageList.children.at(-1) instanceof Spacer, true);
    assertEquals(messageList.children.at(-2) instanceof SystemMessageBlock, true);
    let trailingSpacers = 0;
    for (const child of messageList.children.toReversed()) {
        if (!(child instanceof Spacer)) break;
        trailingSpacers += 1;
    }
    assertEquals(trailingSpacers, 1);

    const tool = ui.startToolExecution("tool-1", "bash", "$ echo hi");
    assertEquals(ui.getActiveToolBlock("tool-1"), tool);
    tool.setOutput("output");
    tool.endExecution(false, 1);
    assertEquals(ui.getActiveToolBlock("tool-1"), undefined);
    ui.toggleToolOutputsExpanded();
    ui.toggleToolOutputsExpanded();
    ui.advanceSpinner();
    ui.setRunningTasks([{ task: 1, assignee: "Tester", description: "Do work" }]);

    assertEquals(messageList.children.some((/** @type {any} */ child) => child instanceof Spacer), true);
    assertEquals(messageList.children.length > 0, true);
    assertEquals(renders() > 0, true);

    ui.clearMessages();
    assertEquals(messageList.children, []);
});

Deno.test("createUiApi opens local commands by default and falls back to toggling the latest block", () => {
    const { tui, messageList } = makeTuiHarness();
    const ui = /** @type {any} */ (createUiApi(null, tui, messageList, new SpinnerBlock()));

    const persisted = ui.startToolExecution("bang-1", "bash", "! printf persisted");
    persisted.setOutput(Array.from({ length: 8 }, (_, index) => `persisted ${index}`).join("\n"));
    const ephemeral = ui.startToolExecution("bang-2", "bash", "!! printf ephemeral");
    ephemeral.setOutput(Array.from({ length: 8 }, (_, index) => `ephemeral ${index}`).join("\n"));

    const rendered = stripAnsi(
        messageList.children.flatMap((/** @type {any} */ child) => child.render?.(100) ?? []).join("\n"),
    );
    assertEquals(rendered.includes("persisted 7"), true);
    assertEquals(rendered.includes("ephemeral 7"), true);

    ui.toggleToolOutputsExpanded();
    const collapsed = stripAnsi(
        messageList.children.flatMap((/** @type {any} */ child) => child.render?.(100) ?? []).join("\n"),
    );
    assertEquals(collapsed.includes("persisted 7"), true);
    assertEquals(collapsed.includes("ephemeral 7"), false);
});

Deno.test("createUiApi does not hide duplicate tool-start events", () => {
    const { tui, messageList } = makeTuiHarness();
    const ui = /** @type {any} */ (createUiApi(null, tui, messageList, new SpinnerBlock()));

    const first = ui.startToolExecution("tool-1", "code_search", "code_search createAgentJobHandler");
    const second = ui.startToolExecution("tool-1", "code_search", "code_search createAgentJobHandler");

    assertEquals(second === first, false);
    const groups = messageList.children.filter((/** @type {any} */ child) => child instanceof ToolExecutionGroupBlock);
    assertEquals(groups.length, 1);
    assertEquals(groups[0].children.length, 2);

    first.endExecution(false, 1);
    second.endExecution(false, 1);
});

Deno.test("createUiApi keeps workflow tools as single custom blocks", () => {
    const { tui, messageList } = makeTuiHarness();
    const ui = /** @type {any} */ (createUiApi(null, tui, messageList, new SpinnerBlock()));

    ui.startToolExecution("tool-1", "bash", "$ echo before");
    ui.startToolExecution("plan-1", "plan_written", "plan_written docs/plans/example.md");
    ui.startToolExecution("tool-2", "read", "read README.md");
    const diff = ui.startToolExecution("diff-1", "review_diff", "review_diff README.md");
    diff.endExecution(false, 1);
    ui.startToolExecution("triage-1", "triage_report", "triage_report FEATURE");

    const groups = messageList.children.filter((/** @type {any} */ child) => child instanceof ToolExecutionGroupBlock);
    assertEquals(groups.length, 2);
    assertEquals(groups[0].children.map((/** @type {any} */ child) => child.toolName), ["bash"]);
    assertEquals(groups[1].children.map((/** @type {any} */ child) => child.toolName), ["read", "review_diff"]);
    assertEquals(groups[1].expanded, false);
    assertEquals(
        messageList.children.filter((/** @type {any} */ child) => child instanceof ToolExecutionBlock).map(
            (/** @type {any} */ child) => child.toolName,
        ),
        ["plan_written", "triage_report"],
    );
});

Deno.test("createUiApi groups contiguous tool calls and closes the group at conversation boundaries", () => {
    const { tui, messageList } = makeTuiHarness();
    const ui = /** @type {any} */ (createUiApi(null, tui, messageList, new SpinnerBlock()));

    ui.startToolExecution("tool-1", "bash", "$ false");
    ui.startToolExecution("tool-2", "read", "read README.md");
    ui.appendAgentMessageStart("Agent").appendText("done");
    ui.startToolExecution("tool-3", "code_search", "code_search ToolExecution");

    const groups = messageList.children.filter((/** @type {any} */ child) => child instanceof ToolExecutionGroupBlock);
    assertEquals(groups.length, 2);
    assertEquals(groups[0].children.length, 2);
    assertEquals(groups[1].children.length, 1);
    assertEquals(messageList.children.filter((/** @type {any} */ child) => child instanceof Spacer).length, 3);
});

Deno.test("createUiApi toggles only visible tool groups", () => {
    const { tui, messageList } = makeTuiHarness();
    /** @type {Array<ToolExecutionGroupBlock | ToolExecutionBlock>} */
    let visibleToolBlocks = [];
    const ui = /** @type {any} */ (
        createUiApi(
            null,
            tui,
            messageList,
            new SpinnerBlock(),
            undefined,
            undefined,
            undefined,
            undefined,
            () => visibleToolBlocks,
        )
    );

    const completed = ui.startToolExecution("tool-1", "bash", "$ echo done");
    completed.setOutput("output");
    completed.endExecution(false, 1);
    ui.appendAgentMessageStart("Agent").appendText("boundary");
    const active = ui.startToolExecution("tool-2", "read", "read file");

    const groups = messageList.children.filter((/** @type {any} */ child) => child instanceof ToolExecutionGroupBlock);
    visibleToolBlocks = [groups[1]];
    ui.toggleToolOutputsExpanded();
    assertEquals(groups.map((/** @type {any} */ group) => group.expanded), [false, true]);

    ui.appendSystemMessage("boundary");
    const inherited = ui.startToolExecution("tool-3", "grep", "grep pattern");
    const newGroup = messageList.children.filter((/** @type {any} */ child) => child instanceof ToolExecutionGroupBlock)
        .at(-1);
    if (!newGroup) throw new Error("Expected a tool execution group");
    assertEquals(newGroup.expanded, false);

    active.endExecution(false, 1);
    inherited.endExecution(false, 1);
    visibleToolBlocks = [groups[1], newGroup];
    ui.toggleToolOutputsExpanded();
    assertEquals(
        messageList.children.filter((/** @type {any} */ child) => child instanceof ToolExecutionGroupBlock).map(
            (/** @type {any} */ group) => group.expanded,
        ),
        [false, false, false],
    );
});

Deno.test("createUiApi keeps an active tool group while pruning bounded history", () => {
    const { tui, messageList } = makeTuiHarness();
    const ui = /** @type {any} */ (createUiApi(null, tui, messageList, new SpinnerBlock()));

    const active = ui.startToolExecution("tool-active", "bash", "$ sleep 10");
    for (let index = 0; index < 700; index++) {
        ui.appendUserMessage(`message ${index}`);
    }

    assertEquals(messageList.children.length <= 1000, true);
    assertEquals(
        messageList.children.some((/** @type {any} */ child) => child instanceof ToolExecutionGroupBlock),
        true,
    );
    assertEquals(ui.getActiveToolBlock("tool-active"), active);
    active.endExecution(false, 1);
});

Deno.test("createUiApi bounds completed children in a long contiguous tool group", () => {
    const { tui, messageList } = makeTuiHarness();
    const ui = /** @type {any} */ (createUiApi(null, tui, messageList, new SpinnerBlock()));
    /** @type {Array<import('./types.js').ToolExecutionBlockApi>} */
    const tools = [];

    for (let index = 0; index < 1005; index++) {
        tools.push(ui.startToolExecution(`tool-${index}`, "bash", `$ echo ${index}`));
    }
    for (const tool of tools) tool.endExecution(false, 1);

    const group = messageList.children.find((/** @type {any} */ child) => child instanceof ToolExecutionGroupBlock);
    if (!group) throw new Error("Expected a tool execution group");
    assertEquals(group.children.length, 1000);
    assertEquals(group.children[0].headerText, "$ echo 5");
});

Deno.test("createUiApi releases old message blocks during long-running TUI sessions", () => {
    const { tui, messageList } = makeTuiHarness();
    const ui = /** @type {any} */ (createUiApi(null, tui, messageList, new SpinnerBlock()));

    for (let index = 0; index < 700; index++) {
        ui.appendUserMessage(`message ${index}`);
    }

    assertEquals(messageList.children.length <= 1000, true);
    assertEquals(messageList.children[0] instanceof UserPromptBlock, true);
});

Deno.test("createUiApi toggles one transient keyboard-help block outside the message list", () => {
    const { tui, messageList, renders } = makeTuiHarness();
    const inputAccessory = makeContainer();
    const ui = /** @type {any} */ (createUiApi(null, tui, messageList, new SpinnerBlock(), inputAccessory));
    const help = { title: "Keyboard shortcuts", items: [{ key: "?", description: "show help" }] };

    ui.showKeyboardHelp(help);
    assertEquals(inputAccessory.children.length, 2);
    assertEquals(inputAccessory.children[0] instanceof KeyboardHelpBlock, true);
    assertEquals(messageList.children.length, 0);

    ui.showKeyboardHelp(help);
    assertEquals(inputAccessory.children.length, 0);

    inputAccessory.addChild("unrelated");
    ui.showKeyboardHelp(help);
    assertEquals(inputAccessory.children.length, 3);
    ui.hideKeyboardHelp();
    assertEquals(inputAccessory.children, ["unrelated"]);
    assertEquals(renders() > 0, true);
});

Deno.test("createUiApi does not flash a managed sync block for benign syncing", () => {
    const { tui, messageList, renders } = makeTuiHarness();
    const inputAccessory = makeContainer();
    const ui = /** @type {any} */ (createUiApi(null, tui, messageList, new SpinnerBlock(), inputAccessory));

    ui.setManagedSyncStatus({
        status: "syncing",
        localGeneration: 0,
        latestGeneration: 1,
    });
    ui.setManagedSyncStatus({
        status: "current",
        localGeneration: 1,
        latestGeneration: 1,
    });

    assertEquals(inputAccessory.children, []);
    assertEquals(renders(), 0);

    ui.setManagedSyncStatus({
        status: "blocked",
        localGeneration: 0,
        latestGeneration: 1,
        message: "Needs recovery",
    });

    assertEquals(
        inputAccessory.children.some((/** @type {any} */ child) => child instanceof ManagedSyncStatusBlock),
        true,
    );
});

Deno.test("createUiApi does not repaint for repeated visible managed sync state", () => {
    const { tui, messageList, renders } = makeTuiHarness();
    const inputAccessory = makeContainer();
    const ui = /** @type {any} */ (createUiApi(null, tui, messageList, new SpinnerBlock(), inputAccessory));

    ui.setManagedSyncStatus({
        status: "active_elsewhere",
        localGeneration: 1,
        latestGeneration: 2,
        owningSurfaceKind: "workspace",
    });
    assertEquals(renders(), 1);

    ui.setManagedSyncStatus({
        status: "active_elsewhere",
        localGeneration: 1,
        latestGeneration: 2,
        owningSurfaceKind: "workspace",
    });

    assertEquals(renders(), 1);
});

Deno.test("createUiApi clearMessages removes input accessory resources", () => {
    const { tui, messageList } = makeTuiHarness();
    const inputAccessory = makeContainer();
    const ui = /** @type {any} */ (createUiApi(null, tui, messageList, new SpinnerBlock(), inputAccessory));

    ui.showKeyboardHelp({ title: "Keyboard shortcuts", items: [{ key: "?", description: "show help" }] });
    ui.setManagedSyncStatus({ status: "behind", owningSurfaceKind: "workspace", owningSurfaceLabel: "Workspace" });
    assertEquals(inputAccessory.children.some((/** @type {any} */ child) => child instanceof KeyboardHelpBlock), true);
    assertEquals(
        inputAccessory.children.some((/** @type {any} */ child) => child instanceof ManagedSyncStatusBlock),
        true,
    );

    ui.clearMessages();

    assertEquals(inputAccessory.children, []);
});

Deno.test("createUiApi adds and removes exact queued-message blocks by runtime id", () => {
    const { tui, messageList } = makeTuiHarness();
    const queuedInput = makeContainer();
    const ui = /** @type {any} */ (
        createUiApi(null, tui, messageList, new SpinnerBlock(), undefined, undefined, undefined, queuedInput)
    );

    ui.appendQueuedMessage("queued-1", "first");
    ui.appendQueuedMessage("queued-1", "duplicate ignored");
    ui.appendQueuedMessage("queued-2", "second");

    assertEquals(messageList.children.length, 0);
    assertEquals(queuedInput.children.length, 4);
    ui.removeQueuedMessage("queued-2");
    assertEquals(queuedInput.children.length, 2);
    assertEquals(queuedInput.children[0] instanceof SystemMessageBlock, true);
    ui.removeQueuedMessage("queued-1");
    assertEquals(queuedInput.children, []);
});

Deno.test("createUiApi renders live elapsed tool time immediately and stops after completion", async () => {
    const harness = makeTuiHarness();
    const timedUi = /** @type {any} */ (createUiApi(null, harness.tui, harness.messageList, new SpinnerBlock()));
    const tool = /** @type {import('./blocks.js').ToolExecutionBlock} */ (
        timedUi.startToolExecution("tool-timer", "bash", "$ sleep 1")
    );

    const initialPlain = tool.render(100).map((line) => stripAnsi(line)).join("\n");
    assertEquals(initialPlain.includes("Elapsed time: 0.0s"), true);
    const initialRenders = harness.renders();

    await new Promise((resolve) => setTimeout(resolve, 250));

    const plain = tool.render(100).map((line) => stripAnsi(line)).join("\n");
    assertEquals(plain.includes("Elapsed time:"), true);
    assertEquals(harness.renders() > initialRenders, true);

    const beforeEndRenders = harness.renders();
    tool.endExecution(false, 700);
    const afterEndRenders = harness.renders();
    await new Promise((resolve) => setTimeout(resolve, 250));

    const endedPlain = tool.render(100).map((line) => stripAnsi(line)).join("\n");
    assertEquals(endedPlain.includes("Elapsed time:"), false);
    assertEquals(endedPlain.includes("Took 0.7s"), true);
    assertEquals(afterEndRenders, beforeEndRenders + 1);
    assertEquals(harness.renders(), afterEndRenders);
});

Deno.test("createUiApi keeps semantic status messages independent from active tool output", () => {
    const { tui, messageList } = makeTuiHarness();
    const ui = /** @type {any} */ (createUiApi(null, tui, messageList, new SpinnerBlock()));

    const tool = ui.startToolExecution("plan-tool", "plan_written", "plan_written docs/plans/example.md");
    ui.appendSystemMessage("[RunWield] Plan name: docs/plans/example.md");
    ui.appendSystemMessage("[RunWield] Opening plan review UI for: example");
    ui.appendSystemMessage("[RunWield] Review server stderr:\nserver warning");
    ui.appendSystemMessage("[RunWield] Waiting for user decision...\n");

    assertEquals(messageList.children.length, 4);
    assertEquals(tool.bodyText, "");

    tool.endExecution(false, 1);
    ui.appendSystemMessage("after completion", false, "RunWield");

    assertEquals(messageList.children.length, 4);
    assertEquals(messageList.children[2] instanceof SystemMessageBlock, true);
});

Deno.test("createUiApi leaves a long-open Plan review idle and resumes tool updates after a decision", async () => {
    const { tui, messageList, renders } = makeTuiHarness();
    const spinner = new SpinnerBlock();
    const ui = createUiApi(null, tui, messageList, spinner);
    try {
        ui.setBusy?.(true);
        const tool = ui.startToolExecution?.("review", "plan_written", "Plan Written");
        assertInstanceOf(tool, ToolExecutionBlock);
        // Follow the browser review adapter: the tool remains pending while busy is cleared.
        ui.setBusy?.(false);
        tool.startTime -= 8 * 60 * 60 * 1000;
        const waitingRenders = renders();
        await new Promise((resolve) => setTimeout(resolve, 250));
        assertEquals(renders(), waitingRenders);
        assertEquals(ui.getActiveToolBlock?.("review"), tool);

        ui.setBusy?.(true);
        // Count tool repaints independently of spinner animation.
        spinner.setBusy(false);
        const resumedRenders = renders();
        await new Promise((resolve) => setTimeout(resolve, 250));
        assertEquals(renders() > resumedRenders, true);
        assertEquals(stripAnsi(tool.render(100).join("\n")).includes("Elapsed time: 28800."), true);

        tool.endExecution(false, 28_800_500);
        ui.setBusy?.(false);
        const completedRenders = renders();
        await new Promise((resolve) => setTimeout(resolve, 250));
        assertEquals(renders(), completedRenders);
        assertEquals(ui.getActiveToolBlock?.("review"), undefined);
        assertEquals(stripAnsi(tool.render(100).join("\n")).includes("Took 28800.5s"), true);
    } finally {
        ui.dispose?.();
    }
});

Deno.test("createUiApi pauses tool timers for terminal prompts, including tools started during the wait", async () => {
    const { tui, messageList, renders, focus } = makeTuiHarness();
    const spinner = new SpinnerBlock();
    const ui = createUiApi(null, tui, messageList, spinner);
    try {
        ui.setBusy?.(true);
        const tool = ui.startToolExecution?.("review", "plan_written", "Plan Written");
        assertInstanceOf(tool, ToolExecutionBlock);
        const prompt = ui.promptText("Review feedback");
        const secondTool = ui.startToolExecution?.("other", "bash", "Other active work");
        assertInstanceOf(secondTool, ToolExecutionBlock);
        const waitingRenders = renders();
        await new Promise((resolve) => setTimeout(resolve, 250));
        assertEquals(renders(), waitingRenders);
        tool.endExecution(false, 100);
        focus().input.onSubmit("Revise the Plan");
        assertEquals(await prompt, "Revise the Plan");
        spinner.setBusy(false);
        const resumedRenders = renders();
        await new Promise((resolve) => setTimeout(resolve, 250));
        assertEquals(renders() > resumedRenders, true);
        assertEquals(ui.getActiveToolBlock?.("review"), undefined);
        assertEquals(ui.getActiveToolBlock?.("other"), secondTool);
    } finally {
        ui.dispose?.();
    }
});

Deno.test("createUiApi setBusy animates while Runtime remains busy and stops when idle", async () => {
    const { tui, messageList, renders } = makeTuiHarness();
    const spinner = new SpinnerBlock();
    const ui = /** @type {any} */ (createUiApi(null, tui, messageList, spinner));

    ui.setBusy(true);
    assertEquals(spinner.isBusy, true);
    const busyFrame = spinner.frame;
    const busyRenderCount = renders();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assertNotEquals(spinner.frame, busyFrame);
    assertNotEquals(renders(), busyRenderCount);

    ui.setBusy(false);
    assertEquals(spinner.isBusy, false);
    const stoppedFrame = spinner.frame;
    const stoppedRenderCount = renders();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assertEquals(spinner.frame, stoppedFrame);
    assertEquals(renders(), stoppedRenderCount);
});

Deno.test("createUiApi suppresses focused cursor while busy animation repaints", () => {
    const { tui, messageList } = makeTuiHarness();
    const spinner = new SpinnerBlock();
    const ui = /** @type {any} */ (createUiApi(null, tui, messageList, spinner));
    const editor = { focused: false, invalidate() {}, render: () => [] };

    tui.setFocus(editor);
    assertEquals(editor.focused, true);

    ui.setBusy(true);
    assertEquals(tui.focusedComponent, editor);
    assertEquals(editor.focused, false);

    ui.setBusy(false);
    assertEquals(tui.focusedComponent, editor);
    assertEquals(editor.focused, true);
});

Deno.test("createUiApi pauses the busy animation while waiting for prompt input", async () => {
    const { tui, messageList, focus } = makeTuiHarness();
    const spinner = new SpinnerBlock();
    const ui = /** @type {any} */ (createUiApi(null, tui, messageList, spinner));

    ui.setBusy(true);
    assertEquals(spinner.isBusy, true);

    const prompt = ui.promptText("What should the Engineer try next?");
    assertEquals(spinner.isBusy, false);
    focus().input.onSubmit("Merge main first.");

    assertEquals(await prompt, "Merge main first.");
    assertEquals(spinner.isBusy, true);
    ui.setBusy(false);
});

Deno.test("createUiApi renders validation panel separately from active prompt placement", async () => {
    const { tui, messageList, focus } = makeTuiHarness();
    const validationPanelContainer = makeContainer();
    const activeInteractionContainer = makeContainer();
    const ui = /** @type {any} */ (
        createUiApi(
            null,
            tui,
            messageList,
            new SpinnerBlock(),
            undefined,
            validationPanelContainer,
            activeInteractionContainer,
        )
    );

    ui.updateValidationProgress({
        kind: "mechanical",
        outcome: "running",
        stage: "ci",
        checks: { ci: "running", semanticReview: "skipped", humanReview: "skipped", merge: "skipped" },
    });
    const promptPromise = ui.promptSelect("Resolve?", [{ value: "yes", label: "Yes" }]);

    assertEquals(validationPanelContainer.children[0] instanceof ValidationHandoffBlock, true);
    assertEquals(validationPanelContainer.children[1] instanceof Spacer, true);
    assertEquals(activeInteractionContainer.children[0] instanceof PromptSelectBlock, true);
    assertEquals(messageList.children, []);

    focus().list.onSelect({ value: "yes" });
    assertEquals(await promptPromise, "yes");
    assertEquals(activeInteractionContainer.children, []);
    assertEquals(messageList.children[0] instanceof PromptSelectBlock, true);
    assertEquals(validationPanelContainer.children[0] instanceof ValidationHandoffBlock, true);
});

Deno.test("createUiApi marks stale reviewer feedback by report order instead of wall clock", () => {
    const { tui, messageList } = makeTuiHarness();
    const validationPanelContainer = makeContainer();
    const ui = /** @type {any} */ (
        createUiApi(null, tui, messageList, new SpinnerBlock(), undefined, validationPanelContainer)
    );
    const originalNow = Date.now;
    Date.now = () => 1000;
    try {
        ui.updateValidationProgress({
            kind: "workflow",
            outcome: "running",
            stage: "semantic_review",
            cycle: 1,
            maxCycles: 3,
            totalCycle: 1,
            checks: { ci: "passed", semanticReview: "failed", humanReview: "pending", merge: "pending" },
        });
        ui.updateValidationReport("reviewer", { agentName: "Reviewer", markdown: "needs changes", approved: false });
        ui.updateValidationReport("engineer", { agentName: "Engineer", markdown: "addressed feedback" });

        const plain = stripAnsi(validationPanelContainer.children[0].render(160).join("\n"));
        assertEquals(plain.includes("feedback addressed; rechecking"), true);
    } finally {
        Date.now = originalNow;
    }
});

Deno.test("createUiApi promptSelect resolves selection, cancellation, and selection-change hook", async () => {
    const { tui, messageList, focus } = makeTuiHarness();
    const ui = /** @type {any} */ (createUiApi(null, tui, messageList, new SpinnerBlock()));
    /** @type {string[]} */
    const previews = [];

    const selectionPromise = ui.promptSelect("Pick one", [
        { value: "one", label: "One" },
        { value: "two", label: "Two" },
    ], {
        onSelectionChange: (/** @type {string} */ value) => previews.push(value),
    });
    const selectBlock = focus();
    assertEquals(messageList.children[1] instanceof Spacer, true);
    selectBlock.list.onSelectionChange({ value: "two" });
    selectBlock.list.onSelect({ value: "two" });

    assertEquals(await selectionPromise, "two");
    assertEquals(previews, ["two"]);

    const cancelPromise = ui.promptSelect("Cancel", [{ value: "one", label: "One" }]);
    assertEquals(messageList.children[3] instanceof Spacer, true);
    focus().list.onCancel();
    assertEquals(await cancelPromise, null);

    const childCountBeforeTransient = messageList.children.length;
    const transientPromise = ui.promptSelect("Transient", [{ value: "router", label: "router" }], {
        persistResult: false,
    });
    focus().list.onSelect({ value: "router" });
    assertEquals(await transientPromise, "router");
    assertEquals(messageList.children.length, childCountBeforeTransient);

    const agentPromptPromise = ui.promptSelect("Switch agent:", [{ value: "engineer", label: "engineer" }]);
    focus().list.onSelect({ value: "engineer" });
    assertEquals(await agentPromptPromise, "engineer");
    assertEquals(messageList.children.length, childCountBeforeTransient);
});

Deno.test("createUiApi promptText resolves submit, rejects empty required submit, and aborts", async () => {
    const { tui, messageList, focus } = makeTuiHarness();
    const ui = /** @type {any} */ (createUiApi(null, tui, messageList, new SpinnerBlock()));

    const textPromise = ui.promptText("Name", { defaultValue: "Ada", allowEmpty: false });
    const textBlock = focus();
    assertEquals(messageList.children[1] instanceof Spacer, true);
    textBlock.input.onSubmit("");
    assertEquals(await textPromise, "Ada");

    const requiredPromise = ui.promptText("Required", { allowEmpty: false });
    const requiredBlock = focus();
    requiredBlock.input.onSubmit("   ");
    let settled = false;
    requiredPromise.then(() => {
        settled = true;
    });
    await Promise.resolve();
    assertEquals(settled, false);
    requiredBlock.input.onSubmit("Grace");
    assertEquals(await requiredPromise, "Grace");

    const privatePromptChildCount = messageList.children.length;
    const privatePromise = ui.promptText("API key", { allowEmpty: false, persistResult: false });
    focus().input.onSubmit("secret-key");
    assertEquals(await privatePromise, "secret-key");
    assertEquals(messageList.children.length, privatePromptChildCount);

    const abortPromise = ui.promptText("Abort");
    ui.abortActivePrompt();
    assertEquals(await abortPromise, null);
});

Deno.test("createUiApi clearMessages settles active prompt without orphaned interaction state", async () => {
    const { tui, messageList, focus } = makeTuiHarness();
    const activeInteractionContainer = makeContainer();
    const ui = /** @type {any} */ (
        createUiApi(null, tui, messageList, new SpinnerBlock(), undefined, undefined, activeInteractionContainer)
    );

    const promptPromise = ui.promptText("Clear me");
    assertNotEquals(focus(), null);
    assertEquals(activeInteractionContainer.children.length, 2);

    ui.clearMessages();

    assertEquals(await promptPromise, null);
    assertEquals(activeInteractionContainer.children, []);
    assertEquals(messageList.children, []);
    assertEquals(focus(), null);
});

Deno.test("createUiApi suppressOutput settles active prompt without stale interaction components", async () => {
    const { tui, messageList, focus } = makeTuiHarness();
    const activeInteractionContainer = makeContainer();
    const ui = /** @type {any} */ (
        createUiApi(null, tui, messageList, new SpinnerBlock(), undefined, undefined, activeInteractionContainer)
    );

    const promptPromise = ui.promptSelect("Continue?", [{ value: "yes", label: "Yes" }]);
    assertEquals(activeInteractionContainer.children.length, 2);
    assertNotEquals(focus(), null);

    ui.suppressOutput();

    assertEquals(await promptPromise, null);
    assertEquals(activeInteractionContainer.children, []);
    assertEquals(messageList.children, []);
    assertEquals(focus(), null);
    assertEquals(ui.isOutputSuppressed(), true);
});

Deno.test("createUiApi suppressOutput silences later UI mutations except clearing existing messages", () => {
    const { tui, messageList, renders } = makeTuiHarness();
    const ui = /** @type {any} */ (createUiApi(null, tui, messageList, new SpinnerBlock()));

    ui.appendUserMessage("visible");
    const beforeSuppressChildren = messageList.children.length;
    const beforeSuppressRenders = renders();
    ui.suppressOutput();
    ui.appendUserMessage("hidden");
    ui.appendSystemMessage("hidden");
    ui.appendAgentMessageStart("Agent").appendText("hidden");
    ui.startToolExecution("hidden", "bash", "$");
    ui.requestRender();
    ui.advanceSpinner();
    ui.setBusy(true);
    ui.setRunningTasks([]);

    assertEquals(ui.isOutputSuppressed(), true);
    assertEquals(messageList.children.length, beforeSuppressChildren);
    assertEquals(renders(), beforeSuppressRenders);
    assertEquals(ui.getActiveToolBlock("hidden"), undefined);

    ui.clearMessages();
    assertEquals(messageList.children, []);
});

Deno.test("createUiApi dispose clears prompts, timers, focus, and validation containers", async () => {
    const { tui, messageList, focus } = makeTuiHarness();
    const spinner = new SpinnerBlock();
    const inputAccessoryContainer = makeContainer();
    const validationPanelContainer = makeContainer();
    const activeInteractionContainer = makeContainer();
    const ui = createUiApi(
        null,
        tui,
        messageList,
        spinner,
        inputAccessoryContainer,
        validationPanelContainer,
        activeInteractionContainer,
    );

    const prompt = ui.promptText("Prompt", { persistResult: false });
    assertNotEquals(focus(), null);
    ui.updateValidationProgress?.({ outcome: "running", stage: "testing", message: "Testing" });
    ui.showKeyboardHelp?.({ title: "Keyboard shortcuts", items: [{ key: "?", description: "show help" }] });
    ui.setManagedSyncStatus?.({ status: "behind", owningSurfaceKind: "workspace", owningSurfaceLabel: "Workspace" });
    ui.startToolExecution?.("tool-1", "bash", "bash");
    assertEquals(inputAccessoryContainer.children.length, 4);
    ui.dispose?.();

    assertEquals(await prompt, null);
    assertEquals(focus(), null);
    assertEquals(validationPanelContainer.children.length, 0);
    assertEquals(activeInteractionContainer.children.length, 0);
    assertEquals(inputAccessoryContainer.children, []);
    assertEquals(ui.getActiveToolBlock?.("tool-1"), undefined);
});
