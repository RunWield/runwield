import { getCwd } from "../../constants.ts";
import { agentRegistry } from "../../shared/session/agent-registry.ts";
import { AGENTS } from "../../constants.ts";
import type { CommandCompletionItem } from "../registry.ts";

export async function getAgentCompletions(argumentPrefix: string): Promise<CommandCompletionItem[]> {
    const agents = await agentRegistry.list(getCwd());
    return agents
        .map((agent) => ({
            value: agent.name,
            label: agent.name,
            description: agent.name === AGENTS.ROUTER ? "Reset to default router (triage) flow" : agent.description,
        }))
        .filter((item) => item.value.startsWith(argumentPrefix));
}
