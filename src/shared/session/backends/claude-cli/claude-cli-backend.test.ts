import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { defineTool, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { withProcessGlobalTestLock } from "../../../../testing/process-global-lock.ts";
import { getModelRegistry } from "../../../models/model-registry.ts";
import { createTaskCompletedTool } from "../../../../tools/task-completed.ts";
import { HostedSession } from "../../hosted-session.js";
import { setCustomSetting } from "../../../settings.js";
import { drainWorkflowMetrics, getWorkflowMetricsFilePath } from "../../../workflow/metrics.js";
import { readLatestTaskCompletedOutcome } from "../../../workflow/workflow-results.js";
import { prepareClaudeCliCommand, removeClaudeCliPromptFile } from "./command.ts";
import { ClaudeCliExecutionSession } from "./execution-session.ts";
import { ClaudeCliBackendError } from "./failure.ts";
import { parseClaudeCliStream } from "./stream-parser.ts";

async function withTempDir(callback: (dir: string) => Promise<void>): Promise<void> {
    const dir = await Deno.makeTempDir({ prefix: "runwield-claude-backend-" });
    try {
        await callback(dir);
    } finally {
        await Deno.remove(dir, { recursive: true }).catch(() => undefined);
    }
}

async function installClaudeFixture(binDir: string, logPath: string): Promise<void> {
    await Deno.mkdir(binDir, { recursive: true });
    const fixturePath = new URL("./testing/fake-claude-mcp-client.ts", import.meta.url).pathname;
    // The fixture lives in the workspace so its npm imports (the real MCP SDK
    // client) resolve through the repository deno.json/node_modules.
    const script = `#!/bin/sh\nexec deno run -A ${JSON.stringify(fixturePath)} "$@"\n`;
    const path = join(binDir, "claude");
    await Deno.writeTextFile(path, script);
    await Deno.chmod(path, 0o755);
    await Deno.writeTextFile(logPath, "");
}

async function withClaudeFixture(callback: (root: string, logPath: string) => Promise<void>): Promise<void> {
    await withProcessGlobalTestLock(async () => {
        const previousPath = Deno.env.get("PATH");
        const previousLog = Deno.env.get("RUNWIELD_CLAUDE_FIXTURE_LOG");
        const previousOutput = Deno.env.get("RUNWIELD_CLAUDE_FIXTURE_OUTPUT");
        const previousStreamFile = Deno.env.get("RUNWIELD_CLAUDE_FIXTURE_STREAM_FILE");
        const previousCalls = Deno.env.get("RUNWIELD_CLAUDE_FIXTURE_MCP_CALLS");
        const previousExitCode = Deno.env.get("RUNWIELD_CLAUDE_FIXTURE_EXIT_CODE");
        const previousStderr = Deno.env.get("RUNWIELD_CLAUDE_FIXTURE_STDERR");
        const previousMalformed = Deno.env.get("RUNWIELD_CLAUDE_FIXTURE_MALFORMED");
        const previousSleep = Deno.env.get("RUNWIELD_CLAUDE_FIXTURE_SLEEP_MS");
        const previousPartialStream = Deno.env.get("RUNWIELD_CLAUDE_FIXTURE_PARTIAL_STREAM");
        const previousPartialChars = Deno.env.get("RUNWIELD_CLAUDE_FIXTURE_PARTIAL_CHARS");
        await withTempDir(async (root) => {
            const binDir = join(root, "bin");
            const logPath = join(root, "fixture.jsonl");
            await installClaudeFixture(binDir, logPath);
            Deno.env.set("PATH", `${binDir}:${previousPath || ""}`);
            Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_LOG", logPath);
            try {
                await callback(root, logPath);
            } finally {
                if (previousPath === undefined) Deno.env.delete("PATH");
                else Deno.env.set("PATH", previousPath);
                if (previousLog === undefined) Deno.env.delete("RUNWIELD_CLAUDE_FIXTURE_LOG");
                else Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_LOG", previousLog);
                if (previousOutput === undefined) Deno.env.delete("RUNWIELD_CLAUDE_FIXTURE_OUTPUT");
                else Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_OUTPUT", previousOutput);
                if (previousStreamFile === undefined) Deno.env.delete("RUNWIELD_CLAUDE_FIXTURE_STREAM_FILE");
                else Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_STREAM_FILE", previousStreamFile);
                if (previousCalls === undefined) Deno.env.delete("RUNWIELD_CLAUDE_FIXTURE_MCP_CALLS");
                else Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_MCP_CALLS", previousCalls);
                if (previousExitCode === undefined) Deno.env.delete("RUNWIELD_CLAUDE_FIXTURE_EXIT_CODE");
                else Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_EXIT_CODE", previousExitCode);
                if (previousStderr === undefined) Deno.env.delete("RUNWIELD_CLAUDE_FIXTURE_STDERR");
                else Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_STDERR", previousStderr);
                if (previousMalformed === undefined) Deno.env.delete("RUNWIELD_CLAUDE_FIXTURE_MALFORMED");
                else Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_MALFORMED", previousMalformed);
                if (previousSleep === undefined) Deno.env.delete("RUNWIELD_CLAUDE_FIXTURE_SLEEP_MS");
                else Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_SLEEP_MS", previousSleep);
                if (previousPartialStream === undefined) Deno.env.delete("RUNWIELD_CLAUDE_FIXTURE_PARTIAL_STREAM");
                else Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_PARTIAL_STREAM", previousPartialStream);
                if (previousPartialChars === undefined) Deno.env.delete("RUNWIELD_CLAUDE_FIXTURE_PARTIAL_CHARS");
                else Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_PARTIAL_CHARS", previousPartialChars);
            }
        });
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

function streamFromText(text: string): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
        },
    });
}

Deno.test("Claude CLI command uses direct argv with stream-json and no resume", async () => {
    await withTempDir(async () => {
        const command = await prepareClaudeCliCommand({ selector: "sonnet", systemPrompt: "system" });
        try {
            assertEquals(command.command, "claude");
            assertEquals(command.args.includes("--output-format"), true);
            assertEquals(command.args.includes("stream-json"), true);
            assertEquals(command.args.includes("--no-session-persistence"), true);
            assertEquals(command.args.includes("--permission-mode"), true);
            assertEquals(command.args[command.args.indexOf("--permission-mode") + 1], "acceptEdits");
            assertEquals(command.args.includes("--resume"), false);
            assertEquals(command.args[command.args.indexOf("--model") + 1], "sonnet");
        } finally {
            await removeClaudeCliPromptFile(command);
        }
    });
});

Deno.test("Claude CLI command pre-authorizes project and workflow tools", async () => {
    await withTempDir(async () => {
        const command = await prepareClaudeCliCommand({
            selector: "sonnet",
            systemPrompt: "system",
            allowedToolNames: [
                "runwield_triage_report",
                "runwield_triage_report",
                "mcp__runwield__runwield_triage_report",
                "mcp__runwield__web_search",
                "mcp__runwield__web_fetch",
                "mcp__runwield__web_code_search",
                "mcp__runwield__web_docs_search",
            ],
        });
        try {
            const allowedIndex = command.args.indexOf("--allowedTools");
            assertEquals(allowedIndex >= 0, true);
            const allowedTools = command.args.slice(allowedIndex + 1);
            assertEquals(allowedTools.includes("Read"), true);
            assertEquals(allowedTools.includes("Write"), true);
            assertEquals(allowedTools.includes("Edit"), true);
            assertEquals(allowedTools.includes("MultiEdit"), true);
            assertEquals(allowedTools.includes("Bash"), true);
            assertEquals(allowedTools.includes("WebFetch"), false);
            assertEquals(allowedTools.includes("WebSearch"), false);
            assertEquals(allowedTools.includes("mcp__runwield__web_search"), true);
            assertEquals(allowedTools.includes("mcp__runwield__web_fetch"), true);
            assertEquals(allowedTools.includes("mcp__runwield__web_code_search"), true);
            assertEquals(allowedTools.includes("mcp__runwield__web_docs_search"), true);
            assertEquals(allowedTools.includes("EnterWorktree"), true);
            assertEquals(
                allowedTools.filter((tool) => tool === "runwield_triage_report").length,
                1,
            );
            assertEquals(allowedTools.includes("mcp__runwield__runwield_triage_report"), true);
        } finally {
            await removeClaudeCliPromptFile(command);
        }
    });
});

Deno.test("Claude CLI command writes an owner-only appended prompt file", async () => {
    const command = await prepareClaudeCliCommand({ selector: "opus", systemPrompt: "private prompt" });
    try {
        assertEquals(await Deno.readTextFile(command.promptFilePath), "private prompt");
        const mode = (await Deno.stat(command.promptFilePath)).mode;
        if (mode !== null) assertEquals(mode & 0o777, 0o600);
    } finally {
        await removeClaudeCliPromptFile(command);
    }
});

Deno.test("Claude CLI command prompt file cleanup removes the file", async () => {
    const command = await prepareClaudeCliCommand({ selector: "haiku", systemPrompt: "cleanup" });
    await removeClaudeCliPromptFile(command);
    await assertRejects(() => Deno.stat(command.promptFilePath), Deno.errors.NotFound);
});

Deno.test("Claude CLI parser emits assistant text and ignores internal events", async () => {
    const deltas: string[] = [];
    const result = await parseClaudeCliStream(
        streamFromText([
            JSON.stringify({ type: "system", subtype: "init" }),
            JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hel" }] } }),
            JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "lo" } }),
            JSON.stringify({ type: "tool_use", name: "Bash" }),
            JSON.stringify({ type: "result", result: "hello", usage: { input_tokens: 3, output_tokens: 4 } }),
        ].join("\n")),
        { onDelta: (delta) => deltas.push(delta.text) },
    );
    assertEquals(deltas, ["hel", "lo"]);
    assertEquals(result.text, "hello");
    assertEquals(result.metadata.usage.inputTokens, 3);
});

Deno.test("Claude Code 2.1.284 captured Read stream pairs native tool progress with terminal usage", async () => {
    const captured = await Deno.readTextFile(
        new URL("./fixtures/claude-2.1.284-read-tool-stream.jsonl", import.meta.url),
    );
    const calls: string[] = [];
    const sources: string[] = [];
    const result = await parseClaudeCliStream(streamFromText(captured), {
        onDelta: () => {},
        onNativeToolStart: (call) => calls.push(`start:${call.callId}:${call.toolName}`),
        onNativeToolResult: (call) => calls.push(`finish:${call.callId}:${call.isError}`),
        onUsage: (observation) => sources.push(observation.sourceId),
    });
    assertEquals(calls, ["start:call_fixture_1:Read", "finish:call_fixture_1:false"]);
    assertEquals(result.metadata.externalSessionId, "session_fixture_1");
    assertEquals(result.metadata.usage.inputTokens, 4);
    assertEquals(result.metadata.usage.outputTokens, 507);
    assertEquals(result.metadata.isError, false);
    assertEquals(result.text, "Checking file.\nmint");
    assertEquals(sources.filter((source) => source === "message_fixture_1").length, 3);
    assert(sources.includes("claude_turn_total"));
});

Deno.test("Claude CLI parser preserves a structured error result", async () => {
    const message = "You've hit your monthly spend limit · raise it in Claude settings";
    const result = await parseClaudeCliStream(
        streamFromText(`${JSON.stringify({ type: "result", is_error: true, result: message })}\n`),
        { onDelta: () => undefined },
    );
    assertEquals(result.text, message);
    assertEquals(result.metadata.isError, true);
});

Deno.test("Claude CLI parser preserves plain stdout diagnostics as assistant text", async () => {
    const deltas: string[] = [];
    const result = await parseClaudeCliStream(
        streamFromText([
            JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "visible reply" }] } }),
            "I'm requesting permission to call runwield_plan_written.",
        ].join("\n")),
        { onDelta: (delta) => deltas.push(delta.text) },
    );
    assertEquals(deltas, ["visible reply", "I'm requesting permission to call runwield_plan_written."]);
    assertEquals(result.text, "visible replyI'm requesting permission to call runwield_plan_written.");
    assertEquals(result.metadata.usage.inputTokens, null);
});

Deno.test("Claude CLI parser preserves line breaks in plain assistant stdout", async () => {
    const deltas: string[] = [];
    const result = await parseClaudeCliStream(
        streamFromText("First line\nSecond line\nThird line"),
        {
            onDelta: (delta) => deltas.push(delta.text),
            isTerminalAccepted: () => true,
        },
    );
    assertEquals(deltas, ["First line", "\nSecond line", "\nThird line"]);
    assertEquals(result.text, "First line\nSecond line\nThird line");
});

Deno.test("Claude CLI parser separates streamed assistant updates across tool calls", async () => {
    const deltas: string[] = [];
    const result = await parseClaudeCliStream(
        streamFromText([
            JSON.stringify({
                type: "stream_event",
                event: { type: "content_block_delta", delta: { type: "text_delta", text: "Checking." } },
            }),
            JSON.stringify({
                type: "assistant",
                message: { content: [{ type: "text", text: "Checking." }, { type: "tool_use", name: "Bash" }] },
            }),
            JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }),
            JSON.stringify({
                type: "stream_event",
                event: { type: "content_block_delta", delta: { type: "text_delta", text: "Next step." } },
            }),
            JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Next step." }] } }),
            JSON.stringify({ type: "result", result: "Next step." }),
        ].join("\n")),
        { onDelta: (delta) => deltas.push(delta.text) },
    );
    assertEquals(deltas.join(""), "Checking.\nNext step.");
    assertEquals(result.text, "Checking.\nNext step.");
});

Deno.test("Claude CLI parser keeps plain diagnostics around a matching final result", async () => {
    const result = await parseClaudeCliStream(
        streamFromText([
            JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "visible reply" }] } }),
            "The routing call needs your approval.",
            JSON.stringify({ type: "result", result: "visible reply", usage: { input_tokens: 1, output_tokens: 2 } }),
        ].join("\n")),
        { onDelta: () => undefined },
    );
    assertEquals(result.text, "visible replyThe routing call needs your approval.");
    assertEquals(result.metadata.usage.outputTokens, 2);
});

Deno.test("Claude CLI parser streams thinking and text deltas live without duplicating the final message", async () => {
    const textDeltas: string[] = [];
    const thinkingDeltas: string[] = [];
    let thinkingEndCalls = 0;
    const result = await parseClaudeCliStream(
        streamFromText([
            JSON.stringify({
                type: "stream_event",
                event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
            }),
            JSON.stringify({
                type: "stream_event",
                event: {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "thinking_delta", thinking: "Let me " },
                },
            }),
            JSON.stringify({
                type: "stream_event",
                event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "check." } },
            }),
            JSON.stringify({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }),
            JSON.stringify({
                type: "stream_event",
                event: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
            }),
            JSON.stringify({
                type: "stream_event",
                event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hel" } },
            }),
            JSON.stringify({
                type: "stream_event",
                event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "lo" } },
            }),
            JSON.stringify({ type: "stream_event", event: { type: "content_block_stop", index: 1 } }),
            JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } }),
            JSON.stringify({ type: "result", result: "hello", usage: { input_tokens: 1, output_tokens: 2 } }),
        ].join("\n")),
        {
            onDelta: (delta) => textDeltas.push(delta.text),
            onThinkingDelta: (delta) => thinkingDeltas.push(delta.text),
            onThinkingEnd: () => {
                thinkingEndCalls += 1;
            },
        },
    );
    assertEquals(thinkingDeltas, ["Let me ", "check."]);
    assertEquals(textDeltas, ["hel", "lo"]);
    assertEquals(thinkingEndCalls, 1);
    assertEquals(result.text, "hello");
});

Deno.test("Claude CLI line parser rejects malformed stream-json", async () => {
    await assertRejects(
        () => parseClaudeCliStream(streamFromText("{bad-json}\n"), { onDelta: () => undefined }),
        Error,
        "malformed",
    );
});

Deno.test("Claude CLI parser rejects final text that differs from visible stream", async () => {
    await assertRejects(
        () =>
            parseClaudeCliStream(
                streamFromText(
                    `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "a" }] } })}\n${
                        JSON.stringify({ type: "result", result: "b" })
                    }\n`,
                ),
                { onDelta: () => undefined },
            ),
        Error,
        "did not match",
    );
});

Deno.test("Claude CLI execution session appends RunWield transcript entries and sends stdin history", async () => {
    await withClaudeFixture(async (root, logPath) => {
        Deno.env.set(
            "RUNWIELD_CLAUDE_FIXTURE_OUTPUT",
            JSON.stringify({
                type: "assistant",
                message: { content: [{ type: "text", text: "reply" }] },
                result: "reply",
            }),
        );
        const model = getModelRegistry().find("claude-cli", "sonnet");
        if (!model) throw new Error("missing claude model");
        const manager = SessionManager.inMemory(root);
        manager.appendMessage({ role: "user", timestamp: Date.now(), content: [{ type: "text", text: "prior" }] });
        const session = new ClaudeCliExecutionSession({
            cwd: root,
            agentName: "Guide",
            agentDisplayName: "Guide",
            finalSystemPrompt: "system",
            model,
            sessionManager: manager,
        });
        const messages = await session.runTurn({ userRequest: "now" });
        const log = JSON.parse((await Deno.readTextFile(logPath)).trim());
        assertStringIncludes(log.stdin, "USER: prior");
        assertStringIncludes(log.stdin, "USER: now");
        assertStringIncludes(log.promptText, "system");
        assertEquals(messages.at(-1)?.role, "assistant");
        const entries = manager.getBranch();
        assertEquals(entries.filter((entry) => entry.type === "message").length, 3);
        assertEquals(
            entries.some((entry) => entry.type === "custom" && entry.customType === "runwield.execution_backend"),
            true,
        );
        assertEquals(entries.some((entry) => entry.type === "model_change"), true);
    });
});

Deno.test("captured Claude Code 2.1.284 Read stream reaches the execution owner's JSONL", async () => {
    await withClaudeFixture(async (root) => {
        await setCustomSetting("workflowMetrics", true, "project", root);
        Deno.env.set(
            "RUNWIELD_CLAUDE_FIXTURE_STREAM_FILE",
            new URL("./fixtures/claude-2.1.284-read-tool-stream.jsonl", import.meta.url).pathname,
        );
        const model = getModelRegistry().find("claude-cli", "sonnet");
        if (!model) throw new Error("missing claude model");
        const manager = SessionManager.inMemory(root);
        const session = new ClaudeCliExecutionSession({
            cwd: root,
            agentName: "Guide",
            agentDisplayName: "Guide",
            finalSystemPrompt: "system",
            model,
            sessionManager: manager,
        });
        await session.runTurn({ userRequest: "Read the disposable file." });
        await drainWorkflowMetrics();
        const rows = (await Deno.readTextFile(getWorkflowMetricsFilePath(root))).trim().split("\n")
            .map((line) => JSON.parse(line));
        const native = rows.filter((row) => row.callId === "call_fixture_1");
        assertEquals(native.map((row) => row.event), ["tool_call_started", "tool_call_finished"]);
        assertEquals(native[0].toolName, "Read");
        assertEquals(native[1].outcome, "success");
        assertEquals(
            rows.some((row) =>
                row.event === "model_usage" && row.inputTokens === 4 &&
                row.outputTokens === 507
            ),
            true,
        );
        const latency = rows.find((row) => row.event === "response_latency");
        assertEquals(typeof latency?.firstResponseAt, "number");
        assertEquals(latency.firstResponseAt <= latency.firstVisibleTextAt, true);
        assertEquals(JSON.stringify(rows).includes("/fixture/readme.txt"), false);
    });
});

Deno.test("truncated Claude stream preserves observed assistant usage on failure", async () => {
    await withClaudeFixture(async (root) => {
        await setCustomSetting("workflowMetrics", true, "project", root);
        const streamPath = join(root, "truncated-stream.jsonl");
        await Deno.writeTextFile(
            streamPath,
            JSON.stringify({
                type: "assistant",
                message: {
                    id: "message-truncated",
                    model: "sonnet",
                    usage: { input_tokens: 22, output_tokens: 0 },
                    content: [{ type: "text", text: "partial" }],
                },
            }) + "\n{bad json}\n",
        );
        Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_STREAM_FILE", streamPath);
        const model = getModelRegistry().find("claude-cli", "sonnet");
        if (!model) throw new Error("missing claude model");
        const session = new ClaudeCliExecutionSession({
            cwd: root,
            agentName: "Guide",
            agentDisplayName: "Guide",
            finalSystemPrompt: "system",
            model,
            sessionManager: SessionManager.inMemory(root),
        });
        await assertRejects(() => session.runTurn({ userRequest: "truncated" }));
        await drainWorkflowMetrics();
        const rows = (await Deno.readTextFile(getWorkflowMetricsFilePath(root))).trim().split("\n")
            .map((line) => JSON.parse(line));
        assertEquals(rows.find((row) => row.event === "execution_finished")?.outcome, "failed");
        assertEquals(rows.find((row) => row.event === "model_usage")?.inputTokens, 22);
    });
});

Deno.test("Claude CLI execution session streams thinking and text runtime events live", async () => {
    await withClaudeFixture(async (root) => {
        Deno.env.set(
            "RUNWIELD_CLAUDE_FIXTURE_OUTPUT",
            JSON.stringify({
                type: "assistant",
                message: { content: [{ type: "text", text: "reply" }] },
                result: "reply",
            }),
        );
        Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_PARTIAL_STREAM", "1");
        Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_PARTIAL_CHARS", "1");
        const model = getModelRegistry().find("claude-cli", "sonnet");
        if (!model) throw new Error("missing claude model");
        const manager = SessionManager.inMemory(root);
        const hostedSession = new HostedSession({
            id: `hosted-${crypto.randomUUID()}`,
            cwd: root,
            sessionManager: manager as never,
        });
        const events: Array<{ type?: string; delta?: string; messageId?: string; agentName?: string }> = [];
        hostedSession.setEventSink((event: { type?: string; delta?: string; messageId?: string }) =>
            events.push(event)
        );
        const session = new ClaudeCliExecutionSession({
            cwd: root,
            agentName: "planner",
            agentDisplayName: "Plan Designer",
            finalSystemPrompt: "system",
            model,
            sessionManager: manager,
            hostedSession,
        });
        await session.runTurn({ userRequest: "now" });

        const thinkingDeltas = events.filter((event) => event.type === "assistant_thinking_delta");
        const thinkingEnds = events.filter((event) => event.type === "assistant_thinking_end");
        const textDeltas = events.filter((event) => event.type === "assistant_text_delta");
        assertEquals(thinkingDeltas.map((event) => event.delta).join(""), "thinking about it...");
        assertEquals(thinkingEnds.length, 1);
        // The live text_delta stream events cover "reply"; the later complete `assistant` message
        // must not be re-emitted as a duplicate delta.
        assertEquals(textDeltas.map((event) => event.delta).join(""), "reply");
        assertEquals(
            [...thinkingDeltas, ...thinkingEnds, ...textDeltas].map((event) => event.agentName),
            [...thinkingDeltas, ...thinkingEnds, ...textDeltas].map(() => "Plan Designer"),
        );
        assertEquals(textDeltas.length < "reply".length, true);
        assert(thinkingDeltas.every((event) => event.messageId === thinkingDeltas[0]?.messageId));
        assert(events.indexOf(thinkingEnds[0]) < events.indexOf(textDeltas[0]));
    });
});

Deno.test("Claude CLI execution metadata is sanitized", async () => {
    await withClaudeFixture(async (root) => {
        Deno.env.set(
            "RUNWIELD_CLAUDE_FIXTURE_OUTPUT",
            JSON.stringify({
                type: "assistant",
                message: { content: [{ type: "text", text: "safe" }] },
                result: "safe",
            }),
        );
        const model = getModelRegistry().find("claude-cli", "sonnet");
        if (!model) throw new Error("missing claude model");
        const manager = SessionManager.inMemory(root);
        const session = new ClaudeCliExecutionSession({
            cwd: root,
            agentName: "Guide",
            agentDisplayName: "Guide",
            finalSystemPrompt: "secret prompt",
            model,
            sessionManager: manager,
        });
        await session.runTurn({ userRequest: "hello" });
        const serialized = JSON.stringify(manager.getBranch().filter((entry) => entry.type === "custom"));
        assertStringIncludes(serialized, "runwield.execution_backend");
        assertEquals(serialized.includes("secret prompt"), false);
        assertEquals(serialized.includes("append-system-prompt-file"), false);
        assertEquals(serialized.includes("RUNWIELD_CLAUDE_FIXTURE"), false);
        assertStringIncludes(serialized, "external-1");
    });
});

Deno.test("^Claude CLI MCP config is additive authenticated and ephemeral$", async () => {
    await withClaudeFixture(async (root, logPath) => {
        await setCustomSetting("workflowMetrics", true, "project", root);
        const model = getModelRegistry().find("claude-cli", "sonnet");
        if (!model) throw new Error("missing claude model");
        const manager = SessionManager.inMemory(root);
        const hostedSession = new HostedSession({
            id: `hosted-${crypto.randomUUID()}`,
            cwd: root,
            sessionManager: manager as never,
        });
        hostedSession.setActiveExecutionWorkflow({
            planName: "quick-fix",
            triageMeta: { classification: "QUICK_FIX" },
            executionAgent: "engineer",
            executionStarted: true,
            executionCwd: root,
        });
        const taskTool = createTaskCompletedTool({ hostedSession, agentName: "Engineer" });
        const callsPath = join(root, "mcp-calls.json");
        await Deno.writeTextFile(
            callsPath,
            JSON.stringify([
                { name: "runwield_task_completed", arguments: { message: "mcp accepted" } },
            ]),
        );
        Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_MCP_CALLS", callsPath);
        const session = new ClaudeCliExecutionSession({
            cwd: root,
            agentName: "engineer",
            agentDisplayName: "Engineer",
            finalSystemPrompt: "system",
            model,
            sessionManager: manager,
            hostedSession,
            bridgedTools: [taskTool],
        });
        const messages = await session.runTurn({ userRequest: "execute" });
        await drainWorkflowMetrics();
        const metricRows = (await Deno.readTextFile(getWorkflowMetricsFilePath(root))).trim().split("\n")
            .map((line) => JSON.parse(line));
        const bridgeCalls = metricRows.filter((row) => ["tool_call_started", "tool_call_finished"].includes(row.event));
        assertEquals(bridgeCalls.map((row) => row.event), ["tool_call_started", "tool_call_finished"]);
        assertEquals(bridgeCalls[0].callId, bridgeCalls[1].callId);
        assertEquals(bridgeCalls[1].outcome, "success");

        const lines = (await Deno.readTextFile(logPath)).trim().split("\n").map((line) => JSON.parse(line));
        const argvLine = lines[0];
        assertEquals(argvLine.args.includes("--mcp-config"), true);
        assertEquals(argvLine.args.includes("--strict-mcp-config"), false);
        const configPath = argvLine.args[argvLine.args.indexOf("--mcp-config") + 1];

        const configLine = lines.find((line) => line.mcp?.config);
        assertEquals(configLine.mcp.config.url.startsWith("http://127.0.0.1:"), true);
        assertEquals(configLine.mcp.config.authHeaderPresent, true);
        if (configLine.mcp.config.configMode !== null) {
            assertEquals(configLine.mcp.config.configMode & 0o777, 0o600);
        }
        const authLine = lines.find((line) => line.mcp?.unauthorizedStatus !== undefined);
        assertEquals(authLine.mcp.unauthorizedStatus, 401);
        assertEquals(authLine.mcp.wrongTokenStatus, 401);
        const toolsLine = lines.find((line) => line.mcp?.tools);
        assertEquals(toolsLine.mcp.tools, ["runwield_task_completed"]);
        // The turn outcome is recorded canonically for existing workflow readers.
        assertEquals(readLatestTaskCompletedOutcome(messages), true);
        const branch = manager.getBranch();
        assertEquals(
            branch.some((entry) => entry.type === "custom" && entry.customType === "runwield.task_completion"),
            true,
        );

        // Config file and loopback listener are gone after the turn.
        await assertRejects(() => Deno.stat(configPath), Deno.errors.NotFound);
        await assertRejects(() => fetch(configLine.mcp.config.url), TypeError);
    });
});

Deno.test("^Claude CLI missing executable fails before workflow mutation$", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousPath = Deno.env.get("PATH");
        await withTempDir(async (root) => {
            const emptyBin = join(root, "empty-bin");
            await Deno.mkdir(emptyBin);
            Deno.env.set("PATH", emptyBin);
            try {
                const model = getModelRegistry().find("claude-cli", "sonnet");
                if (!model) throw new Error("missing claude model");
                const manager = SessionManager.inMemory(root);
                const hostedSession = new HostedSession({
                    id: `hosted-${crypto.randomUUID()}`,
                    cwd: root,
                    sessionManager: manager as never,
                });
                hostedSession.setActiveExecutionWorkflow({
                    planName: "plan",
                    triageMeta: { classification: "PLANNED_CHANGE" },
                    executionAgent: "engineer",
                    executionStarted: true,
                    executionCwd: root,
                });
                const session = new ClaudeCliExecutionSession({
                    cwd: root,
                    agentName: "Engineer",
                    agentDisplayName: "Engineer",
                    finalSystemPrompt: "system",
                    model,
                    sessionManager: manager,
                    hostedSession,
                });
                const error = await assertRejects(
                    () => session.runTurn({ userRequest: "do it" }),
                    ClaudeCliBackendError,
                    "Claude Code",
                );
                assertEquals(error.kind, "missing_executable");
                assertEquals(manager.getBranch().filter((entry) => entry.type === "message").length, 0);
                assertEquals(hostedSession.getActiveExecutionWorkflow()?.planName, "plan");
                assertEquals(
                    manager.getBranch().some((entry) =>
                        entry.type === "custom" && entry.customType === "runwield.backend_status" &&
                        (entry as { data?: { kind?: string } }).data?.kind === "missing_executable"
                    ),
                    true,
                );
            } finally {
                if (previousPath === undefined) Deno.env.delete("PATH");
                else Deno.env.set("PATH", previousPath);
            }
        });
    });
});

Deno.test("^Claude CLI auth failure is a sanitized visible non-zero exit$", async () => {
    await withClaudeFixture(async (root) => {
        Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_EXIT_CODE", "1");
        Deno.env.set(
            "RUNWIELD_CLAUDE_FIXTURE_STDERR",
            "not signed in\nAuthorization: Bearer secret-token\nSee https://secret.example/login\n",
        );
        const model = getModelRegistry().find("claude-cli", "sonnet");
        if (!model) throw new Error("missing claude model");
        const manager = SessionManager.inMemory(root);
        const hostedSession = new HostedSession({
            id: `hosted-${crypto.randomUUID()}`,
            cwd: root,
            sessionManager: manager as never,
        });
        const events: Array<{ type?: string; level?: string; message?: string }> = [];
        hostedSession.setEventSink((event: { type?: string; level?: string; message?: string }) => events.push(event));
        const session = new ClaudeCliExecutionSession({
            cwd: root,
            agentName: "Engineer",
            agentDisplayName: "Engineer",
            finalSystemPrompt: "system",
            model,
            sessionManager: manager,
            hostedSession,
        });
        const error = await assertRejects(() => session.runTurn({ userRequest: "auth" }), ClaudeCliBackendError);
        assertEquals(error.kind, "auth_failed");
        assertStringIncludes(error.message, "Claude Code authentication failed");
        assertEquals(error.message.includes("secret-token"), false);
        assertEquals(error.message.includes("https://secret.example"), false);
        const statusEntries = manager.getBranch().filter((entry) =>
            entry.type === "custom" && entry.customType === "runwield.backend_status"
        ) as Array<{ data?: { kind?: string; message?: string; exitCode?: number | null } }>;
        assertEquals(statusEntries.length, 1);
        assertEquals(statusEntries[0].data?.kind, "auth_failed");
        assertEquals(statusEntries[0].data?.exitCode, 1);
        const serialized = JSON.stringify(manager.getBranch());
        assertEquals(serialized.includes("secret-token"), false);
        assertEquals(serialized.includes("Authorization"), false);
        assertEquals(events.some((event) => event.type === "system_status" && event.level === "error"), true);
    });
});

Deno.test("^Claude CLI structured limit failure shows Claude's message$", async () => {
    await withClaudeFixture(async (root) => {
        const limitMessage = "You've hit your monthly spend limit · raise it at claude.ai/settings/usage";
        Deno.env.set(
            "RUNWIELD_CLAUDE_FIXTURE_OUTPUT",
            JSON.stringify({ result: limitMessage, isError: true }),
        );
        const model = getModelRegistry().find("claude-cli", "sonnet");
        if (!model) throw new Error("missing claude model");
        const manager = SessionManager.inMemory(root);
        const hostedSession = new HostedSession({
            id: `hosted-${crypto.randomUUID()}`,
            cwd: root,
            sessionManager: manager as never,
        });
        const events: Array<{ type?: string; message?: string }> = [];
        hostedSession.setEventSink((event: { type?: string; message?: string }) => events.push(event));
        const session = new ClaudeCliExecutionSession({
            cwd: root,
            agentName: "Engineer",
            agentDisplayName: "Engineer",
            finalSystemPrompt: "system",
            model,
            sessionManager: manager,
            hostedSession,
        });

        const error = await assertRejects(() => session.runTurn({ userRequest: "continue" }), ClaudeCliBackendError);

        assertEquals(error.kind, "non_zero_exit");
        assertEquals(error.message, limitMessage);
        const statusEntries = manager.getBranch().filter((entry) =>
            entry.type === "custom" && entry.customType === "runwield.backend_status"
        ) as Array<{ data?: { message?: string } }>;
        assertEquals(statusEntries.length, 1);
        assertEquals(statusEntries[0].data?.message, limitMessage);
        assertEquals(
            events.some((event) => event.type === "system_status" && event.message === limitMessage),
            true,
        );
    });
});

Deno.test("^Claude CLI malformed stream is a typed failure with cleanup$", async () => {
    await withClaudeFixture(async (root) => {
        Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_MALFORMED", "1");
        const model = getModelRegistry().find("claude-cli", "sonnet");
        if (!model) throw new Error("missing claude model");
        const manager = SessionManager.inMemory(root);
        const hostedSession = new HostedSession({
            id: `hosted-${crypto.randomUUID()}`,
            cwd: root,
            sessionManager: manager as never,
        });
        hostedSession.setActiveExecutionWorkflow({
            planName: "quick-fix",
            triageMeta: { classification: "QUICK_FIX" },
            executionAgent: "engineer",
            executionStarted: true,
            executionCwd: root,
        });
        const taskTool = createTaskCompletedTool({ hostedSession, agentName: "Engineer" });
        const session = new ClaudeCliExecutionSession({
            cwd: root,
            agentName: "Engineer",
            agentDisplayName: "Engineer",
            finalSystemPrompt: "system",
            model,
            sessionManager: manager,
            hostedSession,
            bridgedTools: [taskTool],
        });
        const error = await assertRejects(() => session.runTurn({ userRequest: "malformed" }), ClaudeCliBackendError);
        assertEquals(error.kind, "malformed_stream");
        const entries = manager.getBranch();
        assertEquals(
            entries.some((entry) =>
                entry.type === "custom" && entry.customType === "runwield.backend_status" &&
                (entry as { data?: { kind?: string } }).data?.kind === "malformed_stream"
            ),
            true,
        );
        const logEntry = JSON.parse(
            (await Deno.readTextFile(Deno.env.get("RUNWIELD_CLAUDE_FIXTURE_LOG") || "")).trim().split("\n")[0],
        );
        const promptPath = logEntry.args[logEntry.args.indexOf("--append-system-prompt-file") + 1];
        const mcpPath = logEntry.args[logEntry.args.indexOf("--mcp-config") + 1];
        await assertRejects(() => Deno.stat(promptPath), Deno.errors.NotFound);
        await assertRejects(() => Deno.stat(mcpPath), Deno.errors.NotFound);
    });
});

Deno.test("^Claude CLI abort cancels the subprocess and preserves active workflow$", async () => {
    await withClaudeFixture(async (root, logPath) => {
        Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_SLEEP_MS", "1000");
        const model = getModelRegistry().find("claude-cli", "sonnet");
        if (!model) throw new Error("missing claude model");
        const manager = SessionManager.inMemory(root);
        const hostedSession = new HostedSession({
            id: `hosted-${crypto.randomUUID()}`,
            cwd: root,
            sessionManager: manager as never,
        });
        hostedSession.setActiveExecutionWorkflow({
            planName: "plan",
            triageMeta: { classification: "PLANNED_CHANGE" },
            executionAgent: "engineer",
            executionStarted: true,
            executionCwd: root,
        });
        const session = new ClaudeCliExecutionSession({
            cwd: root,
            agentName: "Engineer",
            agentDisplayName: "Engineer",
            finalSystemPrompt: "system",
            model,
            sessionManager: manager,
            hostedSession,
        });
        const run = session.runTurn({ userRequest: "slow" });
        await waitForLogText(logPath, "slow");
        session.abort();
        const error = await assertRejects(() => run, ClaudeCliBackendError);
        assertEquals(error.kind, "canceled");
        assertEquals(hostedSession.getActiveExecutionWorkflow()?.planName, "plan");
        assertEquals(
            manager.getBranch().some((entry) =>
                entry.type === "custom" && entry.customType === "runwield.backend_status" &&
                (entry as { data?: { kind?: string } }).data?.kind === "canceled"
            ),
            true,
        );
        const log = await Deno.readTextFile(logPath);
        assert(log.includes("SIGTERM") || log.includes("slow"));
    });
});

Deno.test("Claude stream exposes native tool results and alternative per-model usage", async () => {
    const calls: string[] = [];
    const usage: Array<{ sourceId: string; aggregationBasis: string; inputTokens: number | null }> = [];
    await parseClaudeCliStream(
        streamFromText([
            JSON.stringify({
                type: "assistant",
                message: {
                    id: "msg_1",
                    model: "claude-sonnet",
                    usage: { input_tokens: 0, output_tokens: 3 },
                    content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/private" } }, {
                        type: "text",
                        text: "done",
                    }],
                },
            }),
            JSON.stringify({
                type: "user",
                message: {
                    content: [
                        { type: "tool_result", tool_use_id: "toolu_1", content: "private result", is_error: false },
                    ],
                },
            }),
            JSON.stringify({
                type: "result",
                result: "done",
                total_cost_usd: 0.1,
                usage: { input_tokens: 10, output_tokens: 5 },
                modelUsage: { "claude-sonnet": { inputTokens: 8, outputTokens: 5, costUSD: 0.08 } },
            }),
        ].join("\n")),
        {
            onDelta: () => {},
            onNativeToolStart: (call) => calls.push(`start:${call.callId}`),
            onNativeToolResult: (result) => calls.push(`end:${result.callId}`),
            onUsage: (observation) =>
                usage.push({
                    sourceId: observation.sourceId,
                    aggregationBasis: observation.aggregationBasis,
                    inputTokens: observation.usage.inputTokens,
                }),
        },
    );
    assertEquals(calls, ["start:toolu_1", "end:toolu_1"]);
    assertEquals(usage.map((entry) => [entry.aggregationBasis, entry.inputTokens]), [["alternative", 0], ["turn", 10], [
        "alternative",
        8,
    ]]);
});

Deno.test("Claude full thinking content precedes visible text as first response", async () => {
    const events: string[] = [];
    await parseClaudeCliStream(
        streamFromText(
            [
                JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "hidden" }] } }),
                JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "visible" }] } }),
                JSON.stringify({ type: "result", result: "visible" }),
            ].join("\n") + "\n",
        ),
        {
            onThinkingObserved: () => events.push("response"),
            onDelta: () => events.push("text"),
        },
    );
    assertEquals(events, ["response", "text"]);
});

Deno.test("Claude owner counts an MCP bridge call once when its alias also appears in native stream", async () => {
    await withClaudeFixture(async (root) => {
        await setCustomSetting("workflowMetrics", true, "project", root);
        const callsPath = join(root, "calls.json");
        await Deno.writeTextFile(
            callsPath,
            JSON.stringify([{ name: "read_fixture", arguments: { value: "PRIVATE-ARG" } }]),
        );
        Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_MCP_CALLS", callsPath);
        const streamPath = join(root, "overlap.jsonl");
        await Deno.writeTextFile(
            streamPath,
            [
                {
                    type: "assistant",
                    message: {
                        content: [
                            {
                                type: "tool_use",
                                id: "stream-alias",
                                name: "mcp__runwield__read_fixture",
                                input: { value: "PRIVATE-ARG" },
                            },
                            {
                                type: "tool_use",
                                id: "native-read",
                                name: "Read",
                                input: { file_path: "/private/file" },
                            },
                        ],
                    },
                },
                {
                    type: "user",
                    message: {
                        content: [
                            { type: "tool_result", tool_use_id: "stream-alias", content: "PRIVATE-RESULT" },
                            { type: "tool_result", tool_use_id: "native-read", content: "PRIVATE-RESULT" },
                        ],
                    },
                },
                { type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
                { type: "result", result: "done", usage: { input_tokens: 2, output_tokens: 1 } },
            ].map((line) => JSON.stringify(line)).join("\n") + "\n",
        );
        Deno.env.set("RUNWIELD_CLAUDE_FIXTURE_STREAM_FILE", streamPath);
        const model = getModelRegistry().find("claude-cli", "sonnet");
        if (!model) throw new Error("missing claude model");
        const tool = defineTool({
            name: "read_fixture",
            label: "Read Fixture",
            description: "Read fixture",
            parameters: Type.Object({ value: Type.String() }),
            execute: () =>
                Promise.resolve({ content: [{ type: "text" as const, text: "PRIVATE-RESULT" }], details: {} }),
        });
        const session = new ClaudeCliExecutionSession({
            cwd: root,
            agentName: "Guide",
            agentDisplayName: "Guide",
            finalSystemPrompt: "system",
            model,
            sessionManager: SessionManager.inMemory(root),
            bridgedTools: [tool],
        });
        await session.runTurn({ userRequest: "Read fixture." });
        await drainWorkflowMetrics();
        const rows = (await Deno.readTextFile(getWorkflowMetricsFilePath(root))).trim().split("\n")
            .map((line) => JSON.parse(line));
        const started = rows.filter((row) => row.event === "tool_call_started");
        assertEquals(started.map((row) => row.toolName).sort(), ["Read", "read_fixture"]);
        assertEquals(rows.filter((row) => row.event === "tool_call_finished").length, 2);
        assertEquals(rows.find((row) => row.event === "execution_finished")?.callCount, 2);
        assertEquals(rows.some((row) => row.callId === "stream-alias"), false);
        assertEquals(JSON.stringify(rows).includes("PRIVATE-"), false);
    });
});
