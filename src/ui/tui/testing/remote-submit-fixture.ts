import { runtimeSourceArgs } from "../../../testing/runtime-source-args.ts";
import { serveHttp } from "../../../shared/http-server.ts";
import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { spawnNativeProcess } from "../../../shared/foreground-process.ts";
import { assertEquals } from "../../../testing/assertions.ts";
import { join } from "node:path";
import { getModelRegistry } from "../../../shared/models/model-registry.ts";
import { __resetSettingsForTests } from "../../../shared/settings.js";
import { processLines } from "../../../shared/remote/remote-runtime-lines.ts";
import {
    type RuntimeFixture,
    within,
    withRemoteRuntimeFixture,
} from "../../../shared/remote/remote-runtime-test-fixture.ts";
import { type RemoteSubmitCommand, type RemoteSubmitReport } from "./remote-submit-client.ts";
import process from "node:process";

export interface RemoteSubmitProcess {
    send(command: RemoteSubmitCommand): Promise<void>;
    read(): Promise<RemoteSubmitReport>;
    close(): Promise<void>;
}
export interface RemoteSubmitFixture extends RuntimeFixture {
    requests: string[];
    startTui(): Promise<RemoteSubmitProcess>;
}

/** Real laptop authority and external HTTP provider; the child runs the production TUI bootstrap. */
export async function withRemoteSubmitFixture(run: (fixture: RemoteSubmitFixture) => Promise<void>) {
    await withRemoteRuntimeFixture(async (f) => {
        const requests: string[] = [];
        const secret = "laptop-only-submit-secret";
        const provider = serveHttp({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
            assertEquals(request.headers.get("Authorization"), `Bearer ${secret}`);
            requests.push(await request.text());
            const chunk = (content: string, finish: string | null) =>
                `data: ${JSON.stringify({
                    id: "chatcmpl-submit",
                    object: "chat.completion.chunk",
                    created: 1,
                    model: "remote-model",
                    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: finish }],
                })}\n\n`;
            return new Response(
                chunk(`TUI-TURN-${requests.length}-741`, null) + chunk("", "stop") + "data: [DONE]\n\n",
                {
                    headers: { "Content-Type": "text/event-stream" },
                },
            );
        });
        const port = provider.addr.transport === "tcp" ? provider.addr.port : 0;
        const settings = JSON.parse(await fsReadFile(f.settingsPath, "utf8"));
        const configured = JSON.stringify({
            ...settings,
            defaultProvider: "laptop-http",
            defaultModel: "remote-model",
        });
        await fsWriteFile(f.settingsPath, configured);
        await fsWriteFile(join(f.resources, "settings.json"), configured);
        await fsWriteFile(
            join(f.homeDir, ".wld", "models.json"),
            JSON.stringify({
                providers: {
                    "laptop-http": {
                        api: "openai-completions",
                        baseUrl: `http://127.0.0.1:${port}/v1`,
                        models: [{ id: "remote-model", name: "Remote Model", contextWindow: 128000, maxTokens: 1000 }],
                    },
                },
            }),
        );
        await fsWriteFile(
            join(f.homeDir, ".wld", "auth.json"),
            JSON.stringify({
                "laptop-http": { type: "api_key", key: secret },
            }),
        );
        __resetSettingsForTests();
        await getModelRegistry().refresh();
        const processes: RemoteSubmitProcess[] = [];
        try {
            await run({
                ...f,
                requests,
                async startTui() {
                    const process = await startProcess(f);
                    processes.push(process);
                    return process;
                },
            });
        } finally {
            for (const process of processes) await process.close();
            await provider.shutdown();
        }
    });
}

async function startProcess(f: RuntimeFixture): Promise<RemoteSubmitProcess> {
    const child = spawnNativeProcess(process.execPath, {
        args: runtimeSourceArgs([
            "run",
            "-A",
            "--quiet",
            "--config",
            new URL("../../../../deno.json", import.meta.url).pathname,
            new URL("./remote-submit-client.ts", import.meta.url).pathname,
        ]),
        cwd: f.remoteProject,
        env: {
            HOME: f.remoteHome,
            WLD_TEST_SANDBOX_HOME: f.remoteHome,
            MNEMOTECA_DB_PATH: join(f.remoteHome, "memory.db"),
        },
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
    });
    const writer = child.stdin.getWriter();
    const reader = processLines(child.stdout);
    const stderr = new Response(child.stderr).text();
    await writer.write(
        new TextEncoder().encode(
            JSON.stringify({ connection: f.control.connection, cwd: f.remoteProject, resources: f.resources }) + "\n",
        ),
    );
    let closed = false;
    const send = async (command: RemoteSubmitCommand) =>
        await writer.write(new TextEncoder().encode(JSON.stringify(command) + "\n"));
    return {
        send,
        async read() {
            const next = await within(reader.read(), 12000);
            if (next.done) throw new Error(await stderr);
            return JSON.parse(next.value);
        },
        async close() {
            if (closed) return;
            closed = true;
            await send({ close: true }).catch(() => {});
            await writer.close().catch(() => {});
            try {
                assertEquals((await within(child.status, 5000)).code, 0, await stderr);
            } finally {
                try {
                    child.kill("SIGKILL");
                } catch {
                    /* Already exited. */
                }
                await child.status;
                await reader.cancel().catch(() => {});
                reader.releaseLock();
                writer.releaseLock();
            }
        },
    };
}
