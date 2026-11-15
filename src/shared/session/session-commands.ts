/** Semantic command support for clients that do not host an interactive Runtime. */
import { getSlashCommandDefinition, getSlashCommandDefinitions } from "../../cmd/registry.js";
import { runHelpCommand } from "../../cmd/help/index.ts";
import { runContextCommand } from "../../cmd/context/index.ts";
import type { SessionRuntime } from "./session-runtime.ts";
import type { SessionCommandResult } from "./session-input-contract.ts";
export interface SessionCommandContext {
    runtime: SessionRuntime;
    sessionId?: string;
}
export function supportedSessionCommands() {
    return getSlashCommandDefinitions("workspace").filter((command) => command.sessionAction);
}
export function parseSessionCommand(text: string) {
    if (!text.trim().startsWith("/") || /[\r\n]/.test(text)) throw new Error("Use one slash command line.");
    const [name, ...args] = text.trim().slice(1).split(/\s+/);
    return { name, args };
}
export async function executeSessionCommand(
    text: string,
    context: SessionCommandContext,
): Promise<SessionCommandResult> {
    const { name, args } = parseSessionCommand(text);
    const definition = getSlashCommandDefinition(name, "workspace");
    if (!definition?.sessionAction) throw new Error(`Command /${name} is not supported in this Session client.`);
    const action = definition.sessionAction;
    if (action === "agent" || action === "model") {
        if (!args.length) return { action };
        if (args.length !== 1) throw new Error(`Use /${definition.name} with one selection.`);
        if (action === "agent") return { action: "configure", selection: { agentName: args[0] } };
        const slash = args[0].indexOf("/");
        if (slash < 1 || slash === args[0].length - 1) throw new Error("Use /model provider/model.");
        return {
            action: "configure",
            selection: { provider: args[0].slice(0, slash), model: args[0].slice(slash + 1) },
        };
    }
    if (action === "new") {
        if (args.length) throw new Error("Use /new without a name in this Session client.");
        return { action: "new" };
    }
    const messages: string[] = [];
    const uiAPI = {
        appendSystemMessage: (message: string) => {
            messages.push(message);
        },
    };
    if (action === "help")
        await runHelpCommand(args, {
            uiAPI,
            slashSurface: "workspace",
            commandNames: supportedSessionCommands().map((command) => command.name),
        });
    else
        await runContextCommand(args, {
            uiAPI,
            plainText: true,
            sessionRuntime: context.runtime,
            sessionId: context.sessionId,
        });
    return { action: "message", message: messages.join("\n\n").replace(/\x1b\[[0-9;]*m/g, "") };
}
