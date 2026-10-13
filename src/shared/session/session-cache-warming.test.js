import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { HostedSession } from "./hosted-session.js";
import { ensureRootAgentSession, runRootTurn } from "./session.js";

/**
 * @param {import('@earendil-works/pi-coding-agent').AgentSession} session
 */
function makeWarmingEligible(session) {
    const model = session.model;
    if (!model) throw new Error("expected a selected model");
    model.promptCache = { short: 11, long: 11 };
    model.cost = { input: 100, output: 1, cacheRead: 1, cacheWrite: 100 };
}

test("RunWield cache policy prevents an otherwise eligible Pi warming request", async () => {
    await withRuntimeCommandFixture("runwield-cache-warming-", async ({ projectRoot, setModelResponseFactory }) => {
        const runScenario = async (/** @type {boolean} */ enablePositiveControl) => {
            const manager = SessionManager.inMemory(projectRoot);
            const hosted = new HostedSession({
                id: `cache-warming-${enablePositiveControl ? "control" : "off"}`,
                cwd: projectRoot,
                sessionManager: /** @type {never} */ (manager),
            });
            /** @type {number[]} */
            const calls = [];
            let normalCalls = 0;
            /** @type {import('@earendil-works/pi-ai').FauxResponseFactory} */
            const respond = (context, options) => {
                // Warm requests may repeat while a real shell starts/runs on a
                // loaded machine. They must never consume a normal-turn response.
                setModelResponseFactory(respond);
                const maxTokens = options?.maxTokens || 0;
                calls.push(maxTokens);
                if (maxTokens === 1) return fauxAssistantMessage(fauxText("cache refreshed"));
                normalCalls++;
                if (normalCalls === 1) {
                    return fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 1.5; printf done" }));
                }
                assertEquals(normalCalls, 2, "exactly one real follow-up follows the Bash result");
                assert(
                    context.messages.some(
                        (message) =>
                            message.role === "toolResult" &&
                            !message.isError &&
                            message.content.some((part) => part.type === "text" && part.text.includes("done")),
                    ),
                    "the normal request must receive the successful real Bash result",
                );
                return fauxAssistantMessage(fauxText("turn complete"));
            };
            setModelResponseFactory(respond);

            const session = await ensureRootAgentSession({ hostedSession: hosted, agentName: "operator" });
            makeWarmingEligible(session);
            const getCacheWarmingMode = session.settingsManager.getCacheWarmingMode;
            if (enablePositiveControl) session.settingsManager.getCacheWarmingMode = () => "streaming";
            try {
                const messages = await runRootTurn({
                    hostedSession: hosted,
                    agentName: "operator",
                    userRequest: `Use bash once and wait for it. ${"x".repeat(20_000)}`,
                });
                const final = messages.at(-1);
                assert(
                    final?.role === "assistant" &&
                        final.stopReason !== "error" &&
                        final.stopReason !== "aborted" &&
                        final.content.some((part) => part.type === "text" && part.text === "turn complete"),
                    "the real turn must finish successfully after Bash completes",
                );
            } finally {
                session.settingsManager.getCacheWarmingMode = getCacheWarmingMode;
                hosted.dispose();
            }
            return {
                calls,
                warmingEntries: manager
                    .getEntries()
                    .filter((entry) => entry.type === "usage" && entry.kind === "cache_warm").length,
            };
        };

        const disabled = await runScenario(false);
        assertEquals(disabled.calls, [0, 0]);
        assertEquals(disabled.warmingEntries, 0);

        const positiveControl = await runScenario(true);
        assert(positiveControl.calls.includes(1), "eligible Pi control must make a one-token warming request");
        assertEquals(
            positiveControl.calls.filter((maxTokens) => maxTokens !== 1),
            [0, 0],
        );
        assertEquals(
            positiveControl.warmingEntries,
            positiveControl.calls.filter((maxTokens) => maxTokens === 1).length,
        );
    });
});
