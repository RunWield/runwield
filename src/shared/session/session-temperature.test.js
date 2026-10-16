import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { strictEqual as assertStrictEquals } from "node:assert/strict";
import {
    createAssistantMessageEventStream,
    getCurrentSystemPrompt,
    getCurrentTools,
    normalizeContext,
} from "@earendil-works/pi-ai";
import { applySessionTemperature } from "./session.js";

/**
 * @typedef {Object} StreamCall
 * @property {import('@earendil-works/pi-ai').Model<import('@earendil-works/pi-ai').Api>} model
 * @property {import('@earendil-works/pi-ai').TranscriptContext} context
 * @property {import('@earendil-works/pi-ai').SimpleStreamOptions | undefined} options
 */

/**
 * @param {import('@earendil-works/pi-ai').Model<import('@earendil-works/pi-ai').Api>} model
 * @param {string} [errorMessage]
 * @returns {import('@earendil-works/pi-ai').AssistantMessage}
 */
function assistantMessage(model, errorMessage) {
    return {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: errorMessage ? "error" : "stop",
        ...(errorMessage ? { errorMessage } : {}),
        timestamp: Date.now(),
    };
}

/**
 * @param {import('@earendil-works/pi-ai').Model<import('@earendil-works/pi-ai').Api>} model
 * @param {string} [errorMessage]
 * @returns {import('@earendil-works/pi-ai').AssistantMessageEventStream}
 */
function completedStream(model, errorMessage) {
    const stream = createAssistantMessageEventStream();
    const message = assistantMessage(model, errorMessage);
    stream.push({ type: "start", partial: message });
    if (errorMessage) {
        stream.push({ type: "error", reason: "error", error: message });
    } else {
        stream.push({ type: "done", reason: "stop", message });
    }
    return stream;
}

/**
 * @param {(model: import('@earendil-works/pi-ai').Model<import('@earendil-works/pi-ai').Api>, options: import('@earendil-works/pi-ai').SimpleStreamOptions | undefined, calls: StreamCall[]) => import('@earendil-works/pi-ai').AssistantMessageEventStream | Promise<import('@earendil-works/pi-ai').AssistantMessageEventStream>} responder
 * @returns {{ session: import('@earendil-works/pi-coding-agent').AgentSession, calls: StreamCall[] }}
 */
function fakeSession(responder) {
    /** @type {StreamCall[]} */
    const calls = [];
    const session = /** @type {import('@earendil-works/pi-coding-agent').AgentSession} */ ({
        agent: {
            streamFunction(model, context, options) {
                calls.push({ model, context, options });
                return responder(model, options, calls);
            },
        },
    });
    return { session, calls };
}

/**
 * @param {Partial<import('@earendil-works/pi-ai').Model<import('@earendil-works/pi-ai').Api>>} overrides
 * @returns {import('@earendil-works/pi-ai').Model<import('@earendil-works/pi-ai').Api>}
 */
function testModel(overrides) {
    return {
        id: "test-model",
        name: "Test model",
        api: "openai-responses",
        provider: "test",
        baseUrl: "https://example.invalid",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
        maxTokens: 1000,
        ...overrides,
    };
}

test("applySessionTemperature omits temperature for known no-sampling model families", async () => {
    const noSamplingModels = [
        testModel({
            id: "gpt-5.6-sol",
            provider: "openai-codex",
            api: "openai-codex-responses",
        }),
        testModel({
            id: "kimi-code",
            provider: "kimi-coding",
            api: "openai-completions",
        }),
    ];

    for (const model of noSamplingModels) {
        const { session, calls } = fakeSession((model) => completedStream(model));
        applySessionTemperature(session, 0.4);

        const events = [];
        const source = await session.agent.streamFunction(
            model,
            normalizeContext({ messages: [] }),
            { temperature: 0.9 },
        );
        for await (const event of source) {
            events.push(event.type);
        }

        assertEquals(calls.length, 1);
        assertEquals(calls[0].options, {});
        assertEquals(events, ["start", "done"]);
    }
});

test("applySessionTemperature still configures providers that accept it", async () => {
    const { session, calls } = fakeSession((model) => completedStream(model));
    applySessionTemperature(session, 0.4);

    const model = testModel({ id: "temperature-model" });
    const source = await session.agent.streamFunction(
        model,
        normalizeContext({ messages: [] }),
        { maxTokens: 100 },
    );
    for await (const _event of source) {
        // Consume the wrapped stream.
    }

    assertEquals(calls.length, 1);
    assertEquals(calls[0].options, { maxTokens: 100, temperature: 0.4 });
});

test("applySessionTemperature retries exact unsupported parameter errors without duplicate start", async () => {
    const { session, calls } = fakeSession((model, options) => {
        if (options?.temperature !== undefined) {
            return completedStream(model, "Codex error: Unsupported parameter: temperature");
        }
        return completedStream(model);
    });
    applySessionTemperature(session, 0.4);

    const model = testModel({ id: "future-reasoning-model" });
    const transcript = normalizeContext({
        messages: [
            {
                role: "system",
                content: "Base instructions",
                toolsAdded: [{ name: "obsolete", description: "Old tool", parameters: { type: "object" } }],
                timestamp: 1,
            },
            { role: "user", content: [{ type: "text", text: "request" }], timestamp: 2 },
            {
                role: "system",
                content: "Later instructions",
                toolsRemoved: [{ name: "obsolete" }],
                toolsAdded: [{ name: "current", description: "Current tool", parameters: { type: "object" } }],
                timestamp: 3,
            },
        ],
    });
    const events = [];
    const signal = AbortSignal.timeout(5_000);
    const source = await session.agent.streamFunction(
        model,
        transcript,
        { maxTokens: 100, signal },
    );
    for await (const event of source) {
        events.push(event.type);
    }

    assertEquals(calls.length, 2);
    assertStrictEquals(calls[0].context, transcript);
    assertStrictEquals(calls[1].context, transcript);
    assertEquals(getCurrentSystemPrompt(calls[1].context.messages), "Base instructions\n\nLater instructions");
    assertEquals(getCurrentTools(calls[1].context.messages).map((tool) => tool.name), ["current"]);
    assertEquals(calls[0].options?.maxTokens, 100);
    assertEquals(calls[0].options?.temperature, 0.4);
    assertStrictEquals(calls[0].options?.signal, signal);
    assertEquals(calls[1].options?.maxTokens, 100);
    assertEquals(calls[1].options?.temperature, undefined);
    assertStrictEquals(calls[1].options?.signal, signal);
    assertEquals(events, ["start", "done"]);
});

test("applySessionTemperature retries temperature capability errors", async () => {
    const temperatureCapabilityErrors = [
        '400: {"message":"invalid temperature: only 1 is allowed for this model","type":"invalid_request_error"}',
        "temperature is not supported by this model",
        "temperature is not allowed for this model",
    ];

    for (const [index, errorMessage] of temperatureCapabilityErrors.entries()) {
        const { session, calls } = fakeSession((model, options) => {
            if (options?.temperature !== undefined) {
                return completedStream(model, errorMessage);
            }
            return completedStream(model);
        });
        applySessionTemperature(session, 0.4);

        const model = testModel({ id: `fixed-temperature-model-${index}` });
        const events = [];
        const source = await session.agent.streamFunction(
            model,
            normalizeContext({ messages: [] }),
            { maxTokens: 100 },
        );
        for await (const event of source) {
            events.push(event.type);
        }

        assertEquals(calls.map((call) => call.options), [
            { maxTokens: 100, temperature: 0.4 },
            { maxTokens: 100 },
        ]);
        assertEquals(events, ["start", "done"]);
    }
});

test("applySessionTemperature remembers discovered temperature capability failures", async () => {
    const model = testModel({ id: "runtime-discovered-no-temperature" });
    const { session, calls } = fakeSession((model, options) => {
        if (options?.temperature !== undefined) {
            return completedStream(model, "temperature is not accepted by this model");
        }
        return completedStream(model);
    });
    applySessionTemperature(session, 0.4);

    for (let i = 0; i < 2; i += 1) {
        const source = await session.agent.streamFunction(
            model,
            normalizeContext({ messages: [] }),
            { maxTokens: 100 },
        );
        for await (const _event of source) {
            // Consume the wrapped stream.
        }
    }

    assertEquals(calls.map((call) => call.options), [
        { maxTokens: 100, temperature: 0.4 },
        { maxTokens: 100 },
        { maxTokens: 100 },
    ]);
});

test("applySessionTemperature retries rejected temperature capability requests", async () => {
    const model = testModel({ id: "kimi-k3-preview", provider: "moonshotai", api: "openai-completions" });
    const { session, calls } = fakeSession((model, options) => {
        if (options?.temperature !== undefined) {
            return Promise.reject(
                new Error(
                    '400: {"message":"invalid temperature: only 1 is allowed for this model","type":"invalid_request_error"}',
                ),
            );
        }
        return completedStream(model);
    });
    applySessionTemperature(session, 0.4);

    const events = [];
    const source = await session.agent.streamFunction(
        model,
        normalizeContext({ messages: [] }),
        { maxTokens: 100 },
    );
    for await (const event of source) {
        events.push(event.type);
    }

    assertEquals(calls.map((call) => call.options), [
        { maxTokens: 100, temperature: 0.4 },
        { maxTokens: 100 },
    ]);
    assertEquals(events, ["start", "done"]);
});

test("applySessionTemperature terminates wrapped streams on rejected provider errors and cancellation", async () => {
    const cases = [
        { error: new Error("provider offline"), reason: "error" },
        { error: new DOMException("turn canceled", "AbortError"), reason: "aborted" },
    ];

    for (const [index, testCase] of cases.entries()) {
        const model = testModel({ id: `rejected-provider-${index}` });
        const { session, calls } = fakeSession(() => Promise.reject(testCase.error));
        applySessionTemperature(session, 0.4);

        const events = [];
        const source = await session.agent.streamFunction(
            model,
            normalizeContext({ messages: [] }),
            { maxTokens: 100 },
        );
        for await (const event of source) {
            events.push(event);
        }

        assertEquals(calls.length, 1);
        assertEquals(events.map((event) => event.type), ["error"]);
        const errorEvent = events[0];
        if (errorEvent.type !== "error") throw new Error("expected an error event");
        assertEquals(errorEvent.reason, testCase.reason);
        assertEquals(errorEvent.error.errorMessage, testCase.error.message);
    }
});

test("applySessionTemperature does not retry unsupported temperature after content starts", async () => {
    const model = testModel({ id: "partial-temperature-rejection" });
    const { session, calls } = fakeSession((model) => {
        const stream = createAssistantMessageEventStream();
        const partial = assistantMessage(model);
        partial.content = [{ type: "text", text: "" }];
        const error = assistantMessage(model, "temperature is not supported by this model");
        stream.push({ type: "start", partial });
        stream.push({ type: "text_start", contentIndex: 0, partial });
        stream.push({ type: "error", reason: "error", error });
        return stream;
    });
    applySessionTemperature(session, 0.4);

    const events = [];
    const source = await session.agent.streamFunction(
        model,
        normalizeContext({ messages: [] }),
        { maxTokens: 100 },
    );
    for await (const event of source) {
        events.push(event.type);
    }

    assertEquals(calls.length, 1);
    assertEquals(events, ["start", "text_start", "error"]);
});
