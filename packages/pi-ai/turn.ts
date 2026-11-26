import type { JsonValue } from "@runwield/parsing/jsonc";

/** An encoded image to include in a model turn. */
export interface TurnImage {
    type: "image";
    data: string;
    mimeType: string;
}

/** A text request and any accompanying images. */
export interface TurnInput {
    text: string;
    images?: TurnImage[];
}

/** Token and cost measurements reported for one request. Missing fields are unmeasured. */
export interface TurnUsage {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    costAmount?: number;
}

/** Text, usage and terminal status from a direct provider completion. */
export interface CompletedTurn {
    text: string;
    usage?: TurnUsage;
    status: "succeeded" | "failed" | "canceled";
    errorMessage?: string;
}

/** Describe a provider failure after the session exhausted its retries. */
export function formatProviderRetryExhaustion(diagnostic: string | undefined, retries: number) {
    const message = formatProviderError(diagnostic);
    const retryCount = `${retries} ${retries === 1 ? "retry was" : "retries were"} completed.`;
    const temporary = /stopped responding|temporarily unavailable|too many requests/.test(message);
    return `${message} ${retryCount}${temporary ? " You can try again." : ""}`;
}

/** Map a provider diagnostic to a user-facing failure message. */
export function formatProviderError(diagnostic: string | undefined) {
    const text = diagnostic || "";
    if (/insufficient_quota|quota|billing|out of budget|usage limit|session limit|available balance/i.test(text)) {
        return "The model service reports a usage or billing limit. Check your account.";
    }
    if (/\b401\b|\b403\b|unauthori[sz]ed|authentication|invalid.api.key|credential/i.test(text)) {
        return "The model service could not verify your access. Check your sign-in or API credentials.";
    }
    if (
        /unexpected eof|stream ended without|stream ended before|socket hang up|connection (?:error|lost)|network error|fetch failed/i.test(
            text,
        )
    ) {
        return "The model service stopped responding before the reply was complete.";
    }
    if (/\b429\b|rate.?limit|too many requests/i.test(text)) {
        return "The model service is receiving too many requests.";
    }
    if (/\b50[0234]\b|\b52[04]\b|overloaded|service unavailable|server error|timeout|timed out/i.test(text)) {
        return "The model service is temporarily unavailable.";
    }
    if (/\b40[04]\b|invalid.request|bad request|model not found|endpoint|context (?:length|overflow)/i.test(text)) {
        return "The model service rejected this request. Check the selected model and provider settings.";
    }
    return "The model service could not complete this request.";
}

/** Text or image content returned during or after a tool call. */
export type ToolContentBlock = { type: "text"; text: string } | TurnImage;

/** A tool result with structured content and its rendered text. */
export interface ToolResult {
    /** Complete displayable content snapshot. */
    content: ToolContentBlock[];
    /** Complete text-only projection for text surfaces. */
    output: string;
    /** Structured tool result details such as truncation metadata. */
    details: ToolDetails | null;
}

type ToolDetails = Record<string, JsonValue | undefined> | JsonValue[];

/** A tool result envelope from a live turn or recorded transcript. */
interface ToolResultEnvelope {
    content?: ToolResultBlock[] | string | null;
    details?: ToolDetails | null;
}

/** Content fields recognized from current or older tool results. */
interface ToolResultBlock {
    type?: JsonValue;
    text?: JsonValue;
    data?: JsonValue;
    mimeType?: JsonValue;
}

/** A tool envelope, its bare content, or plain output from a shell or older transcript. */
export type ToolResultInput =
    ToolResultEnvelope | ToolResultBlock | ToolResultBlock[] | JsonValue | bigint | symbol | undefined;

function removeModelOnlyImageOmissionNotes(output: string) {
    return output
        .split("\n")
        .filter(
            (line) =>
                !line.startsWith("[Image omitted:") && !line.startsWith("[Current model does not support images."),
        )
        .join("\n")
        .trimEnd();
}

/** Map tool envelopes and plain output to structured content and display text. */
export function normalizeToolResult(value: ToolResultInput): ToolResult {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : null;
    const envelopedContent = source && "content" in source ? source.content : undefined;
    const rawContent: readonly ToolResultInput[] = Array.isArray(value)
        ? value
        : Array.isArray(envelopedContent)
          ? envelopedContent
          : [value];

    const content: ToolContentBlock[] = [];
    for (const block of rawContent) {
        if (block === undefined || block === null) continue;
        if (typeof block !== "object") {
            content.push({ type: "text", text: String(block) });
            continue;
        }
        if (
            "type" in block &&
            block.type === "image" &&
            "data" in block &&
            typeof block.data === "string" &&
            "mimeType" in block &&
            typeof block.mimeType === "string"
        ) {
            content.push({ type: "image", data: block.data, mimeType: block.mimeType });
            continue;
        }
        if ("text" in block && typeof block.text === "string") content.push({ type: "text", text: block.text });
    }
    const rawDetails = source && "details" in source ? source.details : undefined;
    const details = rawDetails && typeof rawDetails === "object" ? rawDetails : null;
    const displayDetails = Array.isArray(details) ? null : details;
    let output =
        displayDetails?.runwieldDisplay === "binary_display_suppressed"
            ? ""
            : content
                  .filter((block) => block.type === "text")
                  .map((block) => block.text)
                  .join("");
    if (Array.isArray(displayDetails?.runwieldDisplayImages)) {
        output = removeModelOnlyImageOmissionNotes(output);
    }
    return {
        content,
        output,
        details,
    };
}
