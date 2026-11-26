import { Type } from "typebox";

const SESSION_NAME_MAX_LENGTH = 40;

/** Sanitize and bound the requested Session name before the caller saves it. */
export function sanitizeSessionName(value: string | null | undefined): string {
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

export const SET_SESSION_NAME_TOOL = {
    name: "set_session_name",
    label: "Set Session Name",
    description:
        "Set or replace the current Session Name. Use this early when the Session is unnamed, or later only when the user asks to rename the Session.",
    promptSnippet:
        "Set or replace the current Session Name with a short descriptive name when the Session is unnamed or the user asks to rename it.",
    parameters: Type.Object(
        {
            name: Type.String({
                minLength: 1,
                description:
                    "Short 3-6 word Session Name suitable for /session display and the terminal tab title. Use a concise noun phrase, not a sentence.",
            }),
        },
        { additionalProperties: false },
    ),
} as const;
