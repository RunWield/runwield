/**
 * @module ui/tui/bash-interceptor
 * Parses TUI `!command` and `!!command` input, then delegates execution to
 * the public SessionRuntime surface.
 */

import type { InteractiveSessionRuntime as SessionRuntime } from "@runwield/session-runtime/services";

export interface BashContext {
    userRequest: string;
    sessionRuntime: SessionRuntime;
    sessionId: string;
    concurrent?: boolean;
}

export async function handleBashCommand(ctx: BashContext): Promise<boolean> {
    const { userRequest } = ctx;
    if (!userRequest.startsWith("!")) return false;

    const ephemeral = userRequest.startsWith("!!");
    const command = (ephemeral ? userRequest.slice(2) : userRequest.slice(1)).trim();
    if (!command) return true;

    await ctx.sessionRuntime.runLocalShellCommand(ctx.sessionId, {
        command,
        userRequest,
        persist: !ephemeral && !ctx.concurrent,
    });
    return true;
}
