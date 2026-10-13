import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { createAssistantMessageEventStream, normalizeContext } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { formatProviderError, normalizeProviderStream } from "./provider-errors.ts";

const model: Model<Api> = {
    api: "fixture",
    provider: "fixture",
    id: "model",
    name: "Model",
    baseUrl: "http://localhost",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
};
const context = normalizeContext({ messages: [] });
const usage = {
    input: 5,
    output: 3,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 8,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const partial: AssistantMessage = {
    role: "assistant",
    api: "fixture",
    provider: "fixture",
    model: "model",
    timestamp: 1,
    content: [{ type: "text", text: "Partial reply" }],
    usage,
    stopReason: "pending",
};

test("standalone EOF keeps partial response and final result in sync", async () => {
    const source = createAssistantMessageEventStream();
    const stream = normalizeProviderStream(() => source, model, context);
    source.push({ type: "start", partial });
    source.push({ type: "text_delta", contentIndex: 0, delta: "Partial reply", partial });
    source.push({
        type: "error",
        reason: "error",
        error: {
            ...partial,
            content: [],
            usage: { ...usage, input: 0, output: 0 },
            stopReason: "error",
            errorMessage: "Unexpected EOF",
        },
    });
    const events = [];
    for await (const event of stream) events.push(event);
    assertEquals(events.map((event) => event.type), ["start", "text_delta", "error"]);
    const failure = events.find((event) => event.type === "error");
    if (!failure || failure.type !== "error") throw new Error("Missing error event");
    assertEquals(failure.error.errorMessage, "Network error: Unexpected EOF");
    assertEquals(failure.error.content, partial.content);
    assertEquals(failure.error.usage, usage);
    assertEquals(await stream.result(), failure.error);
});

for (const failureKind of ["sync", "rejected", "iterator"]) {
    test(`${failureKind} provider failure settles with the last partial reply`, async () => {
        const source = createAssistantMessageEventStream();
        if (failureKind === "iterator") {
            const emitted: AssistantMessage = {
                ...partial,
                content: [
                    ...partial.content,
                    { type: "thinking", thinking: "thinking" },
                    { type: "toolCall", id: "unfinished", name: "do_not_run", arguments: {} },
                ],
            };
            source[Symbol.asyncIterator] = async function* () {
                yield { type: "start", partial: emitted };
                yield { type: "thinking_delta", contentIndex: 1, delta: "thinking", partial: emitted };
                yield { type: "toolcall_delta", contentIndex: 2, delta: "{", partial: emitted };
                throw new Error("Unexpected EOF");
            };
        }
        const provider = failureKind === "sync"
            ? () => {
                throw new Error("Unexpected EOF");
            }
            : failureKind === "rejected"
            ? () => Promise.reject(new Error("Unexpected EOF"))
            : () => source;
        const stream = normalizeProviderStream(provider, model, context);
        const events = [];
        for await (const event of stream) events.push(event);
        const failure = events.find((event) => event.type === "error");
        if (!failure || failure.type !== "error") throw new Error("Missing error event");
        assertEquals(failure.error.errorMessage, "Network error: Unexpected EOF");
        assertEquals(await stream.result(), failure.error);
        if (failureKind === "iterator") {
            assertEquals(failure.error.content.map((block) => block.type), ["text", "thinking", "toolCall"]);
            assertEquals(failure.error.usage, usage);
        }
    });
}

test("only an isolated EOF is normalized; abort and successful text are unchanged", async () => {
    for (const diagnostic of ["401 Unauthorized: Unexpected EOF", "insufficient_quota EOF", "invalid JSON EOF"]) {
        const source = createAssistantMessageEventStream();
        const stream = normalizeProviderStream(() => source, model, context);
        source.push({
            type: "error",
            reason: "error",
            error: { ...partial, stopReason: "error", errorMessage: diagnostic },
        });
        assertEquals((await stream.result()).errorMessage, diagnostic);
    }
    const lowercase = createAssistantMessageEventStream();
    const normalized = normalizeProviderStream(() => lowercase, model, context);
    lowercase.push({
        type: "error",
        reason: "error",
        error: { ...partial, stopReason: "error", errorMessage: "  unexpected eof  " },
    });
    assertEquals((await normalized.result()).errorMessage, "Network error: unexpected eof");
    const source = createAssistantMessageEventStream();
    const controller = new AbortController();
    const stream = normalizeProviderStream(() => source, model, context, { signal: controller.signal });
    controller.abort();
    source.push({
        type: "error",
        reason: "error",
        error: { ...partial, stopReason: "error", errorMessage: "Unexpected EOF" },
    });
    assertEquals((await stream.result()).stopReason, "aborted");
    const success = createAssistantMessageEventStream();
    const good = normalizeProviderStream(() => success, model, context);
    success.push({
        type: "done",
        reason: "stop",
        message: { ...partial, content: [{ type: "text", text: "Unexpected EOF" }], stopReason: "stop" },
    });
    assertEquals((await good.result()).content, [{ type: "text", text: "Unexpected EOF" }]);
});

test("display text is safe and specific without exposing the provider body", () => {
    const cases = [
        ["Unexpected EOF", "stopped responding"],
        ["socket hang up", "stopped responding"],
        ["503 <html>private</html>", "temporarily unavailable"],
        ["429", "too many requests"],
        ["401 Unauthorized", "verify your access"],
        ["insufficient_quota", "usage or billing limit"],
        ["You have hit your session limit", "usage or billing limit"],
        ["404 <!DOCTYPE html>private", "rejected this request"],
        ["invalid_request_error", "rejected this request"],
        ['{"secret":true}', "could not complete this request"],
    ];
    for (const [diagnostic, expected] of cases) {
        const message = formatProviderError(diagnostic);
        assertStringIncludes(message, expected);
        assertEquals(message.includes("private") || message.includes("secret"), false);
    }
});

test("provider receives the original model, context, options and cancellation signal once", async () => {
    const controller = new AbortController();
    const options = { signal: controller.signal, temperature: 0.4 };
    const source = createAssistantMessageEventStream();
    let calls = 0;
    const output = normalizeProviderStream(
        (receivedModel, receivedContext, receivedOptions) => {
            calls++;
            assertEquals(receivedModel, model);
            assertEquals(receivedContext, context);
            assertEquals(receivedOptions, options);
            return source;
        },
        model,
        context,
        options,
    );
    source.push({ type: "done", reason: "stop", message: { ...partial, stopReason: "stop" } });
    assertEquals(await output.result(), { ...partial, stopReason: "stop" });
    assertEquals(calls, 1);
});

test("final EOF cache usage is retained when ordinary token counters are zero", async () => {
    const source = createAssistantMessageEventStream();
    const stream = normalizeProviderStream(() => source, model, context);
    source.push({ type: "start", partial });
    const cacheUsage = { ...usage, input: 0, output: 0, cacheRead: 10, totalTokens: 10 };
    source.push({
        type: "error",
        reason: "error",
        error: {
            ...partial,
            content: [],
            usage: cacheUsage,
            stopReason: "error",
            errorMessage: "Unexpected EOF",
        },
    });
    assertEquals((await stream.result()).usage, cacheUsage);
    assertEquals((await stream.result()).content, partial.content);
});
