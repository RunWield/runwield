/** Host presentation and transport identities; durable workflow policy stays shared. */
export type AttachedHostId = "claude-code" | "codex";

export interface AttachedHost {
    id: AttachedHostId;
    displayName: "Claude Code" | "Codex";
    agentLabel: string;
    clientNames: readonly string[];
    implementEntrypoint: string;
    reviewEntrypoint: string;
    updatePlugin: string;
    updateHost: string;
}

export const ATTACHED_HOSTS: Record<AttachedHostId, AttachedHost> = {
    "claude-code": {
        id: "claude-code",
        displayName: "Claude Code",
        agentLabel: "Claude",
        clientNames: ["claude-code"],
        implementEntrypoint: "/runwield:implement",
        reviewEntrypoint: "/runwield:plan-review",
        updatePlugin:
            "Update the plugin in Claude Code: /plugin marketplace update runwield, then /plugin update runwield@runwield.",
        updateHost: "Update Claude Code with claude update.",
    },
    codex: {
        id: "codex",
        displayName: "Codex",
        agentLabel: "Codex",
        // Observed in Codex CLI 0.164.0-alpha.11.1's MCP initialize request.
        clientNames: ["codex-mcp-client"],
        implementEntrypoint: "$runwield implement",
        reviewEntrypoint: "$runwield resume",
        updatePlugin:
            "Update the RunWield plugin through Codex's plugin settings or reinstall it from its marketplace.",
        updateHost: "Update Codex through the desktop app or the package manager used to install the CLI.",
    },
};

export function attachedHost(id: string): AttachedHost | null {
    return id === "claude-code" || id === "codex" ? ATTACHED_HOSTS[id] : null;
}

/** The selected adapter cannot make an unrelated MCP client a supported host. */
export function attachedMcpHost(adapter: AttachedHostId, clientName: string | undefined): string {
    return clientName && ATTACHED_HOSTS[adapter].clientNames.includes(clientName) ? adapter : "unsupported-client";
}
