import { spawnNativeProcess } from "../../../../foreground-process.ts";
import { getHomeDir } from "../../../../../constants.ts";
import { getCwd } from "../../../../../constants.ts";
import { lstat as fsLstat, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import process from "node:process";
import { createInterface } from "node:readline";

interface JsonRecord {
    [key: string]: string | number | boolean | null | JsonRecord | string[] | JsonRecord[];
}

function readArg(args: string[], flag: string): string {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] || "" : "";
}

function joinPath(...parts: string[]): string {
    return parts
        .map((part, index) => {
            const trimmed = index === 0 ? part.replace(/\/+$/, "") : part.replace(/^\/+|\/+$/g, "");
            return trimmed;
        })
        .filter(Boolean)
        .join("/");
}

async function fileExists(path: string): Promise<boolean> {
    try {
        const info = await fsLstat(path);
        return info.isFile() && !info.isSymbolicLink();
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
    }
}

let acp: { sessionId: string; promptId: number; mcpServers: AcpFixtureServer[] } | undefined;
interface AcpFixtureServer {
    name: string;
    command: string;
    args: string[];
    env: { name: string; value: string }[];
}
interface AcpFixturePacket {
    id?: number | string;
    method?: string;
    params?: { value?: string; configId?: string; prompt?: { text: string }[]; mcpServers?: AcpFixtureServer[] };
    result?: { outcome?: { outcome?: string; optionId?: string } };
}
const pendingPermissions = new Map<string, (allowed: boolean) => void>();
function send(value: JsonRecord): void {
    console.log(JSON.stringify(value));
}
function update(value: JsonRecord): void {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: acp?.sessionId ?? "", update: value } });
}
function reply(id: number, result: JsonRecord): void {
    send({ jsonrpc: "2.0", id, result });
}
function emit(value: JsonRecord): void {
    if (!acp) throw new Error("ACP session not initialized");
    if (value.event === "step_update") {
        const step = value.step_update as JsonRecord;
        if (step.step_type === "agent_response") {
            update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: step.text_delta } });
            return;
        }
        if (step.step_type === "tool") {
            const info = step.tool_info as JsonRecord;
            const status = step.state === "ACTIVE" ? "in_progress" : step.state === "ERROR" ? "failed" : "completed";
            update({
                sessionUpdate: status === "in_progress" ? "tool_call" : "tool_call_update",
                toolCallId: String(step.step_index ?? step.tool_name),
                name: step.tool_name,
                title: step.tool_name,
                status,
                ...(info.parameters ? { rawInput: info.parameters } : {}),
                ...(typeof info.output === "string"
                    ? { content: [{ type: "content", content: { type: "text", text: info.output } }] }
                    : {}),
            });
        }
    }
    if (value.event === "result") {
        const result = value.result as JsonRecord;
        const usage = (result.usage ?? {}) as JsonRecord;
        if (result.error) {
            send({ jsonrpc: "2.0", id: acp.promptId, error: { code: -32603, message: result.error } });
            return;
        }

        reply(acp.promptId, {
            stopReason: result.response === "different" ? "refusal" : "end_turn",
            usage: {
                inputTokens: usage.input_tokens ?? null,
                outputTokens: usage.output_tokens ?? null,
                cachedReadTokens: usage.cache_read_tokens ?? usage.cached_input_tokens ?? null,
                cachedWriteTokens: usage.cache_write_tokens ?? usage.cache_creation_input_tokens ?? null,
            },
        });
    }
}

function requestPermission(name: string, args: JsonRecord): Promise<boolean> {
    const id = "permission:" + crypto.randomUUID();
    send({
        jsonrpc: "2.0",
        id,
        method: "session/request_permission",
        params: {
            sessionId: acp?.sessionId ?? "",
            toolCall: { toolCallId: id, name, title: name, kind: "other", rawInput: args },
            options: [
                { optionId: "allow", name: "Allow", kind: "allow_once" },
                { optionId: "deny", name: "Deny", kind: "reject_once" },
            ],
        },
    });
    return new Promise((resolve) => pendingPermissions.set(id, resolve));
}

async function maybeStartDescendant(): Promise<void> {
    const pidPath = process.env["RUNWIELD_AGY_DESCENDANT_PID"] || "";
    if (!pidPath) return;
    const holdsPipes = process.env["RUNWIELD_AGY_DESCENDANT_HOLDS_PIPES"] === "1";
    const shell = spawnNativeProcess("sh", {
        cwd: getCwd(),
        args: ["-c", "sleep 30 & echo $! > " + pidPath + "; exit 0"],
        stdin: "null",
        stdout: holdsPipes ? "inherit" : "null",
        stderr: holdsPipes ? "inherit" : "null",
    });
    await shell.status;
}

async function runConfiguredMcp(home: string): Promise<void> {
    const callsPath = process.env["RUNWIELD_AGY_EXECUTION_MCP_CALLS"] || "";
    if (!callsPath) return;
    const server = acp?.mcpServers.find((entry) => /^runwield_turn_[a-z0-9]+$/.test(entry.name));
    if (!server) throw new Error("missing RunWield MCP server");
    const clientModule = await import("@modelcontextprotocol/sdk/client/index.js");
    const stdioModule = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const transport = new stdioModule.StdioClientTransport({
        command: server.command,
        args: server.args,
        env: {
            ...{ ...process.env },
            HOME: home,
            PATH: process.env["PATH"] || "",
            ...Object.fromEntries((server.env ?? []).map(({ name, value }) => [name, value])),
        },
        stderr: "pipe",
    });
    const client = new clientModule.Client({ name: "runwield-agy-fixture", version: "1.0.0" });
    try {
        await client.connect(transport);
        const listed = await client.listTools();
        const logPath = process.env["RUNWIELD_AGY_EXECUTION_LOG"] || "";
        if (logPath) {
            await fsWriteFile(
                logPath,
                JSON.stringify({ mcp: { tools: listed.tools.map((tool: { name: string }) => tool.name) } }) + "\n",
                { flag: "a" },
            );
        }
        const calls = JSON.parse(await fsReadFile(callsPath, "utf8"));
        const results = [];
        for (const call of calls) {
            if (
                !(await requestPermission("mcp_" + server.name + "_" + call.name.replaceAll(/[^a-zA-Z0-9_]/g, "_"), {
                    toolSummary: "Invoke " + call.name,
                }))
            ) {
                results.push({ name: call.name, isError: true, permissionDenied: true });
                continue;
            }
            const result = await client.callTool({ name: call.name, arguments: call.arguments || {} });
            results.push({ name: call.name, isError: result.isError === true });
        }
        if (logPath) await fsWriteFile(logPath, JSON.stringify({ mcp: { calls: results } }) + "\n", { flag: "a" });
    } finally {
        await client.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
    }
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const home = getHomeDir();
    if (process.env["RUNWIELD_AGY_REQUIRE_AUTH"] === "1") {
        const encoder = new TextEncoder();
        await writeOutput(process.stderr, encoder.encode("Authenti"));
        await new Promise((resolve) => setTimeout(resolve, 25));
        await writeOutput(
            process.stderr,
            encoder.encode(
                "cation required. Please visit the URL to log in:\nhttps://example.test/login?code=private-code\n",
            ),
        );
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        await fsWriteFile(joinPath(home, "auth-wait-timed-out"), "timed out");
        process.exit(1);
    }
    if (args[0] !== "acp") throw new Error("expected ACP command");
    return runAcp(args, home);
}

async function runAcp(args: string[], home: string): Promise<void> {
    if (
        args.includes("-p") ||
        args.includes("--dangerously-skip-permissions") ||
        !args.includes("--process-per-session")
    ) {
        throw new Error("invalid ACP command flags");
    }
    let model = process.env["RUNWIELD_AGY_EXPECTED_MODEL"] || "gemini-3.8-flash";
    let effort = process.env["RUNWIELD_AGY_EXPECTED_EFFORT"] || "low";
    const sessionId = "conversation-" + crypto.randomUUID();
    const input = createInterface({ input: process.stdin });
    const selection = () => ({
        models: { currentModelId: process.env["RUNWIELD_AGY_REPORTED_MODEL"] ?? model + "-" + effort },
        modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] },
        configOptions: [
            { id: "mode", currentValue: "default" },
            { id: "model", currentValue: model },
            { id: "thought_level", currentValue: effort },
        ],
    });
    input.on("line", (line) => {
        const message = JSON.parse(line) as AcpFixturePacket;
        if (typeof message.id === "string" && !message.method) {
            pendingPermissions.get(message.id)?.(message.result?.outcome?.optionId === "allow");
            pendingPermissions.delete(message.id);
            return;
        }
        if (message.method === "session/cancel") {
            if (acp) reply(acp.promptId, { stopReason: "cancelled" });
            return;
        }
        if (typeof message.id !== "number") return;
        const id = message.id;
        switch (message.method) {
            case "initialize":
                reply(id, {
                    protocolVersion: 1,
                    agentCapabilities: {},
                    agentInfo: { name: "Antigravity ACP Server", version: "1.5.12" },
                });
                break;
            case "session/new": {
                const pidPath = process.env["RUNWIELD_AGY_SLEEP_AGENTS_PID"];
                if (pidPath) {
                    void fsWriteFile(pidPath, String(process.pid));
                    break;
                }
                acp = { sessionId, promptId: -1, mcpServers: message.params?.mcpServers ?? [] };
                if (process.env["RUNWIELD_AGY_FAIL_AGENTS"] === "1") process.exit(3);
                reply(id, { sessionId, ...selection() });
                break;
            }
            case "session/set_config_option":
                if (message.params?.configId === "model") model = message.params.value ?? "";
                if (message.params?.configId === "thought_level") effort = message.params.value ?? "";
                reply(id, selection());
                break;
            case "session/prompt":
                if (!acp) throw new Error("prompt before ACP session/new");
                acp.promptId = id;
                void runTurn(
                    args,
                    home,
                    message.params?.prompt?.map((part) => part.text).join("") ?? "",
                    model,
                    effort,
                ).catch((error) => {
                    console.error(error);
                    process.exit(1);
                });
                break;
            case "session/close":
                reply(id, {});
                input.close();
                break;
        }
    });
    await new Promise<void>((resolve) => input.once("close", resolve));
}

async function runTurn(args: string[], home: string, prompt: string, model: string, effort: string): Promise<void> {
    const logPath = process.env["RUNWIELD_AGY_EXECUTION_LOG"] || "";
    const agent = readArg(args, "--agent");
    const reportedModel = process.env["RUNWIELD_AGY_REPORTED_MODEL"] || model + "-" + effort;
    if (!agent || !agent.startsWith("runwield-")) {
        console.error("missing owned agent");
        process.exit(2);
    }
    if (!model || !effort) {
        console.error("missing model or effort");
        process.exit(2);
    }
    const definitionPath = joinPath(home, ".gemini", "config", "agents", agent, "agent.md");
    const definition = await fsReadFile(definitionPath, "utf8");
    if (prompt.includes("RunWield Bridged Tools") || prompt.includes("RunWield system prompt")) {
        console.error("system prompt leaked into user text");
        process.exit(2);
    }
    if (logPath) {
        await fsWriteFile(
            logPath,
            JSON.stringify({ args, prompt, agent, model, effort, definition, sessionId: acp?.sessionId }) + "\n",
            {
                flag: "a",
            },
        );
    }
    await maybeStartDescendant();
    if (process.env["RUNWIELD_AGY_FAIL_TURN"] === "1") process.exit(4);
    await runConfiguredMcp(home);
    if (process.env["RUNWIELD_AGY_FAIL_AFTER_MCP"] === "1") process.exit(5);
    const capturedStream = process.env["RUNWIELD_AGY_CAPTURED_STREAM"];
    if (capturedStream) {
        const stream = await fsReadFile(capturedStream, "utf8");
        for (const line of stream.split("\n").filter(Boolean)) emit(JSON.parse(line) as JsonRecord);
        return;
    }
    if (process.env["RUNWIELD_AGY_MALFORMED_FAIL_WITH_STDERR"] === "1") {
        console.log("{not json}");
        console.error("authentication failed for private account");
        process.exit(7);
    }
    if (process.env["RUNWIELD_AGY_MALFORMED_AUTH_STDERR_ZERO"] === "1") {
        console.log("{not json}");
        console.error("authentication failed for private account");
        return;
    }
    if (process.env["RUNWIELD_AGY_MALFORMED_AFTER_MCP"] === "1") {
        console.log("{not json}");
        return;
    }

    if (acp && prompt.endsWith("USER: fixture-native-summary-permission")) {
        const allowed = await requestPermission("run_command", { toolSummary: "check project" });
        if (allowed) await fsWriteFile(joinPath(getCwd(), "disposable.txt"), "unexpected effect");
        update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: allowed ? "approved" : "denied" },
        });
        reply(acp.promptId, { stopReason: "end_turn" });
        return;
    }

    if (acp && prompt.includes("fixture-native-permission")) {
        const allowed = await requestPermission("write_file", { Path: "disposable.txt", Content: "fixture" });
        if (allowed) await fsWriteFile(joinPath(getCwd(), "disposable.txt"), "fixture");
        update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: allowed ? "approved" : "denied" },
        });
        reply(acp.promptId, { stopReason: "end_turn" });
        return;
    }

    if (acp && prompt.includes("fixture-denied-file-read")) {
        await requestPermission("view_file", { AbsolutePath: joinPath(home, "project", "check.test.js") });
        reply(acp.promptId, { stopReason: "end_turn" });
        return;
    }

    if (process.env["RUNWIELD_AGY_PERMISSION_RESULT"] === "1") {
        emit({
            event: "init",
            conversation_id: "conversation-" + crypto.randomUUID(),
            init: { agent, model: reportedModel },
        });
        emit({
            event: "result",
            result: {
                response: "permission result",
                status: "blocked",
                error: "permission denied by Antigravity",
                usage: { input_tokens: 1, output_tokens: 2 },
            },
        });
        return;
    }

    if (prompt.endsWith("USER: fixture-native-tool-steps")) {
        emit({ event: "init", conversation_id: "native-tools", init: { agent, model: reportedModel } });
        emit({
            event: "step_update",
            step_update: {
                step_index: 2,
                step_type: "tool",
                state: "ACTIVE",
                tool_name: "run_command",
                tool_info: { name: "run_command", parameters: { CommandLine: "pwd" } },
            },
        });
        const release = joinPath(getCwd(), "native-tool-continue");
        for (let attempt = 0; attempt < 500 && !(await fileExists(release)); attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (!(await fileExists(release))) throw new Error("native tool start was not observed before completion");
        emit({
            event: "step_update",
            step_update: {
                step_index: 2,
                step_type: "tool",
                state: "DONE",
                tool_name: "run_command",
                duration_seconds: 0.05,
                tool_info: { name: "run_command", parameters: { CommandLine: "pwd" }, output: "project-root" },
            },
        });
        emit({
            event: "step_update",
            step_update: {
                step_index: 2,
                step_type: "tool",
                state: "DONE",
                tool_name: "run_command",
                tool_info: { name: "run_command", output: "project-root" },
            },
        });
        emit({
            event: "step_update",
            step_update: {
                step_index: 3,
                step_type: "tool",
                state: "ACTIVE",
                tool_name: "view_file",
                tool_info: { name: "view_file", parameters: { AbsolutePath: "README.md" } },
            },
        });
        emit({
            event: "step_update",
            step_update: {
                step_index: 4,
                step_type: "tool",
                state: "ACTIVE",
                tool_name: "write_to_file",
                tool_info: { name: "write_to_file", parameters: { TargetFile: "new.txt" } },
            },
        });
        emit({
            event: "step_update",
            step_update: {
                step_index: 4,
                step_type: "tool",
                state: "ERROR",
                tool_name: "write_to_file",
                tool_info: { name: "write_to_file", output: "permission denied" },
            },
        });
        emit({
            event: "step_update",
            step_update: {
                step_index: 5,
                step_type: "tool",
                state: "ACTIVE",
                tool_name: "manage_task",
                tool_info: { name: "manage_task", parameters: { Action: "status", TaskId: "task-1" } },
            },
        });
        emit({
            event: "step_update",
            step_update: {
                step_index: 5,
                step_type: "tool",
                state: "DONE",
                tool_name: "manage_task",
                tool_info: { name: "manage_task" },
            },
        });
        emit({
            event: "step_update",
            step_update: {
                step_index: 6,
                step_type: "tool",
                state: "ACTIVE",
                tool_name: "call_mcp_tool",
                tool_info: { name: "call_mcp_tool" },
            },
        });
        emit({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "done" } });
        emit({ event: "result", result: { response: "done", usage: { input_tokens: 17, output_tokens: 19 } } });
        return;
    }

    const resultText = prompt.includes("ASSISTANT: agy:first")
        ? "agy:second saw agy:first"
        : "agy:first plan_written task_completed review_complete";
    emit({
        event: "init",
        conversation_id: "conversation-" + crypto.randomUUID(),
        init: { agent, model: reportedModel },
    });
    emit({ event: "step_update", step_update: { update_type: "tool_info", name: "display-only" } });
    emit({ event: "step_update", step_update: { step_type: "agent_response", text_delta: resultText.slice(0, 9) } });
    emit({ event: "step_update", step_update: { step_type: "agent_response", text_delta: resultText.slice(9) } });
    emit({ event: "result", result: { response: resultText, usage: { input_tokens: 17, output_tokens: 19 } } });
}

await main();

async function writeOutput(stream: NodeJS.WriteStream, value: Uint8Array): Promise<void> {
    await new Promise<void>((resolve, reject) => stream.write(value, (error) => (error ? reject(error) : resolve())));
}
