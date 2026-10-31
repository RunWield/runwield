import { test } from "node:test";
import { serveHttp } from "../http-server.ts";
import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import { join } from "node:path";
import { type RemoteSessionRequest } from "./session-protocol.ts";
import { deferred, makeControlFixture, within } from "./session-save-test-fixture.ts";
import { verificationClient } from "./session-save-verification-fixture.ts";
import { makeSaveModelRuntime } from "./session-save-agent-fixture.ts";
import { handleModelRequest, LocalModelBridge } from "./model-bridge.ts";

for (const barrier of ["user", "toolCall", "toolResult"] as const) {
    test(`real Pi ${barrier} save acknowledgement blocks dependent model or remote tool progress`, async () => {
        const f = await makeControlFixture();
        await f.ready();
        const contexts: string[] = [];
        const modelBridge = new LocalModelBridge(await makeSaveModelRuntime(contexts));
        const saved = deferred();
        const release = deferred();
        let held = false;
        const server = serveHttp({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
            if (request.headers.get("Authorization") !== `Bearer ${f.control.credential}`) {
                return new Response(null, { status: 401 });
            }
            const path = new URL(request.url).pathname;
            if (path.startsWith("/models/")) return await handleModelRequest(modelBridge, request, path);
            const body = await request.text();
            const input: RemoteSessionRequest = JSON.parse(body);
            const response = await fetch(`${f.baseUrl}/session/request`, {
                method: "POST",
                headers: request.headers,
                body,
            });
            const target =
                barrier === "user"
                    ? '"role":"user"'
                    : barrier === "toolCall"
                      ? '"type":"toolCall"'
                      : '"role":"toolResult"';
            if (!held && input.kind === "append" && input.contents.includes(target)) {
                held = true;
                assertEquals(response.status, 200);
                const bytes = await response.text();
                saved.resolve();
                await release.promise;
                return new Response(bytes);
            }
            return response;
        });
        assert(server.addr.transport === "tcp");
        const client = verificationClient(f, `http://127.0.0.1:${server.addr.port}`, {
            mode: "turn",
            modelConnection: { port: server.addr.port, credential: f.control.credential },
        });
        try {
            await within(saved.promise);
            assertEquals(contexts.length, barrier === "user" ? 0 : 1);
            if (barrier === "toolResult") {
                assertEquals(await fsReadFile(join(f.remoteProject, "dependent-marker"), "utf8"), "effect\n");
            } else {
                await assertRejects(() => fsStat(join(f.remoteProject, "dependent-marker")), Error, "ENOENT");
            }
            assertEquals(f.store.inspectSessionActivation(f.session.runwieldSessionId).generation, null);
            release.resolve();
            const result = await client.result();
            assertEquals(result.effects, 1);
            assertEquals(result.roles, ["system", "user", "assistant", "toolResult", "assistant"]);
            assert(contexts.length >= 3, "the full turn and real compaction must reach the laptop provider");
        } finally {
            release.resolve();
            await client.close();
            await server.shutdown();
            modelBridge.close();
            await f.close();
        }
    });
}
