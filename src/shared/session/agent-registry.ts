import { createAgentRegistry } from "@runwield/agents";

export const agentRegistry = createAgentRegistry();

export const { primary: AGENTS, isolated: SUBAGENTS } = agentRegistry.ids;
