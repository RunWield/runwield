import { createServer } from "node:http";
import { test } from "node:test";
import { equal, deepEqual, ok, rejects } from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { packageFixture } from "../testing/plan-package-fixture.ts";
import {
    authorLocalPlan,
    PreparedProjectStore,
    registerHomeProjectOwner,
    type HomeProjectOwner,
    loadPlan,
    type ProjectStoreBinding,
    type ProjectStoreCommand,
} from "../../plan-store/index.ts";
import { startRemoteControlService } from "./control.ts";
import { ProjectStoreClient } from "./project-store-client.ts";
const build = { buildId: "a".repeat(64), protocol: 1 };
async function admit(endpoint: string, credential: string) {
    for (const action of ["handshake", "readiness"]) {
        const response = await fetch(`${endpoint}/${action}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${credential}` },
            body: action === "handshake" ? JSON.stringify(build) : undefined,
        });
        equal(response.status, 200);
    }
}
interface Owner {
    port: number;
    credential: string;
    binding: ProjectStoreBinding;
}
const driver = fileURLToPath(new URL("./project-store-process.ts", import.meta.url));
async function owner(root: string | HomeProjectOwner) {
    const child = spawn(process.execPath, [driver, "owner", typeof root === "string" ? root : JSON.stringify(root)], {
        stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "",
        error = "";
    child.stderr.on("data", (chunk) => {
        error += chunk.toString();
    });
    const info = await new Promise<Owner>((resolve, reject) => {
        child.stdout.on("data", (chunk) => {
            output += chunk.toString();
            if (output.includes("\n")) resolve(JSON.parse(output.split("\n")[0]!));
        });
        child.on("error", reject);
        child.on("exit", () => reject(new Error(error || "Owner exited before readiness")));
    });
    const endpoint = `http://127.0.0.1:${info.port}`;
    await admit(endpoint, info.credential);
    return {
        ...info,
        endpoint,
        async close() {
            const done = new Promise<void>((resolve) => child.once("exit", () => resolve()));
            child.stdin.end("close\n");
            await done;
        },
    };
}
async function clientProcess(connection: Owner & { endpoint: string }, command: ProjectStoreCommand, home: string) {
    const child = spawn(process.execPath, [driver, "client", JSON.stringify({ ...connection, command })], {
        env: { ...process.env, HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
        error = "";
    child.stdout.on("data", (chunk) => {
        output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
        error += chunk.toString();
    });
    const code = await new Promise<number | null>((resolve, reject) => {
        child.on("exit", resolve);
        child.on("error", reject);
    });
    equal(code, 0, error);
    return JSON.parse(output);
}

async function dropReply(endpoint: string) {
    const server = createServer(async (request, response) => {
        try {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const forwarded = await fetch(`${endpoint}/project-store`, {
                method: "POST",
                headers: { Authorization: request.headers.authorization || "" },
                body: Buffer.concat(chunks),
            });
            await forwarded.text();
            response.destroy();
        } catch {
            response.destroy();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Proxy has no loopback address.");
    return {
        endpoint: `http://127.0.0.1:${address.port}`,
        close: () =>
            new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    };
}

test("separate client home and fresh owner connections retain a completed operation identity", async () => {
    const fixture = await packageFixture();
    const home = await mkdtemp(join(tmpdir(), "project-store-client-"));
    let connection: Awaited<ReturnType<typeof owner>> | undefined;
    try {
        await authorLocalPlan(fixture.root, { planName: "proposal", contextMarkdown: "# Before\n" });
        const before = (await loadPlan(fixture.root, "proposal"))!;
        connection = await owner(fixture.root);
        const command = {
            kind: "save-prose" as const,
            planId: before.attrs.planId!,
            operationId: randomUUID(),
            expectedRevision: before.revision!,
            body: "# Remote edit\n",
        };
        const proxy = await dropReply(connection.endpoint);
        try {
            await rejects(clientProcess({ ...connection, endpoint: proxy.endpoint }, command, home));
        } finally {
            await proxy.close();
        }
        const first = await clientProcess(
            connection,
            { kind: "reconcile", planId: command.planId, operationId: command.operationId },
            home,
        );
        await connection.close();
        connection = await owner(fixture.root);
        deepEqual(await clientProcess(connection, command, home), first);
        equal((await loadPlan(fixture.root, "proposal"))!.body, "# Remote edit\n");
        deepEqual(await readdir(home), []);
    } finally {
        await connection?.close();
        await fixture.cleanup();
        await rm(home, { recursive: true });
    }
});

test("registration, handshake, owner binding and revocation gate the real transport", async () => {
    const fixture = await packageFixture();
    const service = startRemoteControlService(build);
    try {
        await authorLocalPlan(fixture.root, { planName: "proposal", contextMarkdown: "# Before\n" });
        const plan = (await loadPlan(fixture.root, "proposal"))!;
        const endpoint = `http://127.0.0.1:${service.port}`;
        const headers = { Authorization: `Bearer ${service.credential}` };
        equal((await fetch(`${endpoint}/project-store`, { method: "POST", headers })).status, 403);
        const binding = service.registerProjectStore(fixture.root);
        const client = new ProjectStoreClient(endpoint, service.credential, binding);
        const command = { kind: "read" as const, planId: plan.attrs.planId!, resource: "context.md" };
        await rejects(client.execute(command), /403/);
        await admit(endpoint, service.credential);
        const result = await client.execute(command);
        ok("body" in result.result);
        equal(result.result.body, "# Before\n");
        await rejects(new ProjectStoreClient(endpoint, "wrong", binding).execute(command), /401/);
        await rejects(
            new ProjectStoreClient(endpoint, service.credential, { ...binding, projectId: "wrong" }).execute(command),
            /403/,
        );
        service.unregisterProjectStore();
        await rejects(client.execute(command), /404/);
        service.registerProjectStore(fixture.root);
        service.requestShutdown();
        await rejects(client.execute(command), /403/);
    } finally {
        await service.close();
        await fixture.cleanup();
    }
});

test("shutdown before the final streamed byte prevents mutation admission", async () => {
    const fixture = await packageFixture();
    const service = startRemoteControlService(build);
    try {
        await authorLocalPlan(fixture.root, { planName: "proposal", contextMarkdown: "# Before\n" });
        const before = (await loadPlan(fixture.root, "proposal"))!;
        const binding = service.registerProjectStore(fixture.root);
        const endpoint = `http://127.0.0.1:${service.port}`;
        await admit(endpoint, service.credential);
        const payload = JSON.stringify({
            binding,
            command: {
                kind: "save-prose",
                planId: before.attrs.planId!,
                operationId: randomUUID(),
                expectedRevision: before.revision!,
                body: "# Forbidden\n",
            },
        });
        let release: (() => void) | undefined;
        const waiting = new Promise<void>((resolve) => {
            release = resolve;
        });
        const body = new ReadableStream<Uint8Array>({
            async start(controller) {
                controller.enqueue(new TextEncoder().encode(payload.slice(0, -1)));
                await waiting;
                controller.enqueue(new TextEncoder().encode(payload.slice(-1)));
                controller.close();
            },
        });
        const response = fetch(`${endpoint}/project-store`, {
            method: "POST",
            headers: { Authorization: `Bearer ${service.credential}` },
            body,
        });
        await new Promise((resolve) => setTimeout(resolve, 40));
        service.requestShutdown();
        release!();
        equal((await response).status, 403);
        equal((await loadPlan(fixture.root, "proposal"))!.revision, before.revision);
        const receipts = join(
            fixture.identity.executionAccountHome,
            ".wld",
            "projects",
            fixture.identity.projectId,
            "internal",
            "plan-packages",
            "operations",
        );
        await rejects(readdir(receipts), { code: "ENOENT" });
    } finally {
        await service.close();
        await fixture.cleanup();
    }
});

test("a separate owner process serves a registered Project with no laptop source checkout", async () => {
    const registration = await registerHomeProjectOwner({
        projectId: randomUUID(),
        repositoryId: randomUUID(),
        displayName: "Home-only",
    });
    const home = await mkdtemp(join(tmpdir(), "home-only-client-"));
    let connection: Awaited<ReturnType<typeof owner>> | undefined;
    try {
        const before = await new PreparedProjectStore(registration).author({
            planName: "proposal",
            contextMarkdown: "# Only home storage\n",
        });
        connection = await owner(registration);
        const command = {
            kind: "save-prose" as const,
            operationId: randomUUID(),
            planId: before.planId,
            expectedRevision: before.revision,
            body: "# Remote-only edit\n",
        };
        const first = await clientProcess(connection, command, home);
        await connection.close();
        connection = await owner(registration);
        deepEqual(await clientProcess(connection, command, home), first);
        const read = await clientProcess(
            connection,
            { kind: "read", planId: before.planId, resource: "context.md" },
            home,
        );
        equal(read.result.body, "# Remote-only edit\n");
        deepEqual(await readdir(home), []);
        const root = join(registration.executionAccountHome, ".wld", "projects", registration.projectId);
        const names = await readdir(root);
        equal(names.includes(".git"), false);
        equal(names.includes(".wld"), false);
    } finally {
        await connection?.close();
        await rm(home, { recursive: true });
    }
});
