import { test } from "node:test";
import { assertEquals, assertInstanceOf, assertStringIncludes } from "../../testing/assertions.ts";
import { Container, Editor, type TUI, TuiMainScreen } from "@earendil-works/pi-tui";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { getModelRegistry, RunWieldModelRegistry } from "../../shared/models/model-registry.ts";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getEditorTheme, initRunWieldTheme } from "../theme/theme.ts";
import { VirtualTerminal } from "./testing/virtual-terminal.ts";
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

test("^TUI model selector exposes Pi and Claude CLI without offering retired Antigravity models$", async () => {
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
            assertStringIncludes(initialScreen, "Use /login for API providers");
            assertStringIncludes(initialScreen, "External CLI choices require their CLI installed and signed in");
            assertStringIncludes(initialScreen, "current");

            assertEquals(initialScreen.includes("agy-cli/"), false);
            selector.handleInput("opus");
            const filteredScreen = selector.render(120).join("\n");
            assertStringIncludes(filteredScreen, "claude-cli/opus");
            assertEquals(filteredScreen.includes("runtime-command-fixture/fixture-model"), false);

            selector.handleInput("\r");
            assertEquals(selected, [{ id: "opus", provider: "claude-cli" }]);
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

for (const [outcome, action] of [
    ["success", "row"],
    ["failure", "row"],
    ["timeout", "row"],
    ["success", "shortcut"],
    ["success", "empty-row"],
] as const) {
    test(
        `TUI catalog refresh via ${action} bypasses a fresh cache and handles ${outcome}`,
        { timeout: 25_000 },
        async () => {
            await withRuntimeCommandFixture(`model-selector-refresh-${outcome}-`, async ({ homeDir }) => {
                let latest = false;
                let serverRequests = 0;
                const server = Bun.serve({
                    hostname: "127.0.0.1",
                    port: 0,
                    fetch(request) {
                        serverRequests += 1;
                        const provider = new URL(request.url).pathname.split("/").at(-1);
                        if (provider !== "openai") return Response.json([]);
                        if (latest && outcome === "failure")
                            return new Response("Catalog unavailable", { status: 401 });
                        if (latest && outcome === "timeout") return new Promise<Response>(() => {});
                        return Response.json(
                            [
                                {
                                    id: latest ? "new-catalog-model" : "cached-catalog-model",
                                    name: "Catalog fixture",
                                    api: "openai-responses",
                                    provider: "openai",
                                    baseUrl: "https://api.openai.com/v1",
                                    reasoning: false,
                                    input: ["text"],
                                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                                    contextWindow: 128000,
                                    maxTokens: 4096,
                                },
                            ],
                            { headers: { "last-modified": "Fri, 01 Jan 2100 00:00:00 GMT" } },
                        );
                    },
                });
                const { tui, terminal, container, editor } = makeTui();
                try {
                    const runtime = await ModelRuntime.create({
                        authPath: `${homeDir}/catalog-auth.json`,
                        modelsPath: null,
                        modelsStorePath: `${homeDir}/catalog-store.json`,
                        catalogBaseUrl: server.url.origin,
                    });
                    await runtime.setRuntimeApiKey("openai", "fixture-key");
                    await runtime.refresh({ providers: ["openai"], allowNetwork: true, force: true });
                    latest = true;
                    serverRequests = 0;
                    const registry = new RunWieldModelRegistry({ runtime, configDir: homeDir });
                    const selected: string[] = [];
                    const search = action === "empty-row" ? "new-catalog-model" : "catalog-model";
                    const selector = new RunWieldModelSelectorComponent({
                        tui,
                        modelRegistry: registry,
                        initialSearchInput: search,
                        onSelect: (model) => {
                            selected.push(model.id);
                        },
                        onCancel: () => {},
                    });
                    container.children.splice(container.children.indexOf(editor), 1, selector);
                    tui.setFocus(selector);
                    tui.start();
                    const screen = () => selector.render(120).join("\n");
                    const waitFor = async (message: string) => {
                        for (let attempt = 0; attempt < 2000 && !screen().includes(message); attempt++) {
                            await new Promise((resolve) => setTimeout(resolve, 10));
                        }
                        assertStringIncludes(screen(), message);
                    };
                    assertEquals(screen().includes("Refreshing Pi model catalogs…"), false);
                    assertEquals(screen().includes("Pi model catalogs refreshed."), false);
                    assertStringIncludes(
                        screen(),
                        action === "empty-row" ? "No matching models" : "cached-catalog-model",
                    );
                    assertEquals(serverRequests, 0);
                    assertEquals(screen().includes("openai/new-catalog-model"), false);
                    assertStringIncludes(screen(), "Refresh catalog");
                    if (action !== "shortcut") {
                        terminal.input("\x1b[A");
                        assertStringIncludes(screen(), "→ Refresh catalog");
                        terminal.input("\r");
                        assertEquals(selected, []);
                    } else {
                        terminal.input("\x12");
                    }
                    assertStringIncludes(screen(), "Refreshing Pi model catalogs…");
                    if (outcome === "success") {
                        await waitFor("openai/new-catalog-model");
                        assertStringIncludes(screen(), "Pi model catalogs refreshed.");
                    } else {
                        await waitFor("Could not refresh model catalogs; showing cached models.");
                        assertStringIncludes(screen(), "cached-catalog-model");
                        assertEquals(screen().includes("Pi model catalogs refreshed."), false);
                        assertStringIncludes(screen(), outcome === "timeout" ? "timed out" : "openai:");
                    }
                    assertEquals(selector.getSearchInput().getValue(), search);
                    if (action !== "shortcut") terminal.input("\x1b[B");
                    terminal.input("\r");
                    assertEquals(selected, [outcome === "success" ? "new-catalog-model" : "cached-catalog-model"]);
                } finally {
                    tui.stop();
                    await server.stop(true);
                }
            });
        },
    );
}
