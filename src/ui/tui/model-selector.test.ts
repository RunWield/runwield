import { test } from "node:test";
import { assertEquals, assertInstanceOf, assertStringIncludes } from "../../testing/assertions.ts";
import { Container, Editor, type TUI, TuiMainScreen } from "@earendil-works/pi-tui";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { getModelRegistry } from "../../shared/models/model-registry.ts";
import { getEditorTheme, initRunWieldTheme } from "../theme/theme.js";
import { VirtualTerminal } from "./testing/virtual-terminal.js";
import { RunWieldModelSelectorComponent } from "./model-selector.ts";

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

function makeTui(): { tui: TUI; terminal: CompatibleVirtualTerminal; container: Container; editor: Editor } {
    initRunWieldTheme();
    const terminal = new CompatibleVirtualTerminal({ columns: 120, rows: 34 });
    const tui = new TuiMainScreen(terminal);
    const container = new Container();
    const editor = new Editor(tui, getEditorTheme());
    container.addChild(editor);
    tui.addChild(container);
    return { tui, terminal, container, editor };
}

test("^TUI model selector exposes Pi, Claude CLI, and Agy CLI models without API auth$", async () => {
    await withRuntimeCommandFixture("model-selector-mixed-", async () => {
        const { tui, container, editor } = makeTui();
        const selected: Array<{ id: string; provider: string }> = [];
        try {
            const registry = getModelRegistry();
            await registry.getRuntime();
            const currentModel = registry.find("runtime-command-fixture", "fixture-model");
            const selector = new RunWieldModelSelectorComponent({
                tui,
                currentModel,
                modelRegistry: registry,
                onSelect: (model) => {
                    selected.push({ id: model.id, provider: model.provider });
                },
                onCancel: () => container.children.splice(container.children.indexOf(selector), 1, editor),
            });
            container.children.splice(container.children.indexOf(editor), 1, selector);
            tui.setFocus(selector);
            tui.requestRender();

            const initialScreen = selector.render(120).join("\n");
            assertStringIncludes(initialScreen, "runtime-command-fixture/fixture-model");
            assertStringIncludes(initialScreen, "claude-cli/sonnet");
            assertStringIncludes(initialScreen, "Claude CLI");
            assertStringIncludes(initialScreen, "agy-cli/gemini-3.8-flash");
            assertStringIncludes(initialScreen, "agy-cli/gemini-3.1-pro");
            assertStringIncludes(initialScreen, "Antigravity CLI");
            assertStringIncludes(initialScreen, "Use /login for API providers");
            assertStringIncludes(initialScreen, "External CLI choices require their CLI installed and signed in");
            assertStringIncludes(initialScreen, "current");

            selector.handleInput("flash");
            const filteredScreen = selector.render(120).join("\n");
            assertStringIncludes(filteredScreen, "agy-cli/gemini-3.8-flash");
            assertStringIncludes(filteredScreen, "Agy must be installed and signed in");
            assertStringIncludes(filteredScreen, "first use asks before RunWield MCP setup");
            assertEquals(filteredScreen.includes("runtime-command-fixture/fixture-model"), false);

            selector.handleInput("\r");
            assertEquals(selected, [{ id: "gemini-3.8-flash", provider: "agy-cli" }]);
        } finally {
            tui.stop();
        }
    });
});

test("TUI model selector cancellation leaves selection callbacks untouched", async () => {
    await withRuntimeCommandFixture("model-selector-cancel-", async () => {
        const { tui } = makeTui();
        let selected = false;
        let cancelled = false;
        try {
            const registry = getModelRegistry();
            await registry.getRuntime();
            const selector = new RunWieldModelSelectorComponent({
                tui,
                modelRegistry: registry,
                onSelect: () => {
                    selected = true;
                },
                onCancel: () => {
                    cancelled = true;
                },
            });
            assertInstanceOf(selector, RunWieldModelSelectorComponent);
            selector.handleInput("\x1b");
            assertEquals(selected, false);
            assertEquals(cancelled, true);
        } finally {
            tui.stop();
        }
    });
});
