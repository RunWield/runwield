import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { deferred, makeControlFixture, within } from "./session-save-test-fixture.ts";
import { openFileSessionStore } from "../session/file-session-store.ts";
import { RemoteSessionOwner } from "../session/remote-session-owner.ts";
import { parseRemoteSessionTranscript, type RemoteSessionRequest } from "./session-protocol.ts";

type ControlFixture = Awaited<ReturnType<typeof makeControlFixture>>;
type TransportReply = (input: RemoteSessionRequest, response: Response) => Promise<Response>;
interface ClientOptions {
    mode: "save" | "fault" | "manual-fault" | "workflow" | "lifecycle" | "mount" | "reload" | "worker-fault";
    blockedMethod?: string;
    faultGate?: string;
    timeoutMs?: number;
    operation?: string;
}
interface ClientResult {
    failed?: boolean;
    stopped?: boolean;
    readStopped?: boolean;
    writeStopped?: boolean;
    progressStopped?: boolean;
    pendingStopped?: boolean;
    settlementStopped?: boolean;
    checkpointStopped?: boolean;
    lateReadStopped?: boolean;
    lateWriteStopped?: boolean;
    lateCheckpointStopped?: boolean;
    storeStopped?: boolean;
    locatorStopped?: boolean;
    lifecycleStopped?: boolean;
    entries?: number;
    file?: string | null;
    persisted?: boolean;
    pending?: number;
    kind?: string;
    cwd?: string;
}

/** Proxy only the genuine HTTP boundary. All accepted requests reach the actual control service and owner. */
function startTransport(f: ControlFixture, reply: TransportReply) {
    const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
        const contents = await request.text();
        const input: RemoteSessionRequest = JSON.parse(contents);
        const response = await fetch(`${f.baseUrl}/session/request`, {
            method: "POST",
            headers: request.headers,
            body: contents,
        });
        return await reply(input, response);
    });
    const addr = server.addr;
    if (addr.transport !== "tcp") throw new Error("Expected HTTP transport");
    return { baseUrl: `http://127.0.0.1:${addr.port}`, close: () => server.shutdown() };
}

function startClient(f: ControlFixture, baseUrl: string, options: ClientOptions) {
    const marker = join(f.remoteProject, "dependent-marker");
    const child = new Deno.Command(Deno.execPath(), {
        args: [
            "run",
            "-A",
            "--node-modules-dir=manual",
            "--quiet",
            new URL("./session-save-test-client.ts", import.meta.url).pathname,
            JSON.stringify({
                connection: {
                    baseUrl,
                    credential: f.control.credential,
                    operation: options.operation ?? f.owner.operation,
                    timeoutMs: options.timeoutMs ?? 5_000,
                },
                cwd: f.remoteProject,
                marker,
                mount: f.mount,
                ...options,
            }),
        ],
        env: { HOME: f.home, MNEMOTECA_DB_PATH: join(f.home, "mnemoteca.sqlite3") },
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
    }).spawn();
    const output = child.output();
    return {
        marker,
        async releaseFault() {
            const writer = child.stdin.getWriter();
            try {
                await writer.write(new Uint8Array([1]));
                await writer.close();
            } finally {
                writer.releaseLock();
            }
        },
        async result(): Promise<ClientResult> {
            const result = await within(output, 20_000);
            const stderr = new TextDecoder().decode(result.stderr);
            assertEquals(result.code, 0, stderr);
            return JSON.parse(new TextDecoder().decode(result.stdout).trim());
        },
        async close() {
            try {
                child.kill("SIGKILL");
            } catch { /* Process already exited. */ }
            await output;
        },
    };
}

async function assertFileFree(f: ControlFixture, markerExpected: boolean) {
    const files = Array.from(Deno.readDirSync(f.remoteProject)).map((entry) => entry.name).sort();
    assertEquals(files, markerExpected ? ["dependent-marker"] : []);
    assertEquals(Array.from(Deno.readDirSync(f.mount)).map((entry) => entry.name), []);
    await assertRejects(() => Deno.stat(join(f.home, ".wld", "sessions")), Deno.errors.NotFound);
    await assertRejects(() => Deno.stat(join(f.home, ".pi", "agent", "sessions")), Deno.errors.NotFound);
}

Deno.test("remote append cannot return or authorize a dependent action before laptop acknowledgement", async () => {
    const f = await makeControlFixture();
    await f.ready();
    const saved = deferred();
    const release = deferred();
    const proxy = startTransport(f, async (input, response) => {
        if (input.kind === "append" && input.sequence === 1) {
            assertEquals(response.status, 200);
            const bytes = await response.text();
            saved.resolve();
            await release.promise;
            return new Response(bytes, { status: 200 });
        }
        return response;
    });
    const client = startClient(f, proxy.baseUrl, { mode: "save" });
    try {
        await within(saved.promise);
        const entries = parseRemoteSessionTranscript(f.owner.inspect().contents).slice(1);
        assertEquals(entries.length, 1);
        assertEquals(entries[0].type, "custom");
        await assertRejects(() => Deno.stat(client.marker), Deno.errors.NotFound);
        release.resolve();
        const result = await client.result();
        assertEquals(result, { entries: 3, file: null, persisted: false, cwd: f.remoteProject });
        const persisted = parseRemoteSessionTranscript(f.owner.inspect().contents).slice(1);
        assertEquals(persisted.map((entry) => entry.type), ["custom", "message", "compaction"]);
        assertEquals(await Deno.readTextFile(client.marker), "dependent action");
        assertEquals(f.store.inspectSessionActivation(f.session.runwieldSessionId).activation?.state, "idle");
        await assertFileFree(f, true);
    } finally {
        release.resolve();
        await client.close();
        await proxy.close();
        await f.close();
    }
});

Deno.test("real HostedSession workflow waiter cannot advance before accepted event save acknowledgement", async () => {
    const f = await makeControlFixture();
    await f.ready();
    const saved = deferred();
    const release = deferred();
    const proxy = startTransport(f, async (input, response) => {
        if (input.kind === "append" && input.sequence === 1) {
            assertEquals(response.status, 200);
            const bytes = await response.text();
            saved.resolve();
            await release.promise;
            return new Response(bytes);
        }
        return response;
    });
    const client = startClient(f, proxy.baseUrl, { mode: "workflow" });
    try {
        await within(saved.promise);
        assertStringIncludes(f.owner.inspect().contents, '"state":"accepted"');
        await assertRejects(() => Deno.stat(client.marker), Deno.errors.NotFound);
        release.resolve();
        assertEquals(await client.result(), { kind: "plan_written", pending: 0, file: null });
        assertEquals(await Deno.readTextFile(client.marker), "plan_written:remote-plan-call");
        assertStringIncludes(f.owner.inspect().contents, '"state":"settled"');
        await assertFileFree(f, true);
    } finally {
        release.resolve();
        await client.close();
        await proxy.close();
        await f.close();
    }
});

Deno.test("swallowed manual-model save failure leaves retained reads, writes, workflow progress and settlement denied", async () => {
    const f = await makeControlFixture();
    await f.ready();
    const proxy = startTransport(f, async (input, response) => {
        if (input.kind === "append" && input.contents.includes("runwield.manual_model")) {
            assertEquals(response.status, 200);
            await response.text();
            return new Response(null, { status: 503 });
        }
        return response;
    });
    const client = startClient(f, proxy.baseUrl, { mode: "manual-fault" });
    try {
        assertEquals(await client.result(), {
            readStopped: true,
            writeStopped: true,
            progressStopped: true,
            pendingStopped: true,
            settlementStopped: true,
            checkpointStopped: true,
        });
        const transcript = f.owner.inspect().contents;
        assertStringIncludes(transcript, "runwield.manual_model");
        assert(!transcript.includes('"state":"settled"'));
        assert(!transcript.includes("after-fault"));
        f.owner.markUncertain();
        assertEquals(f.store.inspectSessionActivation(f.session.runwieldSessionId).activation?.state, "uncertain");
        await assertFileFree(f, false);
    } finally {
        await client.close();
        await proxy.close();
        await f.close();
    }
});

for (const fault of ["disconnect", "late-ack", "worker-invalid-json", "wrong-evidence"] as const) {
    Deno.test(`remote ${fault} is sticky and fresh reload uses saved laptop evidence without effect replay`, async () => {
        const f = await makeControlFixture();
        await f.ready();
        const saved = deferred();
        const release = deferred();
        const proxy = startTransport(f, async (input, response) => {
            if (input.kind !== "append") return response;
            assertEquals(response.status, 200);
            const bytes = await response.text();
            saved.resolve();
            if (fault === "late-ack") {
                await release.promise;
                return new Response(bytes);
            }
            if (fault === "worker-invalid-json") return new Response("not-json");
            if (fault === "wrong-evidence") {
                const acknowledgement = JSON.parse(bytes);
                acknowledgement.evidence.digestHex = "0".repeat(64);
                return Response.json(acknowledgement);
            }
            // An abruptly closed response stream is a real network disconnect after save.
            return new Response(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.error(new Error("Disconnected laptop acknowledgement"));
                    },
                }),
            );
        });
        const faultGate = fault === "late-ack" ? join(f.home, "fault-observed.json") : undefined;
        const client = startClient(f, proxy.baseUrl, { mode: "fault", timeoutMs: 1_500, faultGate });
        let reload: ReturnType<typeof startClient> | undefined;
        let reloaded: ReturnType<typeof openFileSessionStore> | undefined;
        try {
            await within(saved.promise);
            if (faultGate) {
                for (let attempt = 0;; attempt++) {
                    try {
                        await Deno.stat(faultGate);
                        break;
                    } catch (error) {
                        if (!(error instanceof Deno.errors.NotFound) || attempt >= 1_000) throw error;
                        await new Promise((resolve) => setTimeout(resolve, 10));
                    }
                }
                assertEquals(JSON.parse(await Deno.readTextFile(faultGate)), {
                    failed: true,
                    readStopped: true,
                    writeStopped: true,
                    checkpointStopped: true,
                });
                release.resolve();
                await client.releaseFault();
            }
            assertEquals(await client.result(), {
                failed: true,
                readStopped: true,
                writeStopped: true,
                checkpointStopped: true,
                ...(faultGate ? { lateReadStopped: true, lateWriteStopped: true, lateCheckpointStopped: true } : {}),
            });
            const savedContents = f.owner.inspect().contents;
            assertStringIncludes(savedContents, "already finished");
            f.owner.markUncertain();
            release.resolve();
            f.owner.recoverUncertain();
            f.store.close();
            reloaded = openFileSessionStore({ baseDir: f.baseDir });
            const state = reloaded.inspectSessionActivation(f.session.runwieldSessionId);
            assertEquals(state.activation?.state, "idle");
            const proof = reloaded.acquireSessionActivation({
                runwieldSessionId: f.session.runwieldSessionId,
                projectId: f.session.projectId,
                ownerInstanceId: "reloaded-owner",
                ownerProcessKind: "test",
                phase: "preparing",
                expectedGeneration: state.generation?.generation ?? null,
            });
            const owner = new RemoteSessionOwner(reloaded, proof);
            f.control.registerSessionOwner(owner);
            reload = startClient(f, f.baseUrl, { mode: "reload", operation: owner.operation });
            assertEquals(await reload.result(), { entries: 1, file: null });
            assertEquals(owner.inspect().contents, savedContents);
            await assertFileFree(f, false);
            const stale = await f.post("/session/request", JSON.stringify(f.request("append", 1, "")));
            assertEquals(stale.status, 409);
            await stale.text();
        } finally {
            release.resolve();
            await client.close();
            await reload?.close();
            await proxy.close();
            reloaded?.close();
            await f.close();
        }
    });
}

for (const blockedMethod of ["newSession", "setSessionFile", "createBranchedSession", "constructor", "forkFrom"]) {
    Deno.test(`remote lifecycle ${blockedMethod} fails closed without a local writer fallback`, async () => {
        const f = await makeControlFixture();
        await f.ready();
        const client = startClient(f, f.baseUrl, { mode: "lifecycle", blockedMethod });
        try {
            assertEquals(await client.result(), { stopped: true, readStopped: true });
            assertEquals(f.owner.inspect().contents, f.initial);
            await assertFileFree(f, false);
        } finally {
            await client.close();
            await f.close();
        }
    });
}

Deno.test("detached remote personal mount cannot create a local file store or root Session writer", async () => {
    const f = await makeControlFixture();
    await f.ready();
    const client = startClient(f, f.baseUrl, { mode: "mount" });
    try {
        assertEquals(await client.result(), {
            storeStopped: true,
            locatorStopped: true,
            lifecycleStopped: true,
            file: null,
        });
        assertStringIncludes(f.owner.inspect().contents, '"mount":"detached"');
        await assertFileFree(f, false);
    } finally {
        await client.close();
        await f.close();
    }
});

Deno.test("remote save Worker permission failure wakes the caller and leaves the manager permanently denied", async () => {
    const f = await makeControlFixture();
    await f.ready();
    const client = startClient(f, f.baseUrl, { mode: "worker-fault" });
    try {
        assertEquals(await client.result(), {
            failed: true,
            readStopped: true,
            writeStopped: true,
            checkpointStopped: true,
        });
        assertEquals(f.owner.inspect().contents, f.initial);
        f.owner.markUncertain();
        f.owner.recoverUncertain();
        assertEquals(f.store.inspectSessionActivation(f.session.runwieldSessionId).activation?.state, "idle");
        await assertFileFree(f, false);
    } finally {
        await client.close();
        await f.close();
    }
});
