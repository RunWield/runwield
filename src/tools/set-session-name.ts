/** Agent Custom Tool for setting the current Session Name. */

import { type Static, Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { HostedSession } from "../shared/session/hosted-session.js";
import { sanitizeSessionName } from "../shared/session-name.ts";
import { emitHostedSessionRuntimeEvent, RuntimeEventTypes } from "../shared/session/session-runtime-events.js";

export const SET_SESSION_NAME_TOOL_NAME = "set_session_name";

const PARAMETERS = Type.Object(
    {
        name: Type.String({
            minLength: 1,
            description:
                "Short 3-6 word Session Name suitable for /session display and the terminal tab title. Use a concise noun phrase, not a sentence.",
        }),
    },
    { additionalProperties: false },
);

type SetSessionNameParams = Static<typeof PARAMETERS>;

export interface SetSessionNameDetails {
    name: string;
}

type SetSessionNameResult = AgentToolResult<SetSessionNameDetails | null> & { isError?: boolean };

interface SetSessionNameToolOptions {
    hostedSession?: HostedSession | null;
}

function errorResult(message: string): SetSessionNameResult {
    return {
        content: [{ type: "text", text: message }],
        details: null,
        isError: true,
    };
}

export function createSetSessionNameTool({ hostedSession }: SetSessionNameToolOptions = {}) {
    return defineTool<typeof PARAMETERS, SetSessionNameDetails | null>({
        name: SET_SESSION_NAME_TOOL_NAME,
        label: "Set Session Name",
        description:
            "Set or replace the current Session Name. Use this early when the Session is unnamed, or later only when the user asks to rename the Session.",
        promptSnippet:
            "Set or replace the current Session Name with a short descriptive name when the Session is unnamed or the user asks to rename it.",
        parameters: PARAMETERS,
        async execute(_toolCallId, params: SetSessionNameParams): Promise<SetSessionNameResult> {
            await Promise.resolve();
            const name = sanitizeSessionName(params.name);
            if (!name) return errorResult("set_session_name rejected: name is empty after sanitization.");
            if (!hostedSession) return errorResult("set_session_name rejected: no active HostedSession is available.");

            const sessionManager = hostedSession.getRootSessionManager?.();
            if (!sessionManager || typeof sessionManager.appendSessionInfo !== "function") {
                return errorResult("set_session_name rejected: no writable root Session manager is available.");
            }

            sessionManager.appendSessionInfo(name);
            emitHostedSessionRuntimeEvent(hostedSession, { type: RuntimeEventTypes.SESSION_RENAMED, name });

            return {
                content: [{ type: "text", text: `Session name set: ${name}` }],
                details: { name },
            };
        },
    });
}
