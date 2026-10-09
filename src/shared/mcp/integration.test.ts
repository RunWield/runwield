import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import {
    createAgentSession,
    DefaultResourceLoader,
    SessionManager,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { dirname, fromFileUrl, join } from "@std/path";
import { getCwd } from "../../constants.js";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { SessionHost } from "../session/session-host.ts";
import { HostedSession } from "../session/hosted-session.js";
import { buildAgentSession, runIsolatedAgentSession } from "../session/session.js";
import { createSessionRuntime } from "../session/session-runtime.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { startMcpIntegration } from "./integration.ts";
import { getModelRegistry } from "../models/model-registry.ts";
import { getSettingsDir, getSettingsManager } from "../settings.js";

interface McpResultDetails {
    server: string;
    tool: string;
    fullOutputPath?: string;
}

const fixtureServer = join(dirname(fromFileUrl(import.meta.url)), "fixture-server.ts");

function callFixtureTool(
    tool: ToolDefinition,
    marker: string,
    onUpdate?: Parameters<ToolDefinition["execute"]>[3],
) {
    const context = {} as Parameters<ToolDefinition["execute"]>[4];
    return tool.execute(`call-${marker}`, { marker }, undefined, onUpdate, context);
}

async function readLog(path: string): Promise<string[]> {
    try {
        return (await Deno.readTextFile(path)).trim().split("\n").filter(Boolean);
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return [];
        throw error;
    }
}

async function startFixtureIntegration(env: Record<string, string> = {}) {
    const logPath = await Deno.makeTempFile({ prefix: "runwield-mcp-log-" });
    const integrationResult = await startMcpIntegration({
        cwd: getCwd(),
        servers: [{
            name: "fixture",
            command: Deno.execPath(),
            args: ["run", "-A", fixtureServer],
            env: { RUNWIELD_MCP_FIXTURE_LOG: logPath, ...env },
            source: "request",
        }],
    });
    return { ...integrationResult, logPath };
}

Deno.test("MCP integration exposes a real stdio tool and forwards arguments", async () => {
    const integrationResult = await startFixtureIntegration();
    try {
        assertEquals(integrationResult.warnings, []);
        const tools = integrationResult.integration.getTools();
        assertEquals(tools.map((tool) => tool.name), ["mcp__fixture__fixture_echo"]);
        const context = {} as Parameters<typeof tools[0]["execute"]>[4];
        const result = await tools[0].execute("call-1", { marker: "real-call" }, undefined, undefined, context);
        assertEquals(result.content, [{ type: "text", text: "fixture-result:real-call" }]);
        const logLines = await readLog(integrationResult.logPath);
        assertStringIncludes(logLines.join("\n"), '"event":"call"');
        assertStringIncludes(logLines.join("\n"), '"marker":"real-call"');
    } finally {
        await integrationResult.integration.close();
        await Deno.remove(integrationResult.logPath).catch(() => {});
    }
});

Deno.test("root Pi turns can call a real MCP fixture tool", async () => {
    await withRuntimeCommandFixture("runwield-root-mcp-call-", async (fixture) => {
        const logPath = await Deno.makeTempFile({ prefix: "runwield-root-mcp-log-" });
        const runtime = createSessionRuntime();
        let sawToolResultInTurn = false;
        let sawErrorResultInTurn = false;
        fixture.setModelResponseFactories([
            () => {
                return fauxAssistantMessage([
                    fauxToolCall("mcp__fixture__fixture_echo", { marker: "root-pi" }),
                    fauxToolCall("mcp__fixture__fixture_echo", { marker: "error" }),
                ]);
            },
            (context) => {
                sawToolResultInTurn = JSON.stringify(context.messages).includes("fixture-result:root-pi");
                sawErrorResultInTurn = context.messages.some((message) =>
                    message.role === "toolResult" && message.toolName === "mcp__fixture__fixture_echo" &&
                    message.isError === true
                );
                return fauxAssistantMessage(fauxText("Root MCP turn complete."));
            },
        ]);
        try {
            const sessionId = await runtime.createPromptReadySession({
                cwd: fixture.projectRoot,
                mcpServers: [{
                    name: "fixture",
                    command: Deno.execPath(),
                    args: ["run", "-A", fixtureServer],
                    env: { RUNWIELD_MCP_FIXTURE_LOG: logPath },
                    source: "request",
                }],
            });
            const result = await runtime.promptSession(sessionId, { initialRequest: "Call the MCP fixture." });
            assertEquals(result.ok, true);
            assertEquals(sawToolResultInTurn, true);
            assertEquals(sawErrorResultInTurn, true);
            const logLines = await readLog(logPath);
            assertStringIncludes(logLines.join("\n"), '"marker":"root-pi"');
        } finally {
            await runtime.closeAllSessionsWhenIdle?.();
            await Deno.remove(logPath).catch(() => {});
        }
    });
});

Deno.test("Pi MCP client follows paginated tool lists and retains tool annotations", async () => {
    const integrationResult = await startFixtureIntegration({
        RUNWIELD_MCP_FIXTURE_PAGINATED: "1",
        RUNWIELD_MCP_FIXTURE_TOOLS: "first,second",
    });
    try {
        const tools = integrationResult.integration.getTools();
        assertEquals(tools.map((tool) => tool.name), ["mcp__fixture__first", "mcp__fixture__second"]);
        assertEquals(tools.map((tool) => tool.annotations), [{ readOnlyHint: true }, { readOnlyHint: true }]);
        assertStringIncludes((await readLog(integrationResult.logPath)).join("\n"), '"cursor":"second-page"');
        const result = await callFixtureTool(tools[1], "paginated");
        assertEquals(result.content, [{ type: "text", text: "fixture-result:paginated" }]);
    } finally {
        await integrationResult.integration.close();
        await Deno.remove(integrationResult.logPath).catch(() => {});
    }
});

Deno.test("Pi MCP content conversion preserves structured results, errors, and embedded images", async () => {
    const integrationResult = await startFixtureIntegration();
    try {
        const [tool] = integrationResult.integration.getTools();
        const structured = await callFixtureTool(tool, "structured");
        assertEquals(structured.content, [{
            type: "text",
            text: JSON.stringify({ marker: "structured", count: 2 }, null, 2),
        }]);
        assertEquals(structured.details, {
            server: "fixture",
            tool: "fixture_echo",
        });
        const failed = await callFixtureTool(tool, "error");
        assertEquals(failed.isError, true);
        assertEquals(failed.details, { server: "fixture", tool: "fixture_echo" });
        assertEquals(structured.structuredContent, {
            content: [],
            structuredContent: { marker: "structured", count: 2 },
        });
        assertEquals(failed.content, [{ type: "text", text: "fixture-error" }]);
        const image = await callFixtureTool(tool, "image-resource");
        assertEquals(image.content, [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]);
    } finally {
        await integrationResult.integration.close();
        await Deno.remove(integrationResult.logPath).catch(() => {});
    }
});

Deno.test("Pi MCP progress reaches the RunWield tool update callback", async () => {
    const integrationResult = await startFixtureIntegration();
    try {
        const [tool] = integrationResult.integration.getTools();
        const updates: string[] = [];
        const result = await callFixtureTool(tool, "progress", (update) => {
            for (const block of update.content) if (block.type === "text") updates.push(block.text);
        });
        assertEquals(updates, ["Fixture halfway done."]);
        assertEquals(result.content, [{ type: "text", text: "fixture-result:progress" }]);
    } finally {
        await integrationResult.integration.close();
        await Deno.remove(integrationResult.logPath).catch(() => {});
    }
});

Deno.test("Pi MCP transport inherits only RunWield's minimal environment and configured credentials", async () => {
    await withProcessGlobalTestLock(async () => {
        const prior = Deno.env.get("RUNWIELD_MCP_UNCONFIGURED_SECRET");
        Deno.env.set("RUNWIELD_MCP_UNCONFIGURED_SECRET", "host-secret");
        try {
            const integrationResult = await startFixtureIntegration({
                RUNWIELD_MCP_CONFIGURED_SECRET: "configured-secret",
            });
            try {
                const [tool] = integrationResult.integration.getTools();
                const result = await callFixtureTool(tool, "environment");
                assertEquals(result.content, [{
                    type: "text",
                    text: JSON.stringify({ inherited: null, configured: "configured-secret" }),
                }]);
            } finally {
                await integrationResult.integration.close();
                await Deno.remove(integrationResult.logPath).catch(() => {});
            }
        } finally {
            if (prior === undefined) Deno.env.delete("RUNWIELD_MCP_UNCONFIGURED_SECRET");
            else Deno.env.set("RUNWIELD_MCP_UNCONFIGURED_SECRET", prior);
        }
    });
});

Deno.test("root Agent handoff keeps the MCP fixture tool available", async () => {
    await withRuntimeCommandFixture("runwield-root-mcp-handoff-", async (fixture) => {
        const logPath = await Deno.makeTempFile({ prefix: "runwield-root-mcp-handoff-log-" });
        const runtime = createSessionRuntime();
        let sawToolResultAfterHandoff = false;
        fixture.setModelResponseFactories([
            () => fauxAssistantMessage(fauxToolCall("mcp__fixture__fixture_echo", { marker: "handoff" })),
            (context) => {
                sawToolResultAfterHandoff = JSON.stringify(context.messages).includes("fixture-result:handoff");
                return fauxAssistantMessage(fauxText("Planner MCP turn complete."));
            },
        ]);
        try {
            const sessionId = await runtime.createPromptReadySession({
                cwd: fixture.projectRoot,
                mcpServers: [{
                    name: "fixture",
                    command: Deno.execPath(),
                    args: ["run", "-A", fixtureServer],
                    env: { RUNWIELD_MCP_FIXTURE_LOG: logPath },
                    source: "request",
                }],
            });
            const switched = await runtime.switchAgent(sessionId, { agentName: "planner" });
            assertEquals(switched.ok, true);

            const result = await runtime.promptSession(sessionId, { initialRequest: "Use MCP after Agent handoff." });

            assertEquals(result.ok, true);
            assertEquals(sawToolResultAfterHandoff, true);
            assertStringIncludes((await readLog(logPath)).join("\n"), '"marker":"handoff"');
        } finally {
            await runtime.closeAllSessionsWhenIdle?.();
            await Deno.remove(logPath).catch(() => {});
        }
    });
});

Deno.test("two Runtime Sessions own and close their MCP integrations independently", async () => {
    await withRuntimeCommandFixture("runwield-mcp-two-session-", async (fixture) => {
        const firstLog = await Deno.makeTempFile({ prefix: "runwield-mcp-first-log-" });
        const secondLog = await Deno.makeTempFile({ prefix: "runwield-mcp-second-log-" });
        const runtime = createSessionRuntime();
        const serverFor = (logPath: string) => ({
            name: "fixture",
            command: Deno.execPath(),
            args: ["run", "-A", fixtureServer],
            env: { RUNWIELD_MCP_FIXTURE_LOG: logPath },
            source: "request" as const,
        });
        try {
            const firstId = await runtime.createPromptReadySession({
                cwd: fixture.projectRoot,
                mcpServers: [serverFor(firstLog)],
            });
            const secondId = await runtime.createPromptReadySession({
                cwd: fixture.projectRoot,
                mcpServers: [serverFor(secondLog)],
            });
            await runtime.closeSession(firstId);
            fixture.setModelMessages([
                fauxAssistantMessage(fauxToolCall("mcp__fixture__fixture_echo", { marker: "second-live" })),
                fauxAssistantMessage(fauxText("Second Session MCP turn complete.")),
            ]);

            const result = await runtime.promptSession(secondId, { initialRequest: "Use the second MCP pool." });

            assertEquals(result.ok, true);
            assertStringIncludes((await readLog(firstLog)).join("\n"), '"event":"shutdown"');
            assertStringIncludes((await readLog(secondLog)).join("\n"), '"marker":"second-live"');
        } finally {
            await runtime.closeAllSessionsWhenIdle?.();
            await Deno.remove(firstLog).catch(() => {});
            await Deno.remove(secondLog).catch(() => {});
        }
    });
});

Deno.test("HostedSession dehydration keeps MCP ownership and direct disposal closes only its integration", async () => {
    const host = new SessionHost();
    const first = await startFixtureIntegration();
    const second = await startFixtureIntegration();
    const firstSession = host.createSession({
        id: "first-mcp-owner",
        cwd: getCwd(),
        managed: {
            runwieldSessionId: "runwield-first",
            projectId: "project",
            piSessionId: "pi-first",
            transcriptPath: first.logPath,
            currentSegmentId: "segment-first",
            generation: 0,
            name: null,
            activeAgent: null,
            workflowContext: null,
        },
    });
    const secondSession = host.createSession({
        id: "second-mcp-owner",
        cwd: getCwd(),
        managed: {
            runwieldSessionId: "runwield-second",
            projectId: "project",
            piSessionId: "pi-second",
            transcriptPath: second.logPath,
            currentSegmentId: "segment-second",
            generation: 0,
            name: null,
            activeAgent: null,
            workflowContext: null,
        },
    });
    try {
        await firstSession.setMcpIntegration(first.integration);
        await secondSession.setMcpIntegration(second.integration);
        firstSession.dehydrateManagedSession();
        const [firstTool] = firstSession.getMcpRootTools();
        const context = {} as Parameters<typeof firstTool["execute"]>[4];
        const dehydratedResult = await firstTool.execute(
            "call-dehydrated",
            { marker: "dehydrated-owner" },
            undefined,
            undefined,
            context,
        );
        assertEquals(dehydratedResult.content, [{ type: "text", text: "fixture-result:dehydrated-owner" }]);

        await host.disposeSession(firstSession.id);
        assertStringIncludes((await readLog(first.logPath)).join("\n"), '"event":"shutdown"');
        assertEquals((await readLog(second.logPath)).join("\n").includes('"event":"shutdown"'), false);

        const [secondTool] = secondSession.getMcpRootTools();
        const secondContext = {} as Parameters<typeof secondTool["execute"]>[4];
        const liveResult = await secondTool.execute(
            "call-second-live",
            { marker: "second-owned" },
            undefined,
            undefined,
            secondContext,
        );
        assertEquals(liveResult.content, [{ type: "text", text: "fixture-result:second-owned" }]);
    } finally {
        await host.dispose();
        await Deno.remove(first.logPath).catch(() => {});
        await Deno.remove(second.logPath).catch(() => {});
    }
});

Deno.test("Runtime replacement carries MCP ownership to the new Session", async () => {
    await withRuntimeCommandFixture("runwield-mcp-replacement-", async (fixture) => {
        const logPath = await Deno.makeTempFile({ prefix: "runwield-mcp-replacement-log-" });
        const runtime = createSessionRuntime();
        fixture.setModelMessages([
            fauxAssistantMessage(fauxToolCall("mcp__fixture__fixture_echo", { marker: "replacement" })),
            fauxAssistantMessage(fauxText("Replacement MCP turn complete.")),
        ]);
        try {
            const sessionId = await runtime.createPromptReadySession({
                cwd: fixture.projectRoot,
                mcpServers: [{
                    name: "fixture",
                    command: Deno.execPath(),
                    args: ["run", "-A", fixtureServer],
                    env: { RUNWIELD_MCP_FIXTURE_LOG: logPath },
                    source: "request",
                }],
            });
            const replacementId = await runtime.replaceSessionForExecutionFollowUp(sessionId, {
                planName: "mcp-replacement",
                triageMeta: { classification: "FEATURE", complexity: "LOW" },
                executionAgent: "engineer",
                executionCwd: fixture.projectRoot,
            });

            const result = await runtime.promptSession(replacementId, { initialRequest: "Use the carried MCP tool." });
            assertEquals(result.ok, true);
            assertStringIncludes((await readLog(logPath)).join("\n"), '"marker":"replacement"');
            await runtime.closeAllSessionsWhenIdle?.();
            assertStringIncludes((await readLog(logPath)).join("\n"), '"event":"shutdown"');
        } finally {
            await runtime.closeAllSessionsWhenIdle?.();
            await Deno.remove(logPath).catch(() => {});
        }
    });
});

Deno.test("MCP integration warnings identify connection failures without exposing raw server text", async () => {
    const spawnFailure = await startMcpIntegration({
        cwd: getCwd(),
        servers: [{ name: "dead", command: "/definitely/not/runwield-mcp", args: [], env: {}, source: "request" }],
    });
    try {
        assertEquals(spawnFailure.integration.getTools(), []);
        assertEquals(spawnFailure.warnings[0].serverName, "dead");
        assertEquals(spawnFailure.warnings[0].stage, "connection");
        assertEquals(spawnFailure.warnings[0].message.includes("/definitely/not"), false);
    } finally {
        await spawnFailure.integration.close();
    }

    const initFailure = await startFixtureIntegration({ RUNWIELD_MCP_FIXTURE_INIT_ERROR: "1" });
    try {
        assertEquals(initFailure.integration.getTools(), []);
        assertEquals(initFailure.warnings[0].stage, "connection");
        assertEquals(initFailure.warnings[0].message.includes("TOKEN=abc"), false);
        assertEquals(initFailure.warnings[0].message.includes("--secret"), false);
    } finally {
        await initFailure.integration.close();
        await Deno.remove(initFailure.logPath).catch(() => {});
    }

    const listFailure = await startFixtureIntegration({ RUNWIELD_MCP_FIXTURE_LIST_ERROR: "1" });
    try {
        assertEquals(listFailure.integration.getTools(), []);
        assertEquals(listFailure.warnings[0].stage, "connection");
        assertEquals(listFailure.warnings[0].message.includes("TOKEN=abc"), false);
        assertEquals(listFailure.warnings[0].message.includes("--flag"), false);
    } finally {
        await listFailure.integration.close();
        await Deno.remove(listFailure.logPath).catch(() => {});
    }
});

Deno.test("MCP integration uses stable aliases for normalized-name collisions", async () => {
    const first = await startFixtureIntegration({ RUNWIELD_MCP_FIXTURE_TOOLS: "same-name,same_name" });
    const second = await startFixtureIntegration({ RUNWIELD_MCP_FIXTURE_TOOLS: "same_name,same-name" });
    try {
        const firstAliases = new Map(first.integration.getTools().map((tool) => [tool.label, tool.name]));
        const secondAliases = new Map(second.integration.getTools().map((tool) => [tool.label, tool.name]));
        assertEquals(firstAliases, secondAliases);
        assert([...firstAliases.values()].every((name) => /^mcp__fixture__same_name_[a-f0-9]{8}$/.test(name)));
    } finally {
        await first.integration.close();
        await second.integration.close();
        await Deno.remove(first.logPath).catch(() => {});
        await Deno.remove(second.logPath).catch(() => {});
    }
});

Deno.test("Pi MCP preserves embedded text and saves full oversized output", async () => {
    const integrationResult = await startFixtureIntegration();
    try {
        const [tool] = integrationResult.integration.getTools();
        const context = {} as Parameters<typeof tool["execute"]>[4];
        const resource = await tool.execute("call-resource", { marker: "resource" }, undefined, undefined, context);
        assertEquals(resource.content[0].type, "text");
        assert((resource.content[0] as { type: "text"; text: string }).text.length === 20_000);
        const resourceLink = await tool.execute(
            "call-resource-link",
            { marker: "resource-link" },
            undefined,
            undefined,
            context,
        );
        assert((resourceLink.content[0] as { type: "text"; text: string }).text.length < 22_000);
        const path = (resourceLink.details as McpResultDetails).fullOutputPath;
        assert(path);
        const fullOutput = await Deno.readTextFile(path);
        assertStringIncludes(fullOutput, "t".repeat(20_000));
        assertStringIncludes(fullOutput, "u".repeat(20_000));
        await Deno.remove(path);
    } finally {
        await integrationResult.integration.close();
        await Deno.remove(integrationResult.logPath).catch(() => {});
    }
});

Deno.test("Pi MCP updates root declarations and withdraws tools without reconnecting", async () => {
    const { integration, logPath } = await startFixtureIntegration();
    const cwd = getCwd();
    const binding = integration.bindRoot();
    assert(binding);
    const loader = new DefaultResourceLoader({
        cwd,
        agentDir: getSettingsDir("global"),
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noContextFiles: true,
        extensionFactories: [binding.extensionFactory],
    });
    await loader.reload();
    const { session } = await createAgentSession({
        cwd,
        agentDir: getSettingsDir("global"),
        modelRuntime: await getModelRegistry().getRuntime(),
        settingsManager: getSettingsManager(cwd),
        sessionManager: SessionManager.inMemory(cwd),
        noTools: "builtin",
        resourceLoader: loader,
    });
    try {
        await session.bindExtensions({});
        assertEquals(session.getActiveToolNames(), ["mcp__fixture__fixture_echo"]);
        assertEquals(session.getAllTools().some((tool) => tool.name === "codemode"), false);
        const [tool] = integration.getTools();
        await callFixtureTool(tool, "change-tools");
        const deadline = Date.now() + 5_000;
        while (!session.getActiveToolNames().includes("mcp__fixture__replacement") && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assertEquals(session.getActiveToolNames(), ["mcp__fixture__replacement"]);
        assertEquals(integration.getTools().map((tool) => tool.name), ["mcp__fixture__replacement"]);
        binding.dispose();
        session.dispose();
        await callFixtureTool(integration.getTools()[0], "after-dispose");
        assertEquals((await readLog(logPath)).filter((line) => line.includes('"event":"started"')).length, 1);
    } finally {
        binding.dispose();
        session.dispose();
        await integration.close();
        await Deno.remove(logPath).catch(() => {});
    }
});

Deno.test("Pi MCP exposes and reads native resource tools", async () => {
    const { integration, logPath } = await startFixtureIntegration({ RUNWIELD_MCP_FIXTURE_RESOURCES: "1" });
    try {
        const tools = integration.getTools();
        const read = tools.find((tool) => tool.name === "read_mcp_resource");
        assert(read);
        assert(tools.some((tool) => tool.name === "list_mcp_resources"));
        assert(tools.some((tool) => tool.name === "list_mcp_resource_templates"));
        const result = await read.execute(
            "read-fixture",
            { server: "fixture", uri: "fixture://document" },
            undefined,
            undefined,
            {} as Parameters<ToolDefinition["execute"]>[4],
        );
        assertStringIncludes(JSON.stringify(result.content), "fixture-resource");
    } finally {
        await integration.close();
        await Deno.remove(logPath).catch(() => {});
    }
});

Deno.test("RunWield root MCP updates preserve a narrowed Agent's other tool restrictions", async () => {
    await withRuntimeCommandFixture("runwield-mcp-live-policy-", async (fixture) => {
        const { integration, logPath } = await startFixtureIntegration();
        const hosted = new HostedSession({ id: "mcp-policy", cwd: fixture.projectRoot });
        await hosted.setMcpIntegration(integration);
        const { session } = await buildAgentSession({ hostedSession: hosted, agentName: "guide", toolNames: ["read"] });
        try {
            const otherTools = session.getActiveToolNames().filter((name) => !name.startsWith("mcp__"));
            assertEquals(otherTools.includes("write"), false);
            assertEquals(otherTools.includes("bash"), false);
            assertEquals(session.getAllTools().some((tool) => tool.name === "codemode"), false);
            const blocked = await session.extensionRunner?.emitToolCall({
                type: "tool_call",
                toolName: "mcp__unconfigured__write",
                toolCallId: "blocked-late-tool",
                input: {},
            });
            assertEquals(blocked?.block, true);
            await callFixtureTool(integration.getTools()[0], "change-tools");
            const deadline = Date.now() + 5_000;
            while (!session.getActiveToolNames().includes("mcp__fixture__replacement") && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert(session.getActiveToolNames().includes("mcp__fixture__replacement"));
            assertEquals(session.getActiveToolNames().includes("mcp__fixture__fixture_echo"), false);
            assertEquals(session.getActiveToolNames().filter((name) => !name.startsWith("mcp__")), otherTools);
        } finally {
            session.dispose();
            await hosted.dispose();
            await Deno.remove(logPath).catch(() => {});
        }
    });
});

Deno.test("an initially empty MCP inventory updates its root while isolated calls stay restricted", async () => {
    await withRuntimeCommandFixture("runwield-empty-mcp-", async (fixture) => {
        const toolsPath = join(fixture.projectRoot, "mcp-tools.txt");
        await Deno.writeTextFile(toolsPath, "");
        const { integration } = await startMcpIntegration({
            cwd: fixture.projectRoot,
            servers: [{
                name: "fixture",
                command: Deno.execPath(),
                args: ["run", "-A", fixtureServer],
                env: { RUNWIELD_MCP_FIXTURE_TOOLS_PATH: toolsPath },
                source: "request",
            }],
        });
        const hosted = new HostedSession({ id: crypto.randomUUID(), cwd: fixture.projectRoot });
        await hosted.setMcpIntegration(integration);
        assertEquals(integration.getTools(), []);
        const { session } = await buildAgentSession({
            hostedSession: hosted,
            agentName: "guide",
            mcpRootTools: integration.getTools(),
            mcpIntegration: integration,
        });
        try {
            await Deno.writeTextFile(toolsPath, "replacement");
            const deadline = Date.now() + 5_000;
            while (!session.getActiveToolNames().includes("mcp__fixture__replacement") && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert(session.getActiveToolNames().includes("mcp__fixture__replacement"));
            const result = await callFixtureTool(integration.getTools()[0], "discovered-later");
            assertEquals(result.content, [{ type: "text", text: "fixture-result:discovered-later" }]);
            fixture.setModelResponseFactories([() => fauxAssistantMessage(fauxText("Isolated complete."))]);
            let inspected = false;
            await runIsolatedAgentSession({
                hostedSession: hosted,
                agentName: "guide",
                userRequest: "Run an isolated check.",
                mcpRootTools: integration.getTools(),
                mcpIntegration: integration,
                onExecutionSessionBuilt: (built) => {
                    inspected = true;
                    assertEquals(built.tools.some((name) => name.startsWith("mcp__")), false);
                    assertEquals(
                        built.session?.getAllTools().some((tool: ToolDefinition) => tool.name.startsWith("mcp__")),
                        false,
                    );
                },
            });
            assert(inspected);
        } finally {
            session.dispose();
            await hosted.dispose();
        }
    });
});

Deno.test("a root with failed initial discovery receives tools after official MCP reconnect", async () => {
    await withRuntimeCommandFixture("runwield-recovered-mcp-", async (fixture) => {
        const failurePath = join(fixture.projectRoot, "init-error.txt");
        await Deno.writeTextFile(failurePath, "1");
        const { integration, warnings } = await startMcpIntegration({
            cwd: fixture.projectRoot,
            servers: [{
                name: "fixture",
                command: Deno.execPath(),
                args: ["run", "-A", fixtureServer],
                env: { RUNWIELD_MCP_FIXTURE_INIT_ERROR_PATH: failurePath },
                source: "request",
            }],
        });
        const hosted = new HostedSession({ id: crypto.randomUUID(), cwd: fixture.projectRoot });
        await hosted.setMcpIntegration(integration);
        assert(warnings.length > 0);
        assertEquals(integration.getTools(), []);
        const { session } = await buildAgentSession({
            hostedSession: hosted,
            agentName: "guide",
            mcpRootTools: integration.getTools(),
            mcpIntegration: integration,
        });
        try {
            await Deno.writeTextFile(failurePath, "0");
            await integration.runCommand("reconnect fixture");
            assert(session.getActiveToolNames().includes("mcp__fixture__fixture_echo"));
            assertEquals((await callFixtureTool(integration.getTools()[0], "recovered")).content, [{
                type: "text",
                text: "fixture-result:recovered",
            }]);
        } finally {
            session.dispose();
            await hosted.dispose();
        }
    });
});

Deno.test("Pi MCP status and reconnect commands work without a model turn", async () => {
    const { integration, logPath } = await startFixtureIntegration();
    try {
        const status = await integration.runCommand("");
        assertStringIncludes(JSON.stringify(status), "fixture");
        assertStringIncludes(JSON.stringify(status), "connected");
        await integration.runCommand("reconnect fixture");
        assertEquals((await readLog(logPath)).filter((line) => line.includes('"event":"started"')).length, 2);
        const result = await callFixtureTool(integration.getTools()[0], "reconnected");
        assertEquals(result.content, [{ type: "text", text: "fixture-result:reconnected" }]);
    } finally {
        await integration.close();
        await Deno.remove(logPath).catch(() => {});
    }
});

Deno.test("MCP integration close waits for fixture server shutdown", async () => {
    const integrationResult = await startFixtureIntegration();
    await integrationResult.integration.close();
    const logLines = await readLog(integrationResult.logPath);
    assertStringIncludes(logLines.join("\n"), '"event":"shutdown"');
    await Deno.remove(integrationResult.logPath).catch(() => {});
});

Deno.test("MCP tool calls honor cancellation signals and shut down cleanly", async () => {
    const integrationResult = await startFixtureIntegration();
    try {
        const [tool] = integrationResult.integration.getTools();
        const context = {} as Parameters<typeof tool["execute"]>[4];
        const controller = new AbortController();
        const pending = tool.execute("call-slow", { marker: "slow" }, controller.signal, undefined, context);
        controller.abort();
        await assertRejects(() => pending);
        await integrationResult.integration.close();
        assertStringIncludes((await readLog(integrationResult.logPath)).join("\n"), '"event":"shutdown"');
    } finally {
        await integrationResult.integration.close();
        await Deno.remove(integrationResult.logPath).catch(() => {});
    }
});
