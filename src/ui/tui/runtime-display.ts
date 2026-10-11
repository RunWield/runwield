/** Shared conversation renderer. It consumes live or replay events, never a Runtime. */
import type { AgentMessageAppender, UiAPI } from "./types.js";
import { RuntimeEventTypes } from "../../shared/session/session-runtime-events.js";

const HIDDEN_TOOL_BLOCK_NAMES = new Set(["task_completed", "review_complete", "triage_report", "user_interview"]);

interface RuntimeDisplayImage {
    base64: string;
    mimeType: string;
}

type RuntimeDisplayEvent = Partial<
    ReturnType<typeof import("../../shared/session/session-transcript-projection.js").createReplayEvents>[number]
>;

interface RuntimeDisplayImageCandidate {
    base64?: string;
    mimeType?: string;
}

function collectDetailDisplayImage(image: RuntimeDisplayImageCandidate): RuntimeDisplayImage[] {
    return typeof image.base64 === "string" && typeof image.mimeType === "string"
        ? [{ base64: image.base64, mimeType: image.mimeType }]
        : [];
}

function collectRuntimeDisplayImages(event: RuntimeDisplayEvent): RuntimeDisplayImage[] {
    const contentImages = Array.isArray(event.content)
        ? event.content.flatMap((block) =>
            block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string"
                ? [{ base64: block.data, mimeType: block.mimeType }]
                : []
        )
        : [];
    const detailImages = Array.isArray(event.details?.runwieldDisplayImages)
        ? event.details.runwieldDisplayImages.flatMap(collectDetailDisplayImage)
        : [];
    const images: RuntimeDisplayImage[] = [];
    const seen = new Set();
    for (const image of [...contentImages, ...detailImages]) {
        const key = `${image.mimeType}:${image.base64}`;
        if (seen.has(key)) continue;
        seen.add(key);
        images.push(image);
    }
    return images;
}

export function createTuiDisplayConsumer(uiAPI: UiAPI) {
    const assistantMessages = new Map<string, AgentMessageAppender>();
    const thinkingMessages = new Map<string, ReturnType<NonNullable<UiAPI["appendThinkingStart"]>>>();
    return {
        consume(event: RuntimeDisplayEvent) {
            const value = event;
            switch (event.type) {
                case RuntimeEventTypes.USER_MESSAGE:
                    if (!(typeof value.text === "string" && value.text.startsWith("!") && value.images.length === 0)) {
                        uiAPI.appendUserMessage?.(value.text);
                        for (const image of value.images) uiAPI.appendImage?.(image.base64, image.mimeType);
                    }
                    break;
                case RuntimeEventTypes.ASSISTANT_TEXT_DELTA: {
                    const messageId = value.messageId;
                    let appender = assistantMessages.get(messageId);
                    if (!appender) {
                        appender = uiAPI.appendAgentMessageStart(value.agentName);
                        assistantMessages.set(messageId, appender);
                    }
                    appender.appendText(value.delta);
                    break;
                }
                case RuntimeEventTypes.ASSISTANT_THINKING_DELTA: {
                    if (value._meta?.replay) break;
                    if (!uiAPI.appendThinkingStart) break;
                    const messageId = value.messageId;
                    let appender = thinkingMessages.get(messageId);
                    if (!appender) {
                        appender = uiAPI.appendThinkingStart();
                        thinkingMessages.set(messageId, appender);
                    }
                    appender.appendDelta(value.delta);
                    break;
                }
                case RuntimeEventTypes.ASSISTANT_THINKING_END: {
                    if (value._meta?.replay) break;
                    const messageId = value.messageId;
                    thinkingMessages.get(messageId)?.end();
                    thinkingMessages.delete(messageId);
                    break;
                }
                case RuntimeEventTypes.TOOL_START: {
                    if (!uiAPI.startToolExecution || HIDDEN_TOOL_BLOCK_NAMES.has(value.toolName)) break;
                    uiAPI.startToolExecution(value.toolCallId, value.toolName, value.title);
                    break;
                }
                case RuntimeEventTypes.TOOL_UPDATE: {
                    const block = uiAPI.getActiveToolBlock?.(value.toolCallId);
                    block?.setOutput(value.output);
                    break;
                }
                case RuntimeEventTypes.TOOL_END: {
                    const block = uiAPI.getActiveToolBlock?.(value.toolCallId);
                    const images = collectRuntimeDisplayImages(value);
                    if (
                        !block && value.toolName === "task_completed" &&
                        value.details?.outcome === "pair_completion_checkpoint" && value.output
                    ) {
                        uiAPI.appendSystemMessage(value.output, false, "Pair checkpoint");
                    }
                    if (block) {
                        block.setOutput(value.output);
                        for (const image of images) block.appendDisplayImage?.(image.base64, image.mimeType);
                        block.endExecution(value.isError, value.durationMs);
                    } else {
                        for (const image of images) uiAPI.appendImage?.(image.base64, image.mimeType);
                    }
                    break;
                }
                case RuntimeEventTypes.TURN_END:
                    assistantMessages.clear();
                    for (const appender of thinkingMessages.values()) appender.end();
                    thinkingMessages.clear();
                    break;
                case RuntimeEventTypes.SYSTEM_STATUS:
                    uiAPI.appendSystemMessage(value.message, value.level === "error", value.header);
                    break;
                case RuntimeEventTypes.CANCELLATION:
                    if (value.message) uiAPI.appendSystemMessage(value.message, false, "RunWield");
                    break;
                case RuntimeEventTypes.TERMINAL_ERROR:
                    if (!value.messageAlreadyReported) uiAPI.appendSystemMessage(value.message, true);
                    break;
            }
        },
        dispose() {
            for (const appender of thinkingMessages.values()) appender.end();
            thinkingMessages.clear();
            assistantMessages.clear();
        },
    };
}
