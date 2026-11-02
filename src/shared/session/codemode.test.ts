import { test } from "node:test";
import { deepEqual, equal, match, ok, rejects } from "node:assert/strict";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager, defineTool, type AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { withRuntimeCommandFixture, type RuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { buildAgentSession } from "./session.js";
import { setCustomSetting } from "../settings.js";
import { startMcpIntegration } from "../mcp/integration.ts";

async function script(fixture: RuntimeCommandFixture, session: AgentSession, code: string) {
    const id = crypto.randomUUID();
    fixture.setModelMessages([
        fauxAssistantMessage(fauxToolCall("codemode", { code }, { id })),
        fauxAssistantMessage("Done"),
    ]);
    await session.prompt("Run the requested script.");
    const result = session.messages.findLast((message) => message.role === "toolResult" && message.toolCallId === id);
    ok(result?.role === "toolResult", "real agent loop produced codemode result");
    return {
        result,
        text: result.content
            .filter((item) => item.type === "text")
            .map((item) => item.text)
            .join("\n"),
    };
}

test("Pi roots execute parallel authorized tools and report canonical nested activity", async () => {
    await withRuntimeCommandFixture("codemode-parallel-", async (f) => {
        await writeFile(join(f.projectRoot, "left.txt"), "20");
        await writeFile(join(f.projectRoot, "right.txt"), "22");
        const { session } = await buildAgentSession({ agentName: "engineer", cwd: f.projectRoot });
        const nested: string[] = [];
        session.subscribe((event) => {
            if (event.type === "tool_execution_start" && event.parentToolCallId) nested.push(event.toolName);
        });
        try {
            ok(session.getActiveToolNames().includes("codemode"));
            const { text, result } = await script(
                f,
                session,
                'const values = await Promise.all([tools.read({path:"left.txt"}), tools.read({path:"right.txt"})]); text(values.map(Number).reduce((a,b)=>a+b,0));',
            );
            equal(result.isError, false);
            match(text, /\b42\b/);
            deepEqual(nested, ["read", "read"]);
        } finally {
            session.dispose();
        }
    });
});

test("restricted codemode discovery cannot recover writes, shell, or workflow decisions", async () => {
    await withRuntimeCommandFixture("codemode-policy-", async (f) => {
        const { session } = await buildAgentSession({
            agentName: "engineer",
            cwd: f.projectRoot,
            toolNames: ["read", "codemode"],
        });
        try {
            const discovered = await script(f, session, "text(ALL_TOOLS.map(t=>t.name));");
            ok(!discovered.text.includes('"write"'));
            ok(!discovered.text.includes('"bash"'));
            const rejected = await script(f, session, 'await tools.write({path:"forbidden.txt",content:"bad"});');
            equal(rejected.result.isError, true);
            await rejects(stat(join(f.projectRoot, "forbidden.txt")));
            const shell = await script(f, session, 'await tools.bash({command:"touch forbidden.txt"});');
            equal(shell.result.isError, true);
            await rejects(stat(join(f.projectRoot, "forbidden.txt")));
        } finally {
            session.dispose();
        }
        const root = await buildAgentSession({ agentName: "router", cwd: f.projectRoot });
        try {
            ok(root.session.getActiveToolNames().includes("triage_report"));
            ok(!root.session.getCallableToolNames().includes("triage_report"));
            equal(
                (
                    await script(
                        f,
                        root.session,
                        'await tools.triage_report({routingIntent:"QUICK_FIX", complexity:"LOW", summary:"blocked"});',
                    )
                ).result.isError,
                true,
            );
        } finally {
            root.session.dispose();
        }
    });
});

test("successful stores follow resumed Session branches; failed writes and partial output stay honest", async () => {
    await withRuntimeCommandFixture("codemode-store-", async (f) => {
        const manager = SessionManager.create(f.projectRoot, join(f.homeDir, "sessions"));
        const before = manager.appendCustomEntry("before-store", {});
        let { session } = await buildAgentSession({
            agentName: "engineer",
            cwd: f.projectRoot,
            sessionManager: manager,
        });
        try {
            equal((await script(f, session, 'store("answer",42); text("stored");')).result.isError, false);
            const failed = await script(
                f,
                session,
                'store("failed",true); text("partial"); throw new Error("expected failure");',
            );
            equal(failed.result.isError, true);
            match(failed.text, /partial[\s\S]*expected failure/);
            const path = manager.getSessionFile();
            ok(path);
            session.dispose();
            const resumed = SessionManager.open(path);
            ({ session } = await buildAgentSession({
                agentName: "engineer",
                cwd: f.projectRoot,
                sessionManager: resumed,
            }));
            match(
                (await script(f, session, 'text({answer:load("answer"), failed:load("failed") ?? null});')).text,
                /"answer":42,"failed":null/,
            );
            session.dispose();
            resumed.branch(before);
            ({ session } = await buildAgentSession({
                agentName: "engineer",
                cwd: f.projectRoot,
                sessionManager: resumed,
            }));
            match((await script(f, session, 'text(load("answer") ?? "absent");')).text, /absent/);
        } finally {
            session.dispose();
        }
    });
});

test("deadline cancellation releases capacity and subsequent scripts run", async () => {
    await withRuntimeCommandFixture("codemode-cancel-", async (f) => {
        const { session } = await buildAgentSession({ agentName: "engineer", cwd: f.projectRoot });
        try {
            const timed = await script(f, session, '// @options: {"timeout_ms":30}\nwhile(true) {}');
            equal(timed.result.isError, true);
            match(timed.text, /timed out/);
            match((await script(f, session, "text(42);")).text, /42/);
            const output = await script(f, session, '// @options: {"max_output_tokens":10}\ntext("x".repeat(1000));');
            match(output.text, /truncat|full output/i);
        } finally {
            session.dispose();
        }
    });
});

test("only mode preserves direct workflow declarations and project settings override global presentation", async () => {
    await withRuntimeCommandFixture("codemode-settings-", async (f) => {
        await setCustomSetting("codemode", { mode: "on", inlineBudget: 1000 }, "global", f.projectRoot);
        await setCustomSetting("codemode", { mode: "only", inlineBudget: 0 }, "project", f.projectRoot);
        const { session } = await buildAgentSession({ agentName: "router", cwd: f.projectRoot });
        try {
            equal(session.settingsManager.getSettings().codemode?.mode, "only");
            ok(session.getActiveToolNames().includes("triage_report"));
            ok(!session.getCallableToolNames().includes("triage_report"));
            match((await script(f, session, 'text(ALL_TOOLS.some(t=>t.name==="read"));')).text, /true/);
        } finally {
            session.dispose();
        }
        await mkdir(join(f.projectRoot, ".wld", "agents"), { recursive: true });
        await writeFile(
            join(f.projectRoot, ".wld", "agents", "engineer.md"),
            "---\ntools: [read]\n---\nRestricted agent",
        );
        const disabled = await buildAgentSession({ agentName: "engineer", cwd: f.projectRoot });
        try {
            ok(!disabled.session.getActiveToolNames().includes("codemode"));
        } finally {
            disabled.session.dispose();
        }
    });
});

test("plain schemas coerce identically for direct and nested calls, rejecting invalid inputs before effects", async () => {
    await withRuntimeCommandFixture("codemode-schema-", async (f) => {
        const received: number[][] = [];
        const tool = defineTool({
            name: "collect",
            label: "Collect",
            description: "Collect numbers",
            parameters: Type.Object({ values: Type.Array(Type.Number()) }),
            execute(_id, params) {
                received.push(params.values);
                return Promise.resolve({
                    content: [{ type: "text", text: JSON.stringify(params.values) }],
                    details: {},
                });
            },
        });
        const { session } = await buildAgentSession({ agentName: "engineer", cwd: f.projectRoot, customTools: [tool] });
        try {
            f.setModelMessages([
                fauxAssistantMessage(fauxToolCall("collect", { values: "7" })),
                fauxAssistantMessage("Done"),
            ]);
            await session.prompt("Collect");
            await script(f, session, 'text(await tools.collect({values:"8"}));');
            deepEqual(received, [[7], [8]]);
            equal((await script(f, session, 'await tools.collect({values:"bad"});')).result.isError, true);
            equal((await script(f, session, "await tools.collect({});")).result.isError, true);
            deepEqual(received, [[7], [8]]);
        } finally {
            session.dispose();
        }
    });
});

test("codemode calls the real MCP connection and follows root replacement without spawning another server", async () => {
    await withRuntimeCommandFixture("codemode-mcp-", async (f) => {
        const log = join(f.projectRoot, "mcp.log");
        const toolsPath = join(f.projectRoot, "mcp-tools.txt");
        await writeFile(toolsPath, "fixture_echo");
        const { integration } = await startMcpIntegration({
            cwd: f.projectRoot,
            servers: [
                {
                    name: "fixture",
                    command: process.execPath,
                    args: [fileURLToPath(new URL("../mcp/fixture-server.ts", import.meta.url))],
                    env: { RUNWIELD_MCP_FIXTURE_LOG: log, RUNWIELD_MCP_FIXTURE_TOOLS_PATH: toolsPath },
                    source: "request",
                },
            ],
        });
        try {
            for (const agentName of ["engineer", "guide"]) {
                const { session } = await buildAgentSession({
                    agentName,
                    cwd: f.projectRoot,
                    mcpIntegration: integration,
                });
                try {
                    const name = integration.getTools()[0].name;
                    const result = await script(
                        f,
                        session,
                        `const tool=ALL_TOOLS.find(t=>t.name===${JSON.stringify(name)}); text(await tools[tool.name]({marker:"nested"}));`,
                    );
                    equal(result.result.isError, false, result.text);
                    match(result.text, /nested/);
                    const structured = await script(
                        f,
                        session,
                        `text(await tools[${JSON.stringify(name)}]({marker:"structured"}));`,
                    );
                    match(structured.text, /structuredContent/);
                    const error = await script(
                        f,
                        session,
                        `text(await tools[${JSON.stringify(name)}]({marker:"error"}));`,
                    );
                    match(error.text, /"isError":true/);
                    if (agentName === "engineer") {
                        await writeFile(toolsPath, "fixture_next");
                        const deadline = Date.now() + 2000;
                        while (
                            !integration.getTools().some((tool) => tool.name.endsWith("fixture_next")) &&
                            Date.now() < deadline
                        )
                            await new Promise((resolve) => setTimeout(resolve, 5));
                        ok(integration.getTools().some((tool) => tool.name.endsWith("fixture_next")));
                        const changed = await script(f, session, "text(ALL_TOOLS.map(t=>t.name));");
                        match(changed.text, /fixture_next/);
                        ok(!changed.text.includes("fixture_echo"));
                        equal(
                            (await script(f, session, `await tools[${JSON.stringify(name)}]({marker:"removed"});`))
                                .result.isError,
                            true,
                        );
                    }
                } finally {
                    session.dispose();
                }
            }
            const rows = (await readFile(log, "utf8"))
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line));
            equal(rows.filter((row) => row.event === "started").length, 1);
        } finally {
            await integration.close();
        }
    });
});

test("worker admission queues excess scripts and an aborted queued script never invokes tools", async () => {
    await withRuntimeCommandFixture("codemode-admission-", async (f) => {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const started: string[] = [];
        const hold = defineTool({
            name: "hold",
            label: "Hold",
            description: "Wait for external completion",
            parameters: Type.Object({ id: Type.String() }),
            async execute(_id, params) {
                started.push(params.id);
                await gate;
                return { content: [{ type: "text", text: params.id }], details: {} };
            },
        });
        const sessions: AgentSession[] = [];
        const pending: Promise<{ content: { type: string; text?: string }[] }>[] = [];
        try {
            for (let i = 0; i < 5; i++)
                sessions.push(
                    (await buildAgentSession({ agentName: "engineer", cwd: f.projectRoot, customTools: [hold] }))
                        .session,
                );
            const abort = new AbortController();
            for (const [index, session] of sessions.entries()) {
                const id = `capacity-${index}`;
                session.agent.state.messages = [
                    ...session.agent.state.messages,
                    fauxAssistantMessage(fauxToolCall("codemode", {}, { id })),
                ];
                const tool = session.agent.state.tools.find((tool) => tool.name === "codemode");
                ok(tool);
                pending.push(
                    tool.execute(
                        id,
                        {
                            code:
                                (index === 3 ? '// @options: {"timeout_ms":100}\n' : "") +
                                `text(await tools.hold({id:"${index}"}));`,
                        },
                        index === 2 ? abort.signal : undefined,
                    ),
                );
            }
            const deadline = Date.now() + 2000;
            while (started.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
            deepEqual([...started].sort(), ["0", "1"]);
            abort.abort();
            const cancelled = await pending[2];
            match(cancelled.content.map((item) => item.text ?? "").join("\n"), /aborted[\s\S]*did not start/i);
            const expired = await pending[3];
            match(expired.content.map((item) => item.text ?? "").join("\n"), /timed out[\s\S]*did not start/i);
            deepEqual([...started].sort(), ["0", "1"]);
            release();
            await Promise.all(pending);
            deepEqual([...started].sort(), ["0", "1", "4"]);
            match((await script(f, sessions[0], "text(42)")).text, /42/);
        } finally {
            release();
            await Promise.allSettled(pending);
            for (const session of sessions) session.dispose();
        }
    });
});

test("non-chat models use configured auth and persist attributed usage exactly once", async () => {
    await withRuntimeCommandFixture("codemode-model-", async (f) => {
        const { createProvider } = await import("@earendil-works/pi-ai");
        const { getModelRuntime } = await import("../models/model-registry.ts");
        const runtime = await getModelRuntime();
        const calls: string[] = [];
        runtime.registerNativeProvider(
            createProvider({
                id: "codemode-fixture",
                name: "Codemode fixture",
                auth: {
                    apiKey: { name: "Fixture", resolve: () => Promise.resolve({ auth: { apiKey: "configured-key" } }) },
                },
                models: [
                    {
                        type: "classifier",
                        id: "judge",
                        name: "Judge",
                        provider: "codemode-fixture",
                        api: "typesafe-system-one",
                        baseUrl: "https://fixture.invalid",
                        input: ["text"],
                        contextWindow: 4096,
                        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
                    },
                ],
                classifiers: {
                    "typesafe-system-one": {
                        classify(model, _context, options) {
                            calls.push(`${model.provider}/${model.id}:${options?.apiKey}`);
                            return Promise.resolve({
                                api: model.api,
                                provider: model.provider,
                                model: model.id,
                                answers: { approved: { type: "bool", probability: 1 } },
                                stopReason: "stop",
                                timestamp: Date.now(),
                                usage: {
                                    input: 10,
                                    output: 2,
                                    cacheRead: 0,
                                    cacheWrite: 0,
                                    totalTokens: 12,
                                    cost: { input: 0.1, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.12 },
                                },
                            });
                        },
                    },
                },
            }),
        );
        const manager = SessionManager.inMemory(f.projectRoot);
        const { session } = await buildAgentSession({
            agentName: "engineer",
            cwd: f.projectRoot,
            sessionManager: manager,
        });
        try {
            const result = await script(
                f,
                session,
                'const model=await models.getModelOfType("classifier","codemode-fixture","judge"); text(await models.classify(model,{state:{ready:true},questions:{approved:{type:"bool",instructions:"Approve",criteria:{true:"ready",false:"blocked"}}}}));',
            );
            equal(result.result.isError, false, result.text);
            deepEqual(calls, ["codemode-fixture/judge:configured-key"]);
            const usage = manager.getEntries().filter((entry) => entry.type === "usage");
            equal(usage.length, 1);
            equal(usage[0].provider, "codemode-fixture");
            equal(usage[0].model, "judge");
            equal(usage[0].usage.cost.total, 0.12);
            equal(result.result.usage, undefined);
            equal(
                (await script(f, session, 'await models.classify({provider:"missing",id:"missing"},{})')).result
                    .isError,
                true,
            );
        } finally {
            session.dispose();
            runtime.unregisterProvider("codemode-fixture");
        }
    });
});

test("script images retain native content and recursive codemode remains unavailable", async () => {
    await withRuntimeCommandFixture("codemode-image-", async (f) => {
        const { session } = await buildAgentSession({ agentName: "engineer", cwd: f.projectRoot });
        try {
            const png =
                "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAEElEQVR4nGP4z8AARwzIHABvqgf5gNwAKAAAAABJRU5ErkJggg==";
            const result = await script(
                f,
                session,
                `image({type:"image",data:"${png}",mimeType:"image/png"}); text(ALL_TOOLS.some(t=>t.name==="codemode"));`,
            );
            equal(result.result.isError, false, result.text);
            ok(result.result.content.some((item) => item.type === "image" && item.mimeType === "image/png"));
            match(result.text, /false/);
            equal((await script(f, session, 'await tools.codemode({code:"text(1)"})')).result.isError, true);
        } finally {
            session.dispose();
        }
    });
});
