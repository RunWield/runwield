import { text as readStreamText } from "node:stream/consumers";
import { createInterface } from "node:readline";
import process from "node:process";
import { readFile as fsReadFile, stat as fsStat, writeFile as fsWriteFile } from "node:fs/promises";
/**
 * @module shared/session/backends/claude-cli/testing/fake-claude-mcp-client
 *
 * Test-only fake `claude` executable body. The test fixtures install a tiny
 * `claude` shim on PATH that execs this script with the real argv, so module
 * resolution (including the real MCP SDK client) runs from the workspace
 * instead of a temp dir.
 *
 * Non-MCP mode reproduces the old inline fixture exactly: it logs the argv,
 * stdin, and appended system prompt, then emits a stream-json assistant
 * message plus result line.
 *
 * MCP mode (when `--mcp-config` is present) additionally reads the generated
 * Claude MCP config, connects a real MCP SDK client over loopback HTTP with
 * the config's Bearer token, lists the advertised tools, and executes the
 * calls described by `RUNWIELD_CLAUDE_FIXTURE_MCP_CALLS` (a JSON array of
 * `{ name, arguments }`). Everything is appended to the fixture log as JSON
 * lines for the test to assert against.
 */

import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp";

interface FixtureMcpCall {
    name: string;
    arguments?: JsonObject;
}

/** Concrete JSON value shape for fixture log entries. */
type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
interface JsonObject {
    [key: string]: JsonValue;
}

interface StringMap {
    [key: string]: string;
}

interface McpServerConfig {
    url?: string;
    headers?: StringMap;
}

interface McpServerMap {
    [key: string]: McpServerConfig;
}

interface ClaudeMcpConfig {
    mcpServers?: McpServerMap;
}

interface ToolResultContentBlock {
    type: string;
    text?: string;
}

interface FixtureOutput {
    isError?: boolean;
    result?: string;
}

async function readTextFile(path: string | undefined): Promise<string> {
    if (!path) return "";
    try {
        return await fsReadFile(path, "utf8");
    } catch {
        return "";
    }
}

async function appendLogLine(entry: JsonObject): Promise<void> {
    const logPath = process.env["RUNWIELD_CLAUDE_FIXTURE_LOG"];
    if (!logPath) return;
    await fsWriteFile(logPath, JSON.stringify(entry) + "\n", { flag: "a" });
}

async function runMcpCalls(configPath: string): Promise<void> {
    const config = JSON.parse(await readTextFile(configPath)) as ClaudeMcpConfig;
    const server = config.mcpServers?.runwield;
    if (!server?.url) {
        await appendLogLine({ mcp: { error: "missing runwield mcp server in config" } });
        return;
    }
    let configMode: number | null = null;
    try {
        configMode = (await fsStat(configPath)).mode;
    } catch {
        // Mode unavailable on this platform.
    }
    await appendLogLine({
        mcp: {
            config: {
                url: server.url,
                authHeaderPresent: typeof server.headers?.Authorization === "string",
                configMode,
            },
        },
    });
    const unauthorized = await fetch(server.url, { method: "POST", body: "{}" });
    const wrongToken = await fetch(server.url, {
        method: "POST",
        headers: { Authorization: "Bearer not-the-token" },
        body: "{}",
    });
    await appendLogLine({ mcp: { unauthorizedStatus: unauthorized.status, wrongTokenStatus: wrongToken.status } });
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: {
            headers: {
                ...(server.headers ? server.headers : {}),
            },
        },
    });
    const client = new Client({ name: "runwield-claude-fixture", version: "1.0.0" });
    try {
        await client.connect(transport);
        const listed = await client.listTools();
        await appendLogLine({ mcp: { tools: listed.tools.map((tool) => tool.name) } });
        const callsJson = await readTextFile(process.env["RUNWIELD_CLAUDE_FIXTURE_MCP_CALLS"]);
        const calls = (callsJson ? JSON.parse(callsJson) : []) as FixtureMcpCall[];
        const results: JsonValue[] = [];
        for (const call of calls) {
            try {
                const result = await client.callTool({
                    name: call.name,
                    arguments: call.arguments ?? {},
                });
                results.push({
                    name: call.name,
                    isError: result.isError === true,
                    text: extractCallResultText(result.content as ToolResultContentBlock[]),
                });
            } catch (error) {
                results.push({
                    name: call.name,
                    isError: true,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        await appendLogLine({ mcp: { calls: results } });
    } finally {
        try {
            await client.close();
        } catch {
            // Transport teardown best-effort.
        }
        try {
            await transport.close();
        } catch {
            // Transport teardown best-effort.
        }
    }
}

function extractCallResultText(content: ToolResultContentBlock[]): string {
    if (!Array.isArray(content)) return "";
    return content
        .flatMap((block) => {
            if (block.type !== "text") return [];
            return typeof block.text === "string" ? [block.text] : [];
        })
        .join("\n");
}

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

try {
    process.on("SIGTERM", () => {
        appendLogLine({ signal: "SIGTERM" }).finally(() => process.exit(143));
    });
} catch {
    // Signal listeners are unavailable on some platforms.
}

async function main(): Promise<void> {
    const streamed = process.argv.includes("--input-format");
    const lines = streamed ? createInterface({ input: process.stdin })[Symbol.asyncIterator]() : null;
    const initialLine = lines ? (await lines.next()).value || "" : "";
    const initial = initialLine ? (JSON.parse(initialLine) as JsonObject) : null;
    const initialMessage = initial?.message as JsonObject | undefined;
    const stdin = streamed ? String(initialMessage?.content || "") : await readStreamText(process.stdin);
    let replayEnabled = false;
    const pendingReplays: JsonObject[] = [];
    let completedText: string | null = null;
    const replay = async (message: JsonObject) => {
        await appendLogLine({ consumed: message });
        console.log(JSON.stringify({ ...message, isReplay: true }));
        if (completedText !== null) {
            console.log(
                JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: completedText }] } }),
            );
            console.log(
                JSON.stringify({ type: "result", result: completedText, usage: { input_tokens: 1, output_tokens: 2 } }),
            );
        }
    };
    const inputDone = lines
        ? (async () => {
              for await (const line of { [Symbol.asyncIterator]: () => lines }) {
                  const message = JSON.parse(line) as JsonObject;
                  if (message.type === "control_request") {
                      const request = message.request as JsonObject;
                      const index = pendingReplays.findIndex((pending) => pending.uuid === request.message_uuid);
                      if (index >= 0) pendingReplays.splice(index, 1);
                      console.log(
                          JSON.stringify({
                              type: "control_response",
                              response: {
                                  subtype: "success",
                                  request_id: message.request_id,
                                  response: { cancelled: index >= 0 },
                              },
                          }),
                      );
                      continue;
                  }
                  await appendLogLine({ steering: message });
                  if (replayEnabled) await replay(message);
                  else pendingReplays.push(message);
              }
          })()
        : Promise.resolve();
    const promptIndex = process.argv.slice(2).indexOf("--append-system-prompt-file");
    const promptPath = promptIndex >= 0 ? process.argv.slice(2)[promptIndex + 1] : "";
    const promptText = await readTextFile(promptPath);
    await appendLogLine({ args: process.argv.slice(2), stdin, promptText });

    const exitCodeText = process.env["RUNWIELD_CLAUDE_FIXTURE_EXIT_CODE"];
    if (exitCodeText) {
        const stderrText = process.env["RUNWIELD_CLAUDE_FIXTURE_STDERR"] || "fixture stderr";
        await process.stderr.write(new TextEncoder().encode(stderrText));
        process.exit(Number.parseInt(exitCodeText, 10));
    }

    const mcpConfigIndex = process.argv.slice(2).indexOf("--mcp-config");
    if (mcpConfigIndex >= 0) {
        const beforeMcpSleepMsText = process.env["RUNWIELD_CLAUDE_FIXTURE_BEFORE_MCP_SLEEP_MS"];
        if (beforeMcpSleepMsText) await sleep(Number.parseInt(beforeMcpSleepMsText, 10));
        await runMcpCalls(process.argv.slice(2)[mcpConfigIndex + 1]);
    }

    const sleepMsText = process.env["RUNWIELD_CLAUDE_FIXTURE_SLEEP_MS"];
    if (sleepMsText) await sleep(Number.parseInt(sleepMsText, 10));
    replayEnabled = true;
    for (const message of pendingReplays.splice(0)) await replay(message);
    if (process.env["RUNWIELD_CLAUDE_FIXTURE_MALFORMED"]) {
        console.log("{malformed-stream-line");
        return;
    }

    const capturedStream = process.env["RUNWIELD_CLAUDE_FIXTURE_STREAM_FILE"];
    if (capturedStream) {
        await process.stdout.write(new TextEncoder().encode(await fsReadFile(capturedStream, "utf8")));
        return;
    }
    const output = process.env["RUNWIELD_CLAUDE_FIXTURE_OUTPUT"] || "";
    const parsedOutput = output ? (JSON.parse(output) as FixtureOutput) : null;
    const text = parsedOutput
        ? parsedOutput.result || "fixture"
        : process.env["RUNWIELD_CLAUDE_FIXTURE_TEXT"] || "fixture reply";
    if (process.env["RUNWIELD_CLAUDE_FIXTURE_PARTIAL_STREAM"]) {
        const half = Math.max(1, Math.ceil(text.length / 2));
        for (const thinking of ["thinking about it", "..."]) {
            console.log(
                JSON.stringify({
                    type: "stream_event",
                    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking } },
                }),
            );
        }
        const textChunks = process.env["RUNWIELD_CLAUDE_FIXTURE_PARTIAL_CHARS"]
            ? Array.from(text)
            : [text.slice(0, half), text.slice(half)];
        for (const chunk of textChunks) {
            if (!chunk) continue;
            console.log(
                JSON.stringify({
                    type: "stream_event",
                    event: { type: "content_block_delta", delta: { type: "text_delta", text: chunk } },
                }),
            );
        }
    }
    console.log(
        JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "text", text }] },
        }),
    );
    const postTerminalText = process.env["RUNWIELD_CLAUDE_FIXTURE_POST_TERMINAL_TEXT"] || "";
    if (postTerminalText) {
        console.log(
            JSON.stringify({
                type: "assistant",
                message: { content: [{ type: "text", text: postTerminalText }] },
            }),
        );
    }
    if (process.env["RUNWIELD_CLAUDE_FIXTURE_NO_RESULT"]) return;
    completedText = text;
    console.log(
        JSON.stringify({
            type: "result",
            result: text,
            ...(parsedOutput?.isError ? { is_error: true } : {}),
            session_id: "external-1",
            usage: { input_tokens: 1, output_tokens: 2 },
        }),
    );
    await inputDone;
}

await main();
