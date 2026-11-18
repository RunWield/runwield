import { test } from "node:test";
import { equal, ok, rejects } from "node:assert/strict";
import { rename, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { getHomeDir } from "../../constants.js";
import { admitProjectIdentity } from "../project-identity.ts";
import { git } from "../git-test-fixture.ts";
import { composedRemoteFixture } from "./composed-store-fixture.ts";
import { startRemoteControlService } from "./control.ts";
import { RemoteSessionControl } from "./session-control-client.ts";
import type { ResolvedRemoteTarget } from "./target.ts";
import { listSavedRemoteSessions } from "./laptop-session-control.ts";

for (const retainIdentity of [true, false])
    test(
        retainIdentity
            ? "managed Guide Sessions retain verified identity and writer exclusion across a repository rename"
            : "a remote rename cannot infer missing historical Session identity",
        async () => {
            await withProcessGlobalTestLock(async () => {
                const fixture = await composedRemoteFixture();
                const baseDir = join(getHomeDir(), "managed-session-rebinding", crypto.randomUUID());
                const services: ReturnType<typeof startRemoteControlService>[] = [];
                let root = fixture.root;
                const host = {
                    hostname: "fixture-host",
                    user: "developer",
                    port: 22,
                    hostKeyFingerprint: "SHA256:verified",
                };
                async function connect() {
                    const target: ResolvedRemoteTarget = {
                        host,
                        cwd: root,
                        home: fixture.remoteHome,
                        os: "Linux",
                        arch: "x86_64",
                        gitRoot: root,
                        gitDir: join(root, ".git"),
                        gitCommonDir: join(root, ".git"),
                        primaryRoot: root,
                        isWorktree: false,
                    };
                    const identity = { buildId: "a".repeat(64), protocol: 1 };
                    const service = startRemoteControlService(
                        identity,
                        { baseDir, target, targetLabel: `fixture:${root}` },
                        undefined,
                        "",
                        {
                            host: "fixture-host",
                            cwd: root,
                            remoteHome: fixture.remoteHome,
                            executable: "/verified/runtime/wld",
                        },
                    );
                    services.push(service);
                    const endpoint = `http://127.0.0.1:${service.port}`;
                    const headers = { Authorization: `Bearer ${service.credential}` };
                    for (const action of ["handshake", "readiness"]) {
                        const response = await fetch(`${endpoint}/${action}`, {
                            method: "POST",
                            headers,
                            body: action === "handshake" ? JSON.stringify(identity) : undefined,
                        });
                        equal(response.status, 200);
                        await response.text();
                    }
                    return {
                        service,
                        client: new RemoteSessionControl({ port: service.port, credential: service.credential }),
                        async save(operation: string, sequence: number, kind: string, contents = "") {
                            const response = await fetch(`${endpoint}/session/request`, {
                                method: "POST",
                                headers,
                                body: JSON.stringify({ operation, sequence, kind, contents }),
                            });
                            equal(response.status, 200);
                            return await response.json();
                        },
                        async inspectPlanOwner() {
                            const response = await fetch(`${endpoint}/project-store/inspect`, {
                                method: "POST",
                                headers,
                            });
                            equal(response.status, 200);
                            return await response.json();
                        },
                    };
                }
                try {
                    const first = await connect();
                    const sessionId = crypto.randomUUID();
                    const operation = await first.client.create(sessionId);
                    await first.save(operation, 0, "hydrate");
                    await first.save(
                        operation,
                        1,
                        "append",
                        JSON.stringify({
                            type: "message",
                            id: "rename-sentinel",
                            parentId: null,
                            timestamp: new Date().toISOString(),
                            message: {
                                role: "user",
                                content: [{ type: "text", text: "Managed rename sentinel" }],
                                timestamp: Date.now(),
                            },
                        }) + "\n",
                    );
                    // A completed Guide turn materializes remote identity without a laptop Plan package.
                    const admit = () =>
                        admitProjectIdentity(root, {
                            context: {
                                executionAccountHome: fixture.remoteHome,
                                personalOwner: { kind: "managed-remote", identity: getHomeDir() },
                            },
                        });
                    if (retainIdentity) equal((await admit()).kind, "existing");
                    await first.client.checkpoint(operation);
                    equal(await first.inspectPlanOwner(), null);
                    equal((await first.client.list())[0].id, sessionId);
                    await first.service.close();
                    const originalRoot = root;
                    root = `${root}-renamed`;
                    await rename(originalRoot, root);
                    if (!retainIdentity) equal((await admit()).kind, "existing");
                    const next = await connect();
                    const sessions = await next.client.list();
                    if (!retainIdentity) {
                        equal(sessions.length, 0);
                        await rejects(next.client.begin(sessionId), /refused begin/);
                        equal(listSavedRemoteSessions(baseDir)[0].summary.id, sessionId);
                        return;
                    }
                    equal(sessions.length, 1);
                    equal(sessions[0].id, sessionId);
                    equal(sessions[0].firstMessage, "Managed rename sentinel");
                    const resumed = await next.client.begin(sessionId);
                    const contents = (await next.save(resumed, 0, "hydrate")).contents;
                    ok(contents.includes("Managed rename sentinel"));
                    equal(JSON.parse(contents.split("\n")[0]).cwd, originalRoot);
                    const contender = await connect();
                    await rejects(contender.client.begin(sessionId), /refused begin/);
                    await next.client.checkpoint(resumed);
                    const acquired = await contender.client.begin(sessionId);
                    await contender.save(acquired, 0, "hydrate");
                    await contender.client.checkpoint(acquired);
                    host.hostKeyFingerprint = "SHA256:another-host";
                    const wrongHost = await connect();
                    equal((await wrongHost.client.list()).length, 0);
                    await rejects(wrongHost.client.begin(sessionId), /refused begin/);
                    host.hostKeyFingerprint = "SHA256:verified";
                    const originalHome = getHomeDir();
                    const otherHome = join(originalHome, "different-personal-owner");
                    await mkdir(otherHome);
                    process.env.HOME = otherHome;
                    try {
                        const wrongOwner = await connect();
                        equal((await wrongOwner.client.list()).length, 0);
                        await rejects(wrongOwner.client.begin(sessionId), /refused begin/);
                    } finally {
                        process.env.HOME = originalHome;
                    }
                    for (const key of ["runwield.projectId", "runwield.repositoryId"]) {
                        const original = await git(root, ["config", "--get", key]);
                        await git(root, ["config", key, crypto.randomUUID()]);
                        try {
                            const wrongRepository = await connect();
                            equal((await wrongRepository.client.list()).length, 0);
                            await rejects(wrongRepository.client.begin(sessionId), /refused begin/);
                        } finally {
                            await git(root, ["config", key, original]);
                        }
                    }
                    const checkoutMarker = join(root, ".git", "runwield-checkout-id");
                    const marker = await readFile(checkoutMarker, "utf8");
                    await writeFile(checkoutMarker, crypto.randomUUID());
                    try {
                        const wrongCheckout = await connect();
                        equal((await wrongCheckout.client.list()).length, 0);
                        await rejects(wrongCheckout.client.begin(sessionId), /refused begin/);
                    } finally {
                        await writeFile(checkoutMarker, marker);
                    }
                    equal((await next.client.list())[0].id, sessionId);
                    equal(listSavedRemoteSessions(baseDir).length, 1);
                } finally {
                    for (const service of services) await service.close();
                    if (root !== fixture.root) await rename(root, fixture.root);
                    await fixture.cleanup();
                }
            });
        },
    );
