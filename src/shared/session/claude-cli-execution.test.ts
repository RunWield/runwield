import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, SessionManager } from "@earendil-works/pi-coding-agent";
import { AGENTS } from "../../constants.js";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { HostedSession } from "./hosted-session.js";
import { getRunWieldSessionDir, openPersistedRootSession } from "./root-session.js";
import { __resetSettingsForTests } from "../settings.js";
import {
    abortActiveSession,
    ensureRootAgentSession,
    getRootSessionRebuildOptions,
    runIsolatedAgentSession,
    runRootTurn,
    steerActiveSessionWithTarget,
} from "./session.js";
import { ClaudeCliBackendError } from "./backends/claude-cli/failure.ts";
import { CLAUDE_CLI_MCP_PROVENANCE } from "./backends/claude-cli/mcp-bridge.ts";
import { readLatestTaskCompletedOutcome } from "../workflow/workflow-results.js";
import { readLatestTriageOutcome } from "../workflow/orchestrator.ts";
import { startMcpIntegration } from "../mcp/integration.ts";
import { runValidationAgentUntilEvent } from "./agent-workflow-step.ts";
import { settleWorkflowToolEvent } from "../workflow/workflow-tool-events.ts";
import { readRequestAttemptEntries } from "./request-dispatch.ts";

interface ToolResultDetails {
    outcome?: string;
    message?: string;
    name?: string;
    reason?: string;
    provenance?: string;
}

interface ToolResultMessage {
    role?: string;
    toolName?: string;
    isError?: boolean;
    details?: ToolResultDetails;
}

interface BranchContentBlock {
    type?: string;
    name?: string;
}

interface BranchMessage {
    role?: string;
    toolName?: string;
    content?: BranchContentBlock[];
}

interface BranchMessageEntry {
    type: string;
    message?: BranchMessage;
}

interface BranchCustomData {
    kind?: string;
    requestId?: string;
    attemptId?: string;
    phase?: string;
    dispatchKind?: string;
}

interface BranchCustomEntry {
    type: string;
    customType?: string;
    data?: BranchCustomData;
}

interface RootSessionRef {
    kind: string;
}

async function removeTempDir(path: string): Promise<void> {
    await Deno.remove(path, { recursive: true }).catch(() => undefined);
}

async function installClaudeFixture(binDir: string, logPath: string): Promise<void> {
    await Deno.mkdir(binDir, { recursive: true });
    const fixturePath = new URL("./backends/claude-cli/testing/fake-claude-mcp-client.ts", import.meta.url).pathname;
    // The fixture lives in the workspace so its npm imports (the real MCP SDK
    // client) resolve through the repository deno.json/node_modules.
    const script = `#!/bin/sh\nexec deno run -A ${JSON.stringify(fixturePath)} "$@"\n`;
    const path = join(binDir, "claude");
    await Deno.writeTextFile(path, script);
    await Deno.chmod(path, 0o755);
    await Deno.writeTextFile(logPath, "");
}

async function withClaudeExecutionFixture(
    callback: (home: string, cwd: string, logPath: string) => Promise<void>,
): Promise<void> {
    await withProcessGlobalTestLock(async () => {
        const previousHome = Deno.env.get("HOME");
        const previousPath = Deno.env.get("PATH");
        const previousLog = Deno.env.get("RUNWIELD_CLAUDE_FIXTURE_LOG");
        const previousText = Deno.env.get("RUNWIELD_CLAUDE_FIXTURE_TEXT");
        const previousCalls = Deno.env.get("RUNWIELD_CLAUDE_FIXTURE_MCP_CALLS");
        const previousSleep = Deno.env.get("RUNWIELD_CLAUDE_FIXTURE_SLEEP_MS");
        const previousBeforeMcpSleep = Deno.env.get("RUNWIELD_CLAUDE_FIXTURE_BEFORE_MCP_SLEEP_MS");
        const previousPostTerminal = Deno.env.get("RUNWIELD_CLAUDE_FIXTURE_POST_TERMINAL_TEXT");
        const home = await Deno.makeTempDir({ prefix: "runwield-claude-exec-home-" });
        const cwd = join(home, "project");
        const binDir = join(home, "bin");
        const logPath = join(home, "claude-log.jsonl");
        try {
            await Deno.mkdir(cwd, { recursive: true });
            await installClaudeFixture(binDir, logPath);
            Deno.env.set("HOME", home);
            Deno.env.set("PATH", `${binDir}:${previousPath || ""}`);
            Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_LOG", logPath);
            await callback(home, cwd, logPath);
        } finally {
            __resetSettingsForTests();
            if (previousHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", previousHome);
            if (previousPath === undefined) Deno.env.delete("PATH");
            else Deno.env.set("PATH", previousPath);
            if (previousLog === undefined) Deno.env.delete("RUNWIELD_CLAUDE_FIXTURE_LOG");
            else Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_LOG", previousLog);
            if (previousText === undefined) Deno.env.delete("RUNWIELD_CLAUDE_FIXTURE_TEXT");
            else Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_TEXT", previousText);
            if (previousCalls === undefined) Deno.env.delete("RUNWIELD_CLAUDE_FIXTURE_MCP_CALLS");
            else Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_MCP_CALLS", previousCalls);
            if (previousSleep === undefined) Deno.env.delete("RUNWIELD_CLAUDE_FIXTURE_SLEEP_MS");
            else Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_SLEEP_MS", previousSleep);
            if (previousBeforeMcpSleep === undefined) Deno.env.delete("RUNWIELD_CLAUDE_FIXTURE_BEFORE_MCP_SLEEP_MS");
            else Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_BEFORE_MCP_SLEEP_MS", previousBeforeMcpSleep);
            if (previousPostTerminal === undefined) Deno.env.delete("RUNWIELD_CLAUDE_FIXTURE_POST_TERMINAL_TEXT");
            else Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_POST_TERMINAL_TEXT", previousPostTerminal);
            await removeTempDir(home);
        }
    });
}

async function waitForLogText(logPath: string, needle: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const text = await Deno.readTextFile(logPath).catch(() => "");
        if (text.includes(needle)) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`waitForLogText: ${JSON.stringify(needle)} did not appear in ${logPath} within 10s`);
}

function createHostedSession(cwd: string, manager: SessionManager): HostedSession {
    const hostedSession = new HostedSession({
        id: `hosted-${crypto.randomUUID()}`,
        cwd,
        sessionManager: manager as never,
    });
    hostedSession.setActiveModelState("sonnet", "claude-cli", true);
    return hostedSession;
}

Deno.test("Claude CLI selected root turn dispatches without Pi AgentSession", async () => {
    await withClaudeExecutionFixture(async (_home, cwd, logPath) => {
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        const root = await ensureRootAgentSession({ hostedSession, agentName: AGENTS.GUIDE });
        assertEquals((root as never as RootSessionRef).kind, "claude-cli");
        await runRootTurn({ hostedSession, agentName: AGENTS.GUIDE, userRequest: "hello" });
        const log = JSON.parse((await Deno.readTextFile(logPath)).trim().split("\n")[0]);
        assertEquals(log.args.includes("--model"), true);
        assertEquals(log.args[log.args.indexOf("--model") + 1], "sonnet");
        assertEquals("agent" in root, false);
    });
});

Deno.test("Claude CLI replacement waits for steering preparation before closing the handoff", async () => {
    await withClaudeExecutionFixture(async (_home, cwd, logPath) => {
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        await ensureRootAgentSession({ hostedSession, agentName: AGENTS.GUIDE });
        hostedSession.beginAgentTransition();
        hostedSession.beginAgentSteeringPreparation("early-steering");

        const turn = runRootTurn({
            hostedSession,
            agentName: AGENTS.GUIDE,
            userRequest: "replacement request",
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        assertEquals(await Deno.readTextFile(logPath), "");
        assertEquals(hostedSession.isAgentTransitioning(), true);

        hostedSession.queueAgentTransitionSteering("prepared before replacement", []);
        hostedSession.completeAgentSteeringPreparation("early-steering");
        await turn;

        const log = JSON.parse((await Deno.readTextFile(logPath)).trim().split("\n")[0]);
        assertStringIncludes(log.stdin, "prepared before replacement");
        assertEquals(hostedSession.isAgentTransitioning(), false);
    });
});

Deno.test("Claude CLI selected root turn runs when Agent config has thinking level", async () => {
    await withClaudeExecutionFixture(async (_home, cwd, logPath) => {
        await Deno.mkdir(join(cwd, ".wld"), { recursive: true });
        await Deno.writeTextFile(
            join(cwd, ".wld", "settings.json"),
            JSON.stringify({ agents: { [AGENTS.ENGINEER]: { thinkingLevel: "medium" } } }),
        );
        __resetSettingsForTests();
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        const root = await ensureRootAgentSession({ hostedSession, agentName: AGENTS.ENGINEER });
        assertEquals((root as never as RootSessionRef).kind, "claude-cli");

        const messages = await runRootTurn({
            hostedSession,
            agentName: AGENTS.ENGINEER,
            userRequest: "hello with configured thinking",
        });

        const log = JSON.parse((await Deno.readTextFile(logPath)).trim().split("\n")[0]);
        assertStringIncludes(log.stdin, "hello with configured thinking");
        assertEquals(messages.at(-1)?.role, "assistant");
    });
});

Deno.test("Claude CLI root turn advertises RunWield skills and project tool permissions", async () => {
    await withClaudeExecutionFixture(async (_home, cwd, logPath) => {
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        await ensureRootAgentSession({ hostedSession, agentName: AGENTS.GUIDE });
        await runRootTurn({ hostedSession, agentName: AGENTS.GUIDE, userRequest: "lookup current docs" });
        const log = JSON.parse((await Deno.readTextFile(logPath)).trim().split("\n")[0]);
        const allowedIndex = log.args.indexOf("--allowedTools");
        assertEquals(allowedIndex >= 0, true);
        const allowedTools = log.args.slice(allowedIndex + 1);
        assertEquals(allowedTools.includes("Read"), true);
        assertEquals(allowedTools.includes("Write"), true);
        assertEquals(allowedTools.includes("Bash"), true);
        assertEquals(allowedTools.includes("EnterWorktree"), true);
        assertEquals(allowedTools.includes("mcp__runwield__web_search"), true);
        assertEquals(allowedTools.includes("mcp__runwield__web_fetch"), true);
        assertEquals(allowedTools.includes("mcp__runwield__web_code_search"), true);
        assertEquals(allowedTools.includes("mcp__runwield__web_docs_search"), true);
        assertStringIncludes(log.promptText, "web_search");
        assertStringIncludes(log.promptText, "Search the public web");
    });
});

Deno.test("Claude CLI roots discover initially empty MCP tools and refresh them between turns", async () => {
    await withClaudeExecutionFixture(async (_home, cwd, logPath) => {
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        const externalLogPath = join(cwd, "external-mcp.jsonl");
        const toolsPath = join(cwd, "external-mcp-tools.txt");
        await Deno.writeTextFile(toolsPath, "");
        const fixtureServer = new URL("../mcp/fixture-server.ts", import.meta.url).pathname;
        const poolResult = await startMcpIntegration({
            cwd,
            servers: [{
                name: "fixture",
                command: Deno.execPath(),
                args: ["run", "-A", fixtureServer],
                env: { RUNWIELD_MCP_FIXTURE_LOG: externalLogPath, RUNWIELD_MCP_FIXTURE_TOOLS_PATH: toolsPath },
                source: "request",
            }],
        });
        assertEquals(poolResult.warnings, []);
        assertEquals(poolResult.integration.getTools(), []);
        const callsPath = join(cwd, "mcp-calls-external.json");
        await Deno.writeTextFile(
            callsPath,
            JSON.stringify([{ name: "mcp__fixture__fixture_echo", arguments: { marker: "claude-external" } }]),
        );
        Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_MCP_CALLS", callsPath);
        Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_TEXT", "external mcp done");
        try {
            await ensureRootAgentSession({
                hostedSession,
                agentName: AGENTS.GUIDE,
                mcpRootTools: poolResult.integration.getTools(),
                mcpIntegration: poolResult.integration,
            });
            await Deno.writeTextFile(toolsPath, "fixture_echo");
            const discoveryDeadline = Date.now() + 5_000;
            while (poolResult.integration.getTools().length === 0 && Date.now() < discoveryDeadline) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assertEquals(poolResult.integration.getTools().length, 1);
            const messages = await runRootTurn({
                hostedSession,
                agentName: AGENTS.GUIDE,
                userRequest: "call external",
            });

            const lines = (await Deno.readTextFile(logPath)).trim().split("\n").map((line) => JSON.parse(line));
            const toolsLine = lines.find((line) => line.mcp?.tools);
            assertEquals(toolsLine.mcp.tools.includes("mcp__fixture__fixture_echo"), true);
            const callsLine = lines.find((line) => line.mcp?.calls);
            assertEquals(callsLine.mcp.calls[0].isError, false);
            assertStringIncludes(await Deno.readTextFile(externalLogPath), '"marker":"claude-external"');
            assertEquals(messages.some((message) => message.role === "toolResult"), true);
            const tool = poolResult.integration.getTools()[0];
            await tool.execute(
                "change-tools",
                { marker: "change-tools" },
                undefined,
                undefined,
                {} as Parameters<typeof tool.execute>[4],
            );
            const deadline = Date.now() + 5_000;
            while (
                poolResult.integration.getTools()[0]?.name !== "mcp__fixture__replacement" && Date.now() < deadline
            ) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            await Deno.writeTextFile(
                callsPath,
                JSON.stringify([
                    { name: "mcp__fixture__replacement", arguments: { marker: "claude-next-turn" } },
                ]),
            );
            await runRootTurn({ hostedSession, agentName: AGENTS.GUIDE, userRequest: "call replacement" });
            const nextLines = (await Deno.readTextFile(logPath)).trim().split("\n").map((line) => JSON.parse(line));
            const nextTools = nextLines.filter((line) => line.mcp?.tools).at(-1).mcp.tools;
            assertEquals(nextTools.includes("mcp__fixture__replacement"), true);
            assertEquals(nextTools.includes("mcp__fixture__fixture_echo"), false);
            assertStringIncludes(await Deno.readTextFile(externalLogPath), '"marker":"claude-next-turn"');
        } finally {
            await poolResult.integration.close();
        }
    });
});

Deno.test("Claude CLI root turn can set the Session Name through MCP", async () => {
    await withClaudeExecutionFixture(async (_home, cwd, logPath) => {
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        const events: Array<{ type?: string; name?: string }> = [];
        hostedSession.setEventSink((event: { type?: string; name?: string }) => events.push(event));
        const callsPath = join(cwd, "mcp-calls-session-name.json");
        await Deno.writeTextFile(
            callsPath,
            JSON.stringify([{ name: "set_session_name", arguments: { name: "  claude\n\tsession  " } }]),
        );
        Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_MCP_CALLS", callsPath);
        Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_TEXT", "named session");

        await ensureRootAgentSession({ hostedSession, agentName: AGENTS.GUIDE });
        const messages = await runRootTurn({ hostedSession, agentName: AGENTS.GUIDE, userRequest: "name this" });

        const lines = (await Deno.readTextFile(logPath)).trim().split("\n").map((line) => JSON.parse(line));
        assertEquals(lines[0].args.includes("set_session_name"), true);
        assertEquals(lines[0].args.includes("mcp__runwield__set_session_name"), true);
        const toolsLine = lines.find((line) => line.mcp?.tools);
        assertEquals(toolsLine.mcp.tools.includes("set_session_name"), true);
        const callsLine = lines.find((line) => line.mcp?.calls);
        assertEquals(callsLine.mcp.calls[0].isError, false);
        assertEquals(manager.getSessionName(), "claude session");
        assertEquals(events.some((event) => event.type === "session_renamed" && event.name === "claude session"), true);
        const toolResult = messages.find((message) =>
            message.role === "toolResult" && message.toolName === "set_session_name"
        ) as ToolResultMessage | undefined;
        assertEquals(toolResult?.details?.name, "claude session");
        assertEquals(toolResult?.details?.provenance, CLAUDE_CLI_MCP_PROVENANCE);
    });
});

Deno.test("Claude CLI root keeps agent tool names available for provider reload", async () => {
    await withClaudeExecutionFixture(async (_home, cwd) => {
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        await ensureRootAgentSession({ hostedSession, agentName: AGENTS.GUIDE });

        const rebuildOptions = getRootSessionRebuildOptions(hostedSession);

        assertEquals(rebuildOptions.toolNames?.includes("read"), true);
        assertEquals(rebuildOptions.toolNames?.includes("bash"), true);
        assertEquals(rebuildOptions.toolNames?.includes("set_session_name"), true);
    });
});

Deno.test("Claude CLI root turn emits live assistant text deltas", async () => {
    await withClaudeExecutionFixture(async (_home, cwd) => {
        Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_TEXT", "live reply");
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        const events: string[] = [];
        hostedSession.setEventSink((event: { type?: string; delta?: string }) => {
            if (event.type === "assistant_text_delta" && event.delta) events.push(event.delta);
        });
        await ensureRootAgentSession({ hostedSession, agentName: AGENTS.GUIDE });
        await runRootTurn({ hostedSession, agentName: AGENTS.GUIDE, userRequest: "stream" });
        assertEquals(events, ["live reply"]);
    });
});

Deno.test("Claude CLI isolated turns persist only to the supplied isolated manager", async () => {
    await withClaudeExecutionFixture(async (_home, cwd) => {
        const rootManager = SessionManager.inMemory(cwd);
        const isolatedManager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, rootManager);
        const messages = await runIsolatedAgentSession({
            hostedSession,
            agentName: AGENTS.GUIDE,
            userRequest: "isolated",
            sessionManager: isolatedManager,
        });
        assertEquals(messages.at(-1)?.role, "assistant");
        assertEquals(rootManager.getBranch().length, 0);
        assertEquals(isolatedManager.getBranch().filter((entry) => entry.type === "message").length, 2);
    });
});

Deno.test("Claude CLI accepted workflow completion shuts down without recording a backend failure", async () => {
    await withClaudeExecutionFixture(async (_home, cwd) => {
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, SessionManager.inMemory(cwd));
        const callsPath = join(cwd, "mcp-calls-completion.json");
        await Deno.writeTextFile(
            callsPath,
            JSON.stringify([
                { name: "runwield_task_completed", arguments: { message: "Completed the repair." } },
            ]),
        );
        Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_MCP_CALLS", callsPath);
        const result = await runValidationAgentUntilEvent({ runIsolatedAgentSession }, {
            hostedSession,
            cwd,
            agentName: AGENTS.ENGINEER,
            userRequest: "Complete the repair using task_completed.",
            sessionManager: manager,
        }, "task_completed");
        assertEquals(result.event?.kind, "task_completed");
        assertEquals(result.event?.sourceSessionId, manager.getSessionId());
        assertEquals(readRequestAttemptEntries(manager).map((entry) => entry.phase), ["started", "completed"]);
        assertEquals(
            manager.getBranch().filter((entry) =>
                entry.type === "custom" && entry.customType === "runwield.backend_status"
            ),
            [],
        );
        if (result.event) settleWorkflowToolEvent(hostedSession, result.event);
        hostedSession.dispose();
    });
});

Deno.test("Claude CLI root turn persists normal messages and backend metadata in the existing root JSONL", async () => {
    await withClaudeExecutionFixture(async (_home, cwd) => {
        const sessionDir = getRunWieldSessionDir(cwd);
        await Deno.mkdir(sessionDir, { recursive: true });
        const manager = SessionManager.create(cwd, sessionDir, { id: "claude-root-persist" });
        const hostedSession = createHostedSession(cwd, manager);
        await ensureRootAgentSession({ hostedSession, agentName: AGENTS.GUIDE });
        await runRootTurn({ hostedSession, agentName: AGENTS.GUIDE, userRequest: "persist me" });
        const opened = await openPersistedRootSession({ cwd, sessionId: "claude-root-persist" });
        const serialized = JSON.stringify(opened.sessionManager.getBranch());
        assertStringIncludes(serialized, "persist me");
        assertStringIncludes(serialized, "fixture reply");
        assertStringIncludes(serialized, "runwield.execution_backend");
        assertStringIncludes(serialized, "model_change");
    });
});

Deno.test("Claude CLI image turns fail before subprocess start or transcript append", async () => {
    await withClaudeExecutionFixture(async (_home, cwd, logPath) => {
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        await ensureRootAgentSession({ hostedSession, agentName: AGENTS.GUIDE });
        await assertRejects(
            () =>
                runRootTurn({
                    hostedSession,
                    agentName: AGENTS.GUIDE,
                    userRequest: "image",
                    images: [{ base64: btoa("image"), mimeType: "image/png" }],
                }),
            Error,
            "does not support image attachments",
        );
        assertEquals(await Deno.readTextFile(logPath), "");
        assertEquals(manager.getBranch().filter((entry) => entry.type === "message").length, 0);
    });
});

Deno.test("^Claude CLI MCP lifecycle bridge black-box contract$", async () => {
    await withClaudeExecutionFixture(async (_home, cwd, logPath) => {
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        hostedSession.setActiveExecutionWorkflow({
            planName: "quick-fix",
            triageMeta: { classification: "QUICK_FIX" },
            executionAgent: "engineer",
            executionStarted: true,
            executionCwd: cwd,
        });
        // The fake Claude first attempts an invalid call (rejected without
        // advancement), then an accepted call through the real delegated tool.
        const callsPath = join(cwd, "mcp-calls.json");
        await Deno.writeTextFile(
            callsPath,
            JSON.stringify([
                { name: "runwield_task_completed", arguments: {} },
                { name: "runwield_task_completed", arguments: { message: "vertical accepted" } },
            ]),
        );
        Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_MCP_CALLS", callsPath);
        Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_TEXT", "final text");

        await ensureRootAgentSession({ hostedSession, agentName: AGENTS.ENGINEER });
        const messages = await runRootTurn({ hostedSession, agentName: AGENTS.ENGINEER, userRequest: "implement" });

        // The old no-tools tracer bullet line is gone from the prompt appendix.
        const lines = (await Deno.readTextFile(logPath)).trim().split("\n").map((line) => JSON.parse(line));
        assertStringIncludes(lines[0].promptText, "runwield_task_completed");
        assertEquals(lines[0].promptText.includes("Custom Tools are not exposed to Claude CLI"), false);
        assertStringIncludes(lines[0].promptText, "only way to advance RunWield workflow state");

        // The fake Claude listed Agent-eligible bridged tools over real MCP.
        const toolsLine = lines.find((line) => line.mcp?.tools);
        assertEquals(toolsLine.mcp.tools.includes("runwield_task_completed"), true);
        assertEquals(toolsLine.mcp.tools.includes("memory"), true);
        assertEquals(toolsLine.mcp.tools.includes("delegate_agent"), false);
        // The canonical internal tool result is exposed to current workflow readers.
        assertEquals(readLatestTaskCompletedOutcome(messages), true);
        const toolResults = messages.filter((message) =>
            message.role === "toolResult" && message.toolName === "task_completed"
        );
        assertEquals(toolResults.length, 2);
        const accepted = toolResults.at(-1) as ToolResultMessage;
        assertEquals(accepted.details?.outcome, "task_completed");
        assertEquals(accepted.details?.message, "vertical accepted");
        assertEquals(accepted.details?.provenance, CLAUDE_CLI_MCP_PROVENANCE);
        const rejected = toolResults[0] as ToolResultMessage;
        assertEquals(rejected.isError, true);
        assertEquals("outcome" in (rejected.details || {}), false);

        // The SessionManager transcript carries the same canonical exchange.
        const branchMessages = manager.getBranch()
            .filter((entry) => entry.type === "message")
            .map((entry) => (entry as BranchMessageEntry).message)
            .filter((message): message is BranchMessage => message !== undefined);
        assertEquals(
            branchMessages.some((msg) =>
                msg.role === "assistant" &&
                Array.isArray(msg.content) &&
                msg.content.some((block) => block.type === "toolCall" && block.name === "task_completed")
            ),
            true,
        );
        assertEquals(
            branchMessages.some((msg) => msg.role === "toolResult" && msg.toolName === "task_completed"),
            true,
        );

        // The durable Task Completion outbox remains the execution authority.
        assertEquals(
            manager.getBranch().some(
                (entry) => entry.type === "custom" && entry.customType === "runwield.task_completion",
            ),
            true,
        );
    });
});

Deno.test("Claude CLI plan_written rejects once when live user steering is pending", async () => {
    await withClaudeExecutionFixture(async (_home, cwd, logPath) => {
        Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_BEFORE_MCP_SLEEP_MS", "250");
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        const callsPath = join(cwd, "mcp-calls-plan-written.json");
        await Deno.writeTextFile(
            callsPath,
            JSON.stringify([{ name: "runwield_plan_written", arguments: { planName: "draft-plan" } }]),
        );
        Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_MCP_CALLS", callsPath);

        const run = runIsolatedAgentSession({
            hostedSession,
            agentName: AGENTS.PLANNER,
            userRequest: "draft plan",
            sessionManager: manager,
        });
        await waitForLogText(logPath, "draft plan");

        const steered = await steerActiveSessionWithTarget(hostedSession, "include the timeout case", []);
        assertEquals(steered !== null, true);
        const messages = await run;

        const callsLine = (await Deno.readTextFile(logPath)).trim().split("\n")
            .map((line) => JSON.parse(line))
            .find((line) => line.mcp?.calls);
        assertEquals(callsLine.mcp.calls[0].isError, true);
        assertStringIncludes(callsLine.mcp.calls[0].text, "include the timeout case");
        const planResults = messages.filter((message) =>
            message.role === "toolResult" && message.toolName === "plan_written"
        );
        assertEquals(planResults.length, 1);
        const rejected = planResults[0] as ToolResultMessage;
        assertEquals(rejected.isError, true);
        assertStringIncludes(rejected.details?.reason || "", "include the timeout case");
    });
});

Deno.test("^Claude CLI Router exposes triage_report through the MCP lifecycle bridge$", async () => {
    await withClaudeExecutionFixture(async (_home, cwd, logPath) => {
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        const callsPath = join(cwd, "mcp-calls-triage.json");
        await Deno.writeTextFile(
            callsPath,
            JSON.stringify([{
                name: "runwield_triage_report",
                arguments: {
                    routingIntent: "QUICK_FIX",
                    complexity: "LOW",
                    summary: "Router can report a bounded Claude CLI bug fix.",
                    sessionName: "claude router tools",
                },
            }]),
        );
        Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_MCP_CALLS", callsPath);
        Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_TEXT", "freeform text after triage");

        await ensureRootAgentSession({ hostedSession, agentName: AGENTS.ROUTER });
        const messages = await runRootTurn({ hostedSession, agentName: AGENTS.ROUTER, userRequest: "route this" });

        const lines = (await Deno.readTextFile(logPath)).trim().split("\n").map((line) => JSON.parse(line));
        assertEquals(lines[0].args.includes("--allowedTools"), true);
        assertEquals(lines[0].args.includes("runwield_triage_report"), true);
        assertEquals(lines[0].args.includes("mcp__runwield__runwield_triage_report"), true);
        const toolsLine = lines.find((line) => line.mcp?.tools);
        assertEquals(toolsLine.mcp.tools.includes("runwield_triage_report"), true);
        const triage = readLatestTriageOutcome(messages);
        assertEquals(triage?.routingIntent, "QUICK_FIX");
    });
});

Deno.test("^Claude CLI root turn abort reaches the subprocess and preserves workflow$", async () => {
    await withClaudeExecutionFixture(async (_home, cwd, logPath) => {
        Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_SLEEP_MS", "1000");
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        hostedSession.setActiveExecutionWorkflow({
            planName: "quick-fix",
            triageMeta: { classification: "QUICK_FIX" },
            executionAgent: "engineer",
            executionStarted: true,
            executionCwd: cwd,
        });
        await ensureRootAgentSession({ hostedSession, agentName: AGENTS.ENGINEER });
        const run = runRootTurn({
            hostedSession,
            agentName: AGENTS.ENGINEER,
            userRequest: "slow",
            dispatchKind: "quick_fix",
        });
        await waitForLogText(logPath, "slow");
        assertEquals(abortActiveSession(hostedSession), true);
        const error = await assertRejects(() => run, ClaudeCliBackendError);
        assertEquals(error.kind, "canceled");
        assertEquals(hostedSession.getActiveExecutionWorkflow()?.planName, "quick-fix");
        assertEquals(
            manager.getBranch().filter((entry) =>
                entry.type === "message" && (entry as BranchMessageEntry).message?.role === "assistant"
            ).length,
            0,
        );
        assertEquals(
            manager.getBranch().some((entry) =>
                entry.type === "custom" && entry.customType === "runwield.backend_status" &&
                (entry as BranchCustomEntry).data?.kind === "canceled"
            ),
            true,
        );
        const failedAttempt = manager.getBranch().findLast((entry) =>
            entry.type === "custom" && entry.customType === "runwield.request_attempt" &&
            (entry as BranchCustomEntry).data?.phase === "failed"
        ) as BranchCustomEntry | undefined;
        const backendFailure = manager.getBranch().findLast((entry) =>
            entry.type === "custom" && entry.customType === "runwield.backend_status"
        ) as BranchCustomEntry | undefined;
        assertEquals(failedAttempt?.data?.dispatchKind, "quick_fix");
        assertEquals(failedAttempt?.data?.requestId, backendFailure?.data?.requestId);
        assertEquals(failedAttempt?.data?.attemptId, backendFailure?.data?.attemptId);
        const log = await Deno.readTextFile(logPath);
        assertStringIncludes(log, "slow");
    });
});

Deno.test("^Claude CLI missing terminal signal leaves workflow waiting like Pi$", async () => {
    await withClaudeExecutionFixture(async (_home, cwd) => {
        Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_TEXT", "I need your answer first.");
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        hostedSession.setActiveExecutionWorkflow({
            planName: "quick-fix",
            triageMeta: { classification: "QUICK_FIX" },
            executionAgent: "engineer",
            executionStarted: true,
            executionCwd: cwd,
        });
        await ensureRootAgentSession({ hostedSession, agentName: AGENTS.ENGINEER });
        const messages = await runRootTurn({ hostedSession, agentName: AGENTS.ENGINEER, userRequest: "question" });
        assertEquals(readLatestTaskCompletedOutcome(messages), false);
        assertEquals(hostedSession.getActiveExecutionWorkflow()?.planName, "quick-fix");
        assertEquals(JSON.stringify(manager.getBranch()).includes("I need your answer first."), true);
    });
});

Deno.test("^Claude CLI stops before post-terminal output after an accepted signal$", async () => {
    await withClaudeExecutionFixture(async (_home, cwd) => {
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        hostedSession.setActiveExecutionWorkflow({
            planName: "quick-fix",
            triageMeta: { classification: "QUICK_FIX" },
            executionAgent: "engineer",
            executionStarted: true,
            executionCwd: cwd,
        });
        const callsPath = join(cwd, "mcp-calls-post.json");
        await Deno.writeTextFile(
            callsPath,
            JSON.stringify([{ name: "runwield_task_completed", arguments: { message: "accepted" } }]),
        );
        Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_MCP_CALLS", callsPath);
        Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_TEXT", "final text");
        Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_POST_TERMINAL_TEXT", " post-terminal prose");
        await ensureRootAgentSession({ hostedSession, agentName: AGENTS.ENGINEER });
        const messages = await runRootTurn({ hostedSession, agentName: AGENTS.ENGINEER, userRequest: "finish" });
        assertEquals(readLatestTaskCompletedOutcome(messages), true);
        const serialized = JSON.stringify(manager.getBranch());
        assertEquals(serialized.includes("post-terminal prose"), false);
        assertEquals(serialized.includes("terminal result did not match"), false);
    });
});

Deno.test("Claude CLI caller-supplied review_diff reaches the bridged tool list", async () => {
    await withClaudeExecutionFixture(async (_home, cwd, logPath) => {
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        const reviewDiffTool = defineTool({
            name: "review_diff",
            label: "Review Diff",
            description: "Return review diff.",
            parameters: Type.Object({}),
            execute() {
                return Promise.resolve({ content: [{ type: "text" as const, text: "diff text" }], details: {} });
            },
        });

        await ensureRootAgentSession({ hostedSession, agentName: AGENTS.ENGINEER, customTools: [reviewDiffTool] });
        await runRootTurn({
            hostedSession,
            agentName: AGENTS.ENGINEER,
            userRequest: "review",
            customTools: [reviewDiffTool],
        });

        const lines = (await Deno.readTextFile(logPath)).trim().split("\n").map((line) => JSON.parse(line));
        const toolsLine = lines.find((line) => line.mcp?.tools);
        assertEquals(toolsLine.mcp.tools.includes("review_diff"), true);
    });
});
