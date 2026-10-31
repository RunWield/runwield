import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";

interface PluginHostPaths {
    home: string;
    config: string;
    project: string;
    temporary: string;
}

interface ProbeLaunch {
    args: string[];
    cwd: string;
    clientName: string;
}

interface HostSkill {
    name: string;
    path: string;
    enabled: boolean;
    pluginId?: string;
}

interface HostSkillGroup {
    cwd: string;
    skills: HostSkill[];
}

interface InstalledPluginProbe {
    launch: ProbeLaunch;
    skills: HostSkill[];
}

interface HostThread {
    id: string;
}

interface HostMcpServer {
    name: string;
    runtimeStatus: string;
    pluginId: string;
}

interface HostResult {
    thread?: HostThread;
    data?: Array<HostMcpServer | HostSkillGroup>;
    content?: Array<{ type: string; text?: string }>;
}

interface HostResponse {
    id?: number;
    result?: HostResult;
    error?: { code: number; message: string };
}

interface PendingRequest {
    resolve: (response: HostResponse) => void;
    reject: (error: Error) => void;
}

type RpcParameter = string | number | boolean | null | RpcParameter[] | RpcParameters;
interface RpcParameters {
    [key: string]: RpcParameter;
}

/** The external Core executable records how the installed plugin asks the real Codex host to launch it. */
const PROBE_SOURCE = `#!/usr/bin/env bun
let clientName = "";
for await (const line of console) {
    const message = JSON.parse(line);
    const params = message.params || {};
    let result;
    if (message.method === "initialize") {
        clientName = params.clientInfo.name;
        result = { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "core-launch-probe", version: "1" } };
    } else if (message.method === "tools/list") {
        result = { tools: [{ name: "launch_evidence", description: "Read disposable launch evidence.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } }] };
    } else if (message.method === "tools/call") {
        result = { content: [{ type: "text", text: JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), clientName }) }] };
    } else if (message.id !== undefined) result = {};
    else continue;
    console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
}
`;

/** No model turn is started. The host only initializes the installed package and calls the read-only fixture tool. */
export async function inspectInstalledPluginLaunch(paths: PluginHostPaths): Promise<InstalledPluginProbe> {
    const bin = join(paths.temporary, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "wld"), PROBE_SOURCE, { mode: 0o755 });
    const host = spawn("codex", ["app-server", "-c", "features.apps=false", "-c", "mcp_optional_startup_grace_ms=0"], {
        cwd: paths.project,
        env: {
            ...process.env,
            HOME: paths.home,
            USERPROFILE: paths.home,
            CODEX_HOME: paths.config,
            PATH: `${bin}:${process.env.PATH || ""}`,
        },
        stdio: ["pipe", "pipe", "pipe"],
    });
    const pending = new Map<number, PendingRequest>();
    const lines = createInterface({ input: host.stdout });
    const errors: string[] = [];
    host.stderr.on("data", (data: Buffer) => {
        if (errors.length < 8) errors.push(data.toString().slice(0, 2000));
    });
    const exit = new Promise<void>((resolve) => host.once("exit", () => resolve()));
    const rejectAll = (error: Error) => {
        for (const request of pending.values()) request.reject(error);
        pending.clear();
    };
    host.once("error", rejectAll);
    host.once("exit", () => rejectAll(new Error(`Codex host exited: ${errors.join("\n")}`)));
    lines.on("line", (line) => {
        const message: HostResponse = JSON.parse(line);
        if (message.id === undefined) return;
        pending.get(message.id)?.resolve(message);
        pending.delete(message.id);
    });
    let nextId = 0;
    const request = async (method: string, params: RpcParameters): Promise<HostResult> => {
        const id = ++nextId;
        let timer: ReturnType<typeof setTimeout>;
        const response = await new Promise<HostResponse>((resolve, reject) => {
            timer = setTimeout(
                () => reject(new Error(`Codex ${method} did not respond: ${errors.join("\n")}`)),
                15_000,
            );
            pending.set(id, { resolve, reject });
            host.stdin.write(JSON.stringify({ id, method, params }) + "\n");
        }).finally(() => {
            clearTimeout(timer);
            pending.delete(id);
        });
        assert.equal(response.error, undefined, response.error?.message || method);
        assert(response.result);
        return response.result;
    };
    try {
        await request("initialize", {
            clientInfo: { name: "runwield-package-test", version: "1" },
            capabilities: { experimentalApi: true },
        });
        host.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
        const catalog = await request("skills/list", { cwds: [paths.project], forceReload: true });
        const skills = catalog.data?.flatMap((entry) => ("skills" in entry ? entry.skills : [])) || [];
        const started = await request("thread/start", {
            cwd: paths.project,
            ephemeral: true,
            sandbox: "read-only",
            approvalPolicy: "never",
        });
        assert(started.thread);
        const threadId = started.thread.id;
        const deadline = Date.now() + 15_000;
        let server: HostMcpServer | undefined;
        do {
            const servers = await request("mcpServerStatus/list", { threadId });
            server = servers.data?.find(
                (entry): entry is HostMcpServer => "pluginId" in entry && entry.pluginId === "runwield@runwield",
            );
            if (server?.runtimeStatus === "connected" || server?.runtimeStatus === "failed") break;
            await new Promise((resolve) => setTimeout(resolve, 25));
        } while (Date.now() < deadline);
        assert(server, "The installed plugin did not expose its MCP server.");
        assert.equal(server.runtimeStatus, "connected", errors.join("\n"));
        const result = await request("mcpServer/tool/call", {
            threadId,
            server: server.name,
            tool: "launch_evidence",
            arguments: {},
        });
        assert(result.content?.[0]?.text);
        return { launch: JSON.parse(result.content[0].text), skills };
    } finally {
        lines.close();
        host.kill("SIGTERM");
        const timer = setTimeout(() => host.kill("SIGKILL"), 2000);
        await exit;
        clearTimeout(timer);
    }
}
