import type { TextContent } from "@earendil-works/pi-ai/compat";
import type { createSetSessionNameTool } from "../../../tools/set-session-name.ts";
import type { createBackgroundTaskTool } from "../../../tools/background-task.ts";
import type { McpIntegration } from "@runwield/pi-ai/mcp";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DelegatedSubAgentDefinitionId } from "@runwield/agents";
import type { SessionRuntimeEvent } from "@runwield/session-runtime/events";
import { withRuntimeCommandFixture } from "../../../cmd/testing/runtime-command-fixture.ts";
import { bashFixtureExecutable } from "../../../../scripts/bash-fixture.ts";
import { delimiter } from "node:path";
import {
    writeWorkflowBinaryFixtures,
    assertWorkflowBinaryCallsSupported,
} from "../../../testing/workflow-binary-fixtures.ts";
import { runtimeSourceArgs } from "../../../testing/runtime-source-args.ts";
import { captureForegroundProcess } from "../../captured-process.ts";
import { makeTempFile } from "../../../testing/temp-file.ts";
import { after, before, test } from "node:test";
import { tmpdir } from "node:os";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import process from "node:process";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects } from "../../../testing/assertions.ts";
import { fileURLToPath as fromFileUrl } from "node:url";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { withProcessGlobalTestLock } from "../../../testing/process-global-lock.ts";
import { AGENTS, SUBAGENTS, agentRegistry } from "../agent-registry.ts";
import { __resetSettingsForTests, getSettingsManager } from "../../settings.ts";
import { HostedSession, type HostedRuntimeEventObservation } from "@runwield/session-runtime/host";
import {
    buildAgentSession,
    buildExecutionSession,
    composeClaudeCliBridgedTools,
    resolveEffectiveSessionToolNames,
} from "../session.ts";
import { createReviewDiffTool } from "../../workflow/review-diff-tool.ts";
import { startMcpIntegration } from "@runwield/pi-ai/mcp";
import { mcpFixtureHost } from "../../mcp/integration-fixture.ts";

import type { WorkRecordAccessMode } from "../../work-records/search.ts";

interface WorkRecordAccessDetails {
    accessMode: WorkRecordAccessMode;
}

type ToolExecutionContext = Parameters<ToolDefinition["execute"]>[4];

// This tool does not use the trailing SDK execution arguments.
type SetSessionNameExecute = (
    ...args: SetSessionNameArguments
) => ReturnType<ReturnType<typeof createSetSessionNameTool>["execute"]>;

type SetSessionNameToolArguments = Parameters<ReturnType<typeof createSetSessionNameTool>["execute"]>;
type SetSessionNameArguments = [SetSessionNameToolArguments[0], SetSessionNameToolArguments[1]];
type BackgroundToolResult = Awaited<ReturnType<ReturnType<typeof createBackgroundTaskTool>["execute"]>>;

// The policy tests supply only the part of Pi's context used by these tools.
type PolicyToolContext = ToolExecutionContext & { sessionManager: SessionManager };

interface PolicyToolInput {
    action?: string;
    command?: string;
    task_id?: string;
}

interface RealMcpFixtureTools {
    pool: McpIntegration;
    tools: ToolDefinition[];
    logPath: string;
}

let helperRoot = "";
let priorHelperPath = "";
before(() =>
    withProcessGlobalTestLock(async () => {
        priorHelperPath = process.env.PATH || "";
        helperRoot = await fsMkdtemp(join(tmpdir(), "session-policy-helpers-"));
        const bin = await writeWorkflowBinaryFixtures(helperRoot);
        process.env.PATH = `${bin}${delimiter}${priorHelperPath}`;
    }),
);
after(() =>
    withProcessGlobalTestLock(async () => {
        process.env.PATH = priorHelperPath;
        try {
            await assertWorkflowBinaryCallsSupported(helperRoot);
        } finally {
            await fsRm(helperRoot, { recursive: true });
        }
    }),
);

// Anchored to this file, not Deno.cwd(): test realms share one process, so a
// concurrent test file's chdir would otherwise point these at its temp dir.
const REPO_ROOT = fromFileUrl(new URL("../../../..", import.meta.url));
function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const MCP_FIXTURE_SERVER = fromFileUrl(new URL("../../mcp/fixture-server.ts", import.meta.url));

async function startRealMcpFixtureTools(cwd: string): Promise<RealMcpFixtureTools> {
    const logPath = await makeTempFile({ prefix: "runwield-real-mcp-policy-" });
    const result = await startMcpIntegration({
        ...mcpFixtureHost(cwd),
        servers: [
            {
                name: "fixture",
                command: process.execPath,
                args: runtimeSourceArgs(["run", "-A", MCP_FIXTURE_SERVER]),
                env: { RUNWIELD_MCP_FIXTURE_LOG: logPath },
                source: "request",
            },
        ],
    });
    assertEquals(result.warnings, []);
    return { pool: result.integration, tools: result.integration.getTools(), logPath };
}

async function removeTempDir(path: string) {
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            await fsRm(path, { recursive: true });
            return;
        } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
            if (attempt === 4) throw error;
            await delay(20 * (attempt + 1));
        }
    }
}

test("the RunWield project PM role can delegate", async () => {
    const definition = await agentRegistry.get("pm", REPO_ROOT);
    assert(definition.tools.includes("delegate_agent"));
});

test("Claude CLI bridges the session name tool", async () => {
    const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-cli-session-name-tool-"));
    const sessionManager = SessionManager.inMemory(tempHome);
    const hostedSession = new HostedSession({
        id: "cli-session-name-tool",
        cwd: tempHome,
        sessionManager: sessionManager,
    });
    const agentDef = await agentRegistry.get(AGENTS.ENGINEER, REPO_ROOT);

    try {
        const claudeTools = await composeClaudeCliBridgedTools({
            agentDef,
            agentName: AGENTS.ENGINEER,
            hostedSession,
            triageMeta: undefined,
            cwd: tempHome,
        });
        assertEquals(
            claudeTools.some((tool) => tool.name === "set_session_name"),
            true,
        );
        assertEquals(
            claudeTools.some((tool) => tool.name === "background_task"),
            true,
        );
        assertEquals(
            claudeTools.some((tool) => tool.name === "delegate_agent"),
            false,
        );
    } finally {
        await removeTempDir(tempHome);
    }
});

test("resolveEffectiveSessionToolNames normalizes legacy multi replace tool name", () => {
    assertEquals(resolveEffectiveSessionToolNames(["read", "edit", "multi_replace_file_content"], undefined, []), [
        "read",
        "edit",
        "multi_file_edit",
    ]);
});

test("root Pi Agent builds keep MCP tools when using a subagent definition", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-root-mcp-subagent-"));
        let session: AgentSession | undefined;
        let mcpFixture: Awaited<ReturnType<typeof startRealMcpFixtureTools>> | undefined;
        try {
            process.env["HOME"] = tempHome;
            __resetSettingsForTests();
            await writeVisionModelConfig(tempHome);
            const hostedSession = new HostedSession({ id: "root-mcp-subagent", cwd: tempHome });
            mcpFixture = await startRealMcpFixtureTools(tempHome);
            const mcpTool = mcpFixture.tools[0];
            const built = await buildAgentSession({
                hostedSession,
                agentName: AGENTS.PLANNER,
                modelOverride: "test/text",
                subAgentDefinition: { id: SUBAGENTS.SLICER },
                mcpRootTools: [mcpTool],
            });
            session = built.session;

            assert(built.tools.includes(mcpTool.name));
            assert(built.finalCustomTools.some((tool) => tool.name === mcpTool.name));
        } finally {
            session?.dispose();
            await mcpFixture?.pool.close();
            if (mcpFixture) await fsRm(mcpFixture.logPath).catch(() => {});
            if (originalHome) process.env["HOME"] = originalHome;
            else delete process.env["HOME"];
            __resetSettingsForTests();
            await removeTempDir(tempHome);
        }
    });
});

test("bounded Pi and Claude subagent builds do not inherit root MCP tools", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-subagent-mcp-exclusion-"));
        let session: AgentSession | undefined;
        let mcpFixture: Awaited<ReturnType<typeof startRealMcpFixtureTools>> | undefined;
        try {
            process.env["HOME"] = tempHome;
            __resetSettingsForTests();
            await writeVisionModelConfig(tempHome);
            const hostedSession = new HostedSession({ id: "subagent-mcp-exclusion", cwd: tempHome });
            mcpFixture = await startRealMcpFixtureTools(tempHome);
            const mcpTool = mcpFixture.tools[0];
            const built = await buildAgentSession({
                hostedSession,
                agentName: AGENTS.REVIEWER,
                modelOverride: "test/text",
                subAgentDefinition: { id: SUBAGENTS.REVIEWER },
                mcpRootTools: [],
            });
            session = built.session;
            assertEquals(built.tools.includes(mcpTool.name), false);
            assertEquals(
                built.finalCustomTools.some((tool) => tool.name === mcpTool.name),
                false,
            );

            const agentDef = await agentRegistry.get(AGENTS.GUIDE, tempHome);
            const rootClaudeTools = await composeClaudeCliBridgedTools({
                agentDef,
                agentName: AGENTS.GUIDE,
                hostedSession,
                triageMeta: undefined,
                cwd: tempHome,
                mcpRootTools: [mcpTool],
            });
            const isolatedClaudeTools = await composeClaudeCliBridgedTools({
                agentDef,
                agentName: AGENTS.GUIDE,
                hostedSession,
                triageMeta: undefined,
                cwd: tempHome,
                mcpRootTools: [],
            });
            assert(rootClaudeTools.some((tool) => tool.name === mcpTool.name));
            assertEquals(
                isolatedClaudeTools.some((tool) => tool.name === mcpTool.name),
                false,
            );
        } finally {
            session?.dispose();
            await mcpFixture?.pool.close();
            if (mcpFixture) await fsRm(mcpFixture.logPath).catch(() => {});
            if (originalHome) process.env["HOME"] = originalHome;
            else delete process.env["HOME"];
            __resetSettingsForTests();
            await removeTempDir(tempHome);
        }
    });
});

test("buildAgentSession auto-wires Guide docs-only tools when requested", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-guide-docs-tools-"));
        let session: AgentSession | undefined;

        try {
            process.env["HOME"] = tempHome;
            __resetSettingsForTests();
            await writeVisionModelConfig(tempHome);
            const hostedSession = new HostedSession({ id: "guide-docs-tools", cwd: tempHome });
            const built = await buildAgentSession({
                hostedSession,
                agentName: AGENTS.GUIDE,
                modelOverride: "test/text",
            });
            session = built.session;

            assertEquals(built.tools.includes("write_docs"), true);
            assertEquals(built.tools.includes("edit_docs"), true);
            const writeDocs = built.finalCustomTools.find((tool) => tool.name === "write_docs");
            const editDocs = built.finalCustomTools.find((tool) => tool.name === "edit_docs");
            assert(writeDocs, "expected write_docs to be auto-wired");
            assert(editDocs, "expected edit_docs to be auto-wired");
            assertEquals(typeof writeDocs.execute, "function");
            assertEquals(typeof editDocs.execute, "function");
        } finally {
            session?.dispose();
            __resetSettingsForTests();
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            __resetSettingsForTests();
            await removeTempDir(tempHome);
        }
    });
});

test("buildAgentSession wires task_completed with an event-only HostedSession", async () => {
    await withProcessGlobalTestLock(async () => {
        const events: HostedRuntimeEventObservation[] = [];
        const debugLogPath = await makeTempFile({ prefix: "runwield-session-debug-test-", suffix: ".log" });

        let session: AgentSession | undefined;
        const originalHome = process.env["HOME"];
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-session-tools-policy-"));

        try {
            process.env["HOME"] = tempHome;
            __resetSettingsForTests();
            await writeVisionModelConfig(tempHome);

            const hostedSession = new HostedSession({ id: "task-completed-policy", cwd: tempHome });
            hostedSession.setEventSink({ emit: (event: HostedRuntimeEventObservation) => events.push(event) });

            const built = await buildAgentSession({
                hostedSession,
                agentName: "operator",
                modelOverride: "test/model",
                debugLogPath,
            });
            session = built.session;
            const { finalCustomTools } = built;
            const tool = finalCustomTools.find((candidate) => candidate.name === "task_completed");
            assert(tool, "expected task_completed to be wired");
            const execute = tool.execute;

            await execute(
                "tool-call-1",
                { message: "Done." },
                new AbortController().signal,
                () => {},
                {} as ToolExecutionContext,
            );

            assertEquals(events.length, 1);
            assertEquals(events[0].delta, "**Task completed.**\n\nDone.");
            assertEquals(events[0].agentName, "Operator");
        } finally {
            session?.dispose();
            __resetSettingsForTests();
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            __resetSettingsForTests();
            await removeTempDir(tempHome);
            await fsRm(debugLogPath);
        }
    });
});

test("buildAgentSession auto-wires set_session_name for user-facing Agents", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-set-session-name-wiring-"));
        let session: AgentSession | undefined;
        try {
            process.env["HOME"] = tempHome;
            __resetSettingsForTests();
            await writeVisionModelConfig(tempHome);
            const sessionManager = SessionManager.inMemory(tempHome);
            const hostedSession = new HostedSession({
                id: "set-session-name-policy",
                cwd: tempHome,
                sessionManager: sessionManager,
            });

            const built = await buildAgentSession({
                hostedSession,
                agentName: AGENTS.GUIDE,
                modelOverride: "test/text",
                toolNames: ["read"],
            });
            session = built.session;

            assertEquals(built.tools.includes("set_session_name"), true);
            const tool = built.finalCustomTools.find((candidate) => candidate.name === "set_session_name");
            assert(tool, "expected set_session_name to be auto-wired");
            const result = await (tool.execute as SetSessionNameExecute)("tool-call-1", { name: "guide session" });
            assertEquals(result.details, { name: "guide session" });
            assertEquals(sessionManager.getSessionName(), "guide session");
        } finally {
            session?.dispose();
            __resetSettingsForTests();
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            __resetSettingsForTests();
            await removeTempDir(tempHome);
        }
    });
});

test("buildAgentSession wires review_complete and file tools into the Semantic Reviewer subagent", async () => {
    // Regression: the Semantic Reviewer's session once started with only
    // `review_diff` + `see_image` — no read/grep/find/ls and no
    // `review_complete` — so every `review_complete` call failed with "Tool
    // review_complete not found" and Workflow Validation stalled mid-round.
    // The canonical tool ceiling lives in the subagent definition registry and
    // must reach the session's effective tools and auto-wired custom tools.
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-reviewer-tools-"));
        let session: AgentSession | undefined;

        try {
            process.env["HOME"] = tempHome;
            __resetSettingsForTests();
            await writeVisionModelConfig(tempHome);

            const hostedSession = new HostedSession({ id: "reviewer-tools-policy", cwd: REPO_ROOT });
            const built = await buildAgentSession({
                hostedSession,
                agentName: AGENTS.REVIEWER,
                modelOverride: "test/text",
                subAgentDefinition: {
                    id: SUBAGENTS.REVIEWER,
                    options: { reviewerMode: "discovery" },
                },
                toolNames: [...agentRegistry.isolated.toolCeiling(SUBAGENTS.REVIEWER)],
                customTools: [createReviewDiffTool({ full: "diff" })],
                includeEditFallback: false,
            });
            session = built.session;

            for (const toolName of ["read", "grep", "find", "ls", "review_diff", "review_complete", "delegate_agent"]) {
                assert(built.tools.includes(toolName), `expected ${toolName} in effective reviewer tools`);
            }
            assert(built.finalCustomTools.some((tool) => tool.name === "delegate_agent"));
            const reviewComplete = built.finalCustomTools.find((tool) => tool.name === "review_complete");
            assert(reviewComplete, "expected review_complete to be auto-wired into the reviewer session");
            assertEquals(typeof reviewComplete.execute, "function");
        } finally {
            session?.dispose();
            __resetSettingsForTests();
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            __resetSettingsForTests();
            await removeTempDir(tempHome);
        }
    });
});

async function writeVisionModelConfig(tempHome: string) {
    await fsMkdir(join(tempHome, ".wld"), { recursive: true });
    await fsWriteFile(
        join(tempHome, ".wld", "models.json"),
        JSON.stringify({
            providers: {
                test: {
                    baseUrl: "https://example.invalid/v1",
                    api: "openai-completions",
                    apiKey: "test-key",
                    models: [
                        { id: "model", input: ["text"] },
                        { id: "text", input: ["text"] },
                        { id: "vision", input: ["text", "image"] },
                        { id: "cli", input: ["text"], executionBackend: "claude-cli" },
                    ],
                },
            },
        }),
    );
}

test("Engineer model fallback is one regular system message per Agent", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-agent-model-fallback-"));
        const sessions: AgentSession[] = [];
        const events: SessionRuntimeEvent[] = [];
        try {
            process.env["HOME"] = tempHome;
            await writeVisionModelConfig(tempHome);
            await fsWriteFile(
                join(tempHome, ".wld", "settings.json"),
                `${JSON.stringify({ agents: { engineer: { model: "test/model" } } }, null, 4)}\n`,
            );
            __resetSettingsForTests();
            const eventSink = {
                emit(event: SessionRuntimeEvent) {
                    events.push(event);
                },
            };
            const hostedSession = new HostedSession({
                id: "agent-model-fallback",
                cwd: tempHome,
                eventSink,
            });

            for (let index = 0; index < 2; index++) {
                const built = await buildAgentSession({
                    hostedSession,
                    agentName: AGENTS.REVIEWER_FEEDBACK_ENGINEER,
                    subAgentDefinition: { id: SUBAGENTS.REVIEWER_FEEDBACK_ENGINEER },
                });
                sessions.push(built.session);
            }

            const notices = events.filter((event) => event.type === "system_status");
            assertEquals(notices.length, 1);
            assertEquals(notices[0].header, "RunWield");
            assertEquals(notices[0].level, "info");
            assertEquals(notices[0].message, "The repair Engineer is using the Engineer model: test/model.");
        } finally {
            for (const session of sessions) session.dispose();
            __resetSettingsForTests();
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            await removeTempDir(tempHome);
        }
    });
});

test("buildAgentSession applies invocation thinking override before settings and agent defaults", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-fixture-"));
        try {
            process.env["HOME"] = tempHome;
            __resetSettingsForTests();
            await writeVisionModelConfig(tempHome);
            await fsWriteFile(join(tempHome, ".wld", "settings.json"), JSON.stringify({ defaultThinkingLevel: "low" }));

            const hostedSession = new HostedSession({ id: "thinking-override", cwd: tempHome });
            const built = await buildAgentSession({
                hostedSession,
                agentName: "delegated",
                modelOverride: "test/text",
                thinkingLevelOverride: "high",
                subAgentDefinition: { id: "delegated" },
            });

            assertEquals(built.resolvedThinkingLevel, "high");
            assertEquals(hostedSession.getThinkingLevel(), "high");
            built.session.dispose();
        } finally {
            __resetSettingsForTests();
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            __resetSettingsForTests();
            await removeTempDir(tempHome);
        }
    });
});

test("Validation Repair Engineer thinking falls back through repair, Engineer, then defaults", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-repair-thinking-fallback-"));
        const sessions: AgentSession[] = [];
        try {
            process.env["HOME"] = tempHome;
            await writeVisionModelConfig(tempHome);
            const settingsPath = join(tempHome, ".wld", "settings.json");

            await fsWriteFile(
                settingsPath,
                JSON.stringify({
                    agents: {
                        engineer: { thinkingLevel: "high" },
                        [AGENTS.REVIEWER_FEEDBACK_ENGINEER]: { model: "test/text" },
                    },
                    defaultThinkingLevel: "low",
                }),
            );
            __resetSettingsForTests();
            const engineerFallback = await buildAgentSession({
                cwd: tempHome,
                agentName: AGENTS.REVIEWER_FEEDBACK_ENGINEER,
                modelOverride: "test/text",
                subAgentDefinition: { id: SUBAGENTS.REVIEWER_FEEDBACK_ENGINEER },
            });
            sessions.push(engineerFallback.session);
            assertEquals(engineerFallback.resolvedThinkingLevel, "high");
            assertEquals(engineerFallback.resolvedModel.id, "text");

            await fsWriteFile(
                settingsPath,
                JSON.stringify({
                    agents: {
                        engineer: { model: "test/model", thinkingLevel: "high" },
                        [AGENTS.REVIEWER_FEEDBACK_ENGINEER]: { thinkingLevel: "minimal" },
                    },
                    defaultThinkingLevel: "low",
                }),
            );
            __resetSettingsForTests();
            const repairSpecific = await buildAgentSession({
                cwd: tempHome,
                agentName: AGENTS.REVIEWER_FEEDBACK_ENGINEER,
                subAgentDefinition: { id: SUBAGENTS.REVIEWER_FEEDBACK_ENGINEER },
            });
            sessions.push(repairSpecific.session);
            assertEquals(repairSpecific.resolvedThinkingLevel, "minimal");
            assertEquals(repairSpecific.resolvedModel.id, "model");

            await fsWriteFile(
                settingsPath,
                JSON.stringify({
                    agents: {
                        engineer: { thinkingLevel: "high" },
                        [AGENTS.REVIEWER_FEEDBACK_ENGINEER]: { thinkingLevel: "off" },
                    },
                    defaultThinkingLevel: "low",
                }),
            );
            __resetSettingsForTests();
            const repairOff = await buildAgentSession({
                cwd: tempHome,
                agentName: AGENTS.REVIEWER_FEEDBACK_ENGINEER,
                modelOverride: "test/text",
                subAgentDefinition: { id: SUBAGENTS.REVIEWER_FEEDBACK_ENGINEER },
            });
            sessions.push(repairOff.session);
            assertEquals(repairOff.resolvedThinkingLevel, "off");

            await fsWriteFile(
                settingsPath,
                JSON.stringify({
                    agents: { engineer: { thinkingLevel: "off" } },
                    defaultThinkingLevel: "low",
                }),
            );
            __resetSettingsForTests();
            const offFallback = await buildAgentSession({
                cwd: tempHome,
                agentName: AGENTS.REVIEWER_FEEDBACK_ENGINEER,
                modelOverride: "test/text",
                subAgentDefinition: { id: SUBAGENTS.REVIEWER_FEEDBACK_ENGINEER },
            });
            sessions.push(offFallback.session);
            assertEquals(offFallback.resolvedThinkingLevel, "off");

            await fsWriteFile(
                settingsPath,
                JSON.stringify({
                    defaultThinkingLevel: "low",
                }),
            );
            __resetSettingsForTests();
            const defaultFallback = await buildAgentSession({
                cwd: tempHome,
                agentName: AGENTS.REVIEWER_FEEDBACK_ENGINEER,
                modelOverride: "test/text",
                subAgentDefinition: { id: SUBAGENTS.REVIEWER_FEEDBACK_ENGINEER },
            });
            sessions.push(defaultFallback.session);
            assertEquals(defaultFallback.resolvedThinkingLevel, "low");

            await fsWriteFile(
                settingsPath,
                JSON.stringify({
                    activeModelPreset: "repair",
                    modelPresets: {
                        repair: {
                            agents: {
                                engineer: { thinkingLevel: "medium" },
                            },
                        },
                    },
                    agents: { engineer: { thinkingLevel: "high" } },
                    defaultThinkingLevel: "low",
                }),
            );
            __resetSettingsForTests();
            const presetFallback = await buildAgentSession({
                cwd: tempHome,
                agentName: AGENTS.REVIEWER_FEEDBACK_ENGINEER,
                modelOverride: "test/text",
                subAgentDefinition: { id: SUBAGENTS.REVIEWER_FEEDBACK_ENGINEER },
            });
            sessions.push(presetFallback.session);
            assertEquals(presetFallback.resolvedThinkingLevel, "medium");

            const invocationOverride = await buildAgentSession({
                cwd: tempHome,
                agentName: AGENTS.REVIEWER_FEEDBACK_ENGINEER,
                modelOverride: "test/text",
                thinkingLevelOverride: "xhigh",
                subAgentDefinition: { id: SUBAGENTS.REVIEWER_FEEDBACK_ENGINEER },
            });
            sessions.push(invocationOverride.session);
            assertEquals(invocationOverride.resolvedThinkingLevel, "xhigh");
        } finally {
            for (const session of sessions) session.dispose();
            __resetSettingsForTests();
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            await removeTempDir(tempHome);
        }
    });
});

test("Validation Repair Engineer thinking fallback reaches CLI execution session construction", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-repair-thinking-execution-"));
        try {
            process.env["HOME"] = tempHome;
            await writeVisionModelConfig(tempHome);
            await fsWriteFile(
                join(tempHome, ".wld", "settings.json"),
                JSON.stringify({
                    agents: {
                        engineer: { thinkingLevel: "high" },
                        [AGENTS.REVIEWER_FEEDBACK_ENGINEER]: { model: "claude-cli/sonnet" },
                    },
                    defaultThinkingLevel: "low",
                }),
            );
            __resetSettingsForTests();

            const built = await buildExecutionSession({
                cwd: tempHome,
                agentName: AGENTS.REVIEWER_FEEDBACK_ENGINEER,
                subAgentDefinition: { id: SUBAGENTS.REVIEWER_FEEDBACK_ENGINEER },
            });
            assertEquals(built.resolvedModel.executionBackend, "claude-cli");
            assertEquals(built.resolvedThinkingLevel, "high");
            built.session.dispose();
        } finally {
            __resetSettingsForTests();
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            await removeTempDir(tempHome);
        }
    });
});

test("buildAgentSession disables developer role for Kimi code models", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-kimi-compat-"));
        try {
            process.env["HOME"] = tempHome;
            __resetSettingsForTests();
            await fsMkdir(join(tempHome, ".wld"), { recursive: true });
            await fsWriteFile(
                join(tempHome, ".wld", "models.json"),
                JSON.stringify({
                    providers: {
                        "kimi-code": {
                            baseUrl: "https://api.kimi.com/coding/v1",
                            api: "openai-completions",
                            apiKey: "test-key",
                            models: [
                                {
                                    id: "k3-256k",
                                    reasoning: true,
                                    input: ["text"],
                                    compat: { supportsTemperature: false },
                                },
                            ],
                        },
                    },
                }),
            );

            const built = await buildAgentSession({
                cwd: tempHome,
                agentName: "operator",
                modelOverride: "kimi-code/k3-256k",
            });

            assertEquals(built.resolvedModel.compat?.supportsDeveloperRole, false);
            assertEquals(built.resolvedModel.compat?.supportsTemperature, false);
            built.session.dispose();
        } finally {
            __resetSettingsForTests();
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            __resetSettingsForTests();
            await removeTempDir(tempHome);
        }
    });
});

test("buildAgentSession wires bundled background shell and retained delegate tools", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-delegate-wiring-"));
        const sessions: AgentSession[] = [];
        try {
            process.env["HOME"] = tempHome;
            __resetSettingsForTests();
            await writeVisionModelConfig(tempHome);

            const hostedSession = new HostedSession({ id: "delegate-wiring", cwd: tempHome });
            const enabled = await buildAgentSession({
                hostedSession,
                cwd: tempHome,
                agentName: AGENTS.GUIDE,
                modelOverride: "test/vision",
            });
            sessions.push(enabled.session);
            assert(enabled.finalCustomTools.some((tool) => tool.name === "delegate_agent"));
            assert(enabled.finalCustomTools.some((tool) => tool.name === "background_task"));

            const disabled = await buildAgentSession({
                hostedSession,
                cwd: tempHome,
                agentName: AGENTS.ROUTER,
                modelOverride: "test/vision",
            });
            sessions.push(disabled.session);
            assertEquals(
                disabled.finalCustomTools.some((tool) => tool.name === "delegate_agent"),
                false,
            );
            assert(disabled.finalCustomTools.some((tool) => tool.name === "background_task"));
        } finally {
            for (const session of sessions) session.dispose();
            __resetSettingsForTests();
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            __resetSettingsForTests();
            await removeTempDir(tempHome);
        }
    });
});

test("buildAgentSession injects see_image only for text-only model with vision fallback", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-see-image-injection-"));
        const sessions: AgentSession[] = [];
        try {
            process.env["HOME"] = tempHome;
            __resetSettingsForTests();
            await writeVisionModelConfig(tempHome);
            await fsWriteFile(
                join(tempHome, ".wld", "settings.json"),
                JSON.stringify({
                    visionFallback: { model: "test/vision" },
                }),
            );

            const textBuilt = await buildAgentSession({
                cwd: tempHome,
                agentName: "operator",
                modelOverride: "test/text",
            });
            sessions.push(textBuilt.session);
            assertEquals(textBuilt.tools.includes("see_image"), true);
            assert(textBuilt.finalCustomTools.find((tool) => tool.name === "see_image"));
            const seeImage = textBuilt.finalCustomTools.find((tool) => tool.name === "see_image");
            assert(seeImage, "expected see_image custom tool");
            assert(seeImage.execute, "expected see_image execute");

            const visionBuilt = await buildAgentSession({
                cwd: tempHome,
                agentName: "operator",
                modelOverride: "test/vision",
            });
            sessions.push(visionBuilt.session);
            assertEquals(visionBuilt.tools.includes("see_image"), false);
            assertEquals(Boolean(visionBuilt.finalCustomTools.find((tool) => tool.name === "see_image")), false);
        } finally {
            for (const session of sessions) session.dispose();
            __resetSettingsForTests();
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            await removeTempDir(tempHome);
        }
    });
});

test("buildAgentSession omits see_image for text-only model without fallback", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-see-image-no-fallback-"));
        let session: AgentSession | undefined;
        try {
            process.env["HOME"] = tempHome;
            __resetSettingsForTests();
            await writeVisionModelConfig(tempHome);
            await fsWriteFile(join(tempHome, ".wld", "settings.json"), JSON.stringify({}));

            const built = await buildAgentSession({
                cwd: tempHome,
                agentName: "operator",
                modelOverride: "test/text",
            });
            session = built.session;
            assertEquals(built.tools.includes("see_image"), false);
        } finally {
            session?.dispose();
            __resetSettingsForTests();
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            await removeTempDir(tempHome);
        }
    });
});

test("buildAgentSession defers invalid optional vision fallback until image use", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-see-image-invalid-fallback-"));
        let session: AgentSession | undefined;
        try {
            process.env["HOME"] = tempHome;
            __resetSettingsForTests();
            await writeVisionModelConfig(tempHome);
            await fsWriteFile(
                join(tempHome, ".wld", "settings.json"),
                JSON.stringify({
                    visionFallback: { model: "not-valid" },
                }),
            );
            await fsWriteFile(join(tempHome, "shot.png"), new Uint8Array([1]));

            const built = await buildAgentSession({
                cwd: tempHome,
                agentName: "operator",
                modelOverride: "test/text",
            });
            session = built.session;
            const seeImage = built.finalCustomTools.find((tool) => tool.name === "see_image");
            assert(seeImage, "expected see_image custom tool");
            const result = await seeImage.execute(
                "1",
                { imageRef: "shot.png" },
                undefined,
                undefined,
                {} as ToolExecutionContext,
            );

            assertEquals(result.isError, true);
            assertEquals(
                (result.content[0] as TextContent).text,
                "Invalid visionFallback.model: not-valid. Use provider/id.",
            );
        } finally {
            session?.dispose();
            __resetSettingsForTests();
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            await removeTempDir(tempHome);
        }
    });
});

test("buildAgentSession auto-wires Work Record tools with role access modes", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-work-record-tool-wiring-"));
        const sessions: AgentSession[] = [];
        try {
            process.env["HOME"] = tempHome;
            __resetSettingsForTests();
            await writeVisionModelConfig(tempHome);
            await fsMkdir(join(tempHome, ".wld", "agents"), { recursive: true });
            await fsWriteFile(
                join(tempHome, ".wld", "agents", "custom-agent.md"),
                [
                    "---",
                    "name: Custom Agent",
                    "tools:",
                    "  - work_record_search",
                    "  - work_record_read",
                    "---",
                    "Fixture prompt.",
                ].join("\n"),
            );

            const build = async (agentName: string) => {
                const built = await buildAgentSession({
                    cwd: tempHome,
                    agentName,
                    modelOverride: "test/model",
                });
                sessions.push(built.session);
                return built;
            };

            const guideBuilt = await build(AGENTS.GUIDE);
            const plannerBuilt = await build(AGENTS.PLANNER);
            const customBuilt = await build("custom-agent");
            for (const built of [guideBuilt, plannerBuilt, customBuilt]) {
                assert(built.finalCustomTools.find((tool) => tool.name === "work_record_search"));
                assert(built.finalCustomTools.find((tool) => tool.name === "work_record_read"));
            }

            const guideSearch = guideBuilt.finalCustomTools.find((tool) => tool.name === "work_record_search")!;
            const plannerSearch = plannerBuilt.finalCustomTools.find((tool) => tool.name === "work_record_search")!;
            const customRead = customBuilt.finalCustomTools.find((tool) => tool.name === "work_record_read")!;
            assertEquals(
                (
                    (await guideSearch.execute("1", { query: "" }, undefined, undefined, {} as ToolExecutionContext))
                        .details as WorkRecordAccessDetails
                ).accessMode,
                "all",
            );
            assertEquals(
                (
                    (await plannerSearch.execute("1", { query: "" }, undefined, undefined, {} as ToolExecutionContext))
                        .details as WorkRecordAccessDetails
                ).accessMode,
                "current",
            );
            assertEquals(
                (
                    (await customRead.execute("1", { recordId: "" }, undefined, undefined, {} as ToolExecutionContext))
                        .details as WorkRecordAccessDetails
                ).accessMode,
                "current",
            );
        } finally {
            for (const session of sessions) session.dispose();
            __resetSettingsForTests();
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            __resetSettingsForTests();
            await removeTempDir(tempHome);
        }
    });
});

test("Guide bash policy reaches Pi and background tools and refreshes after root rebuild", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const cwd = await fsMkdtemp(join(tmpdir(), "runwield-guide-bash-policy-"));
        const { ensureRootAgentSession, getRootSessionRebuildOptions, __getRootSessionMetadataForTests } =
            await import("../session.ts");
        const overrideDir = join(cwd, ".wld", "agents");
        const overridePath = join(overrideDir, "guide.md");
        const hostedSession = new HostedSession({ id: "guide-bash-policy", cwd });
        const setPolicy = async (value: string) => {
            await fsMkdir(overrideDir, { recursive: true });
            await fsWriteFile(overridePath, `---\nbashAllowedCommands: ${value}\n---\n`);
        };
        const findTool = (name: string) => {
            const metadata = __getRootSessionMetadataForTests(hostedSession.getRootAgentSession() as AgentSession);
            return ((metadata?.finalCustomTools || []) as ToolDefinition[]).find((tool) => tool.name === name);
        };
        try {
            process.env["HOME"] = cwd;
            __resetSettingsForTests();
            await writeVisionModelConfig(cwd);
            const init = await captureForegroundProcess("git", { cwd, args: ["init", "-b", "main"] });
            assert(init.success);
            await fsWriteFile(join(cwd, "dirty.txt"), "visible in status\n");
            await setPolicy("[git version]");
            getSettingsManager(cwd).setShellPath(bashFixtureExecutable());
            getSettingsManager(cwd).setShellCommandPrefix("printf 'configured shell' > shell-prefix.txt; ");
            await ensureRootAgentSession({ hostedSession, agentName: AGENTS.GUIDE, modelOverride: "test/text" });
            const execute = (tool: ToolDefinition | undefined, params: PolicyToolInput) => {
                assert(tool);
                return tool.execute("call", params, new AbortController().signal, () => {}, {
                    sessionManager: SessionManager.inMemory(cwd),
                } as PolicyToolContext);
            };
            assertEquals(
                (await execute(findTool("bash"), { command: "git version" })).content.some(
                    (item) => item.type === "text" && item.text.includes("git version"),
                ),
                true,
            );
            assertEquals(await fsReadFile(join(cwd, "shell-prefix.txt"), "utf8"), "configured shell");
            assert(
                (await execute(findTool("bash"), { command: "git status --short" })).content.some(
                    (item) => item.type === "text" && item.text.includes("dirty.txt"),
                ),
            );
            await assertRejects(
                () => execute(findTool("bash"), { command: "touch forbidden" }),
                Error,
                "report a blocker",
            );
            const denied = await execute(findTool("background_task"), { action: "start", command: "touch forbidden" });
            assert(denied.content.some((item) => item.type === "text" && item.text.includes("git version")));
            assertEquals(
                getRootSessionRebuildOptions(hostedSession).customTools?.some((tool) => tool.name === "bash"),
                false,
            );
            assert(findTool("bash")?.description.includes("git version"));
            assert(
                __getRootSessionMetadataForTests(
                    hostedSession.getRootAgentSession() as AgentSession,
                )?.promptState.text.includes("git version"),
            );
            await setPolicy("[git status]");
            await ensureRootAgentSession({
                hostedSession,
                agentName: AGENTS.GUIDE,
                modelOverride: "test/text",
                ...getRootSessionRebuildOptions(hostedSession),
            });
            await assertRejects(() => execute(findTool("bash"), { command: "git version" }), Error, "git status");
            const started = await execute(findTool("background_task"), {
                action: "start",
                command: "git status --short",
            });
            const taskId = (started as BackgroundToolResult).details?.task_id;
            assert(taskId);
            await hostedSession.backgroundTasks.wait(taskId);
            assert(
                (
                    (await execute(findTool("background_task"), {
                        action: "status",
                        task_id: taskId,
                    })) as BackgroundToolResult
                ).details?.output.includes("dirty.txt"),
            );
            assert(
                (await execute(findTool("background_task"), { action: "start", command: "git version" })).content.some(
                    (item) => item.type === "text" && item.text.includes("git status"),
                ),
            );
            await setPolicy("[]");
            await ensureRootAgentSession({
                hostedSession,
                agentName: AGENTS.GUIDE,
                modelOverride: "test/text",
                ...getRootSessionRebuildOptions(hostedSession),
            });
            await assertRejects(() => execute(findTool("bash"), { command: "pwd" }), Error, "(none)");
            await setPolicy("null");
            await ensureRootAgentSession({
                hostedSession,
                agentName: AGENTS.GUIDE,
                modelOverride: "test/text",
                ...getRootSessionRebuildOptions(hostedSession),
            });
            await execute(findTool("bash"), { command: "touch unrestricted-file" });
            assertEquals((await fsStat(join(cwd, "unrestricted-file"))).isFile(), true);
        } finally {
            hostedSession.getRootAgentSession()?.dispose?.();
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            __resetSettingsForTests();
            await removeTempDir(cwd);
        }
    });
});

test("read and write delegated Pi sessions inherit only the parent's available bash authority", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const cwd = await fsMkdtemp(join(tmpdir(), "runwield-delegate-bash-policy-"));
        const sessions: AgentSession[] = [];
        try {
            process.env["HOME"] = cwd;
            __resetSettingsForTests();
            await writeVisionModelConfig(cwd);
            const hostedSession = new HostedSession({ id: "read-delegate-bash-policy", cwd });
            const build = async (
                id: DelegatedSubAgentDefinitionId,
                toolNames: string[],
                inheritedBashAllowedCommands: readonly string[] | undefined,
            ) => {
                const built = await buildAgentSession({
                    hostedSession,
                    agentName: AGENTS.DELEGATED,
                    subAgentDefinition: { id },
                    toolNames,
                    inheritedBashAllowedCommands,
                    modelOverride: "test/text",
                });
                sessions.push(built.session);
                return built;
            };
            const read = await build(SUBAGENTS.DELEGATED_READ, ["bash", "read"], ["git status"]);
            const readBash = read.finalCustomTools.find((tool) => tool.name === "bash");
            assert(readBash);
            await assertRejects(
                () =>
                    readBash.execute("call", { command: "git log" }, new AbortController().signal, () => {}, {
                        sessionManager: SessionManager.inMemory(cwd),
                    } as PolicyToolContext),
                Error,
                "git status",
            );
            assertEquals(read.tools.includes("background_task"), false);
            const write = await build(SUBAGENTS.DELEGATED, ["bash", "read"], ["pwd"]);
            const writeBash = write.finalCustomTools.find((tool) => tool.name === "bash");
            assert(writeBash);
            await assertRejects(
                () =>
                    writeBash.execute("call", { command: "git status" }, new AbortController().signal, () => {}, {
                        sessionManager: SessionManager.inMemory(cwd),
                    } as PolicyToolContext),
                Error,
                "pwd",
            );
            const noBash = await build(SUBAGENTS.DELEGATED_READ, ["read"], undefined);
            assertEquals(noBash.tools.includes("bash"), false);
            assertEquals(
                noBash.finalCustomTools.some((tool) => tool.name === "bash"),
                false,
            );
            const unrestrictedWrite = await build(SUBAGENTS.DELEGATED, ["bash", "read"], undefined);
            const unrestrictedBash = unrestrictedWrite.finalCustomTools.find((tool) => tool.name === "bash");
            assert(unrestrictedBash);
            await unrestrictedBash.execute(
                "call",
                { command: "touch write-delegate-file" },
                new AbortController().signal,
                () => {},
                { sessionManager: SessionManager.inMemory(cwd) } as PolicyToolContext,
            );
            assertEquals((await fsStat(join(cwd, "write-delegate-file"))).isFile(), true);
            const defaultRead = await build(SUBAGENTS.DELEGATED_READ, ["bash", "read"], undefined);
            const defaultReadBash = defaultRead.finalCustomTools.find((tool) => tool.name === "bash");
            assert(defaultReadBash);
            const restrictedInput = { command: "cat 'write-delegate-file'" };
            await defaultRead.session.extensionRunner.emitToolCall({
                type: "tool_call",
                toolName: "bash",
                toolCallId: "restricted",
                input: restrictedInput,
            });
            assertEquals(restrictedInput.command, "cat 'write-delegate-file'");
            const unrestrictedInput = { command: "cat 'write-delegate-file'" };
            await unrestrictedWrite.session.extensionRunner.emitToolCall({
                type: "tool_call",
                toolName: "bash",
                toolCallId: "unrestricted",
                input: unrestrictedInput,
            });
            assert(unrestrictedInput.command.includes("snip run --"));
            await assertRejects(
                () =>
                    defaultReadBash.execute(
                        "call",
                        { command: "touch forbidden" },
                        new AbortController().signal,
                        () => {},
                        { sessionManager: SessionManager.inMemory(cwd) } as PolicyToolContext,
                    ),
                Error,
                "report a blocker",
            );
            assertEquals(
                await fsStat(join(cwd, "forbidden")).then(
                    () => true,
                    () => false,
                ),
                false,
            );
        } finally {
            for (const session of sessions) session.dispose();
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            __resetSettingsForTests();
            await removeTempDir(cwd);
        }
    });
});

test("external CLI bridge filters RunWield background starts but not native host commands", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-bridge-bash-policy-"));
    const hostedSession = new HostedSession({ id: "bridge-bash-policy", cwd });
    try {
        const agentDef = await agentRegistry.get(AGENTS.GUIDE, cwd);
        const bridged = await composeClaudeCliBridgedTools({
            agentDef,
            agentName: AGENTS.GUIDE,
            hostedSession,
            cwd,
            triageMeta: undefined,
        });
        const background = bridged.find((tool) => tool.name === "background_task");
        assert(background);
        const result = await background.execute(
            "call",
            { action: "start", command: "touch bridge-sentinel" },
            new AbortController().signal,
            () => {},
            {} as ToolExecutionContext,
        );
        assert(result.content.some((item) => item.type === "text" && item.text.includes("report a blocker")));
        assertEquals(
            await fsStat(join(cwd, "bridge-sentinel")).then(
                () => true,
                () => false,
            ),
            false,
        );
    } finally {
        await hostedSession.backgroundTasks.cancelAllAndSuppress();
        await removeTempDir(cwd);
    }
});

test("Claude CLI bridges declared Plan Deviations for execution Agents", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-cli-deviation-"));
    const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd });
    try {
        for (const agentName of ["plan-engineer", "frontend-engineer"]) {
            const agentDef = await agentRegistry.get(agentName, REPO_ROOT);
            const tools = await composeClaudeCliBridgedTools({
                agentDef,
                agentName,
                hostedSession,
                triageMeta: undefined,
                cwd,
            });
            assertEquals(tools.filter((tool) => tool.name === "record_plan_deviation").length, 1);
        }
    } finally {
        hostedSession.dispose();
        await removeTempDir(cwd);
    }
});

test("real Session tool policy rejects runtime privilege expansion while admitting registered extension tools", async () => {
    await withRuntimeCommandFixture("tool-policy-boundary-", async ({ projectRoot }) => {
        const agentsDir = join(projectRoot, ".wld", "agents");
        await fsMkdir(agentsDir, { recursive: true });
        await fsWriteFile(join(agentsDir, "guide.md"), "---\ntools: [read]\n---\nRead the project.\n");
        const built = await buildAgentSession({
            cwd: projectRoot,
            agentName: "guide",
            toolNames: ["read", "bash", "background_task", "pair_checkpoint", "record_plan_deviation"],
            customTools: [
                {
                    name: "fixture_extension",
                    label: "Fixture extension",
                    description: "An explicitly registered external capability.",
                    parameters: { type: "object", properties: {} },
                    execute: () =>
                        Promise.resolve({ content: [{ type: "text", text: "extension response" }], details: null }),
                },
            ],
        });
        try {
            const permitted = built.session.getActiveToolNames();
            for (const denied of ["bash", "background_task", "pair_checkpoint", "record_plan_deviation"]) {
                assertEquals(permitted.includes(denied), false, denied);
            }
            for (const allowed of ["read", "set_session_name", "fixture_extension"]) {
                assertEquals(permitted.includes(allowed), true, allowed);
            }
        } finally {
            built.session.dispose();
        }
    });
});
