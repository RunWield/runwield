/** List available Agents or start/switch to a chosen active Agent. */

import type { Component } from "@earendil-works/pi-tui";
import { formatCommandHelp, printCommandHelp } from "../help/index.ts";
import {
    buildWorkflowOnlyAgentMessage,
    isWorkflowOnlyAgent,
    listAvailableAgents,
} from "../../shared/session/agents.js";
import { applyUserAgentSelection, listUserAgentOptions } from "../../shared/session/user-selection.ts";
import type { SessionRuntime } from "../../shared/session/session-runtime.ts";
import { AGENTS, getCwd } from "../../constants.js";
import { COMMAND_NAMES } from "../registry.js";
import { setTerminalTitleForName } from "../../ui/tui/terminal-title.ts";
import type { InteractiveSessionPort } from "../../ui/tui/interactive-session-port.ts";

export { getAgentCompletions } from "./getArgumentCompletions.ts";

interface AgentsCommandOptions {
    tui?: import("../../ui/tui/types.js").TuiAPI;
    uiAPI?: import("../../ui/tui/types.js").UiAPI;
    editor?: import("../../ui/tui/types.js").EditorAPI;
    sessionId?: string;
    sessionRuntime?: SessionRuntime;
    sessionPort: InteractiveSessionPort;
    slashSurface?: "tui" | "acp" | "workspace";
}

interface AgentsTuiOptions {
    tui?: import("../../ui/tui/types.js").TuiAPI;
    uiAPI: import("../../ui/tui/types.js").UiAPI;
    editor?: import("../../ui/tui/types.js").EditorAPI;
    sessionId?: string;
    sessionRuntime?: SessionRuntime;
}

async function runAgentsCommandCli(
    agentName: string,
    rest: string[],
    sessionPort: InteractiveSessionPort,
): Promise<void> {
    const agents = await listAvailableAgents(getCwd());

    if (!agentName) {
        console.log("\nAvailable agents:\n");
        for (const agent of agents) {
            console.log(`  ${agent.name.padEnd(14)} ${agent.description}`);
        }
        console.log(`\nUsage: wld agent <name> ["<prompt>"]\n`);
        return;
    }

    const match = agents.find((agent) => agent.name === agentName);
    if (!match) {
        if (await isWorkflowOnlyAgent(agentName, getCwd())) {
            console.log(`\n${buildWorkflowOnlyAgentMessage(agentName, getCwd())}\n`);
            return;
        }
        console.error(`\nUnknown agent: "${agentName}"\n`);
        console.log("Available agents:");
        for (const agent of agents) {
            console.log(`  ${agent.name.padEnd(14)} ${agent.description}`);
        }
        Deno.exit(1);
    }

    const userRequest = rest.join(" ").trim();
    await sessionPort.startInteractiveSession(userRequest || null, {
        initialAgentName: match.name,
    });
}

async function runAgentsCommandTUI(
    agentName: string,
    options: AgentsTuiOptions,
): Promise<"succeeded" | "failed" | "canceled"> {
    const { tui, uiAPI, editor, sessionId, sessionRuntime } = options;
    const projectRoot = sessionId && sessionRuntime ? sessionRuntime.getSessionSnapshot(sessionId)?.cwd : undefined;
    editor?.setText("");

    let chosenAgent: string | null = agentName;
    if (!chosenAgent) {
        const agentOptions = (await listUserAgentOptions(projectRoot))
            .slice()
            .sort((agentA, agentB) => agentA.name.localeCompare(agentB.name))
            .map((agent) => ({
                value: agent.name,
                label: agent.name,
                description: agent.name === AGENTS.ROUTER ? "Reset to default router (triage flow)" : agent.description,
            }));

        const selected = await uiAPI.promptSelect("Switch agent:", agentOptions, { persistResult: false });
        if (!selected) return "canceled";
        chosenAgent = selected;
    }

    if (!sessionId || !sessionRuntime) {
        uiAPI.appendSystemMessage("Agent switching requires an interactive RunWield session.", true);
        return "failed";
    }

    const switchResult = await applyUserAgentSelection(sessionRuntime, sessionId, chosenAgent);
    if (!switchResult.ok) {
        uiAPI.appendSystemMessage(
            `Could not switch to Agent "${chosenAgent}": ${switchResult.error}. The active Agent did not change. Use /model or /settings to choose an available model, then try /agent again.`,
            true,
        );
        if (tui && editor) tui.setFocus(editor as import("../../ui/tui/types.js").EditorAPI & Component);
        return "failed";
    }
    if (!sessionRuntime.getSessionSnapshot(sessionId)?.name) setTerminalTitleForName(undefined);

    if (tui && editor) tui.setFocus(editor as import("../../ui/tui/types.js").EditorAPI & Component);
    return "succeeded";
}

export async function runAgentsCommand(
    argv: string[],
    options: AgentsCommandOptions,
): Promise<void | "succeeded" | "failed" | "canceled"> {
    const [agentName = ""] = argv;

    if (agentName === "help" || agentName === "--help" || agentName === "-h") {
        const help = formatCommandHelp(COMMAND_NAMES.AGENT);
        if (options.uiAPI && help) options.uiAPI.appendSystemMessage(help);
        else printCommandHelp(COMMAND_NAMES.AGENT);
        return;
    }

    if (options.uiAPI && options.editor && options.tui) {
        return await runAgentsCommandTUI(agentName, {
            uiAPI: options.uiAPI,
            editor: options.editor,
            tui: options.tui,
            sessionId: options.sessionId,
            sessionRuntime: options.sessionRuntime,
        });
    }

    await runAgentsCommandCli(agentName, argv.slice(1), options.sessionPort);
}
