import {
    createAssistantMessageEventStream,
    type Api,
    type AssistantMessageEvent,
    type AssistantMessageEventStream,
    type Model,
    type SimpleStreamOptions,
    type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

interface SamplingCompatibility {
    supportsDeveloperRole?: boolean;
    supportsTemperature?: boolean;
}
type ModelCompatibility = NonNullable<Model<Api>["compat"]> & SamplingCompatibility;
type ProviderStreamAgent = AgentSession["agent"] & { streamFn: AgentSession["agent"]["streamFunction"] };

const UNSUPPORTED_TEMPERATURE_RE =
    /\bunsupported (?:parameter|field|argument)\b[^.:\n]*(?::|\b)\s*["']?temperature["']?|\btemperature\b[^.:\n]*\b(?:unsupported|not supported|not allowed|not accepted|invalid temperature)\b|\binvalid temperature\b.*\bonly\b.*\ballowed\b/i;

const modelsWithoutTemperature: Set<string> = new Set();

function getErrorMessage<Value>(value: Value): string {
    if (value instanceof Error) return value.message;
    if (value && typeof value === "object" && "errorMessage" in value) {
        return String(value.errorMessage ?? "");
    }
    return String(value ?? "");
}

function isUnsupportedTemperatureError<Value>(error: Value): boolean {
    return UNSUPPORTED_TEMPERATURE_RE.test(getErrorMessage(error));
}

function getTemperatureCapabilityModelKey(model: Model<Api>): string {
    return [model.provider, model.api, model.id].filter(Boolean).join(":");
}

function isKnownNoSamplingModelFamily(model: Model<Api>): boolean {
    const provider = String(model.provider || "").toLowerCase();
    const api = String(model.api || "").toLowerCase();
    const id = String(model.id || "").toLowerCase();
    return (
        provider === "openai-codex" ||
        api === "openai-codex-responses" ||
        provider.includes("kimi") ||
        id.includes("kimi-code") ||
        id.includes("kimi-coding")
    );
}

function isKimiModelFamily(model: Model<Api>): boolean {
    const provider = String(model.provider || "").toLowerCase();
    const id = String(model.id || "").toLowerCase();
    return provider.includes("kimi") || id.includes("kimi-code") || id.includes("kimi-coding");
}

/** Apply the Pi compatibility flags required by known coding-model families. */
export function withModelExecutionCompatibility<ModelType extends Model<Api>>(
    model: ModelType,
): ModelType & { compat?: ModelCompatibility } {
    if (!isKimiModelFamily(model)) return model;
    return {
        ...model,
        compat: {
            ...model.compat,
            supportsDeveloperRole: false,
            supportsTemperature: false,
        },
    };
}

/**
 * The ChatGPT Codex Responses endpoint and some coding-model families reject
 * sampling temperature. Detect known capability signals up front and remember
 * runtime rejections so later calls avoid repeating the failed request.
 */
function modelSupportsTemperature(model: Model<Api>): boolean {
    const compat = model.compat as ModelCompatibility | undefined;
    if (compat?.supportsTemperature === false) return false;
    if (isKnownNoSamplingModelFamily(model)) return false;
    return !modelsWithoutTemperature.has(getTemperatureCapabilityModelKey(model));
}

/**
 * Some provider/model APIs reject `temperature` even though pi-ai exposes it as
 * a generic stream option. Retry once without temperature when the provider
 * reports that exact incompatibility before emitting assistant content.
 */
function createTemperatureFallbackStream(
    firstSource: AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
    retryWithoutTemperature: () => AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
    onUnsupportedTemperature: (() => void) | undefined,
    model: Model<Api>,
): AssistantMessageEventStream {
    const output = createAssistantMessageEventStream();

    function finishWithError(error: Error | DOMException) {
        const aborted = error.name === "AbortError";
        output.push({
            type: "error",
            reason: aborted ? "aborted" : "error",
            error: {
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
                stopReason: aborted ? "aborted" : "error",
                errorMessage: error.message,
                timestamp: Date.now(),
            },
        });
    }

    async function forward(
        sourcePromise: AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
        canRetry: boolean,
    ): Promise<"retry" | "done"> {
        let source;
        try {
            source = await sourcePromise;
        } catch (error) {
            if (canRetry && isUnsupportedTemperatureError(error)) {
                onUnsupportedTemperature?.();
                return "retry";
            }
            throw error;
        }
        let emittedAssistantContent = false;
        const pendingLifecycleEvents: AssistantMessageEvent[] = [];
        for await (const event of source) {
            if (
                event.type === "error" &&
                !emittedAssistantContent &&
                canRetry &&
                isUnsupportedTemperatureError(event.error)
            ) {
                onUnsupportedTemperature?.();
                return "retry";
            }

            // Providers may emit `start` before reporting request validation
            // errors. Hold it until the first substantive event so a fallback
            // can discard the failed attempt without duplicating lifecycle
            // events in the replacement stream.
            if (event.type === "start") {
                pendingLifecycleEvents.push(event);
                continue;
            }
            for (const pendingEvent of pendingLifecycleEvents.splice(0)) {
                output.push(pendingEvent);
            }
            if (event.type !== "error" && event.type !== "done") {
                emittedAssistantContent = true;
            }
            output.push(event);
        }
        for (const pendingEvent of pendingLifecycleEvents) {
            output.push(pendingEvent);
        }
        return "done";
    }

    (async () => {
        try {
            const result = await forward(firstSource, true);
            if (result === "retry") {
                await forward(retryWithoutTemperature(), false);
            }
            output.end();
        } catch (error) {
            finishWithError(error instanceof Error ? error : new Error(String(error)));
        }
    })();

    return output;
}

function omitTemperatureOption(options: SimpleStreamOptions | undefined): SimpleStreamOptions | undefined {
    if (!options) return undefined;
    const { temperature: _temperature, ...withoutTemperature } = options;
    return withoutTemperature;
}

/** Apply an agent-level temperature as the default for provider requests in a session. */
export function applySessionTemperature(session: AgentSession, temperature: number | undefined) {
    if (temperature === undefined) return;
    const agent = session.agent as ProviderStreamAgent;
    const streamKey = typeof agent.streamFunction === "function" ? "streamFunction" : "streamFn";
    const originalStreamFunction = agent[streamKey];
    agent[streamKey] = (model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions | undefined) => {
        if (!modelSupportsTemperature(model)) {
            return originalStreamFunction(model, context, omitTemperatureOption(options));
        }
        const optionsWithTemperature = {
            ...options,
            temperature,
        };
        try {
            const firstSource = originalStreamFunction(model, context, optionsWithTemperature);
            return createTemperatureFallbackStream(
                firstSource,
                () => originalStreamFunction(model, context, omitTemperatureOption(options)),
                () => modelsWithoutTemperature.add(getTemperatureCapabilityModelKey(model)),
                model,
            );
        } catch (error) {
            if (isUnsupportedTemperatureError(error)) {
                modelsWithoutTemperature.add(getTemperatureCapabilityModelKey(model));
                return originalStreamFunction(model, context, omitTemperatureOption(options));
            }
            throw error;
        }
    };
}
