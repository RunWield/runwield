export const MAX_WEB_FETCH_CHARS = 50_000;

/** Returned text, including the truncation notice when the character limit was exceeded. */
export interface WebTextResult {
    text: string;
    truncated: boolean;
}

function limitText(text: string, maxChars: number, tool: "web_search" | "web_fetch"): WebTextResult {
    if (text.length <= maxChars) return { text, truncated: false };
    const marker = `\n\n[${tool} output truncated at ${maxChars} characters. Use maxChars or a narrower request for remaining content.]`;
    return { text: text.slice(0, maxChars) + marker, truncated: true };
}

export function limitWebSearchText(text: string, maxChars?: number): WebTextResult {
    return limitText(text, maxChars ?? MAX_WEB_FETCH_CHARS, "web_search");
}

export function limitWebFetchText(text: string, maxChars?: number): WebTextResult {
    return limitText(text, maxChars ?? MAX_WEB_FETCH_CHARS, "web_fetch");
}
