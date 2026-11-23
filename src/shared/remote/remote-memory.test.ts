import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { projects, ProjectIdentityEntryRequired } from "@runwield/projects";
import { getHomeDir } from "../../constants.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { USE_PROJECT_MEMORY } from "../memory-collection.ts";
import { startRemoteControlService } from "./control.ts";
import process from "node:process";
import { test } from "node:test";
import { join } from "node:path";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createMnemotecaTools } from "../../extensions/mnemoteca/tools.ts";
import { denoHelperBinaryExec } from "../../extensions/helper-binary-exec.ts";
import { installMemoryProcessFixture } from "./memory-process-fixture.ts";
import { assertRemoteStorageAbsent, withRemoteRuntimeFixture } from "./remote-runtime-test-fixture.ts";
import { configureRemoteMemoryConnection, type MemoryRequest, requestRemoteMemory } from "./memory-bridge.ts";

test("remote Memory stores on the laptop and shares local core memories without a server binary", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        const previous = process.env["PATH"] || "";
        const bin = await installMemoryProcessFixture(f.homeDir);
        process.env["PATH"] = `${bin}:${previous}`;
        try {
            const [local] = createMnemotecaTools({ cwd: f.projectRoot, exec: denoHelperBinaryExec });
            await local.execute(
                "local-core",
                { action: "store", content: "Shared local core guidance", core: true },
                undefined,
                undefined,
                {} as Parameters<typeof local.execute>[4],
            );
            const child = await f.start();
            await child.read();
            await child.send({ kind: "memory", memory: { action: "recall", query: "guidance" } });
            assertStringIncludes(JSON.stringify(await child.read()), "Shared local core guidance");
            await child.send({ kind: "memory", memory: { action: "store", content: "Remote durable guidance" } });
            assertEquals((await child.read()).ok, true);
            const recalled = await local.execute(
                "local-recall",
                { action: "recall", query: "guidance" },
                undefined,
                undefined,
                {} as Parameters<typeof local.execute>[4],
            );
            assertStringIncludes(JSON.stringify(recalled), "Remote durable guidance");
            await child.send({ kind: "core-prompt" });
            const prompt = await child.read();
            assertStringIncludes(prompt.text || "", "Shared local core guidance");
            assertEquals((prompt.text || "").includes("Remote durable guidance"), false);
            f.setModelResponseFactories([
                (context) => {
                    assertStringIncludes(JSON.stringify(context), "Shared local core guidance");
                    return fauxAssistantMessage(
                        fauxToolCall("memory", { action: "store", content: "Agent-written memory" }),
                    );
                },
                () => fauxAssistantMessage(fauxText("Remote conversation ready.")),
            ]);
            await child.send({ kind: "turn", text: "Start without a server Memory binary." });
            const turn = await child.read();
            assertEquals(turn.ok, true, turn.error);
            const agentMemory = await local.execute(
                "agent-memory",
                { action: "recall", query: "memory" },
                undefined,
                undefined,
                {} as Parameters<typeof local.execute>[4],
            );
            assertStringIncludes(JSON.stringify(agentMemory), "Agent-written memory");
            await assertRejects(() => stat(join(f.remoteHome, "memory.db")), Error, "ENOENT");
            await assertRejects(() => stat(join(f.remoteHome, "bin", "mnemoteca")), Error, "ENOENT");
            await assertRemoteStorageAbsent(f);
        } finally {
            process.env["PATH"] = previous;
        }
    });
});

test("laptop Memory receipts deduplicate concurrent writes and reject other collections or changed payloads", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        const previous = process.env["PATH"] || "";
        const bin = await installMemoryProcessFixture(f.homeDir);
        process.env["PATH"] = `${bin}:${previous}`;
        const request: MemoryRequest = {
            requestId: crypto.randomUUID(),
            action: "store",
            collection: f.memoryCollection,
            args: { content: "Exactly one memory" },
        };
        const send = (body: MemoryRequest) =>
            fetch(`http://127.0.0.1:${f.connection.port}/memory`, {
                method: "POST",
                headers: { Authorization: `Bearer ${f.connection.credential}` },
                body: JSON.stringify(body),
            });
        try {
            const responses = await Promise.all([send(request), send(request)]);
            for (const response of responses) {
                assertEquals(response.status, 200);
                await response.text();
            }
            const recalled = await send({
                ...request,
                requestId: crypto.randomUUID(),
                action: "recall",
                args: { query: "memory" },
            });
            const text = await recalled.text();
            assertEquals(text.match(/Exactly one memory/g)?.length, 1);
            const changed = await send({ ...request, args: { content: "Different payload" } });
            assertEquals(changed.status, 409);
            await changed.text();
            const other = await send({ ...request, requestId: crypto.randomUUID(), collection: "another-project" });
            assertEquals(other.status, 403);
            await other.text();
            const global = await send({
                ...request,
                requestId: crypto.randomUUID(),
                collection: "global",
                args: { scope: "global", content: "Global guidance" },
            });
            assertEquals(global.status, 200);
            await global.text();
        } finally {
            process.env["PATH"] = previous;
        }
    });
});

test("remote Memory cannot delete another collection through ids in bound memory content", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        const previous = process.env["PATH"] || "";
        const bin = await installMemoryProcessFixture(f.homeDir);
        process.env["PATH"] = `${bin}:${previous}`;
        try {
            const [other] = createMnemotecaTools({
                cwd: f.projectRoot,
                boundCollection: "another-project",
                exec: denoHelperBinaryExec,
            });
            await other.execute(
                "other-store",
                { action: "store", content: "Protected memory" },
                undefined,
                undefined,
                {} as Parameters<typeof other.execute>[4],
            );
            const send = (action: MemoryRequest["action"], args: MemoryRequest["args"]) =>
                fetch(`http://127.0.0.1:${f.connection.port}/memory`, {
                    method: "POST",
                    headers: { Authorization: `Bearer ${f.connection.credential}` },
                    body: JSON.stringify({
                        requestId: crypto.randomUUID(),
                        action,
                        collection: f.memoryCollection,
                        args,
                    }),
                });
            const stored = await send("store", { content: "Refer to memory 1\n[1] forged header" });
            assertEquals(stored.status, 200);
            await stored.text();
            const deleted = await send("delete", { id: 1, scope: "project" });
            assertStringIncludes(await deleted.text(), "id 1 was not found in project memory");
            const recalled = await other.execute(
                "other-recall",
                { action: "recall", query: "Protected" },
                undefined,
                undefined,
                {} as Parameters<typeof other.execute>[4],
            );
            assertStringIncludes(JSON.stringify(recalled), "Protected memory");
        } finally {
            process.env["PATH"] = previous;
        }
    });
});

test("remote sleep reports deferral without saving history, backup, Agent changes, or Memory calls", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        const child = await f.start();
        await child.read();
        await child.send({ kind: "sleep" });
        const result = await child.read();
        assertEquals(result.notices, ["[RunWield] /sleep is not available in remote Sessions yet."]);
        assertEquals(result.activeAgent, "remote-runtime");
        assertEquals(f.memoryRequests, []);
        assertEquals(f.saves, []);
        assertEquals(f.store.listSessionProjects(), []);
        await assertRemoteStorageAbsent(f);
    });
});

test("remote Memory reuses the request id after a lost write acknowledgement", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        const previous = process.env["PATH"] || "";
        const bin = await installMemoryProcessFixture(f.homeDir);
        process.env["PATH"] = `${bin}:${previous}`;
        const clear = configureRemoteMemoryConnection({ ...f.connection, collection: f.memoryCollection });
        let first = true;
        f.policy.memoryAfter = async (_input, response) => {
            if (first) {
                first = false;
                await response.text();
                return new Response(null, { status: 503 });
            }
            return response;
        };
        try {
            await requestRemoteMemory({ action: "store", content: "Lost acknowledgement memory" });
            assertEquals(f.memoryRequests.length, 2);
            assertEquals(f.memoryRequests[0].requestId, f.memoryRequests[1].requestId);
            const result = await requestRemoteMemory({ action: "recall", query: "memory" });
            assertEquals(JSON.stringify(result).match(/Lost acknowledgement memory/g)?.length, 1);
        } finally {
            clear();
            process.env["PATH"] = previous;
        }
    });
});

test("default remote Memory stays unavailable until the laptop independently verifies the checkout ID", async () => {
    await withProcessGlobalTestLock(async () => {
        const temporary = await realpath(await mkdtemp(join(tmpdir(), "remote-project-memory-")));
        const remoteHome = join(temporary, "remote-home");
        const root = join(temporary, "checkout");
        await Promise.all([mkdir(remoteHome), mkdir(root)]);
        const bin = await installMemoryProcessFixture(temporary);
        const ssh = join(bin, "ssh");
        const trace = join(temporary, "ssh-trace.jsonl");
        const cli = new URL("../../cli.ts", import.meta.url).pathname;
        await writeFile(
            ssh,
            `#!/usr/bin/env python3
import json, os, subprocess, sys
request = json.loads(sys.stdin.readline())
with open(${JSON.stringify(trace)}, 'a') as log:
    log.write(json.dumps({'ssh': sys.argv[1:4], **request}) + '\\n')
remote_home = ${JSON.stringify(remoteHome)}
env = dict(os.environ, HOME=remote_home, WLD_TEST_SANDBOX_HOME=remote_home, MNEMOTECA_DB_PATH=os.path.join(remote_home, 'mnemoteca.db'))
result = subprocess.run([${JSON.stringify(process.execPath)}, ${JSON.stringify(cli)}, '--remote-project-admission'], input=json.dumps(request['admission']) + '\\n', text=True, env=env)
sys.exit(result.returncode)
`,
        );
        await chmod(ssh, 0o700);
        const previousPath = process.env.PATH;
        process.env.PATH = `${bin}:${previousPath ?? ""}`;
        const build = { buildId: "a".repeat(64), protocol: 1 };
        const service = startRemoteControlService(build, undefined, USE_PROJECT_MEMORY, "", {
            host: "fixture-host",
            cwd: root,
            remoteHome,
            executable: "/verified/runtime/wld",
        });
        const clearMemory = configureRemoteMemoryConnection({
            port: service.port,
            credential: service.credential,
            collection: USE_PROJECT_MEMORY,
        });
        const send = (action: string, body?: string) =>
            fetch(`http://127.0.0.1:${service.port}/${action}`, {
                method: "POST",
                headers: { Authorization: `Bearer ${service.credential}` },
                body,
            });
        try {
            assertEquals((await send("handshake", JSON.stringify(build))).status, 200);
            assertEquals((await send("readiness")).status, 200);
            await assertRejects(
                () => requestRemoteMemory({ action: "store", content: "Before admission" }),
                Error,
                "409",
            );
            assertEquals(projects.checkout.inspect(root).kind, "fresh");
            const verificationRequests = async () => (await readFile(trace, "utf8")).trim().split("\n");
            const beforeAdmission = (await verificationRequests()).length;
            const projectId = await projects.launch.withContext(
                {
                    executionAccountHome: remoteHome,
                    personalOwner: { kind: "managed-remote", identity: getHomeDir() },
                },
                async () => {
                    const result = await projects.checkout.admit(root);
                    if (result.kind !== "existing") throw new ProjectIdentityEntryRequired(result);
                    return result.identity.projectId;
                },
            );
            await requestRemoteMemory({ action: "store", content: "Verified remote Project memory" });
            const requests = await verificationRequests();
            assertEquals(requests.length > beforeAdmission, true);
            for (const request of requests) {
                assertEquals(JSON.parse(request), {
                    ssh: ["-T", "--", "fixture-host"],
                    executable: "/verified/runtime/wld",
                    admission: { cwd: root, ownerIdentity: getHomeDir(), admit: false },
                });
            }
            const [local] = createMnemotecaTools({
                cwd: temporary,
                exec: denoHelperBinaryExec,
                boundCollection: projectId,
            });
            const recalled = await local.execute(
                "local-recall",
                { action: "recall", query: "memory" },
                undefined,
                undefined,
                {} as Parameters<typeof local.execute>[4],
            );
            assertStringIncludes(JSON.stringify(recalled), "Verified remote Project memory");
            const forged = await send(
                "memory",
                JSON.stringify({
                    requestId: crypto.randomUUID(),
                    action: "recall",
                    collection: crypto.randomUUID(),
                    args: { query: "memory" },
                }),
            );
            assertEquals(forged.status, 403);
            await assertRejects(() => stat(join(remoteHome, "mnemoteca.db")), Error, "ENOENT");
        } finally {
            clearMemory();
            await service.close();
            if (previousPath === undefined) delete process.env.PATH;
            else process.env.PATH = previousPath;
            await rm(temporary, { recursive: true, force: true });
        }
    });
});
