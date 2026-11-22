import { assert, assertEquals } from "@std/assert";
import { createAssistantMessageEventStream, Type } from "@earendil-works/pi-ai";
import {
    createAgentSession,
    DefaultResourceLoader,
    estimateTokens,
    ModelRuntime,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";

/** @returns {import('@earendil-works/pi-ai').Usage} */
function zeroUsage() {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
}

/**
 * @param {number} callIndex
 * @returns {import('@earendil-works/pi-ai').AssistantMessage}
 */
function assistantMessage(callIndex) {
    return {
        role: "assistant",
        content:
            callIndex === 1
                ? [{ type: "toolCall", id: "tool-1", name: "large_result", arguments: {} }]
                : [{ type: "text", text: "done" }],
        api: "faux",
        provider: "anthropic",
        model: "faux-context",
        usage: zeroUsage(),
        stopReason: "stop",
        timestamp: Date.now(),
    };
}

/**
 * @param {import('@earendil-works/pi-ai').AssistantMessage} message
 * @returns {import('@earendil-works/pi-ai').AssistantMessageEventStream}
 */
function messageStream(message) {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
    });
    return stream;
}

Deno.test("Pi 0.87.1 AgentSession restarts a queued follow-up after a graceful completed-turn end", async () => {
    const cwd = await Deno.makeTempDir({ prefix: "pi-context-contract-" });
    const agentDir = await Deno.makeTempDir({ prefix: "pi-context-agent-" });
    /** @type {import('@earendil-works/pi-coding-agent').AgentSession | undefined} */
    let session;
    try {
        const modelRuntime = await ModelRuntime.create({
            authPath: `${agentDir}/auth.json`,
            modelsPath: null,
            refreshOnCreate: false,
        });
        await modelRuntime.setRuntimeApiKey("anthropic", "fixture-only-key");
        const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
        const loader = new DefaultResourceLoader({
            cwd,
            agentDir,
            settingsManager,
            noExtensions: true,
            noContextFiles: true,
            noSkills: true,
            noPromptTemplates: true,
        });
        await loader.reload();
        const sessionManager = SessionManager.inMemory(cwd);
        ({ session } = await createAgentSession({
            cwd,
            agentDir,
            sessionManager,
            settingsManager,
            modelRuntime,
            resourceLoader: loader,
            model: {
                id: "faux-context",
                name: "Faux Context",
                api: "anthropic-messages",
                provider: "anthropic",
                baseUrl: "http://localhost:0",
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                reasoning: false,
                contextWindow: 6_000,
                maxTokens: 1_000,
            },
            noTools: "builtin",
            customTools: [
                {
                    name: "large_result",
                    label: "Large Result",
                    description: "Return a deterministic tool result.",
                    parameters: Type.Object({}),
                    execute: async () => {
                        if (!session) throw new Error("AgentSession was not created");
                        await session.followUp("queued follow-up");
                        return { content: [{ type: "text", text: "x".repeat(30_000) }], details: {} };
                    },
                },
            ],
        }));
        let providerCalls = 0;
        let completedTurns = 0;
        let pressuredTurnObserved = false;
        session.agent.streamFunction = () => messageStream(assistantMessage(++providerCalls));
        const previousFinishTurn = session.agent.finishTurn;
        session.agent.finishTurn = async (turn, signal) => {
            await previousFinishTurn?.(turn, signal);
            completedTurns++;
            if (turn.toolResults.length > 0) {
                pressuredTurnObserved =
                    turn.context.messages.reduce((total, message) => total + estimateTokens(message), 0) > 5_000;
            }
            return { action: "end" };
        };

        await session.prompt("start");

        assert(pressuredTurnObserved, "completed tool results exceed the model's W - R threshold");
        assertEquals(completedTurns, 3, "the completed-turn end does not stop later AgentSession runs");
        assertEquals(providerCalls, 3, "the queued follow-up restarts past the recovery veto");
        const persistedMessages = sessionManager.buildSessionProjection().messages;
        assertEquals(persistedMessages.filter((message) => message.role === "toolResult").length, 1);
        assertEquals(persistedMessages.filter((message) => message.role === "user").length, 2);
        assert(
            persistedMessages.every((message) => message.role !== "assistant" || message.stopReason !== "aborted"),
            "graceful end must not create an aborted assistant artifact",
        );
    } finally {
        session?.dispose();
        await Deno.remove(cwd, { recursive: true });
        await Deno.remove(agentDir, { recursive: true });
    }
});
