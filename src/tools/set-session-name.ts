/** Agent Custom Tool for setting the current Session Name. */

import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { emitHostedSessionRuntimeEvent, type HostedSession } from "@runwield/session-runtime/host";
import { toolRegistry, type SetSessionNameDetails } from "@runwield/tools";
import { RuntimeEventTypes } from "@runwield/session-runtime/events";

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
    const tool = toolRegistry.get("set_session_name");
    return defineTool<typeof tool.definition.parameters, SetSessionNameDetails | null>({
        ...tool.definition,
        async execute(_toolCallId, params): Promise<SetSessionNameResult> {
            await Promise.resolve();
            const name = tool.sanitize(params.name);
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
