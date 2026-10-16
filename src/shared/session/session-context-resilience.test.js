import { readFile as fsReadFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert, match as assertMatch } from "node:assert/strict";
import { assertEquals, assertThrows } from "../../testing/assertions.ts";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Agent } from "@earendil-works/pi-agent-core";
import { AgentSession, createAgentSession, estimateTokens } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

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
function makeToolCallMessage(callIndex) {
    return {
        role: "assistant",
        content: [{ type: "toolCall", id: `tool-${callIndex}`, name: "large_result", arguments: {} }],
        api: "faux",
        provider: "faux",
        model: "faux-context",
        usage: zeroUsage(),
        stopReason: "stop",
        timestamp: Date.now(),
    };
}

/** @returns {import('@earendil-works/pi-ai').AssistantMessage} */
function makeDoneMessage() {
    return {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        api: "faux",
        provider: "faux",
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
        if (message.stopReason === "error" || message.stopReason === "aborted") {
            stream.push({ type: "error", reason: message.stopReason, error: message });
            stream.end(message);
            return;
        }
        stream.push({ type: "done", reason: finalDoneStopReason(message.stopReason), message });
        stream.end(message);
    });
    return stream;
}

/**
 * @param {import('@earendil-works/pi-ai').AssistantMessage["stopReason"]} stopReason
 * @returns {Exclude<import('@earendil-works/pi-ai').AssistantMessage["stopReason"], "pending" | "error" | "aborted">}
 */
function finalDoneStopReason(stopReason) {
    if (stopReason === "pending") {
        throw new Error('messageStream fixture cannot emit final done with stopReason "pending".');
    }
    if (stopReason === "error" || stopReason === "aborted") {
        throw new Error(`messageStream fixture must emit ${stopReason} as an error event.`);
    }
    return stopReason;
}

/**
 * @param {unknown[]} messages
 * @returns {number}
 */
function estimateContextMessagesTokens(messages) {
    let total = 0;
    for (const message of messages) {
        total += estimateTokens(/** @type {any} */ (message));
    }
    return total;
}

/**
 * @param {unknown[]} messages
 * @returns {boolean}
 */
function hasCompactionSummary(messages) {
    return JSON.stringify(messages).includes("Compaction Summary");
}

test("messageStream fixture rejects pending as a final done stop reason", () => {
    assertThrows(
        () => finalDoneStopReason("pending"),
        Error,
        'messageStream fixture cannot emit final done with stopReason "pending".',
    );
});

test("RunWield/Pi seam currently submits another provider call after tool-result pressure without compaction", async () => {
    const providerContexts =
        /** @type {{ call: number; completedToolResults: number; estimatedTokens: number; compacted: boolean }[]} */ ([]);
    let providerCalls = 0;
    let completedToolResults = 0;
    const contextWindow = 6_000;
    const reserveTokens = 1_000;
    const triggerThreshold = contextWindow - reserveTokens;
    const resultText = "x".repeat(6_000);

    const agent = new Agent({
        initialState: {
            systemPrompt: "system",
            model: {
                id: "faux-context",
                name: "Faux Context",
                api: "faux",
                provider: "faux",
                baseUrl: "http://localhost:0",
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                reasoning: false,
                contextWindow,
                maxTokens: reserveTokens,
            },
            tools: [
                {
                    name: "large_result",
                    label: "Large Result",
                    description: "Return a large deterministic tool result.",
                    parameters: Type.Object({}),
                    execute: () => {
                        completedToolResults++;
                        return Promise.resolve({ content: [{ type: "text", text: resultText }], details: {} });
                    },
                },
            ],
        },
        streamFn: (_model, context) => {
            providerCalls++;
            providerContexts.push({
                call: providerCalls,
                completedToolResults,
                estimatedTokens: estimateContextMessagesTokens(context.messages),
                compacted: hasCompactionSummary(context.messages),
            });
            return messageStream(providerCalls <= 6 ? makeToolCallMessage(providerCalls) : makeDoneMessage());
        },
    });

    assertEquals(typeof agent.streamFunction, "function");
    await agent.prompt("start");

    assertEquals(completedToolResults, 6);
    assertEquals(providerCalls, 7);
    const pressuredProviderCall = providerContexts.find(
        (entry) => entry.completedToolResults >= 4 && entry.estimatedTokens > triggerThreshold,
    );
    assert(pressuredProviderCall, `expected context pressure above W - R (${triggerThreshold}) before a provider call`);
    assertEquals(
        pressuredProviderCall.compacted,
        false,
        "current seam should show the missing behavior: no compaction summary before the next provider call",
    );
    assert(
        providerContexts.some((entry) => entry.call > pressuredProviderCall.call),
        "expected at least one provider call after the pressured completed tool-result turn",
    );
});

/**
 * @param {{ AgentSessionClass: any; AgentClass: any; createSession: Function }} api
 */
function characterizePublicContextResilienceContract(api) {
    const agentSessionMethods = Object.getOwnPropertyNames(api.AgentSessionClass.prototype);
    const agentMethods = Object.getOwnPropertyNames(api.AgentClass.prototype);
    const publicAgentSessionMethods = agentSessionMethods.filter((name) => !name.startsWith("_"));
    const createSessionSource = api.createSession.toString();
    return {
        publicAgentSessionMethods,
        agentMethods,
        hasCompletedTurnStopHook:
            publicAgentSessionMethods.includes("shouldStopAfterTurn") ||
            publicAgentSessionMethods.includes("stopAfterTurn") ||
            createSessionSource.includes("shouldStopAfterTurn"),
        hasRecoveryNumbersBeforeContinuation:
            publicAgentSessionMethods.includes("getCompactionRecovery") ||
            publicAgentSessionMethods.includes("compactAndMeasure"),
        hasPublicContinuationAfterManagedCompaction:
            publicAgentSessionMethods.includes("continueAfterCompaction") ||
            publicAgentSessionMethods.includes("continue"),
        hasQueueOrderContractForContinuation:
            publicAgentSessionMethods.includes("enqueueContinuation") ||
            publicAgentSessionMethods.includes("queueContinuation"),
        hasPrivateAutoCompactionOnly: agentSessionMethods.includes("_runAutoCompaction"),
        hasLowLevelAgentLoopConfig: agentMethods.includes("createLoopConfig"),
        hasPublicStreamFunction:
            "streamFunction" in api.AgentClass.prototype ||
            Object.getOwnPropertyNames(
                new api.AgentClass({ streamFn: () => messageStream(makeDoneMessage()) }),
            ).includes("streamFunction"),
    };
}

test("selected public Pi AgentSession contract lacks the required completed-turn stop and recovery hook", async () => {
    const repositoryRoot = new URL("../../../", import.meta.url);
    const packageConfig = JSON.parse(await fsReadFile(new URL("package.json", repositoryRoot), "utf8"));
    for (const [name, specifier] of Object.entries(packageConfig.dependencies)) {
        if (!name.startsWith("@earendil-works/")) continue;
        assertMatch(
            /** @type {string} */ (specifier),
            /^\d+\.\d+\.\d+$/,
            `${name} should use an exact npm version in the frozen Bun graph`,
        );
    }

    const contract = characterizePublicContextResilienceContract({
        AgentSessionClass: AgentSession,
        AgentClass: Agent,
        createSession: createAgentSession,
    });

    assertEquals(contract.hasCompletedTurnStopHook, false);
    assertEquals(contract.hasRecoveryNumbersBeforeContinuation, false);
    assertEquals(contract.hasPublicContinuationAfterManagedCompaction, false);
    assertEquals(contract.hasQueueOrderContractForContinuation, false);
    assertEquals("shouldStopAfterTurn" in Agent.prototype, false);
    assertEquals(contract.hasPublicStreamFunction, true);
    assertEquals(
        contract.hasLowLevelAgentLoopConfig,
        true,
        "low-level Agent exposes loop config only below RunWield's AgentSession seam",
    );
    assertEquals(
        contract.hasPrivateAutoCompactionOnly,
        true,
        "AgentSession compaction remains private and must not be used by RunWield",
    );
});
