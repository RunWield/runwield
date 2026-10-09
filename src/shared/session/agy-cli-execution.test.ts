import { createSessionRuntime } from "./session-runtime.ts";
import { RuntimeEventTypes } from "./session-runtime-events.js";
import type { SessionRuntimeEvent } from "./session-runtime-events.js";
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AGENTS, SUBAGENTS } from "../../constants.js";
import { loadPlan } from "../../plan-store.js";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { HostedSession } from "./hosted-session.js";
import { setCustomSetting } from "../settings.js";
import { drainWorkflowMetrics, getWorkflowMetricsFilePath } from "../workflow/metrics.js";
import { installAgyCliMcpSetup } from "./backends/agy-cli/mcp-setup.ts";
import { startMcpIntegration } from "../mcp/integration.ts";
import { getRootSessionBranchEntries } from "./root-session.js";
import { createReplayEvents } from "./session-transcript-projection.js";
import { runActiveAgentTurn } from "./agent-switching.js";
import { listPendingWorkflowToolEvents } from "../workflow/workflow-tool-events.ts";
import { createValidationSessionPort } from "../workflow/validation-session-adapter.ts";
import {
    abortActiveSession,
    composeAgyCliBridgedTools,
    composeClaudeCliBridgedTools,
    ensureRootAgentSession,
    runIsolatedAgentSession,
    runRootTurn,
    steerRootSession,
} from "./session.js";

interface AgyFixtureCall {
    args: string[];
    prompt: string;
    agent: string;
    model: string;
    effort: string;
    definition: string;
}

interface RuntimeEventRecord {
    type?: string;
    agentName?: string;
    delta?: string;
    toolName?: string;
    title?: string;
    output?: string;
    isError?: boolean;
}

interface AgyRootRef {
    kind: "agy-cli";
    session: {
        isStreaming: boolean;
        dispose(): Promise<void>;
    };
}

interface BranchEntryRecord {
    type?: string;
    customType?: string;
    data?: Record<string, unknown>;
    message?: { role?: string };
}

async function removeTempDir(path: string): Promise<void> {
    await Deno.remove(path, { recursive: true }).catch(() => undefined);
}

let standaloneWldProxyPath: Promise<string> | null = null;

async function compileStandaloneWldProxy(): Promise<string> {
    const fixtureDir = await Deno.makeTempDir({ prefix: "runwield-standalone-wld-proxy-" });
    const sourcePath = join(fixtureDir, "wld-proxy.ts");
    const outputPath = join(fixtureDir, "wld");
    await Deno.writeTextFile(
        sourcePath,
        `const child = new Deno.Command(${JSON.stringify(Deno.execPath())}, {\n` +
            `    args: ["run", "-A", "--unstable-no-legacy-abort", ${
                JSON.stringify(join(Deno.cwd(), "src", "cli.ts"))
            }, ...Deno.args],\n` +
            `    stdin: "piped",\n` +
            `    stdout: "piped",\n` +
            `    stderr: "piped",\n` +
            `    env: Deno.env.toObject(),\n` +
            `});\n` +
            `const process = child.spawn();\n` +
            `const stdinDone = Deno.stdin.readable.pipeTo(process.stdin).catch(() => undefined);\n` +
            `const stdoutDone = process.stdout.pipeTo(Deno.stdout.writable, { preventClose: true }).catch(() => undefined);\n` +
            `const stderrDone = process.stderr.pipeTo(Deno.stderr.writable, { preventClose: true }).catch(() => undefined);\n` +
            `const status = await process.status;\n` +
            `await Promise.all([stdinDone, stdoutDone, stderrDone]);\n` +
            `Deno.exit(status.code);\n`,
    );
    const output = await new Deno.Command(Deno.execPath(), {
        args: ["compile", "--output", outputPath, "-A", "--no-check", "--unstable-no-legacy-abort", sourcePath],
        stdout: "null",
        stderr: "piped",
    }).output();
    if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
    return outputPath;
}

function getStandaloneWldProxyPath(): Promise<string> {
    if (!standaloneWldProxyPath) standaloneWldProxyPath = compileStandaloneWldProxy();
    return standaloneWldProxyPath;
}

function processAlive(pid: number): boolean {
    try {
        Deno.kill(pid, "SIGCONT");
    } catch {
        return false;
    }
    if (Deno.build.os === "windows") return true;
    try {
        const command = new Deno.Command("ps", {
            args: ["-o", "stat=", "-p", String(pid)],
            stdout: "piped",
            stderr: "null",
        });
        const { success, stdout } = command.outputSync();
        if (!success) return false;
        const state = new TextDecoder().decode(stdout).trim();
        return !state.startsWith("Z");
    } catch {
        return true;
    }
}

async function waitForProcessDeath(pid: number, timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!processAlive(pid)) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return !processAlive(pid);
}

async function installAgyExecutionFixture(binDir: string, logPath: string): Promise<void> {
    await Deno.mkdir(binDir, { recursive: true });
    const fixturePath = join(binDir, "fake-agy-execution.ts");
    const fixtureSource = String.raw`
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
        const info = await Deno.lstat(path);
        return info.isFile && !info.isSymlink;
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
    }
}

function emit(value: JsonRecord): void {
    console.log(JSON.stringify(value));
}

async function maybeStartDescendant(): Promise<void> {
    const pidPath = Deno.env.get("RUNWIELD_AGY_DESCENDANT_PID") || "";
    if (!pidPath) return;
    const holdsPipes = Deno.env.get("RUNWIELD_AGY_DESCENDANT_HOLDS_PIPES") === "1";
    const shell = new Deno.Command("sh", {
        args: ["-c", "sleep 30 & echo $! > " + pidPath + "; exit 0"],
        stdin: "null",
        stdout: holdsPipes ? "inherit" : "null",
        stderr: holdsPipes ? "inherit" : "null",
    }).spawn();
    await shell.status;
}

async function runConfiguredMcp(home: string): Promise<void> {
    const callsPath = Deno.env.get("RUNWIELD_AGY_EXECUTION_MCP_CALLS") || "";
    if (!callsPath) return;
    const configPath = joinPath(home, ".gemini", "config", "mcp_config.json");
    const settingsPath = joinPath(home, ".gemini", "antigravity-cli", "settings.json");
    const config = JSON.parse(await Deno.readTextFile(configPath));
    const settings = JSON.parse(await Deno.readTextFile(settingsPath));
    if (!settings.permissions?.allow?.includes("mcp(runwield/*)")) {
        throw new Error("missing runwield MCP permission");
    }
    const server = config.mcpServers?.runwield;
    const clientModule = await import("npm:@modelcontextprotocol/sdk@^1.30.0/client/index.js");
    const stdioModule = await import("npm:@modelcontextprotocol/sdk@^1.30.0/client/stdio.js");
    const transport = new stdioModule.StdioClientTransport({
        command: server.command,
        args: server.args,
        env: {
            ...Deno.env.toObject(),
            HOME: home,
            PATH: Deno.env.get("PATH") || "",
            RUNWIELD_MCP_BRIDGE_URL: Deno.env.get("RUNWIELD_MCP_BRIDGE_URL") || "",
            RUNWIELD_MCP_BRIDGE_TOKEN: Deno.env.get("RUNWIELD_MCP_BRIDGE_TOKEN") || "",
        },
        stderr: "pipe",
    });
    const client = new clientModule.Client({ name: "runwield-agy-fixture", version: "1.0.0" });
    try {
        await client.connect(transport);
        const listed = await client.listTools();
        const logPath = Deno.env.get("RUNWIELD_AGY_EXECUTION_LOG") || "";
        if (logPath) await Deno.writeTextFile(logPath, JSON.stringify({ mcp: { tools: listed.tools.map((tool: { name: string }) => tool.name) } }) + "\n", { append: true, create: true });
        const calls = JSON.parse(await Deno.readTextFile(callsPath));
        const results = [];
        for (const call of calls) {
            const result = await client.callTool({ name: call.name, arguments: call.arguments || {} });
            results.push({ name: call.name, isError: result.isError === true });
        }
        if (logPath) await Deno.writeTextFile(logPath, JSON.stringify({ mcp: { calls: results } }) + "\n", { append: true, create: true });
    } finally {
        await client.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
    }
}

async function main(): Promise<void> {
    const args = Deno.args;
    const home = Deno.env.get("HOME") || "";
    const prompt = readArg(args, "-p");
    const outputFormat = readArg(args, "--output-format");
    if (prompt === "/agents" && outputFormat === "json") {
        const sleepAgentsPidPath = Deno.env.get("RUNWIELD_AGY_SLEEP_AGENTS_PID") || "";
        if (sleepAgentsPidPath) {
            await Deno.writeTextFile(sleepAgentsPidPath, String(Deno.pid));
            setInterval(() => {}, 1000);
            await new Promise(() => {});
        }
        if (Deno.env.get("RUNWIELD_AGY_FAIL_AGENTS") === "1") Deno.exit(3);
        const agentsRoot = joinPath(home, ".gemini", "config", "agents");
        const agents: JsonRecord[] = [];
        try {
            for await (const entry of Deno.readDir(agentsRoot)) {
                const definitionPath = joinPath(agentsRoot, entry.name, "agent.md");
                if (entry.isDirectory && await fileExists(definitionPath)) {
                    const definition = await Deno.readTextFile(definitionPath);
                    if (definition.includes("\nname: " + entry.name + "\n") || definition.startsWith("---\nname: " + entry.name + "\n")) {
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

    const logPath = Deno.env.get("RUNWIELD_AGY_EXECUTION_LOG") || "";
    const agent = readArg(args, "--agent");
    const model = readArg(args, "--model");
    const effort = readArg(args, "--effort");
    const reportedModel = Deno.env.get("RUNWIELD_AGY_REPORTED_MODEL") || model + "-" + effort;
    if (!agent || !agent.startsWith("runwield-")) {
        console.error("missing owned agent");
        Deno.exit(2);
    }
    if (!model || !effort) {
        console.error("missing model or effort");
        Deno.exit(2);
    }
    if (Deno.realPathSync(readArg(args, "--add-dir")) !== Deno.realPathSync(Deno.cwd()) || !hasArg(args, "--disable-slash-commands") || readArg(args, "--print-timeout") !== "24h" || hasArg(args, "--conversation") || hasArg(args, "--continue") || !hasArg(args, "--dangerously-skip-permissions")) {
        console.error("bad flags");
        Deno.exit(2);
    }
    const definitionPath = joinPath(home, ".gemini", "config", "agents", agent, "agent.md");
    const definition = await Deno.readTextFile(definitionPath);
    if (prompt.includes("RunWield Bridged Tools") || prompt.includes("RunWield system prompt")) {
        console.error("system prompt leaked into user text");
        Deno.exit(2);
    }
    if (logPath) await Deno.writeTextFile(logPath, JSON.stringify({ args, prompt, agent, model, effort, definition }) + "\n", { append: true, create: true });
    await maybeStartDescendant();
    if (Deno.env.get("RUNWIELD_AGY_FAIL_TURN") === "1") Deno.exit(4);
    await runConfiguredMcp(home);
    if (Deno.env.get("RUNWIELD_AGY_FAIL_AFTER_MCP") === "1") Deno.exit(5);
    const capturedStream = Deno.env.get("RUNWIELD_AGY_CAPTURED_STREAM");
    if (capturedStream) {
        await Deno.stdout.write(new TextEncoder().encode(await Deno.readTextFile(capturedStream)));
        return;
    }
    if (Deno.env.get("RUNWIELD_AGY_MALFORMED_FAIL_WITH_STDERR") === "1") {
        console.log("{not json}");
        console.error("authentication failed for private account");
        Deno.exit(7);
    }
    if (Deno.env.get("RUNWIELD_AGY_MALFORMED_AUTH_STDERR_ZERO") === "1") {
        console.log("{not json}");
        console.error("authentication failed for private account");
        return;
    }
    if (Deno.env.get("RUNWIELD_AGY_MALFORMED_AFTER_MCP") === "1") {
        console.log("{not json}");
        return;
    }

    if (prompt.includes("fixture-denied-file-read")) {
        emit({ event: "init", conversation_id: "denied-file-conversation", init: { agent, model: model + "-" + effort } });
        emit({ event: "step_update", step_update: {
            step_type: "tool", state: "ERROR", tool_name: "view_file", tool_info: {
                name: "view_file", parameters: { AbsolutePath: joinPath(home, "project", "check.test.js") },
                error: { type: "TOOL_ERROR", message: "permission check failed for read_file" },
            },
        } });
        emit({ event: "result", result: {
            status: "SUCCESS", response: "", denied_actions: [{ action: "read_file", display_name: "ViewFile" }],
        } });
        return;
    }
    if (Deno.env.get("RUNWIELD_AGY_PERMISSION_RESULT") === "1") {
        emit({ event: "init", conversation_id: "conversation-" + crypto.randomUUID(), init: { agent, model: reportedModel } });
        emit({ event: "result", result: { response: "permission result", status: "blocked", error: "permission denied by Antigravity", usage: { input_tokens: 1, output_tokens: 2 } } });
        return;
    }

    if (prompt.includes("fixture-native-tool-steps")) {
        emit({ event: "init", conversation_id: "native-tools", init: { agent, model: reportedModel } });
        emit({ event: "step_update", step_update: { step_index: 2, step_type: "tool", state: "ACTIVE",
            tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "pwd" } } } });
        const release = joinPath(readArg(args, "--add-dir"), "native-tool-continue");
        for (let attempt = 0; attempt < 500 && !(await fileExists(release)); attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (!(await fileExists(release))) throw new Error("native tool start was not observed before completion");
        emit({ event: "step_update", step_update: { step_index: 2, step_type: "tool", state: "DONE",
            tool_name: "run_command", duration_seconds: 0.05,
            tool_info: { name: "run_command", parameters: { CommandLine: "pwd" }, output: "project-root" } } });
        emit({ event: "step_update", step_update: { step_index: 2, step_type: "tool", state: "DONE",
            tool_name: "run_command", tool_info: { name: "run_command", output: "project-root" } } });
        emit({ event: "step_update", step_update: { step_index: 3, step_type: "tool", state: "ACTIVE",
            tool_name: "view_file", tool_info: { name: "view_file", parameters: { AbsolutePath: "README.md" } } } });
        emit({ event: "step_update", step_update: { step_index: 4, step_type: "tool", state: "ACTIVE",
            tool_name: "write_to_file", tool_info: { name: "write_to_file", parameters: { TargetFile: "new.txt" } } } });
        emit({ event: "step_update", step_update: { step_index: 4, step_type: "tool", state: "ERROR",
            tool_name: "write_to_file", tool_info: { name: "write_to_file", output: "permission denied" } } });
        emit({ event: "step_update", step_update: { step_index: 5, step_type: "tool", state: "ACTIVE",
            tool_name: "manage_task", tool_info: { name: "manage_task", parameters: { Action: "status", TaskId: "task-1" } } } });
        emit({ event: "step_update", step_update: { step_index: 5, step_type: "tool", state: "DONE",
            tool_name: "manage_task", tool_info: { name: "manage_task" } } });
        emit({ event: "step_update", step_update: { step_index: 6, step_type: "tool", state: "ACTIVE",
            tool_name: "call_mcp_tool", tool_info: { name: "call_mcp_tool" } } });
        emit({ event: "result", result: { response: "done", usage: { input_tokens: 17, output_tokens: 19 } } });
        return;
    }

    const resultText = prompt.includes("ASSISTANT: agy:first")
        ? "agy:second saw agy:first"
        : "agy:first plan_written task_completed review_complete";
    emit({ event: "init", conversation_id: "conversation-" + crypto.randomUUID(), init: { agent, model: reportedModel } });
    emit({ event: "step_update", step_update: { update_type: "tool_info", name: "display-only" } });
    emit({ event: "step_update", step_update: { step_type: "agent_response", text_delta: resultText.slice(0, 9) } });
    emit({ event: "step_update", step_update: { step_type: "agent_response", text_delta: resultText.slice(9) } });
    emit({ event: "result", result: { response: resultText, usage: { input_tokens: 17, output_tokens: 19 } } });
}

await main();
`;
    await Deno.writeTextFile(fixturePath, fixtureSource);
    const agyPath = join(binDir, "agy");
    await Deno.writeTextFile(agyPath, `#!/bin/sh\nexec deno run -A ${JSON.stringify(fixturePath)} "$@"\n`);
    await Deno.chmod(agyPath, 0o755);
    const wldPath = join(binDir, "wld");
    await Deno.copyFile(await getStandaloneWldProxyPath(), wldPath);
    await Deno.chmod(wldPath, 0o755);
    await Deno.writeTextFile(logPath, "");
}

async function withAgyExecutionFixture(
    callback: (home: string, cwd: string, logPath: string) => Promise<void>,
): Promise<void> {
    await withProcessGlobalTestLock(async () => {
        const previousHome = Deno.env.get("HOME");
        const previousPath = Deno.env.get("PATH");
        const previousLog = Deno.env.get("RUNWIELD_AGY_EXECUTION_LOG");
        const previousExpectedModel = Deno.env.get("RUNWIELD_AGY_EXPECTED_MODEL");
        const previousExpectedEffort = Deno.env.get("RUNWIELD_AGY_EXPECTED_EFFORT");
        const previousReportedModel = Deno.env.get("RUNWIELD_AGY_REPORTED_MODEL");
        const previousFailAgents = Deno.env.get("RUNWIELD_AGY_FAIL_AGENTS");
        const previousFailTurn = Deno.env.get("RUNWIELD_AGY_FAIL_TURN");
        const previousFailAfterMcp = Deno.env.get("RUNWIELD_AGY_FAIL_AFTER_MCP");
        const previousMalformedAfterMcp = Deno.env.get("RUNWIELD_AGY_MALFORMED_AFTER_MCP");
        const previousMalformedFailWithStderr = Deno.env.get("RUNWIELD_AGY_MALFORMED_FAIL_WITH_STDERR");
        const previousMalformedAuthStderrZero = Deno.env.get("RUNWIELD_AGY_MALFORMED_AUTH_STDERR_ZERO");
        const previousPermissionResult = Deno.env.get("RUNWIELD_AGY_PERMISSION_RESULT");
        const previousSleepAgentsPid = Deno.env.get("RUNWIELD_AGY_SLEEP_AGENTS_PID");
        const previousDescendantPid = Deno.env.get("RUNWIELD_AGY_DESCENDANT_PID");
        const previousDescendantHoldsPipes = Deno.env.get("RUNWIELD_AGY_DESCENDANT_HOLDS_PIPES");
        const previousMcpCalls = Deno.env.get("RUNWIELD_AGY_EXECUTION_MCP_CALLS");
        const previousCapturedStream = Deno.env.get("RUNWIELD_AGY_CAPTURED_STREAM");
        const home = await Deno.makeTempDir({ prefix: "runwield-agy-exec-home-" });
        const cwd = join(home, "project");
        const binDir = join(home, "bin");
        const logPath = join(home, "agy-log.jsonl");
        try {
            await Deno.mkdir(cwd, { recursive: true });
            await installAgyExecutionFixture(binDir, logPath);
            Deno.env.set("HOME", home);
            Deno.env.set("PATH", `${binDir}:${previousPath || ""}`);
            Deno.env.set("RUNWIELD_AGY_EXECUTION_LOG", logPath);
            Deno.env.set("RUNWIELD_AGY_EXPECTED_MODEL", "gemini-3.8-flash");
            Deno.env.set("RUNWIELD_AGY_EXPECTED_EFFORT", "low");
            Deno.env.delete("RUNWIELD_AGY_REPORTED_MODEL");
            Deno.env.delete("RUNWIELD_AGY_FAIL_AGENTS");
            Deno.env.delete("RUNWIELD_AGY_FAIL_TURN");
            Deno.env.delete("RUNWIELD_AGY_FAIL_AFTER_MCP");
            Deno.env.delete("RUNWIELD_AGY_MALFORMED_AFTER_MCP");
            Deno.env.delete("RUNWIELD_AGY_MALFORMED_FAIL_WITH_STDERR");
            Deno.env.delete("RUNWIELD_AGY_MALFORMED_AUTH_STDERR_ZERO");
            Deno.env.delete("RUNWIELD_AGY_PERMISSION_RESULT");
            Deno.env.delete("RUNWIELD_AGY_SLEEP_AGENTS_PID");
            Deno.env.delete("RUNWIELD_AGY_DESCENDANT_PID");
            Deno.env.delete("RUNWIELD_AGY_DESCENDANT_HOLDS_PIPES");
            Deno.env.delete("RUNWIELD_AGY_EXECUTION_MCP_CALLS");
            Deno.env.delete("RUNWIELD_AGY_CAPTURED_STREAM");
            await installAgyCliMcpSetup();
            await callback(home, cwd, logPath);
        } finally {
            if (previousHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", previousHome);
            if (previousPath === undefined) Deno.env.delete("PATH");
            else Deno.env.set("PATH", previousPath);
            if (previousLog === undefined) Deno.env.delete("RUNWIELD_AGY_EXECUTION_LOG");
            else Deno.env.set("RUNWIELD_AGY_EXECUTION_LOG", previousLog);
            if (previousExpectedModel === undefined) Deno.env.delete("RUNWIELD_AGY_EXPECTED_MODEL");
            else Deno.env.set("RUNWIELD_AGY_EXPECTED_MODEL", previousExpectedModel);
            if (previousExpectedEffort === undefined) Deno.env.delete("RUNWIELD_AGY_EXPECTED_EFFORT");
            else Deno.env.set("RUNWIELD_AGY_EXPECTED_EFFORT", previousExpectedEffort);
            if (previousReportedModel === undefined) Deno.env.delete("RUNWIELD_AGY_REPORTED_MODEL");
            else Deno.env.set("RUNWIELD_AGY_REPORTED_MODEL", previousReportedModel);
            if (previousFailAgents === undefined) Deno.env.delete("RUNWIELD_AGY_FAIL_AGENTS");
            else Deno.env.set("RUNWIELD_AGY_FAIL_AGENTS", previousFailAgents);
            if (previousFailTurn === undefined) Deno.env.delete("RUNWIELD_AGY_FAIL_TURN");
            else Deno.env.set("RUNWIELD_AGY_FAIL_TURN", previousFailTurn);
            if (previousFailAfterMcp === undefined) Deno.env.delete("RUNWIELD_AGY_FAIL_AFTER_MCP");
            else Deno.env.set("RUNWIELD_AGY_FAIL_AFTER_MCP", previousFailAfterMcp);
            if (previousMalformedAfterMcp === undefined) Deno.env.delete("RUNWIELD_AGY_MALFORMED_AFTER_MCP");
            else Deno.env.set("RUNWIELD_AGY_MALFORMED_AFTER_MCP", previousMalformedAfterMcp);
            if (previousMalformedFailWithStderr === undefined) {
                Deno.env.delete("RUNWIELD_AGY_MALFORMED_FAIL_WITH_STDERR");
            } else Deno.env.set("RUNWIELD_AGY_MALFORMED_FAIL_WITH_STDERR", previousMalformedFailWithStderr);
            if (previousMalformedAuthStderrZero === undefined) {
                Deno.env.delete("RUNWIELD_AGY_MALFORMED_AUTH_STDERR_ZERO");
            } else Deno.env.set("RUNWIELD_AGY_MALFORMED_AUTH_STDERR_ZERO", previousMalformedAuthStderrZero);
            if (previousPermissionResult === undefined) Deno.env.delete("RUNWIELD_AGY_PERMISSION_RESULT");
            else Deno.env.set("RUNWIELD_AGY_PERMISSION_RESULT", previousPermissionResult);
            if (previousSleepAgentsPid === undefined) Deno.env.delete("RUNWIELD_AGY_SLEEP_AGENTS_PID");
            else Deno.env.set("RUNWIELD_AGY_SLEEP_AGENTS_PID", previousSleepAgentsPid);
            if (previousDescendantPid === undefined) Deno.env.delete("RUNWIELD_AGY_DESCENDANT_PID");
            else Deno.env.set("RUNWIELD_AGY_DESCENDANT_PID", previousDescendantPid);
            if (previousDescendantHoldsPipes === undefined) Deno.env.delete("RUNWIELD_AGY_DESCENDANT_HOLDS_PIPES");
            else Deno.env.set("RUNWIELD_AGY_DESCENDANT_HOLDS_PIPES", previousDescendantHoldsPipes);
            if (previousMcpCalls === undefined) Deno.env.delete("RUNWIELD_AGY_EXECUTION_MCP_CALLS");
            else Deno.env.set("RUNWIELD_AGY_EXECUTION_MCP_CALLS", previousMcpCalls);
            if (previousCapturedStream === undefined) Deno.env.delete("RUNWIELD_AGY_CAPTURED_STREAM");
            else Deno.env.set("RUNWIELD_AGY_CAPTURED_STREAM", previousCapturedStream);
            await removeTempDir(home);
        }
    });
}

function createHostedSession(cwd: string, manager: SessionManager, events: RuntimeEventRecord[] = []): HostedSession {
    const hostedSession = new HostedSession({
        id: `hosted-${crypto.randomUUID()}`,
        cwd,
        sessionManager: manager as never,
        eventSink: (event: RuntimeEventRecord) => events.push(event),
    });
    hostedSession.setActiveModelState("gemini-3.8-flash", "agy-cli", true);
    return hostedSession;
}

async function readCalls(logPath: string): Promise<AgyFixtureCall[]> {
    const text = await Deno.readTextFile(logPath);
    return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as AgyFixtureCall);
}

function expectedAgyEffort(modelId: string, thinkingLevel: string): string {
    if (thinkingLevel === "off" || thinkingLevel === "minimal" || thinkingLevel === "low") return "low";
    if (thinkingLevel === "medium") return modelId === "gemini-3.1-pro" ? "high" : "medium";
    return "high";
}

async function assertNoTemporaryAgents(home: string): Promise<void> {
    const agentsRoot = join(home, ".gemini", "config", "agents");
    const names: string[] = [];
    try {
        for await (const entry of Deno.readDir(agentsRoot)) names.push(entry.name);
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return;
        throw error;
    }
    assertEquals(names.filter((name) => name.startsWith("runwield-")).length, 0);
}

Deno.test("Agy bridged tool composition matches Claude CLI", async () => {
    const cwd = await Deno.makeTempDir({ prefix: "runwield-agy-compose-" });
    try {
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        const agentDef = {
            displayName: "Engineer",
            tools: ["task_completed", "memory", "code_search", "web_search"],
        } as never;

        const agyTools = await composeAgyCliBridgedTools({
            agentDef,
            agentName: AGENTS.ENGINEER,
            hostedSession,
            triageMeta: undefined,
            cwd,
        });
        const claudeTools = await composeClaudeCliBridgedTools({
            agentDef,
            agentName: AGENTS.ENGINEER,
            hostedSession,
            triageMeta: undefined,
            cwd,
        });
        assertEquals(agyTools.map((tool) => tool.name), claudeTools.map((tool) => tool.name));
        assertEquals(agyTools.map((tool) => tool.name).includes("task_completed"), true);
        assertEquals(agyTools.map((tool) => tool.name).includes("memory"), true);
        assertEquals(agyTools.map((tool) => tool.name).includes("code_search"), true);
        assertEquals(agyTools.map((tool) => tool.name).includes("web_search"), true);
    } finally {
        await Deno.remove(cwd, { recursive: true }).catch(() => undefined);
    }
});

Deno.test("Agy roots discover initially empty MCP tools and refresh without recreating the native agent", async () => {
    await withAgyExecutionFixture(async (_home, cwd, logPath) => {
        const hosted = createHostedSession(cwd, SessionManager.inMemory(cwd));
        const externalLog = join(cwd, "external-mcp.jsonl");
        const toolsPath = join(cwd, "external-mcp-tools.txt");
        await Deno.writeTextFile(toolsPath, "");
        const { integration } = await startMcpIntegration({
            cwd,
            servers: [{
                name: "fixture",
                command: Deno.execPath(),
                args: ["run", "-A", new URL("../mcp/fixture-server.ts", import.meta.url).pathname],
                env: { RUNWIELD_MCP_FIXTURE_LOG: externalLog, RUNWIELD_MCP_FIXTURE_TOOLS_PATH: toolsPath },
                source: "request",
            }],
        });
        await hosted.setMcpIntegration(integration);
        assertEquals(integration.getTools(), []);
        const calls = join(cwd, "mcp-calls.json");
        Deno.env.set("RUNWIELD_AGY_EXECUTION_MCP_CALLS", calls);
        try {
            const root = await ensureRootAgentSession({
                hostedSession: hosted,
                agentName: AGENTS.GUIDE,
                mcpRootTools: integration.getTools(),
                mcpIntegration: integration,
            });
            await Deno.writeTextFile(toolsPath, "fixture_echo");
            const discoveryDeadline = Date.now() + 5_000;
            while (integration.getTools().length === 0 && Date.now() < discoveryDeadline) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assertEquals(integration.getTools().length, 1);
            await Deno.writeTextFile(
                calls,
                JSON.stringify([
                    { name: "mcp__fixture__fixture_echo", arguments: { marker: "change-tools" } },
                ]),
            );
            await runRootTurn({ hostedSession: hosted, agentName: AGENTS.GUIDE, userRequest: "change server tools" });
            const deadline = Date.now() + 5_000;
            while (integration.getTools()[0]?.name !== "mcp__fixture__replacement" && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            await Deno.writeTextFile(
                calls,
                JSON.stringify([
                    { name: "mcp__fixture__replacement", arguments: { marker: "agy-next-turn" } },
                ]),
            );
            await runRootTurn({ hostedSession: hosted, agentName: AGENTS.GUIDE, userRequest: "call replacement" });
            assertEquals(hosted.getRootAgentSession(), root);
            const listed = (await Deno.readTextFile(logPath)).trim().split("\n")
                .filter((line) => line.includes('"mcp":{"tools"')).at(-1) || "";
            assertStringIncludes(listed, "mcp__fixture__replacement");
            assertEquals(listed.includes("mcp__fixture__fixture_echo"), false);
            assertStringIncludes(await Deno.readTextFile(externalLog), '"marker":"agy-next-turn"');
        } finally {
            await hosted.dispose();
        }
    });
});

Deno.test("Agy maps every RunWield thinking level to the verified backend model", async () => {
    await withAgyExecutionFixture(async (home, cwd, logPath) => {
        const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
        const modelIds = ["gemini-3.8-flash", "gemini-3.1-pro"];
        for (const modelId of modelIds) {
            for (const thinkingLevel of thinkingLevels) {
                const effort = expectedAgyEffort(modelId, thinkingLevel);
                Deno.env.set("RUNWIELD_AGY_EXPECTED_MODEL", modelId);
                Deno.env.set("RUNWIELD_AGY_EXPECTED_EFFORT", effort);
                await Deno.writeTextFile(logPath, "");
                const manager = SessionManager.inMemory(cwd);
                const hostedSession = createHostedSession(cwd, manager);
                const messages = await runIsolatedAgentSession({
                    hostedSession,
                    agentName: AGENTS.GUIDE,
                    userRequest: `mapping ${modelId} ${thinkingLevel}`,
                    modelOverride: `agy-cli/${modelId}`,
                    thinkingLevelOverride: thinkingLevel as
                        | "off"
                        | "minimal"
                        | "low"
                        | "medium"
                        | "high"
                        | "xhigh"
                        | "max",
                    sessionManager: manager,
                    ignoreManualModelOverride: true,
                });

                const calls = await readCalls(logPath);
                assertEquals(calls.length, 1);
                assertEquals(calls[0].model, modelId);
                assertEquals(calls[0].effort, effort);
                assertEquals(calls[0].args.filter((arg) => arg === "--model").length, 1);
                assertEquals(calls[0].args.filter((arg) => arg === "--effort").length, 1);
                assertEquals(messages.filter((message) => message.role === "assistant").length, 1);

                const branch = getRootSessionBranchEntries(manager) as BranchEntryRecord[];
                const branchText = JSON.stringify(branch);
                assertStringIncludes(branchText, `"model":"${modelId}"`);
                assertStringIncludes(branchText, `"thinkingLevel":"${thinkingLevel}"`);
                assertStringIncludes(branchText, `"effort":"${effort}"`);
                assertStringIncludes(branchText, `"backendModel":"${modelId}-${effort}"`);
                assertStringIncludes(branchText, `"modelId":"${modelId}"`);
                await assertNoTemporaryAgents(home);
            }
        }
    });
});

Deno.test("Agy CLI prompt replay preserves RunWield tool history", async () => {
    await withAgyExecutionFixture(async (_home, cwd, logPath) => {
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        manager.appendMessage({
            role: "assistant",
            timestamp: Date.now(),
            content: [{
                type: "toolCall",
                id: "tool-call-1",
                name: "task_completed",
                arguments: { message: "tool-call-marker" },
            }],
            api: "anthropic",
            provider: "agy-cli",
            model: "gemini-3.8-flash",
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
        } as never);
        manager.appendMessage({
            role: "toolResult",
            timestamp: Date.now(),
            toolCallId: "tool-call-1",
            toolName: "task_completed",
            content: [{ type: "text", text: "tool-result-marker" }],
            isError: false,
        } as never);

        const root = await ensureRootAgentSession({ hostedSession, agentName: AGENTS.GUIDE }) as never as AgyRootRef;
        await runRootTurn({ hostedSession, agentName: AGENTS.GUIDE, userRequest: "after tool history" });

        const calls = await readCalls(logPath);
        assertStringIncludes(calls[0].prompt, "Tool call task_completed");
        assertStringIncludes(calls[0].prompt, "tool-call-marker");
        assertStringIncludes(calls[0].prompt, "Tool result task_completed");
        assertStringIncludes(calls[0].prompt, "tool-result-marker");
        await root.session.dispose();
    });
});

Deno.test("Agy native tool steps reach the live Session and transcript without completing an unfinished tool", async () => {
    await withAgyExecutionFixture(async (_home, cwd) => {
        const manager = SessionManager.inMemory(cwd);
        const events: RuntimeEventRecord[] = [];
        const hostedSession = createHostedSession(cwd, manager, events);
        const root = await ensureRootAgentSession({ hostedSession, agentName: AGENTS.GUIDE }) as never as AgyRootRef;
        try {
            const turn = runRootTurn({
                hostedSession,
                agentName: AGENTS.GUIDE,
                userRequest: "fixture-native-tool-steps",
            });
            try {
                for (
                    let attempt = 0;
                    attempt < 500 &&
                    !events.some((event) =>
                        event.type === RuntimeEventTypes.TOOL_START && event.toolName === "run_command"
                    );
                    attempt++
                ) await new Promise((resolve) => setTimeout(resolve, 10));
                assertEquals(
                    events.some((event) =>
                        event.type === RuntimeEventTypes.TOOL_START && event.toolName === "run_command"
                    ),
                    true,
                );
                assertEquals(events.some((event) => event.type === RuntimeEventTypes.TOOL_END), false);
            } finally {
                await Deno.writeTextFile(join(cwd, "native-tool-continue"), "continue");
            }
            await turn;
            const native = events.filter((event) =>
                event.type === RuntimeEventTypes.TOOL_START || event.type === RuntimeEventTypes.TOOL_END
            );
            assertEquals(native.map((event) => [event.type, event.toolName, event.output]), [
                [RuntimeEventTypes.TOOL_START, "run_command", undefined],
                [RuntimeEventTypes.TOOL_END, "run_command", "project-root"],
                [RuntimeEventTypes.TOOL_START, "view_file", undefined],
                [RuntimeEventTypes.TOOL_START, "write_to_file", undefined],
                [RuntimeEventTypes.TOOL_END, "write_to_file", "permission denied"],
                [RuntimeEventTypes.TOOL_START, "manage_task", undefined],
                [RuntimeEventTypes.TOOL_END, "manage_task", ""],
            ]);
            assertEquals(events.filter((event) => event.toolName === "run_command").map((event) => event.title), [
                "run_command pwd",
                "run_command pwd",
            ]);
            assertEquals(events.filter((event) => event.toolName === "view_file").map((event) => event.title), [
                "view_file README.md",
            ]);
            assertEquals(events.filter((event) => event.toolName === "write_to_file").map((event) => event.title), [
                "write_to_file new.txt",
                "write_to_file new.txt",
            ]);
            assertEquals(events.filter((event) => event.toolName === "manage_task").map((event) => event.title), [
                "manage_task status task-1",
                "manage_task status task-1",
            ]);
            assertEquals(
                events.find((event) =>
                    event.toolName === "write_to_file" &&
                    event.type === RuntimeEventTypes.TOOL_END
                )?.isError,
                true,
            );
            const entries = getRootSessionBranchEntries(manager);
            const branch = JSON.stringify(entries);
            assertStringIncludes(branch, "project-root");
            assertEquals(branch.includes('"name":"view_file"'), false);
            assertEquals(branch.includes('"name":"call_mcp_tool"'), false);
            const replay = createReplayEvents("fixture-session", entries);
            assertEquals(
                replay.filter((event) => event.type === RuntimeEventTypes.TOOL_START).map((event) => event.title),
                [
                    "run_command pwd",
                    "write_to_file new.txt",
                    "manage_task status task-1",
                ],
            );
            assertEquals(replay.some((event) => event.toolName === "view_file"), false);
        } finally {
            await root.session.dispose();
        }
    });
});

Deno.test("captured Antigravity CLI 1.2.12 tool stream reaches the execution owner's JSONL", async () => {
    await withAgyExecutionFixture(async (_home, cwd) => {
        await setCustomSetting("workflowMetrics", true, "project", cwd);
        Deno.env.set(
            "RUNWIELD_AGY_CAPTURED_STREAM",
            new URL("./backends/agy-cli/fixtures/agy-1.2.12-model-read-tool-stream.jsonl", import.meta.url).pathname,
        );
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        try {
            await ensureRootAgentSession({ hostedSession, agentName: AGENTS.GUIDE });
            await runRootTurn({
                hostedSession,
                agentName: AGENTS.GUIDE,
                userRequest: "Read the disposable file.",
                dispatchKind: "quick_fix",
            });
            await drainWorkflowMetrics();
            const rows = (await Deno.readTextFile(getWorkflowMetricsFilePath(cwd))).trim().split("\n")
                .map((line) => JSON.parse(line));
            assertEquals(rows.find((row) => row.event === "execution_started")?.dispatchKind, "quick_fix");
            const native = rows.filter((row) => row.event === "native_tool_observed");
            assertEquals(native.map((row) => [row.toolName, row.stepIndex]), [["view_file", 2]]);
            assertEquals(
                rows.some((row) =>
                    row.event === "model_usage" && row.inputTokens === 31817 &&
                    row.outputTokens === 320
                ),
                true,
            );
            assertEquals(JSON.stringify(rows).includes("readme.txt"), false);
        } finally {
            hostedSession.dispose();
        }
    });
});

Deno.test("Agy failed stream keeps observed terminal cache usage in execution metrics", async () => {
    await withAgyExecutionFixture(async (_home, cwd) => {
        await setCustomSetting("workflowMetrics", true, "project", cwd);
        const streamPath = join(cwd, "bad-terminal.jsonl");
        await Deno.writeTextFile(
            streamPath,
            [
                JSON.stringify({
                    event: "step_update",
                    step_update: { step_type: "agent_response", text_delta: "original" },
                }),
                JSON.stringify({
                    event: "result",
                    result: {
                        status: "SUCCESS",
                        response: "different",
                        usage: { input_tokens: 19, output_tokens: 0, cache_read_tokens: 7 },
                    },
                }),
            ].join("\n") + "\n",
        );
        Deno.env.set("RUNWIELD_AGY_CAPTURED_STREAM", streamPath);
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        try {
            await ensureRootAgentSession({ hostedSession, agentName: AGENTS.GUIDE });
            await assertRejects(() =>
                runRootTurn({ hostedSession, agentName: AGENTS.GUIDE, userRequest: "Check failed usage." })
            );
            await drainWorkflowMetrics();
            const rows = (await Deno.readTextFile(getWorkflowMetricsFilePath(cwd))).trim().split("\n")
                .map((line) => JSON.parse(line));
            assertEquals(rows.find((row) => row.event === "execution_finished")?.outcome, "failed");
            assertEquals(rows.find((row) => row.event === "model_usage")?.cacheReadTokens, 7);
        } finally {
            hostedSession.dispose();
        }
    });
});

Deno.test("Agy CLI selected root turn dispatches through agy and rebuilds RunWield transcript history", async () => {
    await withAgyExecutionFixture(async (home, cwd, logPath) => {
        const manager = SessionManager.inMemory(cwd);
        const events: RuntimeEventRecord[] = [];
        const hostedSession = createHostedSession(cwd, manager, events);
        const root = await ensureRootAgentSession({ hostedSession, agentName: AGENTS.GUIDE }) as never as AgyRootRef;
        assertEquals(root.kind, "agy-cli");

        await runRootTurn({ hostedSession, agentName: AGENTS.GUIDE, userRequest: "first user marker" });
        await runRootTurn({ hostedSession, agentName: AGENTS.GUIDE, userRequest: "second user marker" });

        const calls = await readCalls(logPath);
        assertEquals(calls.length, 2);
        assertEquals(calls[0].model, "gemini-3.8-flash");
        assertEquals(calls[0].effort, "low");
        assertEquals(calls[0].args.includes("--disable-slash-commands"), true);
        assertEquals(calls[0].args[calls[0].args.indexOf("--print-timeout") + 1], "24h");
        assertEquals(calls[0].args.includes("--conversation"), false);
        assertEquals(calls[0].prompt.includes("first user marker"), true);
        assertEquals(calls[0].prompt.includes("Antigravity CLI backend limitations"), false);
        assertEquals(
            calls[1].prompt.includes("ASSISTANT: agy:first plan_written task_completed review_complete"),
            true,
        );
        assertEquals(calls[0].agent.startsWith("runwield-guide-"), true);

        const branch = getRootSessionBranchEntries(manager) as BranchEntryRecord[];
        const branchText = JSON.stringify(branch);
        assertStringIncludes(branchText, "agy:first plan_written task_completed review_complete");
        assertStringIncludes(branchText, "agy:second saw agy:first");
        assertEquals(branchText.includes(calls[0].agent), false);
        assertEquals(
            branch.filter((entry) => entry.type === "message" && entry.message?.role === "assistant").length,
            2,
        );
        assertEquals(
            branch.filter((entry) => entry.type === "custom" && entry.customType === "runwield.execution_backend")
                .length,
            4,
        );
        assertEquals(
            branch.some((entry) => entry.type === "custom" && String(entry.customType).includes("task_completion")),
            false,
        );
        assertEquals(
            events.some((event) => event.type === "assistant_text_delta" && event.agentName === "Guide"),
            true,
        );
        assertEquals(JSON.stringify(events).includes(calls[0].agent), false);

        await root.session.dispose();
        await assertNoTemporaryAgents(home);
    });
});

Deno.test("every eligible Agy role invokes its real lifecycle tool through configured stdio transport", async () => {
    await withAgyExecutionFixture(async (_home, cwd, logPath) => {
        const writeCalls = async (name: string, calls: unknown[]) => {
            const callsPath = join(cwd, `${name}-agy-mcp-calls.json`);
            await Deno.writeTextFile(callsPath, JSON.stringify(calls));
            Deno.env.set("RUNWIELD_AGY_EXECUTION_MCP_CALLS", callsPath);
        };
        const writeApprovedPlan = async (planName: string) => {
            await Deno.mkdir(join(cwd, "docs", "plans"), { recursive: true });
            await Deno.writeTextFile(
                join(cwd, "docs", "plans", `${planName}.md`),
                `---\nclassification: PLANNED_CHANGE\nworkKind: FEATURE\ncomplexity: MEDIUM\nstatus: approved\naffectedPaths:\n  - src/example.ts\n---\n# ${planName}\n`,
            );
        };
        const assertWorkflowEvent = (branchText: string, kind: string, token: string) => {
            assertStringIncludes(branchText, "runwield.workflow_tool_event");
            assertStringIncludes(branchText, `\"kind\":\"${kind}\"`);
            assertStringIncludes(branchText, token);
            assertStringIncludes(branchText, "agy-cli-mcp");
        };

        const planName = `agy-stdio-plan-${crypto.randomUUID()}`;
        const plannerManager = SessionManager.inMemory(cwd);
        const plannerSession = createHostedSession(cwd, plannerManager);
        plannerSession.setInteractionAdapter({
            requestInteraction: async (request) => {
                const reviewedPlanName = String(request._meta?.planName || planName);
                const reviewed = await loadPlan(cwd, reviewedPlanName);
                return {
                    outcome: "accepted",
                    _meta: {
                        approved: true,
                        approvalAction: "run",
                        revision: reviewed?.revision,
                    },
                };
            },
            supportsInteraction: () => true,
        });
        await writeApprovedPlan(planName);
        await writeCalls("planner", [{ name: "runwield_plan_written", arguments: { planName } }]);
        const plannerRoot = await ensureRootAgentSession({
            hostedSession: plannerSession,
            agentName: AGENTS.PLANNER,
        }) as never as AgyRootRef;
        await runRootTurn({ hostedSession: plannerSession, agentName: AGENTS.PLANNER, userRequest: "submit the plan" });
        const plannerBranch = JSON.stringify(getRootSessionBranchEntries(plannerManager));
        assertWorkflowEvent(plannerBranch, "plan_written", planName);
        assertStringIncludes(plannerBranch, "approved_execute");
        await plannerRoot.session.dispose();

        const completionMessage = `stdio completion ${crypto.randomUUID()}`;
        const executionManager = SessionManager.inMemory(cwd);
        const executionSession = createHostedSession(cwd, executionManager);
        executionSession.setActiveExecutionWorkflow({
            planName: "quick-fix",
            triageMeta: { classification: "QUICK_FIX" },
            executionAgent: "engineer",
            executionStarted: true,
            projectRoot: cwd,
            executionCwd: cwd,
            nonGitInPlace: true,
            executionMode: "non_git_in_place",
        });
        await writeCalls("engineer", [{ name: "runwield_task_completed", arguments: { message: completionMessage } }]);
        const executionRoot = await ensureRootAgentSession({
            hostedSession: executionSession,
            agentName: AGENTS.ENGINEER,
        }) as never as AgyRootRef;
        await runRootTurn({
            hostedSession: executionSession,
            agentName: AGENTS.ENGINEER,
            userRequest: "complete the task",
        });
        const executionBranch = JSON.stringify(getRootSessionBranchEntries(executionManager));
        assertWorkflowEvent(executionBranch, "task_completed", completionMessage);
        assertStringIncludes(executionBranch, "task_completed");
        await executionRoot.session.dispose();

        const reviewTitle = `stdio review finding ${crypto.randomUUID()}`;
        const reviewManager = SessionManager.inMemory(cwd);
        const reviewSession = createHostedSession(cwd, reviewManager);
        reviewSession.setActiveExecutionWorkflow({
            planName: "review-plan",
            triageMeta: { classification: "PLANNED_CHANGE" },
            executionAgent: "engineer",
            executionStarted: true,
            validationGeneration: "agy-review-generation",
        });
        await writeCalls("reviewer", [{
            name: "runwield_review_complete",
            arguments: {
                approved: false,
                findings: [{
                    title: reviewTitle,
                    requirement: "must preserve real tool authority",
                    evidence: "test fixture",
                }],
            },
        }]);
        await runIsolatedAgentSession({
            hostedSession: reviewSession,
            agentName: AGENTS.REVIEWER,
            subAgentDefinition: { id: SUBAGENTS.REVIEWER, options: { reviewerMode: "discovery" } },
            userRequest: "review the change",
        });
        const reviewEvents = listPendingWorkflowToolEvents(reviewSession);
        assertEquals(reviewEvents.length, 1);
        assertEquals(reviewEvents[0].kind, "review_complete");
        assertEquals(reviewEvents[0].validationGeneration, "agy-review-generation");
        assertStringIncludes(JSON.stringify(reviewEvents[0].payload), reviewTitle);

        // The validation driver stops the CLI when the tool is accepted. Its
        // result must survive without waiting for a returned transcript.
        const validation = createValidationSessionPort(reviewSession);
        const reviewResult = await validation.runIsolatedAgentSession({
            kind: "reviewer",
            agentName: AGENTS.REVIEWER,
            userRequest: "review the change through validation",
            cwd,
            reviewerMode: "discovery",
            customTools: [],
            sessionManager: validation.createInMemorySessionManager(cwd),
        });
        assertEquals(reviewResult.outcome, "completed");
        if (reviewResult.outcome !== "completed") throw new Error("Agy review did not complete");
        assertEquals(reviewResult.usedDiffTool, false);
        assertEquals(reviewResult.trustedOpaqueMcpReview, true);
        assertEquals(reviewResult.reviewOutcome?.approved, false);
        assertStringIncludes(JSON.stringify(reviewResult.reviewOutcome), reviewTitle);
        assertStringIncludes(await Deno.readTextFile(logPath), "runwield_review_complete");
    });
});

Deno.test("Agy CLI rejects custom-agent drift before the next root turn commits a request", async () => {
    await withAgyExecutionFixture(async (home, cwd, logPath) => {
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        const root = await ensureRootAgentSession({ hostedSession, agentName: AGENTS.GUIDE }) as never as AgyRootRef;

        await runRootTurn({ hostedSession, agentName: AGENTS.GUIDE, userRequest: "first user marker" });
        const callsBefore = await readCalls(logPath);
        const definitionPath = join(home, ".gemini", "config", "agents", callsBefore[0].agent, "agent.md");
        await Deno.writeTextFile(definitionPath, "changed by another owner\n");

        await assertRejects(
            () => runRootTurn({ hostedSession, agentName: AGENTS.GUIDE, userRequest: "second user marker" }),
            Error,
            "Antigravity CLI works, but it did not load RunWield's temporary Agent",
        );

        assertEquals(await Deno.readTextFile(definitionPath), "changed by another owner\n");
        assertEquals((await readCalls(logPath)).length, callsBefore.length);
        const branch = getRootSessionBranchEntries(manager) as BranchEntryRecord[];
        assertEquals(
            branch.filter((entry) => entry.type === "message" && entry.message?.role === "user").length,
            1,
        );
        const branchText = JSON.stringify(branch);
        assertStringIncludes(branchText, "custom_agent_invalid");
        assertEquals(branchText.includes("runwield.workflow_tool_event"), false);
        await root.session.dispose();
    });
});

Deno.test("Agy abort stops the custom-agent preflight before committing the request", async () => {
    if (Deno.build.os === "windows") return;
    await withAgyExecutionFixture(async (_home, cwd) => {
        await setCustomSetting("workflowMetrics", true, "project", cwd);
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        const root = await ensureRootAgentSession({ hostedSession, agentName: AGENTS.GUIDE }) as never as AgyRootRef;
        const pidPath = join(cwd, "agents-preflight.pid");
        const controller = new AbortController();
        Deno.env.set("RUNWIELD_AGY_SLEEP_AGENTS_PID", pidPath);
        const turn = runRootTurn({
            hostedSession,
            agentName: AGENTS.GUIDE,
            userRequest: "preflight abort request",
            signal: controller.signal,
        });
        turn.catch(() => undefined);
        while (true) {
            try {
                await Deno.stat(pidPath);
                break;
            } catch (error) {
                if (!(error instanceof Deno.errors.NotFound)) throw error;
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
        }
        const preflightPid = Number((await Deno.readTextFile(pidPath)).trim());
        controller.abort();
        await assertRejects(() => turn, Error, "Antigravity CLI turn canceled");
        assertEquals(await waitForProcessDeath(preflightPid), true);
        await drainWorkflowMetrics();
        const rows = (await Deno.readTextFile(getWorkflowMetricsFilePath(cwd))).trim().split("\n")
            .map((line) => JSON.parse(line));
        assertEquals(rows.find((row) => row.event === "execution_finished")?.outcome, "canceled");
        const branch = getRootSessionBranchEntries(manager) as BranchEntryRecord[];
        assertEquals(
            branch.filter((entry) => entry.type === "message" && entry.message?.role === "user").length,
            0,
        );
        await root.session.dispose();
    });
});

Deno.test("Agy successful turns close descendant-held output pipes", async () => {
    if (Deno.build.os === "windows") return;
    await withAgyExecutionFixture(async (_home, cwd) => {
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        const root = await ensureRootAgentSession({ hostedSession, agentName: AGENTS.GUIDE }) as never as AgyRootRef;
        const pidPath = join(cwd, "success-descendant.pid");
        Deno.env.set("RUNWIELD_AGY_DESCENDANT_PID", pidPath);
        Deno.env.set("RUNWIELD_AGY_DESCENDANT_HOLDS_PIPES", "1");

        await Promise.race([
            runRootTurn({ hostedSession, agentName: AGENTS.GUIDE, userRequest: "successful descendant turn" }),
            new Promise((_resolve, reject) => setTimeout(() => reject(new Error("Agy turn did not settle")), 5000)),
        ]);

        const descendantPid = Number((await Deno.readTextFile(pidPath)).trim());
        assertEquals(await waitForProcessDeath(descendantPid), true);
        await root.session.dispose();
    });
});

Deno.test("Agy failures preserve workflow authority and terminate every owned process", async () => {
    if (Deno.build.os === "windows") return;
    await withAgyExecutionFixture(async (_home, cwd) => {
        const beforePidPath = join(cwd, "before-descendant.pid");
        const beforeManager = SessionManager.inMemory(cwd);
        const beforeSession = createHostedSession(cwd, beforeManager);
        beforeSession.setActiveExecutionWorkflow({
            planName: "quick-fix-before",
            triageMeta: { classification: "QUICK_FIX" },
            executionAgent: "engineer",
            executionStarted: true,
            projectRoot: cwd,
            executionCwd: cwd,
            nonGitInPlace: true,
            executionMode: "non_git_in_place",
        });
        const beforeRoot = await ensureRootAgentSession({
            hostedSession: beforeSession,
            agentName: AGENTS.ENGINEER,
        }) as never as AgyRootRef;
        Deno.env.set("RUNWIELD_AGY_DESCENDANT_PID", beforePidPath);
        Deno.env.set("RUNWIELD_AGY_FAIL_TURN", "1");

        await assertRejects(
            () =>
                runRootTurn({
                    hostedSession: beforeSession,
                    agentName: AGENTS.ENGINEER,
                    userRequest: "fail before tool",
                    dispatchKind: "plan_execution",
                }),
            Error,
            "Antigravity CLI exited before completing the turn",
        );
        const beforeDescendantPid = Number((await Deno.readTextFile(beforePidPath)).trim());
        assertEquals(await waitForProcessDeath(beforeDescendantPid), true);
        const beforeEntries = getRootSessionBranchEntries(beforeManager) as BranchEntryRecord[];
        assertEquals(
            beforeEntries.filter((entry) => entry.customType === "runwield.workflow_tool_event").length,
            0,
        );
        const beforeStatus = beforeEntries.find((entry) => entry.customType === "runwield.backend_status")?.data;
        assertEquals(beforeStatus?.kind, "non_zero_exit");
        assertEquals(beforeStatus?.afterAcceptedTerminal, undefined);
        await beforeRoot.session.dispose();

        Deno.env.delete("RUNWIELD_AGY_FAIL_TURN");
        const afterPidPath = join(cwd, "after-descendant.pid");
        const callsPath = join(cwd, "after-agy-mcp-calls.json");
        const completionMessage = `accepted terminal ${crypto.randomUUID()}`;
        await Deno.writeTextFile(
            callsPath,
            JSON.stringify([
                { name: "runwield_task_completed", arguments: { message: completionMessage } },
                { name: "runwield_task_completed", arguments: { message: `duplicate ${completionMessage}` } },
            ]),
        );
        Deno.env.set("RUNWIELD_AGY_EXECUTION_MCP_CALLS", callsPath);
        Deno.env.set("RUNWIELD_AGY_DESCENDANT_PID", afterPidPath);
        Deno.env.set("RUNWIELD_AGY_FAIL_AFTER_MCP", "1");
        const afterManager = SessionManager.inMemory(cwd);
        const afterSession = createHostedSession(cwd, afterManager);
        afterSession.setActiveExecutionWorkflow({
            planName: "quick-fix-after",
            triageMeta: { classification: "QUICK_FIX" },
            executionAgent: "engineer",
            executionStarted: true,
            projectRoot: cwd,
            executionCwd: cwd,
            nonGitInPlace: true,
            executionMode: "non_git_in_place",
        });
        const afterRoot = await ensureRootAgentSession({
            hostedSession: afterSession,
            agentName: AGENTS.ENGINEER,
        }) as never as AgyRootRef;

        await runRootTurn({
            hostedSession: afterSession,
            agentName: AGENTS.ENGINEER,
            userRequest: "accept tool then fail host",
            dispatchKind: "plan_execution",
        });

        const afterDescendantPid = Number((await Deno.readTextFile(afterPidPath)).trim());
        assertEquals(await waitForProcessDeath(afterDescendantPid), true);
        const afterEntries = getRootSessionBranchEntries(afterManager) as BranchEntryRecord[];
        assertEquals(afterEntries.filter((entry) => entry.customType === "runwield.workflow_tool_event").length, 1);
        const afterText = JSON.stringify(afterEntries);
        assertStringIncludes(afterText, completionMessage);
        assertEquals(afterText.includes(`duplicate ${completionMessage}`), false);
        const afterStatus = afterEntries.find((entry) => entry.customType === "runwield.backend_status")?.data;
        assertEquals(afterStatus, undefined);
        await afterRoot.session.dispose();

        Deno.env.delete("RUNWIELD_AGY_FAIL_AFTER_MCP");
        Deno.env.delete("RUNWIELD_AGY_DESCENDANT_PID");
        const permissionCallsPath = join(cwd, "permission-agy-mcp-calls.json");
        await Deno.writeTextFile(
            permissionCallsPath,
            JSON.stringify([{ name: "runwield_task_completed", arguments: { message: "accepted permission result" } }]),
        );
        Deno.env.set("RUNWIELD_AGY_EXECUTION_MCP_CALLS", permissionCallsPath);
        Deno.env.set("RUNWIELD_AGY_PERMISSION_RESULT", "1");
        const permissionManager = SessionManager.inMemory(cwd);
        const permissionSession = createHostedSession(cwd, permissionManager);
        permissionSession.setActiveExecutionWorkflow({
            planName: "quick-fix-permission",
            triageMeta: { classification: "QUICK_FIX" },
            executionAgent: "engineer",
            executionStarted: true,
            projectRoot: cwd,
            executionCwd: cwd,
            nonGitInPlace: true,
            executionMode: "non_git_in_place",
        });
        const permissionRoot = await ensureRootAgentSession({
            hostedSession: permissionSession,
            agentName: AGENTS.ENGINEER,
        }) as never as AgyRootRef;
        await runRootTurn({
            hostedSession: permissionSession,
            agentName: AGENTS.ENGINEER,
            userRequest: "accept tool then permission result",
            dispatchKind: "plan_execution",
        });
        const permissionEntries = getRootSessionBranchEntries(permissionManager) as BranchEntryRecord[];
        const permissionStatus = permissionEntries.find((entry) => entry.customType === "runwield.backend_status")
            ?.data;
        assertEquals(permissionStatus, undefined);
        await permissionRoot.session.dispose();
    });
});

Deno.test("Agy retry reconstructs only committed transcript after classified failure", async () => {
    await withAgyExecutionFixture(async (home, cwd, logPath) => {
        const executablePath = join(home, "bin", "agy");
        const executableText = await Deno.readTextFile(executablePath);
        const fixturePath = Deno.env.get("PATH") || "";
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        const root = await ensureRootAgentSession({ hostedSession, agentName: AGENTS.GUIDE }) as never as AgyRootRef;

        await Deno.remove(executablePath);
        Deno.env.set("PATH", join(home, "bin"));
        await assertRejects(
            () => runRootTurn({ hostedSession, agentName: AGENTS.GUIDE, userRequest: "missing executable turn" }),
            Error,
            "Antigravity CLI is not available",
        );
        let branch = getRootSessionBranchEntries(manager) as BranchEntryRecord[];
        assertEquals(branch.filter((entry) => entry.type === "message" && entry.message?.role === "user").length, 0);
        assertEquals(
            branch.find((entry) => entry.customType === "runwield.backend_status")?.data?.kind,
            "missing_executable",
        );
        const attemptsAfterMissing = branch.filter((entry) => entry.customType === "runwield.request_attempt");
        assertStringIncludes(JSON.stringify(attemptsAfterMissing.at(-1)), '"promptMode":"original"');

        await Deno.writeTextFile(executablePath, executableText);
        await Deno.chmod(executablePath, 0o755);
        Deno.env.set("PATH", fixturePath);
        Deno.env.set("RUNWIELD_AGY_MALFORMED_FAIL_WITH_STDERR", "1");
        await assertRejects(
            () => runRootTurn({ hostedSession, agentName: AGENTS.GUIDE, userRequest: "auth stderr turn" }),
            Error,
            "authentication failed for private account",
        );
        branch = getRootSessionBranchEntries(manager) as BranchEntryRecord[];
        assertEquals(
            branch.filter((entry) => entry.customType === "runwield.backend_status").at(-1)?.data?.kind,
            "auth_failed",
        );
        Deno.env.delete("RUNWIELD_AGY_MALFORMED_FAIL_WITH_STDERR");
        Deno.env.set("RUNWIELD_AGY_MALFORMED_AUTH_STDERR_ZERO", "1");
        await assertRejects(
            () => runRootTurn({ hostedSession, agentName: AGENTS.GUIDE, userRequest: "auth stderr exit zero turn" }),
            Error,
            "authentication failed for private account",
        );
        branch = getRootSessionBranchEntries(manager) as BranchEntryRecord[];
        assertEquals(
            branch.filter((entry) => entry.customType === "runwield.backend_status").at(-1)?.data?.kind,
            "auth_failed",
        );
        Deno.env.delete("RUNWIELD_AGY_MALFORMED_AUTH_STDERR_ZERO");
        Deno.env.set("RUNWIELD_AGY_MALFORMED_AFTER_MCP", "1");
        await assertRejects(
            () => runRootTurn({ hostedSession, agentName: AGENTS.GUIDE, userRequest: "bad stream turn" }),
            Error,
            "malformed stream output",
        );
        Deno.env.delete("RUNWIELD_AGY_MALFORMED_AFTER_MCP");
        await Deno.writeTextFile(logPath, "");

        await runRootTurn({ hostedSession, agentName: AGENTS.GUIDE, userRequest: "bad stream turn" });

        branch = getRootSessionBranchEntries(manager) as BranchEntryRecord[];
        const branchText = JSON.stringify(branch);
        assertEquals(branchText.split("bad stream turn").length - 1, 1);
        assertEquals(
            branch.filter((entry) => entry.type === "message" && entry.message?.role === "assistant").length,
            1,
        );
        const calls = await readCalls(logPath);
        assertEquals(calls.length, 1);
        assertStringIncludes(calls[0].prompt, "USER: bad stream turn");
        assertStringIncludes(
            calls[0].prompt,
            "USER: Continue the active agent task after the previous backend failed.",
        );
        await root.session.dispose();
        await assertNoTemporaryAgents(home);
    });
});

Deno.test("Agy CLI replay expands durable named invocations once", async () => {
    await withAgyExecutionFixture(async (home, cwd, logPath) => {
        const manager = SessionManager.inMemory(cwd);
        manager.appendCustomEntry("runwield.named_invocation", {
            version: 1,
            compactInvocation: "/saved-template compact request",
            expandedRequest: "Expanded saved template request",
        });
        manager.appendMessage({
            role: "user",
            timestamp: Date.now(),
            content: [{ type: "text", text: "/saved-template compact request" }],
        });
        manager.appendMessage({
            role: "assistant",
            timestamp: Date.now(),
            api: "agy-cli",
            provider: "agy-cli",
            model: "gemini-3.8-flash",
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            content: [{ type: "text", text: "prior assistant answer" }],
        });
        const hostedSession = createHostedSession(cwd, manager);
        const root = await ensureRootAgentSession({ hostedSession, agentName: AGENTS.GUIDE }) as never as AgyRootRef;

        await runRootTurn({ hostedSession, agentName: AGENTS.GUIDE, userRequest: "continue after template" });

        const calls = await readCalls(logPath);
        assertEquals(calls.length, 1);
        assertStringIncludes(calls[0].prompt, "USER: Expanded saved template request");
        assertEquals(calls[0].prompt.includes("/saved-template compact request"), false);
        await root.session.dispose();
        await assertNoTemporaryAgents(home);
    });
});

Deno.test("Agy CLI isolated image requests fail before agent creation or transcript mutation", async () => {
    await withAgyExecutionFixture(async (home, cwd, logPath) => {
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        await assertRejects(
            () =>
                runIsolatedAgentSession({
                    hostedSession,
                    agentName: AGENTS.GUIDE,
                    userRequest: "image request",
                    images: [{ base64: "abc", mimeType: "image/png" }],
                    modelOverride: "agy-cli/gemini-3.8-flash",
                    sessionManager: manager,
                }),
            Error,
            "does not support image attachments",
        );
        assertEquals(getRootSessionBranchEntries(manager).length, 0);
        assertEquals((await readCalls(logPath)).length, 0);
        await assertNoTemporaryAgents(home);
    });
});

Deno.test("Agy CLI first root image requests fail before agent creation or transcript mutation", async () => {
    await withAgyExecutionFixture(async (home, cwd, logPath) => {
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);

        await assertRejects(
            () =>
                runActiveAgentTurn({
                    hostedSession,
                    agentName: AGENTS.GUIDE,
                    userRequest: "root image request",
                    images: [{ base64: "abc", mimeType: "image/png" }],
                    sessionManager: manager,
                }),
            Error,
            "does not support image attachments",
        );

        assertEquals(getRootSessionBranchEntries(manager).length, 0);
        assertEquals(hostedSession.getRootAgentSession(), null);
        assertEquals((await readCalls(logPath)).length, 0);
        await assertNoTemporaryAgents(home);
    });
});

Deno.test("Agy CLI root process failure records sanitized status and keeps the reusable temporary agent", async () => {
    await withAgyExecutionFixture(async (home, cwd) => {
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        const root = await ensureRootAgentSession({ hostedSession, agentName: AGENTS.GUIDE }) as never as AgyRootRef;
        Deno.env.set("RUNWIELD_AGY_FAIL_TURN", "1");

        await assertRejects(
            () => runRootTurn({ hostedSession, agentName: AGENTS.GUIDE, userRequest: "fail this turn" }),
            Error,
            "Antigravity CLI exited before completing the turn",
        );

        const branchText = JSON.stringify(getRootSessionBranchEntries(manager));
        assertStringIncludes(branchText, "runwield.backend_status");
        assertStringIncludes(branchText, "non_zero_exit");
        await root.session.dispose();
        await assertNoTemporaryAgents(home);
    });
});

Deno.test("Agy CLI returned model mismatch records sanitized selection status", async () => {
    await withAgyExecutionFixture(async (home, cwd) => {
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        Deno.env.set("RUNWIELD_AGY_REPORTED_MODEL", "gemini-3.8-flash-low");
        Deno.env.set("RUNWIELD_AGY_EXPECTED_EFFORT", "medium");

        await assertRejects(
            () =>
                runIsolatedAgentSession({
                    hostedSession,
                    agentName: AGENTS.GUIDE,
                    userRequest: "wrong suffix",
                    modelOverride: "agy-cli/gemini-3.8-flash",
                    thinkingLevelOverride: "medium",
                    sessionManager: manager,
                }),
            Error,
            "Antigravity CLI reported model",
        );

        const status = (getRootSessionBranchEntries(manager) as BranchEntryRecord[])
            .find((entry) => entry.customType === "runwield.backend_status")?.data;
        assertEquals(status?.kind, "selection_mismatch");
        assertEquals(JSON.stringify(status).includes("wrong suffix"), false);
        const backendEntries = (getRootSessionBranchEntries(manager) as BranchEntryRecord[])
            .filter((entry) => entry.customType === "runwield.execution_backend");
        assertEquals(backendEntries.some((entry) => typeof entry.data?.backendModel === "string"), false);
        await assertNoTemporaryAgents(home);
    });
});

Deno.test("HostedSession disposal reaches the Agy execution session", async () => {
    await withAgyExecutionFixture(async (home, cwd) => {
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        await ensureRootAgentSession({ hostedSession, agentName: AGENTS.GUIDE });

        await hostedSession.dispose();

        await assertNoTemporaryAgents(home);
    });
});

Deno.test("Agy CLI root replacement disposes only the owned Agy root", async () => {
    await withAgyExecutionFixture(async (home, cwd) => {
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        let previousPlainRootDisposed = false;
        hostedSession.setRootAgentSession({
            dispose: () => {
                previousPlainRootDisposed = true;
            },
        });
        hostedSession.setRootAgentName(AGENTS.OPERATOR);

        const root = await ensureRootAgentSession({
            hostedSession,
            agentName: AGENTS.GUIDE,
            modelOverride: "agy-cli/gemini-3.8-flash",
        }) as never as AgyRootRef;

        assertEquals(previousPlainRootDisposed, false);
        await root.session.dispose();
        await assertNoTemporaryAgents(home);
    });
});

Deno.test("Agy Engineer custom agent declares native file and shell tools", async () => {
    await withAgyExecutionFixture(async (home, cwd) => {
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        const root = await ensureRootAgentSession({ hostedSession, agentName: AGENTS.ENGINEER }) as never as AgyRootRef;
        try {
            const agentsRoot = join(home, ".gemini", "config", "agents");
            const names: string[] = [];
            for await (const entry of Deno.readDir(agentsRoot)) {
                if (entry.name.startsWith("runwield-engineer-")) names.push(entry.name);
            }
            assertEquals(names.length, 1);
            const definition = await Deno.readTextFile(join(agentsRoot, names[0], "agent.md"));
            assertStringIncludes(definition, "tools:\n");
            assertStringIncludes(definition, "  - run_command\n");
            assertStringIncludes(definition, "  - write_to_file\n");
            assertStringIncludes(definition, "  - replace_file_content\n");
            assertStringIncludes(definition, "  - view_file\n");
        } finally {
            await root.session.dispose();
        }
    });
});

Deno.test("Agy Recorder custom agent restricts native tools to read-only", async () => {
    await withAgyExecutionFixture(async (home, cwd) => {
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        const root = await ensureRootAgentSession({ hostedSession, agentName: AGENTS.RECORDER }) as never as AgyRootRef;
        try {
            const agentsRoot = join(home, ".gemini", "config", "agents");
            const names: string[] = [];
            for await (const entry of Deno.readDir(agentsRoot)) {
                if (entry.name.startsWith("runwield-recorder-")) names.push(entry.name);
            }
            assertEquals(names.length, 1);
            const definition = await Deno.readTextFile(join(agentsRoot, names[0], "agent.md"));
            const frontmatter = definition.split("---")[1] || "";
            assertStringIncludes(frontmatter, "tools:\n");
            assertStringIncludes(frontmatter, "  - view_file\n");
            assertEquals(frontmatter.includes("run_command"), false);
            assertEquals(frontmatter.includes("write_to_file"), false);
            assertEquals(frontmatter.includes("replace_file_content"), false);
        } finally {
            await root.session.dispose();
        }
    });
});

Deno.test("Agy CLI isolated turn uses its own temporary agent and cleans it up", async () => {
    await withAgyExecutionFixture(async (home, cwd, logPath) => {
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        const messages = await runIsolatedAgentSession({
            hostedSession,
            agentName: AGENTS.GUIDE,
            userRequest: "isolated user marker",
            modelOverride: "agy-cli/gemini-3.8-flash",
        });
        assertEquals(messages.at(-1)?.role, "assistant");
        assertStringIncludes(JSON.stringify(messages.at(-1)), "agy:first");
        assertEquals(getRootSessionBranchEntries(manager).length, 0);
        assertEquals(hostedSession.getRootAgentSession(), null);
        const calls = await readCalls(logPath);
        assertEquals(calls.length, 1);
        assertEquals(calls[0].prompt.includes("isolated user marker"), true);
        await assertNoTemporaryAgents(home);
    });
});

Deno.test("Agy CLI same-role roots use distinct temporary agents and clean up independently", async () => {
    await withAgyExecutionFixture(async (home, cwd) => {
        const firstCwd = join(cwd, "first");
        const secondCwd = join(cwd, "second");
        await Deno.mkdir(firstCwd, { recursive: true });
        await Deno.mkdir(secondCwd, { recursive: true });
        const firstManager = SessionManager.inMemory(firstCwd);
        const secondManager = SessionManager.inMemory(secondCwd);
        const firstHostedSession = createHostedSession(cwd, firstManager);
        const secondHostedSession = createHostedSession(cwd, secondManager);
        const firstRoot = await ensureRootAgentSession({
            hostedSession: firstHostedSession,
            agentName: AGENTS.GUIDE,
        }) as never as AgyRootRef;
        const secondRoot = await ensureRootAgentSession({
            hostedSession: secondHostedSession,
            agentName: AGENTS.GUIDE,
        }) as never as AgyRootRef;
        const agentsRoot = join(home, ".gemini", "config", "agents");
        const ownedNames: string[] = [];
        for await (const entry of Deno.readDir(agentsRoot)) {
            if (entry.name.startsWith("runwield-guide-")) ownedNames.push(entry.name);
        }
        assertEquals(ownedNames.length, 2);
        assertEquals(ownedNames[0] === ownedNames[1], false);

        await firstRoot.session.dispose();
        const remainingNames: string[] = [];
        for await (const entry of Deno.readDir(agentsRoot)) {
            if (entry.name.startsWith("runwield-guide-")) remainingNames.push(entry.name);
        }
        assertEquals(remainingNames.length, 1);
        await secondRoot.session.dispose();
        await assertNoTemporaryAgents(home);
    });
});

Deno.test("Agy CLI root setup failure keeps the previous root session usable", async () => {
    await withAgyExecutionFixture(async (home, cwd) => {
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        const root = await ensureRootAgentSession({ hostedSession, agentName: AGENTS.GUIDE }) as never as AgyRootRef;
        Deno.env.set("RUNWIELD_AGY_FAIL_AGENTS", "1");
        await assertRejects(
            () =>
                ensureRootAgentSession({
                    hostedSession,
                    agentName: AGENTS.PLANNER,
                    modelOverride: "agy-cli/gemini-3.8-flash",
                }),
            Error,
            "Antigravity CLI works, but it did not load RunWield's temporary Agent",
        );
        assertEquals(hostedSession.getRootAgentSession() === root as never, true);
        assertEquals(hostedSession.getRootAgentName(), AGENTS.GUIDE);
        await root.session.dispose();
        await assertNoTemporaryAgents(home);
    });
});

Deno.test("Agy CLI root steering is not accepted without mutating transcript", async () => {
    await withAgyExecutionFixture(async (home, cwd) => {
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        const root = await ensureRootAgentSession({ hostedSession, agentName: AGENTS.GUIDE }) as never as AgyRootRef;
        root.session.isStreaming = true;
        const steered = await steerRootSession(hostedSession, "steer me");
        root.session.isStreaming = false;
        assertEquals(steered, false);
        assertEquals(getRootSessionBranchEntries(manager).length, 2);
        await root.session.dispose();
        await assertNoTemporaryAgents(home);
    });
});

Deno.test("Agy CLI abort kills the active process", async () => {
    await withAgyExecutionFixture(async (home, cwd) => {
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        const root = await ensureRootAgentSession({ hostedSession, agentName: AGENTS.GUIDE }) as never as AgyRootRef;
        root.session.isStreaming = true;
        assertEquals(abortActiveSession(hostedSession), true);
        root.session.isStreaming = false;
        await root.session.dispose();
        await assertNoTemporaryAgents(home);
    });
});

Deno.test("Agy empty SUCCESS with a denied read persists actionable failure", async () => {
    await withAgyExecutionFixture(async (home, cwd) => {
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        const root = await ensureRootAgentSession({ hostedSession, agentName: AGENTS.GUIDE }) as never as AgyRootRef;
        try {
            await assertRejects(
                () => runRootTurn({ hostedSession, agentName: AGENTS.GUIDE, userRequest: "fixture-denied-file-read" }),
                Error,
                "Blocked: view_file: [redacted-home]/project/check.test.js",
            );
            const entries = getRootSessionBranchEntries(manager) as BranchEntryRecord[];
            const statuses = entries.filter((entry) => entry.customType === "runwield.backend_status");
            assertEquals(statuses.length, 1);
            assertEquals(statuses[0].data?.kind, "permission_denied");
            assertEquals(statuses[0].data?.exitCode, 0);
            assertStringIncludes(String(statuses[0].data?.message), "/permissions");
            assertEquals(String(statuses[0].data?.message).includes(home), false);
            assertEquals(entries.some((entry) => entry.message?.role === "assistant"), false);
            assertStringIncludes(JSON.stringify(entries), "denied-file-conversation");
        } finally {
            await root.session.dispose();
        }
    });
});

Deno.test("Agy permission failure settles the runtime with one visible notice and remains replayable", async () => {
    await withAgyExecutionFixture(async (_home, cwd) => {
        const runtime = createSessionRuntime();
        const events: SessionRuntimeEvent[] = [];
        try {
            const sessionId = await runtime.createPromptReadySession({
                cwd,
                agentName: AGENTS.GUIDE,
                deferPersistenceUntilFirstMessage: true,
            });
            runtime.subscribeSessionEvents(sessionId, (event) => {
                events.push(event);
            });
            await runtime.reconfigureSessionModel(sessionId, "gemini-3.8-flash", "agy-cli");
            await assertRejects(
                () =>
                    runtime.promptUserTurn(sessionId, {
                        initialRequest: "fixture-denied-file-read",
                    }),
                Error,
                "Blocked: view_file:",
            );
            const notices = events.filter((event) =>
                event.type === "system_status" && event.message.includes("Blocked:")
            );
            const failures = events.filter((event) => event.type === "terminal_error");
            assertEquals(notices.length, 1);
            assertEquals(failures.length, 1);
            assertEquals(failures[0].messageAlreadyReported, true);
            assertEquals(events.some((event) => event.type === "turn_end" && !event.ok), true);
            events.length = 0;
            assertEquals((await runtime.replaySession(sessionId)).ok, true);
            const replay = events;
            assertEquals(
                replay.filter((event) => event.type === "system_status" && event.message.includes("Blocked:")).length,
                1,
            );
        } finally {
            await runtime.closeAllSessionsWhenIdle();
        }
    });
});

Deno.test("Agy accepts the requested model family echoed by current CLI versions", async () => {
    await withAgyExecutionFixture(async (_home, cwd) => {
        Deno.env.set("RUNWIELD_AGY_REPORTED_MODEL", "gemini-3.8-flash");
        const manager = SessionManager.inMemory(cwd);
        const hostedSession = createHostedSession(cwd, manager);
        const root = await ensureRootAgentSession({ hostedSession, agentName: AGENTS.GUIDE }) as never as AgyRootRef;
        try {
            const messages = await runRootTurn({
                hostedSession,
                agentName: AGENTS.GUIDE,
                userRequest: "echoed family",
            });
            assertEquals(messages.some((message) => message.role === "assistant"), true);
            const entries = getRootSessionBranchEntries(manager) as BranchEntryRecord[];
            assertEquals(entries.some((entry) => entry.customType === "runwield.backend_status"), false);
        } finally {
            await root.session.dispose();
        }
    });
});
