import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execPath } from "node:process";
import { setImmediate, setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { deepStrictEqual, ok, rejects } from "node:assert/strict";
import { connectAcpClient, connectAcpServer, type AcpServerOptions } from "@runwield/acp";
import { PROTOCOL_VERSION } from "@runwield/acp/protocol";
import {
    RequestError,
    type InitializeRequest,
    type InitializeResponse,
    type NewSessionRequest,
    type NewSessionResponse,
} from "@agentclientprotocol/sdk/unstable";
import { createInteractiveSessionRuntime } from "@runwield/session-runtime/services";
import { withRuntimeCommandFixture } from "../cmd/testing/runtime-command-fixture.ts";
import { openFileSessionStore } from "../shared/session/file-session-store.ts";
import { startRemoteControlService } from "../shared/remote/control.ts";
import { RemoteSessionControl } from "../shared/remote/session-control-client.ts";
import { runtimeSourceArgs } from "../testing/runtime-source-args.ts";
import { makeManagedSessionFixture } from "../testing/managed-session-fixture.ts";

function connect(options: Pick<AcpServerOptions, "runtime">) {
    const toServer = new TransformStream<Uint8Array>();
    const toClient = new TransformStream<Uint8Array>();
    const server = connectAcpServer({
        ...options,
        transport: { readable: toServer.readable, writable: toClient.writable },
    });
    const client = connectAcpClient({ transport: { readable: toClient.readable, writable: toServer.writable } });
    return { server, client };
}

test("closing one ACP connection releases only the Sessions it opened on the supplied runtime", async () => {
    await withRuntimeCommandFixture("acp-shared-runtime-", async ({ projectRoot }) => {
        const store = openFileSessionStore();
        const runtime = createInteractiveSessionRuntime({ sessionStore: store, ownerProcessKind: "acp" });
        const base = await runtime.createSession({ cwd: projectRoot });
        const options = { runtime };
        const first = connect(options);
        const second = connect(options);
        const openIds = () =>
            runtime
                .listSessions()
                .map((session) => session.id)
                .sort();
        try {
            const initialize = { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { auth: { terminal: true } } };
            const initialized = await first.client.agent.request<InitializeResponse, InitializeRequest>(
                "initialize",
                initialize,
            );
            deepStrictEqual(initialized.authMethods ?? [], []);
            const metadata = initialized.agentCapabilities?.sessionCapabilities?._meta?.runwield;
            ok(metadata && typeof metadata === "object" && "implementedMethods" in metadata);
            ok(Array.isArray(metadata.implementedMethods));
            deepStrictEqual(metadata.implementedMethods.includes("session/set_config_option"), false);
            await second.client.agent.request("initialize", initialize);
            const params = { cwd: projectRoot, mcpServers: [] };
            const firstOpened = await first.client.agent.request<NewSessionResponse, NewSessionRequest>(
                "session/new",
                params,
            );
            deepStrictEqual(firstOpened.configOptions ?? [], []);
            const firstId = openIds().find((id) => id !== base.sessionId);
            ok(firstId);
            await second.client.agent.request("session/new", params);
            const secondId = openIds().find((id) => id !== base.sessionId && id !== firstId);
            ok(secondId);

            first.server.close();
            await first.server.closed;
            deepStrictEqual(openIds(), [base.sessionId, secondId].sort());

            second.server.close();
            await second.server.closed;
            deepStrictEqual(openIds(), [base.sessionId]);
        } finally {
            first.client.close();
            second.client.close();
            first.server.close();
            second.server.close();
            await Promise.allSettled([first.server.closed, second.server.closed]);
            await runtime.closeAllSessionsWhenIdle();
            store.close();
        }
    });
});

test("ACP shutdown waits for a Session opening through MCP and closes it", async () => {
    await withRuntimeCommandFixture("acp-open-shutdown-", async ({ projectRoot }) => {
        const mcpFixture = fileURLToPath(new URL("../shared/mcp/fixture-server.ts", import.meta.url));
        const logPath = join(projectRoot, "mcp.log");
        const releasePath = join(projectRoot, "mcp.release");
        await writeFile(logPath, "");

        const store = openFileSessionStore();
        const runtime = createInteractiveSessionRuntime({ sessionStore: store, ownerProcessKind: "acp" });
        const { client, server } = connect({ runtime });
        try {
            await client.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
            const opened = client.agent.request("session/new", {
                cwd: projectRoot,
                mcpServers: [
                    {
                        name: "delayed",
                        command: execPath,
                        args: runtimeSourceArgs(["run", "-A", mcpFixture]),
                        env: [
                            { name: "RUNWIELD_MCP_FIXTURE_LOG", value: logPath },
                            { name: "RUNWIELD_MCP_FIXTURE_INIT_RELEASE", value: releasePath },
                        ],
                    },
                ],
            });
            void opened.catch(() => {});

            const deadline = Date.now() + 5_000;
            while (!(await readFile(logPath, "utf8")).includes('"event":"initializing"')) {
                if (Date.now() >= deadline) throw new Error("MCP initialization did not begin");
                await setTimeout(10);
            }

            server.close();
            let closed = false;
            const drained = server.closed.then(() => {
                closed = true;
            });
            await setImmediate();
            deepStrictEqual(closed, false);

            await writeFile(releasePath, "");
            await drained;
            deepStrictEqual(runtime.listSessions(), []);
        } finally {
            await writeFile(releasePath, "");
            client.close();
            server.close();
            await Promise.allSettled([server.closed]);
            await runtime.closeAllSessionsWhenIdle();
            store.close();
        }
    });
});

test("concurrent ACP loads retain one runtime Session across saved Session aliases", async () => {
    await withRuntimeCommandFixture("acp-concurrent-load-", async ({ homeDir, projectRoot }) => {
        const fixture = await makeManagedSessionFixture({ home: homeDir, projectRoot });
        const store = fixture.openStore();
        const runtime = createInteractiveSessionRuntime({ sessionStore: store, ownerProcessKind: "acp" });
        const { client, server } = connect({ runtime });
        try {
            await client.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
            const { runwieldSessionId, piSessionId } = fixture.session;
            for (const alias of [runwieldSessionId, `acp-${runwieldSessionId}`, piSessionId]) {
                const params = {
                    cwd: projectRoot,
                    mcpServers: [],
                    _meta: { runwield: { sessionPath: fixture.transcriptPath } },
                };
                const ids = [runwieldSessionId, alias];
                const results = await Promise.allSettled(
                    ids.map((sessionId) => client.agent.request("session/load", { ...params, sessionId })),
                );
                const failed = results.find((result) => result.status === "rejected");
                ok(failed?.reason instanceof RequestError);
                deepStrictEqual(failed.reason.code, -32002, `${alias}: ${failed.reason.message}`);
                const loadedIndex = results.findIndex((result) => result.status === "fulfilled");
                ok(loadedIndex >= 0);
                deepStrictEqual(runtime.listSessions().length, 1);
                await client.agent.request("session/close", { sessionId: ids[loadedIndex] });
                deepStrictEqual(runtime.listSessions(), []);
            }
        } finally {
            client.close();
            server.close();
            await Promise.allSettled([server.closed]);
            await runtime.closeAllSessionsWhenIdle();
            store.close();
            await fixture.cleanup();
        }
    });
});

test("a remote-backed runtime keeps its mapped Session open when ACP deletion is unavailable", async () => {
    await withRuntimeCommandFixture("acp-no-local-store-", async ({ projectRoot }) => {
        const service = startRemoteControlService({ buildId: "a".repeat(64), protocol: 1 });
        const runtime = createInteractiveSessionRuntime({
            sessionStore: null,
            remoteSessionControl: new RemoteSessionControl({ port: service.port, credential: service.credential }),
        });
        const { client, server } = connect({ runtime });
        try {
            const initialized = await client.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION });
            deepStrictEqual(initialized.agentCapabilities?.sessionCapabilities?.delete, undefined);
            const metadata = initialized.agentCapabilities?.sessionCapabilities?._meta?.runwield;
            ok(metadata && typeof metadata === "object" && "implementedMethods" in metadata);
            ok(Array.isArray(metadata.implementedMethods));
            deepStrictEqual(metadata.implementedMethods.includes("session/delete"), false);

            const opened = await client.agent.request<NewSessionResponse, NewSessionRequest>("session/new", {
                cwd: projectRoot,
                mcpServers: [],
            });
            const [session] = runtime.listSessions();
            ok(session);
            for (const sessionId of [opened.sessionId, crypto.randomUUID()]) {
                await rejects(
                    client.agent.request("session/delete", { sessionId }),
                    (error) => error instanceof RequestError && error.code === -32004,
                );
                ok(runtime.getSessionSnapshot(session.id));
            }
            await client.agent.request("session/close", { sessionId: opened.sessionId });
            deepStrictEqual(runtime.listSessions(), []);
        } finally {
            client.close();
            server.close();
            await server.closed;
            await runtime.closeAllSessionsWhenIdle();
            await service.close();
        }
    });
});
