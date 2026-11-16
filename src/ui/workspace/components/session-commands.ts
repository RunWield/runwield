export const WORKSPACE_COMMAND_NAMES = [
    "agent",
    "model",
    "new",
    "resume",
    "settings",
    "plans",
    "session",
    "context",
    "help",
] as const;

export interface SessionCommand {
    name: string;
    description: string;
    kind: "action" | "prompt";
}

export interface SessionAgentDefaults {
    model: string;
    provider: string;
    thinkingLevel: string;
}

export interface SessionAgentOption {
    name: string;
    displayName?: string;
    defaults?: SessionAgentDefaults;
}

export interface SessionModelOption {
    provider: string;
    id: string;
    name?: string;
}

export interface SessionCommandSuggestion {
    key: string;
    label: string;
    description: string;
    value: string;
    kind: "command" | "agent" | "model";
}

export interface SessionCommandOptions {
    commands: SessionCommand[];
    agents: SessionAgentOption[];
    models: SessionModelOption[];
}

/** Model identity stays unambiguous even when providers use the same display name. */
export function sessionModelLabel(model: SessionModelOption): string {
    return `${model.provider}/${model.id}`;
}

export function sessionAgentSelection(agent: SessionAgentOption): SessionAgentDefaults {
    return agent.defaults || { model: "", provider: "", thinkingLevel: "default" };
}

/** Only a leading slash opens the command picker; ordinary prose stays ordinary prose. */
export function sessionCommandSuggestions(draft: string, options: SessionCommandOptions): SessionCommandSuggestion[] {
    const match = /^\/([^\s]*)(?:[ \t]+([^\n]*))?$/.exec(draft);
    if (!match) return [];
    const [, command, argument] = match;
    if (argument === undefined) {
        return options.commands
            .filter((item) => item.name.toLowerCase().includes(command.toLowerCase()))
            .map((item) => ({
                key: item.name,
                label: `/${item.name}`,
                description: item.description,
                value: `/${item.name} `,
                kind: "command",
            }));
    }
    const query = argument.trim().toLowerCase();
    if (command === "agent") {
        return options.agents
            .filter((agent) => `${agent.name} ${agent.displayName}`.toLowerCase().includes(query))
            .map((agent) => ({
                key: agent.name,
                label: agent.displayName || agent.name,
                description: "Switch Agent",
                value: agent.name,
                kind: "agent",
            }));
    }
    if (command === "model") {
        return options.models
            .filter((model) => `${sessionModelLabel(model)} ${model.name}`.toLowerCase().includes(query))
            .map((model) => ({
                key: sessionModelLabel(model),
                label: sessionModelLabel(model),
                description: model.name || model.id,
                value: `${model.provider}\u001f${model.id}`,
                kind: "model",
            }));
    }
    return [];
}
