import { getCwd } from "../../constants.js";
import { listAvailableAgents } from "../../shared/session/agents.js";
import { AGENTS } from "../../constants.js";
import type { CommandCompletionItem } from "../registry.js";

export async function getAgentCompletions(argumentPrefix: string): Promise<CommandCompletionItem[]> {
    const agents = await listAvailableAgents(getCwd());
    return agents
        .map((agent) => ({
            value: agent.name,
            label: agent.name,
            description: agent.name === AGENTS.ROUTER ? "Reset to default router (triage) flow" : agent.description,
        }))
        .filter((item) => item.value.startsWith(argumentPrefix));
}
