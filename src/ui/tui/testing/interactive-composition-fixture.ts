/**
 * @module ui/tui/testing/interactive-composition-fixture
 * Composed-TUI harness for focused onboarding and auth tests.
 *
 * Inside an isolated fixture environment (`withRuntimeCommandFixture`), this
 * composes the REAL interactive TUI on a `VirtualTerminal` and exposes input
 * helpers that feed terminal input and poll normalized screen text. The
 * composition starts in flight; the test drives prompts by typing and then
 * resolves the composition with `waitForComposition()`.
 *
 * Quit hazard: the real `/quit` (`runQuitCommand`) ends in `Deno.exit(0)`,
 * which would kill the test runner. The welcome prompt's hint literally says
 * "Esc Quit", so Esc at the welcome login prompt must NEVER be driven
 * in-process — quit coverage lives in Golden child scenarios only. This
 * harness enforces that mechanically by rejecting `pressKey("escape")` while
 * the welcome prompt title is on screen.
 *
 * A composition that is still pending when the test ends cannot be torn down
 * safely (startup timers outlive it), so every test must drive onboarding to a
 * resolving end state — either a completed setup (login + model selection) or
 * the "No model was selected" return path. `completeOnboarding()` drives the
 * former deterministically using the scripted OAuth provider and is used by
 * `dispose()` as a safety net; it throws if that provider is not registered.
 */

import { endBlink } from "../boot-logo.ts";
import { createInteractiveTuiComposition } from "../interactive-tui-composition.ts";
import { NO_OPEN_BROWSER_PORT } from "../../../shared/browser-port.ts";
import type { SessionRuntime } from "../../../shared/session/session-runtime.ts";
import { stopTUI } from "../tui.ts";
import { normalizeScreenText, VirtualTerminal } from "./virtual-terminal.ts";

const DEFAULT_WAIT_TIMEOUT_MS = 20_000;

const WELCOME_PROMPT_TITLE = "Welcome to RunWield";
const SCRIPTED_OAUTH_PROVIDER_NAME = "Aardvark Fixture OAuth";
const SCRIPTED_OAUTH_MODEL = "scripted-oauth-model";
const SCRIPTED_REDIRECT_URL = "https://fixture.example/callback";

export interface StartupInputStep {
    /** Normalized screen marker to wait for before feeding `input`. */
    marker: string;
    /** Raw terminal input to feed once the marker appears. */
    input: string;
}

export interface InteractiveCompositionOptions {
    startupInput?: StartupInputStep[];
    sessionStartMode?: "new" | "continue";
    initialAgentName?: string;
    initialAgentModel?: string;
    terminalColumns?: number;
    terminalRows?: number;
}

export interface InteractiveCompositionHarness {
    terminal: VirtualTerminal;
    runtime: SessionRuntime;
    sessionId: string;
    /** Feed raw terminal input (text or control bytes) and flush the screen. */
    type(input: string): Promise<void>;
    /** Feed a named key. Escape is refused while the welcome prompt is up. */
    pressKey(key: "enter" | "escape"): Promise<void>;
    /** Poll the normalized screen text until it contains `marker`. */
    waitForScreen(marker: string, timeoutMs?: number): Promise<string>;
    /** Resolve once the composed TUI reports idle (composition already resolved). */
    waitForIdle(timeoutMs?: number): Promise<void>;
    /** Resolve once onboarding completes and the composition object exists. */
    waitForComposition(timeoutMs?: number): Promise<Awaited<ReturnType<typeof createInteractiveTuiComposition>>>;
    /**
     * Clear the real message list through the composed UiAPI. Resets the
     * viewport between steps so screen markers stay fresh and visible.
     */
    clearMessages(): Promise<void>;
    /** Drive a pending onboarding flow to completion via the scripted OAuth provider. */
    completeOnboarding(timeoutMs?: number): Promise<void>;
    /** Stop the TUI and close runtime sessions. Requires a resolved composition. */
    dispose(): Promise<void>;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollScreen(
    terminal: VirtualTerminal,
    predicate: (screen: string) => boolean,
    timeoutMs: number,
    describe: string,
): Promise<string> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        await terminal.flush();
        const screen = terminal.getScreenText();
        if (predicate(screen)) return screen;
        await delay(20);
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for ${describe}. Screen:\n${terminal.getScreenText()}`);
}

export function createInteractiveCompositionHarness(
    options: InteractiveCompositionOptions = {},
): InteractiveCompositionHarness {
    const terminal = new VirtualTerminal({
        columns: options.terminalColumns || 100,
        rows: options.terminalRows || 30,
    });
    let harnessRuntime: SessionRuntime | null = null;
    let harnessSessionId = "";
    let compositionPromise: Promise<Awaited<ReturnType<typeof createInteractiveTuiComposition>>> | null = null;
    let resolvedComposition: Awaited<ReturnType<typeof createInteractiveTuiComposition>> | null = null;

    compositionPromise = createInteractiveTuiComposition(null, {
        browser: NO_OPEN_BROWSER_PORT,
        terminal,
        sessionStartMode: options.sessionStartMode || "new",
        initialAgentName: options.initialAgentName || "router",
        initialAgentModel: options.initialAgentModel,
        onSessionReady: (sessionId, runtime) => {
            harnessSessionId = sessionId;
            harnessRuntime = runtime;
        },
    });
    // Teardown also needs to see startup finish when the test fails before its
    // first waitForComposition call. Observe rejection immediately as well.
    void compositionPromise.then(
        (composition) => {
            resolvedComposition = composition;
        },
        () => {},
    );

    // Feed startup-declared input while the composition is still in flight.
    // Input sent before the TUI attaches its handler to the VirtualTerminal is
    // dropped, so every step waits for a screen marker first.
    const startupInputPromise = (async () => {
        for (const step of options.startupInput || []) {
            await pollScreen(
                terminal,
                (screen) => screen.includes(step.marker),
                DEFAULT_WAIT_TIMEOUT_MS,
                `startup marker ${JSON.stringify(step.marker)}`,
            );
            await typeIntoTerminal(terminal, step.input);
        }
    })();

    async function typeIntoTerminal(target: VirtualTerminal, input: string): Promise<void> {
        target.typeText(input);
        await target.flush();
    }

    async function waitForComposition(
        timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    ): Promise<Awaited<ReturnType<typeof createInteractiveTuiComposition>>> {
        if (resolvedComposition) return resolvedComposition;
        if (!compositionPromise) throw new Error("Composition was never started.");
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
            timeoutId = setTimeout(
                () =>
                    reject(
                        new Error(
                            `Timed out after ${timeoutMs}ms waiting for the TUI composition to resolve. ` +
                                `Screen:\n${terminal.getScreenText()}`,
                        ),
                    ),
                timeoutMs,
            );
        });
        try {
            resolvedComposition = await Promise.race([compositionPromise, timeout]);
        } finally {
            clearTimeout(timeoutId);
        }
        compositionPromise = null;
        await startupInputPromise.catch(() => {});
        return resolvedComposition;
    }

    async function completeOnboarding(timeoutMs = DEFAULT_WAIT_TIMEOUT_MS): Promise<void> {
        if (resolvedComposition) return;
        const startedAt = Date.now();
        while (!resolvedComposition) {
            if (Date.now() - startedAt > timeoutMs) {
                throw new Error(
                    `completeOnboarding timed out after ${timeoutMs}ms. Screen:\n${terminal.getScreenText()}`,
                );
            }
            const screen = terminal.getScreenText();
            if (screen.includes("This tutorial makes a real change")) {
                await typeIntoTerminal(terminal, "skip\r");
            } else if (screen.includes("Select authentication method:")) {
                await typeIntoTerminal(terminal, "\r");
            } else if (screen.includes("Select provider to configure:")) {
                // Filter to the scripted provider so a bare Enter can never
                // select a real builtin OAuth provider.
                await typeIntoTerminal(terminal, SCRIPTED_OAUTH_PROVIDER_NAME);
                await typeIntoTerminal(terminal, "\r");
            } else if (screen.includes("Paste the redirect URL")) {
                await typeIntoTerminal(terminal, `${SCRIPTED_REDIRECT_URL}\r`);
            } else if (screen.includes("Enter API key for")) {
                await typeIntoTerminal(terminal, "fixture-complete-key\r");
            } else if (screen.includes("Only showing models from configured providers")) {
                await typeIntoTerminal(terminal, `${SCRIPTED_OAUTH_MODEL}\r`);
            } else if (screen.includes(WELCOME_PROMPT_TITLE)) {
                await typeIntoTerminal(terminal, "\r");
            } else if (screen.includes("No subscription providers available.")) {
                throw new Error(
                    "completeOnboarding requires registerScriptedOAuthProvider() before the composition " +
                        "reaches the provider prompt.",
                );
            } else if (screen.includes("No model was selected")) {
                // Onboarding already returned without a root Session.
                break;
            } else {
                await delay(20);
            }
        }
        await waitForComposition(timeoutMs - (Date.now() - startedAt));
    }

    async function dispose(): Promise<void> {
        const settled = resolvedComposition;
        if (settled) {
            await settled.dispose();
            return;
        }
        // Safety net: drive a pending onboarding flow to a resolving end
        // state so the process does not outlive the test with startup
        // timers still armed.
        await completeOnboarding().catch(() => {});
        const afterAttempt = resolvedComposition;
        if (afterAttempt) {
            await afterAttempt.dispose();
            return;
        }
        stopTUI();
        endBlink();
        harnessRuntime?.closeAllSessions?.();
    }

    return {
        terminal,
        get runtime(): SessionRuntime {
            if (!harnessRuntime) throw new Error("The composition has not created a Runtime session yet.");
            return harnessRuntime;
        },
        get sessionId(): string {
            if (!harnessSessionId) throw new Error("The composition has not created a session yet.");
            return harnessSessionId;
        },
        async type(input) {
            await typeIntoTerminal(terminal, input);
        },
        async pressKey(key) {
            const screen = terminal.getScreenText();
            if (key === "escape" && screen.includes(WELCOME_PROMPT_TITLE)) {
                throw new Error(
                    "Refusing to drive Escape at the welcome login prompt: the real /quit ends in Deno.exit(0) " +
                        "and would kill the in-process test runner. Quit coverage lives in Golden child scenarios.",
                );
            }
            if (key === "enter") terminal.pressEnter();
            else terminal.pressEscape();
            await terminal.flush();
        },
        async waitForScreen(marker, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS) {
            return await pollScreen(
                terminal,
                (screen) => screen.includes(marker),
                timeoutMs,
                `screen marker ${JSON.stringify(marker)}`,
            );
        },
        async waitForIdle(timeoutMs = 2_000) {
            const composition = await waitForComposition(timeoutMs);
            await composition.waitForIdle(timeoutMs);
        },
        waitForComposition,
        async clearMessages() {
            const composition = await waitForComposition();
            composition.uiAPI.clearMessages?.();
            await terminal.flush();
        },
        completeOnboarding,
        dispose,
    };
}

export { normalizeScreenText };
