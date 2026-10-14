import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { processLines } from "./remote-runtime-lines.ts";
import {
    type RuntimeCommandFixture,
    type RuntimeCommandFixtureOptions,
    withRuntimeCommandFixture,
} from "../../cmd/testing/runtime-command-fixture.ts";
import { defineCommittedGitFixture } from "../git-test-fixture.ts";
import { openFileSessionStore } from "../session/file-session-store.ts";
import { resolveMemoryCollection } from "../memory-collection.ts";
import { writeWorkflowBinaryFixtures } from "../../testing/workflow-binary-fixtures.ts";
import type { MemoryRequest } from "./memory-bridge.ts";
import { startRemoteControlService } from "./control.ts";
import { RemoteSessionControl } from "./session-control-client.ts";
import type {
    RemoteSessionControlRequest,
    RemoteSessionControlResponse,
    RemoteSessionRequest,
} from "./session-protocol.ts";
import type { RuntimeClientCommand, RuntimeClientInput, RuntimeClientReport } from "./remote-runtime-test-client.ts";

const repositories = defineCommittedGitFixture({ "sentinel.txt": "remote initial\n" });
export function latch() {
    let release = () => {};
    const promise = new Promise<void>((resolve) => release = resolve);
    return { promise, release };
}
export async function within<T>(promise: Promise<T>, ms = 20000): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) =>
                timeout = setTimeout(() => reject(new Error("Remote runtime timeout")), ms)
            ),
        ]);
    } finally {
        clearTimeout(timeout);
    }
}
export interface CapturedControl {
    request: RemoteSessionControlRequest;
    response: string;
}
export interface RuntimeProxyPolicy {
    memoryAfter?: (input: MemoryRequest, response: Response) => Promise<Response>;
    before?: (
        request: RemoteSessionRequest | RemoteSessionControlRequest,
        path: string,
    ) => Promise<Response | undefined>;
    handle?: (
        request: RemoteSessionRequest | RemoteSessionControlRequest,
        path: string,
        response: Response,
    ) => Promise<Response>;
}
export interface RuntimeModelRequestOptions {
    maxTokens?: number;
}
export interface RuntimeModelRequest {
    provider: string;
    model: string;
    simple: boolean;
    options: RuntimeModelRequestOptions;
}
export interface RuntimeFixture extends RuntimeCommandFixture {
    remoteProject: string;
    remoteHome: string;
    resources: string;
    memoryCollection: string;
    memoryRequests: MemoryRequest[];
    connection: { port: number; credential: string };
    store: ReturnType<typeof openFileSessionStore>;
    control: RemoteSessionControl;
    controls: CapturedControl[];
    saves: RemoteSessionRequest[];
    modelRequests: RuntimeModelRequest[];
    policy: RuntimeProxyPolicy;
    start(): Promise<RuntimeProcess>;
}
export interface RuntimeProcess {
    send(command: RuntimeClientCommand): Promise<void>;
    read(): Promise<RuntimeClientReport>;
    close(): Promise<void>;
}
async function startProcess(
    input: RuntimeClientInput,
    remoteHome: string,
    remotePath: string,
): Promise<RuntimeProcess> {
    const child = new Deno.Command(Deno.execPath(), {
        args: [
            "run",
            "-A",
            "--quiet",
            "--config",
            new URL("../../../deno.json", import.meta.url).pathname,
            new URL("./remote-runtime-test-client.ts", import.meta.url).pathname,
        ],
        cwd: input.cwd,
        env: {
            HOME: remoteHome,
            WLD_TEST_SANDBOX_HOME: remoteHome,
            MNEMOTECA_DB_PATH: join(remoteHome, "memory.db"),
            PATH: remotePath,
        },
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
    }).spawn();
    const writer = child.stdin.getWriter();
    const reader = processLines(child.stdout);
    const stderr = new Response(child.stderr).text();
    async function send(value: RuntimeClientInput | RuntimeClientCommand) {
        await writer.write(new TextEncoder().encode(JSON.stringify(value) + "\n"));
    }
    await send(input);
    return {
        send,
        async read() {
            const next = await within(reader.read());
            if (next.done) throw new Error(`Remote client exited: ${await stderr}`);
            return JSON.parse(next.value);
        },
        async close() {
            await send({ kind: "close" }).catch(() => {});
            await writer.close().catch(() => {});
            writer.releaseLock();
            try {
                const status = await within(child.status, 5000);
                assertEquals(status.code, 0, await stderr);
            } finally {
                try {
                    child.kill("SIGKILL");
                } catch { /* Already exited. */ }
                await child.status;
                await reader.cancel().catch(() => {});
                reader.releaseLock();
                await stderr;
            }
        },
    };
}
export async function withRemoteRuntimeFixture(
    run: (fixture: RuntimeFixture) => Promise<void>,
    options: RuntimeCommandFixtureOptions = {},
) {
    await withRuntimeCommandFixture("remote-runtime-", async (local) => {
        const remoteProject = await repositories.checkout();
        const remoteHome = await Deno.makeTempDir({ prefix: "remote-runtime-home-" });
        const remoteBin = await writeWorkflowBinaryFixtures(remoteHome);
        await Deno.remove(join(remoteBin, "mnemoteca"));
        const remotePath = `${remoteBin}:/usr/bin:/bin`;
        const resources = join(remoteHome, "mounted-personal-resources");
        await Deno.mkdir(join(resources, "agents"), { recursive: true });
        await Deno.mkdir(join(remoteHome, ".wld"), { recursive: true });
        await Deno.copyFile(local.settingsPath, join(resources, "settings.json"));
        await Deno.writeTextFile(
            join(resources, "agents", "remote-runtime.md"),
            `---\nname: Remote Runtime\ndescription: Test project conversation\ntools:\n    - read\n    - write\n    - see_image\n    - memory\n---\nUse project tools when asked, then answer.\n`,
        );
        await Deno.writeTextFile(join(remoteHome, ".wld", "settings.json"), "remote profile must not be read");
        await Deno.writeTextFile(join(local.projectRoot, "sentinel.txt"), "laptop initial\n");
        const store = openFileSessionStore({ baseDir: join(local.homeDir, "laptop-history") });
        const identity = { buildId: "a".repeat(64), protocol: 1 };
        const memoryCollection = await resolveMemoryCollection({ cwd: local.projectRoot });
        const service = startRemoteControlService(identity, {
            store,
            targetLabel: `fixture:${remoteProject}`,
            target: {
                host: {
                    hostname: "remote-runtime.example",
                    user: "tester",
                    port: 22,
                    hostKeyFingerprint: "SHA256:runtime",
                },
                cwd: remoteProject,
                home: remoteHome,
                os: "Linux",
                arch: "x86_64",
                gitRoot: remoteProject,
                gitDir: join(remoteProject, ".git"),
                gitCommonDir: join(remoteProject, ".git"),
                primaryRoot: remoteProject,
                isWorktree: false,
            },
        }, memoryCollection);
        const controls: CapturedControl[] = [];
        const saves: RemoteSessionRequest[] = [];
        const modelRequests: RuntimeModelRequest[] = [];
        const memoryRequests: MemoryRequest[] = [];
        const policy: RuntimeProxyPolicy = {};
        const baseUrl = `http://127.0.0.1:${service.port}`;
        const proxy = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
            const path = new URL(request.url).pathname;
            const body = request.method === "POST" ? await request.text() : undefined;
            if (path === "/memory" && body) memoryRequests.push(JSON.parse(body));
            if (path === "/models/stream" && body) modelRequests.push(JSON.parse(body));
            if (body && policy.before && (path === "/session/control" || path === "/session/request")) {
                const input: RemoteSessionRequest | RemoteSessionControlRequest = JSON.parse(body);
                const interrupted = await policy.before(input, path);
                if (interrupted) return interrupted;
            }
            const response = await fetch(`${baseUrl}${path}`, {
                method: request.method,
                headers: request.headers,
                body,
            });
            if (path === "/memory" && body && policy.memoryAfter) {
                return await policy.memoryAfter(JSON.parse(body), response);
            }
            if (path === "/session/control" || path === "/session/request") {
                const input: RemoteSessionControlRequest | RemoteSessionRequest = JSON.parse(body || "{}");
                if (path === "/session/control") {
                    controls.push({
                        request: input as RemoteSessionControlRequest,
                        response: await response.clone().text(),
                    });
                } else saves.push(input as RemoteSessionRequest);
                if (policy.handle) return await policy.handle(input, path, response);
            }
            return response;
        });
        assert(proxy.addr.transport === "tcp");
        const connection = { port: proxy.addr.port, credential: service.credential };
        const processes: RuntimeProcess[] = [];
        try {
            for (const [path, body] of [["handshake", JSON.stringify(identity)], ["readiness", ""]]) {
                const response = await fetch(`${baseUrl}/${path}`, {
                    method: "POST",
                    headers: { Authorization: `Bearer ${service.credential}` },
                    body,
                });
                await response.text();
                assertEquals(response.ok, true);
            }
            await run({
                ...local,
                remoteProject,
                remoteHome,
                resources,
                memoryCollection,
                memoryRequests,
                connection,
                store,
                control: new RemoteSessionControl(connection),
                controls,
                saves,
                modelRequests,
                policy,
                async start() {
                    const process = await startProcess(
                        { connection, resources, cwd: remoteProject, memoryCollection },
                        remoteHome,
                        remotePath,
                    );
                    processes.push(process);
                    return process;
                },
            });
        } finally {
            for (const process of processes) await process.close();
            await proxy.shutdown();
            await service.close();
            store.close();
            await Deno.remove(remoteProject, { recursive: true });
            await Deno.remove(remoteHome, { recursive: true });
        }
    }, options);
}
export function assertSmallControlBodies(f: RuntimeFixture) {
    for (const exchange of f.controls) {
        const allowed = exchange.request.kind === "create"
            ? ["kind", "name", "sessionId", "admissionId"]
            : exchange.request.kind === "begin"
            ? ["kind", "sessionId", "admissionId"]
            : exchange.request.kind === "list"
            ? ["kind", "sessionId"]
            : exchange.request.kind === "markUncertain"
            ? ["kind", "operation", "admissionId"]
            : ["kind", "operation"];
        assert(Object.keys(exchange.request).every((key) => allowed.includes(key)), JSON.stringify(exchange));
        const receipt: RemoteSessionControlResponse = JSON.parse(exchange.response);
        assert(Object.keys(receipt).every((key) => ["operation", "sessions"].includes(key)), exchange.response);
        if (Array.isArray(receipt.sessions)) {
            for (const summary of receipt.sessions) {
                assert(
                    Object.keys(summary).every((key) =>
                        ["id", "name", "firstMessage", "messageCount", "modified", "generation", "contents"].includes(
                            key,
                        )
                    ),
                    exchange.response,
                );
            }
        }
        assertEquals(
            exchange.response.includes(f.store.path),
            false,
            "Laptop history paths must not cross Session control",
        );
    }
}

export async function assertRemoteStorageAbsent(f: RuntimeFixture) {
    for (const root of [f.remoteHome, f.remoteProject]) {
        for (const name of ["sessions", "session-store"]) {
            try {
                await Deno.stat(join(root, ".wld", name));
                throw new Error(`Remote Session storage exists: ${root}/${name}`);
            } catch (error) {
                if (!(error instanceof Deno.errors.NotFound)) throw error;
            }
        }
    }
    async function findTranscripts(root: string): Promise<string[]> {
        const found: string[] = [];
        for await (const entry of Deno.readDir(root)) {
            if (entry.name === ".git") continue;
            const path = join(root, entry.name);
            if (entry.isDirectory) found.push(...await findTranscripts(path));
            else if (entry.name.endsWith(".jsonl")) found.push(path);
        }
        return found;
    }
    assertEquals(await findTranscripts(f.remoteHome), []);
    assertEquals(await findTranscripts(f.remoteProject), []);
    assertEquals(
        await Deno.readTextFile(join(f.remoteHome, ".wld", "settings.json")),
        "remote profile must not be read",
    );
}
