import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
    Api,
    AssistantMessage,
    AssistantMessageEventStream,
    Model,
    SimpleStreamOptions,
    TranscriptContext,
} from "@earendil-works/pi-ai";

const EOF_ERROR = /^unexpected eof\.?$/i;

function normalizeEof(message: string) {
    return EOF_ERROR.test(message.trim()) ? `Network error: ${message.trim()}` : message;
}

/**
 * Public provider-stream adapter. It changes only the diagnostic Pi uses to
 * classify a standalone EOF; Pi still owns every retry and backoff.
 */
export function normalizeProviderStream(
    source: (
        model: Model<Api>,
        context: TranscriptContext,
        options?: SimpleStreamOptions,
    ) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
): AssistantMessageEventStream {
    const output = createAssistantMessageEventStream();
    // Start the provider synchronously: a deferred start can move steering and
    // cancellation across the request boundary.
    let initial;
    try {
        initial = source(model, context, options);
    } catch (error) {
        initial = Promise.reject(error);
    }
    (async () => {
        let partial: AssistantMessage | undefined;
        try {
            const input = await initial;
            for await (const event of input) {
                if (event.type === "start" || "partial" in event) partial = event.partial;
                if (event.type === "error") {
                    const aborted = event.reason === "aborted" || options?.signal?.aborted;
                    const error = event.error;
                    const saved =
                        partial && error.content.length === 0 && partial.content.length
                            ? {
                                  ...error,
                                  content: partial.content,
                                  usage:
                                      error.usage.input ||
                                      error.usage.output ||
                                      error.usage.cacheRead ||
                                      error.usage.cacheWrite ||
                                      Object.values(error.usage.cost).some((value) => value !== 0)
                                          ? error.usage
                                          : partial.usage,
                              }
                            : error;
                    output.push({
                        ...event,
                        reason: aborted ? "aborted" : event.reason,
                        error: {
                            ...saved,
                            stopReason: aborted ? "aborted" : saved.stopReason,
                            errorMessage: aborted ? saved.errorMessage : normalizeEof(saved.errorMessage || ""),
                        },
                    });
                } else {
                    output.push(event);
                }
                if (event.type === "error" || event.type === "done") return;
            }
            throw new Error("Provider stream ended without a terminal response event");
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            const aborted = options?.signal?.aborted || (cause instanceof Error && cause.name === "AbortError");
            output.push({
                type: "error",
                reason: aborted ? "aborted" : "error",
                error: {
                    role: "assistant",
                    content: partial?.content || [],
                    api: model.api,
                    provider: model.provider,
                    model: model.id,
                    usage: partial?.usage || {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        totalTokens: 0,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                    },
                    stopReason: aborted ? "aborted" : "error",
                    errorMessage: aborted ? message : normalizeEof(message),
                    timestamp: Date.now(),
                },
            });
        }
    })();
    return output;
}
