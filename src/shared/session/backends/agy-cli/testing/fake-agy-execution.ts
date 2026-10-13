import { spawnNativeProcess } from "../../../../foreground-process.ts";
import { getHomeDir } from "../../../../../constants.js";
import { getCwd } from "../../../../../constants.js";
import { realpathSync as fsRealpathSync } from "node:fs";
import {
    lstat as fsLstat,
    readdir as fsReaddir,
    readFile as fsReadFile,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import process from "node:process";

interface JsonRecord {
    [key: string]: string | number | boolean | JsonRecord | string[] | JsonRecord[];
}

function readArg(args: string[], flag: string): string {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] || "" : "";
}

function hasArg(args: string[], flag: string): boolean {
    return args.includes(flag);
}

function joinPath(...parts: string[]): string {
    return parts.map((part, index) => {
        const trimmed = index === 0 ? part.replace(/\/+$/, "") : part.replace(/^\/+|\/+$/g, "");
        return trimmed;
    }).filter(Boolean).join("/");
}

async function fileExists(path: string): Promise<boolean> {
    try {
        const info = await fsLstat(path);
        return info.isFile() && !info.isSymbolicLink();
    } catch (error) {
        if ((error instanceof Error && "code" in error && error.code === "ENOENT")) return false;
        throw error;
    }
}

function emit(value: JsonRecord): void {
    console.log(JSON.stringify(value));
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
    const configPath = joinPath(home, ".gemini", "config", "mcp_config.json");
    const settingsPath = joinPath(home, ".gemini", "antigravity-cli", "settings.json");
    const config = JSON.parse(await fsReadFile(configPath, "utf8"));
    const settings = JSON.parse(await fsReadFile(settingsPath, "utf8"));
    if (!settings.permissions?.allow?.includes("mcp(runwield/*)")) {
        throw new Error("missing runwield MCP permission");
    }
    const server = config.mcpServers?.runwield;
    const clientModule = await import("@modelcontextprotocol/sdk/client/index.js");
    const stdioModule = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const transport = new stdioModule.StdioClientTransport({
        command: server.command,
        args: server.args,
        env: {
            ...{ ...process.env },
            HOME: home,
            PATH: process.env["PATH"] || "",
            RUNWIELD_MCP_BRIDGE_URL: process.env["RUNWIELD_MCP_BRIDGE_URL"] || "",
            RUNWIELD_MCP_BRIDGE_TOKEN: process.env["RUNWIELD_MCP_BRIDGE_TOKEN"] || "",
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
    const prompt = readArg(args, "-p");
    const outputFormat = readArg(args, "--output-format");
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
    if (prompt === "/agents" && outputFormat === "json") {
        const sleepAgentsPidPath = process.env["RUNWIELD_AGY_SLEEP_AGENTS_PID"] || "";
        if (sleepAgentsPidPath) {
            await fsWriteFile(sleepAgentsPidPath, String(process.pid));
            setInterval(() => {}, 1000);
            await new Promise(() => {});
        }
        if (process.env["RUNWIELD_AGY_FAIL_AGENTS"] === "1") process.exit(3);
        const agentsRoot = joinPath(home, ".gemini", "config", "agents");
        const agents: JsonRecord[] = [];
        try {
            for await (const entry of await fsReaddir(agentsRoot, { withFileTypes: true })) {
                const definitionPath = joinPath(agentsRoot, entry.name, "agent.md");
                if (entry.isDirectory() && await fileExists(definitionPath)) {
                    const definition = await fsReadFile(definitionPath, "utf8");
                    if (
                        definition.includes("\nname: " + entry.name + "\n") ||
                        definition.startsWith("---\nname: " + entry.name + "\n")
                    ) {
                        agents.push({ name: entry.name });
                    }
                }
            }
        } catch {
            // No agents directory yet.
        }
        console.log(JSON.stringify({ command: { name: "agents", data: { agents } } }));
        return;
    }

    const logPath = process.env["RUNWIELD_AGY_EXECUTION_LOG"] || "";
    const agent = readArg(args, "--agent");
    const model = readArg(args, "--model");
    const effort = readArg(args, "--effort");
    const reportedModel = process.env["RUNWIELD_AGY_REPORTED_MODEL"] || model + "-" + effort;
    if (!agent || !agent.startsWith("runwield-")) {
        console.error("missing owned agent");
        process.exit(2);
    }
    if (!model || !effort) {
        console.error("missing model or effort");
        process.exit(2);
    }
    if (
        fsRealpathSync(readArg(args, "--add-dir")) !== fsRealpathSync(getCwd()) ||
        !hasArg(args, "--disable-slash-commands") || readArg(args, "--print-timeout") !== "24h" ||
        hasArg(args, "--conversation") || hasArg(args, "--continue") || !hasArg(args, "--dangerously-skip-permissions")
    ) {
        console.error("bad flags");
        process.exit(2);
    }
    const definitionPath = joinPath(home, ".gemini", "config", "agents", agent, "agent.md");
    const definition = await fsReadFile(definitionPath, "utf8");
    if (prompt.includes("RunWield Bridged Tools") || prompt.includes("RunWield system prompt")) {
        console.error("system prompt leaked into user text");
        process.exit(2);
    }
    if (logPath) {
        await fsWriteFile(logPath, JSON.stringify({ args, prompt, agent, model, effort, definition }) + "\n", {
            flag: "a",
        });
    }
    await maybeStartDescendant();
    if (process.env["RUNWIELD_AGY_FAIL_TURN"] === "1") process.exit(4);
    await runConfiguredMcp(home);
    if (process.env["RUNWIELD_AGY_FAIL_AFTER_MCP"] === "1") process.exit(5);
    const capturedStream = process.env["RUNWIELD_AGY_CAPTURED_STREAM"];
    if (capturedStream) {
        await writeOutput(process.stdout, new TextEncoder().encode(await fsReadFile(capturedStream, "utf8")));
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

    if (prompt.includes("fixture-denied-file-read")) {
        emit({
            event: "init",
            conversation_id: "denied-file-conversation",
            init: { agent, model: model + "-" + effort },
        });
        emit({
            event: "step_update",
            step_update: {
                step_type: "tool",
                state: "ERROR",
                tool_name: "view_file",
                tool_info: {
                    name: "view_file",
                    parameters: { AbsolutePath: joinPath(home, "project", "check.test.js") },
                    error: { type: "TOOL_ERROR", message: "permission check failed for read_file" },
                },
            },
        });
        emit({
            event: "result",
            result: {
                status: "SUCCESS",
                response: "",
                denied_actions: [{ action: "read_file", display_name: "ViewFile" }],
            },
        });
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

    if (prompt.includes("fixture-native-tool-steps")) {
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
        const release = joinPath(readArg(args, "--add-dir"), "native-tool-continue");
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
    await new Promise<void>((resolve, reject) => stream.write(value, (error) => error ? reject(error) : resolve()));
}
