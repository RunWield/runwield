/**
 * @module shared/session-name
 * UI-independent persisted Session Name normalization.
 */

const SESSION_NAME_MAX_LENGTH = 40;

export function sanitizeSessionName<Value>(value: Value): string {
    return Array.from(String(value ?? ""), (char) => {
        const code = char.charCodeAt(0);
        return code < 32 || code === 127 ? " " : char;
    })
        .join("")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, SESSION_NAME_MAX_LENGTH)
        .trim();
}

export function formatSessionTerminalTitle<Value>(name: Value): string {
    const sanitized = sanitizeSessionName(name);
    return sanitized ? `W. - ${sanitized}` : "W.";
}
