import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
// THROWAWAY timing harness for the Shift+Tab thinking-level latency. Deleted after diagnosis.
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { NO_OPEN_BROWSER_PORT } from "../../shared/browser-port.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { createInteractiveTuiComposition } from "./interactive-tui-composition.ts";
import { VirtualTerminal } from "./testing/virtual-terminal.js";
import { getSettingsManager } from "../../shared/settings.js";
import { persistThinkingLevel } from "./chat-session.ts";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 8_000): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Timed out waiting for ${description}.`);
}

test("measure shift+tab thinking-level latency before and after activation", async () => {
    await withRuntimeCommandFixture("debug-thinking-timing-", async ({ setModelResponseFactory }) => {
        const response = () => fauxAssistantMessage(fauxText("Fixture response."));
        setModelResponseFactory(response);
        const terminal = new VirtualTerminal({ columns: 120, rows: 34 });
        const composition = await createInteractiveTuiComposition(null, {
            browser: NO_OPEN_BROWSER_PORT,
            terminal,
            skipModelWelcome: true,
            sessionStartMode: "new",
            initialAgentName: "operator",
        });
        try {
            await composition.waitForIdle();
            const sessionId = composition.sessionId;
            const runtime = composition.runtime;
            const projectRoot = runtime.getSessionSnapshot(sessionId)?.cwd;
            if (!projectRoot) throw new Error("missing cwd");

            const levelIndex = () =>
                LEVELS.indexOf(runtime.getSessionSnapshot(sessionId)?.thinkingLevel as (typeof LEVELS)[number]);

            const pressShiftTabAndTime = async (label: string): Promise<number> => {
                const expected = LEVELS[(levelIndex() + 1) % LEVELS.length];
                await terminal.flush();
                const start = performance.now();
                terminal.input("\x1b[Z");
                if (expected === "off") {
                    await waitFor(() => levelIndex() === 0, `${label}: level back to off`);
                } else {
                    await waitFor(
                        () => terminal.getScreenText().includes(`(${expected})`),
                        `${label}: footer shows (${expected})`,
                    );
                }
                const elapsed = performance.now() - start;
                console.log(`[TIMING] ${label}: ${elapsed.toFixed(1)}ms (level now ${expected})`);
                return elapsed;
            };

            // --- before activation ---
            await pressShiftTabAndTime("pre-activation #1");
            await pressShiftTabAndTime("pre-activation #2");

            // --- component timings, still before activation ---
            {
                const t0 = performance.now();
                const result = await runtime.cycleSessionThinkingLevel(sessionId);
                if (!result.thinkingLevel) throw new Error(result.error || "Thinking level did not change");
                const t1 = performance.now();
                console.log(
                    `[TIMING] runtime.cycleSessionThinkingLevel (pre): ${(t1 - t0).toFixed(2)}ms ok=${result.ok}`,
                );
                const t2 = performance.now();
                await persistThinkingLevel(result.thinkingLevel, projectRoot);
                const t3 = performance.now();
                console.log(`[TIMING] persistThinkingLevel await (pre): ${(t3 - t2).toFixed(2)}ms`);
                const t4 = performance.now();
                await getSettingsManager(projectRoot).flush();
                const t5 = performance.now();
                console.log(`[TIMING] settings flush after persist (pre): ${(t5 - t4).toFixed(2)}ms`);
            }

            // --- activate the session with a first message ---
            terminal.typeText("hello, activate this session");
            terminal.pressEnter();
            await waitFor(
                () => typeof runtime.getSessionSnapshot(sessionId)?.sessionManagerId === "string",
                "session activation (sessionManagerId present)",
            );
            // Cold session activation includes storage and provider setup, outside the latency measurement.
            await composition.waitForIdle(15_000);
            console.log("[TIMING] session is now active:", runtime.getSessionSnapshot(sessionId)?.sessionManagerId);

            // --- after activation ---
            for (let i = 1; i <= 4; i++) {
                await pressShiftTabAndTime(`post-activation #${i}`);
            }

            // --- component timings, after activation ---
            {
                const t0 = performance.now();
                const result = await runtime.cycleSessionThinkingLevel(sessionId);
                if (!result.thinkingLevel) throw new Error(result.error || "Thinking level did not change");
                const t1 = performance.now();
                console.log(
                    `[TIMING] runtime.cycleSessionThinkingLevel (post): ${(t1 - t0).toFixed(2)}ms ok=${result.ok}`,
                );
                const t2 = performance.now();
                await persistThinkingLevel(result.thinkingLevel, projectRoot);
                const t3 = performance.now();
                console.log(`[TIMING] persistThinkingLevel await (post): ${(t3 - t2).toFixed(2)}ms`);
                const t4 = performance.now();
                await getSettingsManager(projectRoot).flush();
                const t5 = performance.now();
                console.log(`[TIMING] settings flush after persist (post): ${(t5 - t4).toFixed(2)}ms`);
                // repeat persist a few times to see steady-state cost
                for (let i = 0; i < 3; i++) {
                    const a = performance.now();
                    await persistThinkingLevel(result.thinkingLevel, projectRoot);
                    await getSettingsManager(projectRoot).flush();
                    const b = performance.now();
                    console.log(`[TIMING] persist+flush steady-state #${i + 1} (post): ${(b - a).toFixed(2)}ms`);
                }
            }

            assertEquals(true, true);
        } finally {
            await composition.dispose();
        }
    });
});
