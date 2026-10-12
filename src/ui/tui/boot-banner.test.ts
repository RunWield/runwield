import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { Container, type TUI, TuiMainScreen } from "@earendil-works/pi-tui";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { getCwdInitState } from "../../cmd/init/init-state.ts";
import { createSessionRuntime, type SessionRuntime } from "../../shared/session/session-runtime.ts";
import { getSettingsManager } from "../../shared/settings.js";
import { createUiApi } from "./api.js";
import { SpinnerBlock } from "./blocks.js";
import { renderBootBanner } from "./boot-banner.ts";
import { normalizeScreenText, VirtualTerminal } from "./testing/virtual-terminal.js";

interface BannerHarness {
    messageList: Container;
    tui: TUI;
    uiAPI: import("./types.js").UiAPI;
}

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

function makeBannerHarness(): BannerHarness {
    const terminal = new CompatibleVirtualTerminal({ columns: 120, rows: 40 });
    const tui = new TuiMainScreen(terminal);
    const messageList = new Container();
    tui.addChild(messageList);
    return {
        messageList,
        tui,
        uiAPI: createUiApi(null, tui, messageList, new SpinnerBlock()),
    };
}

function renderMessages(messageList: Container): string {
    return normalizeScreenText(messageList.render(120).join("\n"));
}

async function createRuntimeSession(projectRoot: string): Promise<{ runtime: SessionRuntime; sessionId: string }> {
    const runtime = createSessionRuntime();
    const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
    return { runtime, sessionId: created.sessionId };
}

Deno.test("renderBootBanner reports fixture prompts, skills, settings, context, and blocked prompts", async () => {
    await withRuntimeCommandFixture("boot-banner-full-", async ({ projectRoot }) => {
        await Deno.mkdir(join(projectRoot, ".wld", "skills", "fixture-diagnose"), { recursive: true });
        await Deno.writeTextFile(join(projectRoot, "RUNWIELD.md"), "# Fixture context\n");
        await Deno.writeTextFile(
            join(projectRoot, ".wld", "skills", "fixture-diagnose", "SKILL.md"),
            "---\nname: fixture-diagnose\ndescription: Fixture skill\n---\n",
        );
        getSettingsManager(projectRoot).setTheme("fixture-theme");
        const { runtime, sessionId } = await createRuntimeSession(projectRoot);
        const harness = makeBannerHarness();
        try {
            await renderBootBanner({
                ...harness,
                sessionRuntime: runtime,
                sessionId,
                projectRoot,
                invokablePromptTemplates: [
                    { name: "review", source: "local" },
                    { name: "release", source: "bundled" },
                ],
                blockedPromptTemplates: [
                    { name: "help", source: "local" },
                    {
                        name: "theme",
                        source: "package",
                        path: "/packages/prompts/theme.md",
                        packageSource: "npm:@example/prompts",
                    },
                ],
                chatPromptAgentName: "operator",
                runtimeTools: { hasSnipBinary: () => Promise.resolve(true) },
            });

            const output = renderMessages(harness.messageList);
            assertStringIncludes(output, "Prompt Templates (2): /review, /release");
            assertStringIncludes(output, "slash commands execute via operator");
            assertStringIncludes(output, "fixture-diagnose");
            assertStringIncludes(output, "Theme: fixture-theme");
            assertStringIncludes(output, "Runtime Optimizers: Snip");
            assertStringIncludes(output, "Context:");
            assertStringIncludes(output, "./RUNWIELD.md");
            assertStringIncludes(output, "./.wld/prompts/help.md command can't be invoked");
            assertStringIncludes(output, "package prompt /theme from npm:@example/prompts");
        } finally {
            runtime.closeSession(sessionId);
            harness.tui.stop();
        }
    });
});

Deno.test("renderBootBanner reports an empty prompt-template registry", async () => {
    await withRuntimeCommandFixture("boot-banner-empty-", async ({ projectRoot }) => {
        const { runtime, sessionId } = await createRuntimeSession(projectRoot);
        const harness = makeBannerHarness();
        try {
            await renderBootBanner({
                ...harness,
                sessionRuntime: runtime,
                sessionId,
                projectRoot,
                invokablePromptTemplates: [],
                blockedPromptTemplates: [],
                chatPromptAgentName: "operator",
                runtimeTools: { hasSnipBinary: () => Promise.resolve(true) },
            });
            assertStringIncludes(renderMessages(harness.messageList), "Prompt Templates: none");
        } finally {
            runtime.closeSession(sessionId);
            harness.tui.stop();
        }
    });
});

Deno.test("renderBootBanner persists and caps missing-Snip warnings in fixture init state", async () => {
    await withRuntimeCommandFixture("boot-banner-snip-", async ({ projectRoot }) => {
        Deno.chdir(projectRoot);
        const { runtime, sessionId } = await createRuntimeSession(projectRoot);
        const harness = makeBannerHarness();
        try {
            for (let boot = 0; boot < 4; boot++) {
                await renderBootBanner({
                    ...harness,
                    sessionRuntime: runtime,
                    sessionId,
                    projectRoot,
                    invokablePromptTemplates: [],
                    blockedPromptTemplates: [],
                    chatPromptAgentName: "operator",
                    runtimeTools: { hasSnipBinary: () => Promise.resolve(false) },
                });
            }

            const warningCount = renderMessages(harness.messageList).split("Snip is not installed").length - 1;
            assertEquals(warningCount, 3);
            assertEquals((await getCwdInitState())?.snipMissingWarningCount, 3);
        } finally {
            runtime.closeSession(sessionId);
            harness.tui.stop();
        }
    });
});
