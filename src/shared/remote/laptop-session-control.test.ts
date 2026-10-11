import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { defineCommittedGitFixture } from "../git-test-fixture.ts";
import { openFileSessionStore } from "../session/file-session-store.ts";
import {
    listManifests,
    listProjectsFromDisk,
    lockPath,
    sessionDirForProject,
} from "../session/file-session-storage.ts";
import { startRemoteControlService } from "./control.ts";
import { LaptopSessionControl, listSavedRemoteSessions } from "./laptop-session-control.ts";
import { RemoteSessionOwner } from "../session/remote-session-owner.ts";
import type { ResolvedRemoteTarget } from "./target.ts";
import type { RemoteSessionControlRequest } from "./session-protocol.ts";
import { customEntry } from "./session-save-test-fixture.ts";

const repositories = defineCommittedGitFixture();
const identity = { buildId: "a".repeat(64), protocol: 1 };

async function fixture(test: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
    const f = await setup();
    try {
        await test(f);
    } finally {
        await f.service.close();
        f.store.close();
        await Deno.remove(f.root, { recursive: true });
    }
}
async function setup() {
    const root = await repositories.checkout();
    const baseDir = join(root, "laptop-sessions");
    const store = openFileSessionStore({ baseDir });
    const target: ResolvedRemoteTarget = {
        host: { hostname: "remote.example", user: "developer", port: 22, hostKeyFingerprint: "SHA256:verified" },
        cwd: root,
        home: root,
        os: "Linux",
        arch: "x86_64",
        gitRoot: root,
        gitDir: join(root, ".git"),
        gitCommonDir: join(root, ".git"),
        primaryRoot: root,
        isWorktree: false,
    };
    const connection = { store, target, targetLabel: `alias:${root}` };
    const service = startRemoteControlService(identity, connection);
    const owners = new Map<string, RemoteSessionOwner>();
    const control = new LaptopSessionControl(connection, owners);
    async function post(path: string, body: string) {
        return await fetch(`http://127.0.0.1:${service.port}${path}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${service.credential}` },
            body,
        });
    }
    for (const [path, body] of [["/handshake", JSON.stringify(identity)], ["/readiness", ""]]) {
        await (await post(path, body)).text();
    }
    async function request(input: RemoteSessionControlRequest) {
        const response = await post("/session/control", JSON.stringify(input));
        if (!response.ok) throw new Error(`Session control status ${response.status}`);
        return await response.json();
    }
    async function save(operation: string, sequence: number, kind: string, contents = "") {
        const response = await post("/session/request", JSON.stringify({ operation, sequence, kind, contents }));
        if (!response.ok) throw new Error(`Session save status ${response.status}`);
        return await response.json();
    }
    return { root, store, target, service, control, owners, request, post, save, baseDir };
}

Deno.test("a dormant laptop connection and empty remote list create no project or Session evidence", async () => {
    await fixture(async (f) => {
        assertEquals(await f.request({ kind: "list" }), { sessions: [] });
        assertEquals(listProjectsFromDisk(f.baseDir), []);
        assertEquals(Array.from(Deno.readDirSync(f.baseDir)), []);
    });
});

Deno.test("first message ownership stays on the laptop and publication releases the native writer", async () => {
    await fixture(async (f) => {
        const sessionId = crypto.randomUUID();
        const created = await f.request({ kind: "create", sessionId, name: "", admissionId: crypto.randomUUID() });
        assertEquals(Object.keys(created), ["operation"]);
        const hydrated = await f.save(created.operation, 0, "hydrate");
        assertEquals(JSON.parse(hydrated.contents.split("\n")[0]).cwd, f.target.cwd);
        const project = listProjectsFromDisk(f.baseDir)[0];
        const directory = sessionDirForProject(f.baseDir, project);
        const file = Deno.openSync(lockPath(directory, sessionId), { read: true, write: true });
        try {
            assertEquals(file.tryLockSync(true), false);
            const user = JSON.stringify({
                type: "message",
                id: "user-entry",
                parentId: null,
                timestamp: new Date().toISOString(),
                message: {
                    role: "user",
                    content: [{ type: "text", text: "remote sentinel" }],
                    timestamp: Date.now(),
                },
            }) + "\n";
            await f.save(created.operation, 1, "append", user);
            await f.request({ kind: "checkpoint", operation: created.operation });
            assertEquals(file.tryLockSync(true), true);
            file.unlockSync();
            const list = await f.request({ kind: "list" });
            assertEquals(list.sessions.length, 1);
            assertEquals(list.sessions[0].id, sessionId);
            assertEquals(list.sessions[0].firstMessage, "remote sentinel");
            assertEquals(Object.keys(list.sessions[0]).sort(), [
                "firstMessage",
                "generation",
                "id",
                "messageCount",
                "modified",
                "name",
            ]);
            const resumed = await f.request({ kind: "begin", sessionId, admissionId: crypto.randomUUID() });
            assertEquals(Object.keys(resumed), ["operation"]);
            assertEquals((await f.save(resumed.operation, 0, "hydrate")).contents.includes("remote sentinel"), true);
            await f.request({ kind: "checkpoint", operation: resumed.operation });
        } finally {
            file.close();
        }
    });
});

Deno.test("remote control rejects paths, proofs and lock handles", async () => {
    await fixture(async (f) => {
        for (const field of ["path", "proof", "lockHandle", "cwd", "projectId"]) {
            const response = await f.post(
                "/session/control",
                JSON.stringify({
                    kind: "create",
                    sessionId: crypto.randomUUID(),
                    name: "",
                    admissionId: crypto.randomUUID(),
                    [field]: f.root,
                }),
            );
            assertEquals(response.status, 400);
            await response.text();
        }
        assertEquals(listProjectsFromDisk(f.baseDir), []);
    });
});

Deno.test("remote begin and list refuse another target's Session", async () => {
    await fixture(async (f) => {
        const sessionId = crypto.randomUUID();
        const created = await f.control.handle({
            kind: "create",
            sessionId,
            name: "",
            admissionId: crypto.randomUUID(),
        });
        const owner = f.owners.get(created.operation || "")!;
        owner.handle({ operation: owner.operation, sequence: 0, kind: "hydrate", contents: "" });
        owner.handle({ operation: owner.operation, sequence: 1, kind: "append", contents: customEntry() });
        await f.control.handle({ kind: "checkpoint", operation: owner.operation });
        for (
            const changed of [
                { ...f.target.host, hostname: "other.example" },
                { ...f.target.host, user: "other" },
                { ...f.target.host, port: 2222 },
                { ...f.target.host, hostKeyFingerprint: "SHA256:other" },
            ]
        ) {
            const other = new LaptopSessionControl({
                store: f.store,
                target: { ...f.target, host: changed },
                targetLabel: "other",
            }, new Map());
            assertEquals(await other.handle({ kind: "list" }), { sessions: [] });
            await assertRejects(
                () => other.handle({ kind: "begin", sessionId, admissionId: crypto.randomUUID() }),
                Error,
                "does not belong",
            );
            await assertRejects(() => other.handle({ kind: "list", sessionId }), Error, "does not belong");
        }
        const otherRoot = new LaptopSessionControl({
            store: f.store,
            target: { ...f.target, primaryRoot: join(f.root, "other") },
            targetLabel: "other",
        }, new Map());
        await assertRejects(
            () => otherRoot.handle({ kind: "begin", sessionId, admissionId: crypto.randomUUID() }),
            Error,
            "does not belong",
        );
    });
});

Deno.test("connection loss preserves durable entries, releases ownership, and recovers without repeating effects", async () => {
    await fixture(async (f) => {
        const sessionId = crypto.randomUUID();
        const created = await f.control.handle({
            kind: "create",
            sessionId,
            name: "",
            admissionId: crypto.randomUUID(),
        });
        const owner = f.owners.get(created.operation || "")!;
        owner.handle({ operation: owner.operation, sequence: 0, kind: "hydrate", contents: "" });
        owner.handle({
            operation: owner.operation,
            sequence: 1,
            kind: "append",
            contents: customEntry("saved-effect"),
        });
        f.control.close();
        assertEquals(f.store.inspectSessionActivation(sessionId).activation?.state, "uncertain");
        assertEquals(f.owners.size, 0);
        const next = new LaptopSessionControl({ store: f.store, target: f.target, targetLabel: "alias" }, new Map());
        const reopened = await next.handle({ kind: "begin", sessionId, admissionId: crypto.randomUUID() });
        assertEquals(typeof reopened.operation, "string");
        const project = listProjectsFromDisk(f.baseDir)[0];
        const manifest = listManifests(sessionDirForProject(f.baseDir, project), false)[0].manifest;
        assertEquals(Deno.readTextFileSync(manifest.segments[0].transcriptPath).split('"saved-effect"').length - 1, 1);
        next.close();
        assertThrows(
            () =>
                owner.handle({
                    operation: owner.operation,
                    sequence: 2,
                    kind: "append",
                    contents: customEntry("repeat"),
                }),
            Error,
            "Stale",
        );
    });
});

Deno.test("offline history reads only the committed prefix while another turn holds the writer", async () => {
    await fixture(async (f) => {
        const sessionId = crypto.randomUUID();
        const created = await f.request({ kind: "create", sessionId, name: "", admissionId: crypto.randomUUID() });
        await f.save(created.operation, 0, "hydrate");
        const user = JSON.stringify({
            type: "message",
            id: "saved-user",
            parentId: null,
            timestamp: new Date().toISOString(),
            message: { role: "user", content: [{ type: "text", text: "saved history" }], timestamp: Date.now() },
        }) + "\n";
        await f.save(created.operation, 1, "append", user);
        await f.request({ kind: "checkpoint", operation: created.operation });
        const opened = await f.request({ kind: "begin", sessionId, admissionId: crypto.randomUUID() });
        await f.save(opened.operation, 0, "hydrate");
        await f.save(opened.operation, 1, "append", customEntry("unpublished"));
        const history = listSavedRemoteSessions(f.baseDir);
        assertEquals(history.length, 1);
        assertEquals(history[0].contents.includes("saved history"), true);
        assertEquals(history[0].contents.includes("unpublished"), false);
        assertEquals(f.store.inspectSessionActivation(sessionId).activation?.state, "active");
        await f.request({ kind: "markUncertain", operation: opened.operation });
    });
});

Deno.test("cancelling before admission arrives refuses both create and begin without acquiring a writer", async () => {
    await fixture(async (f) => {
        const cancelledCreate = crypto.randomUUID();
        await f.request({ kind: "markUncertain", admissionId: cancelledCreate });
        const refused = await f.post(
            "/session/control",
            JSON.stringify({
                kind: "create",
                sessionId: crypto.randomUUID(),
                name: "",
                admissionId: cancelledCreate,
            }),
        );
        assertEquals(refused.status, 409);
        await refused.text();
        assertEquals(listProjectsFromDisk(f.baseDir), []);
        const sessionId = crypto.randomUUID();
        const created = await f.request({ kind: "create", sessionId, name: "", admissionId: crypto.randomUUID() });
        await f.save(created.operation, 0, "hydrate");
        await f.request({ kind: "checkpoint", operation: created.operation });
        const cancelledBegin = crypto.randomUUID();
        await f.request({ kind: "markUncertain", admissionId: cancelledBegin });
        const refusedBegin = await f.post(
            "/session/control",
            JSON.stringify({
                kind: "begin",
                sessionId,
                admissionId: cancelledBegin,
            }),
        );
        assertEquals(refusedBegin.status, 409);
        await refusedBegin.text();
        assertEquals(f.store.inspectSessionActivation(sessionId).activation?.state, "idle");
        const next = await f.request({ kind: "begin", sessionId, admissionId: crypto.randomUUID() });
        await f.request({ kind: "markUncertain", operation: next.operation });
    });
});

Deno.test("cancelling an in-flight first creation releases the real native acquisition when it finishes", async () => {
    await fixture(async (f) => {
        const sessionId = crypto.randomUUID();
        const admissionId = crypto.randomUUID();
        // The real store has asynchronous catalog preparation before native acquisition.
        // Start through the public lifecycle API, then cancel before that await completes.
        const creating = f.control.handle({ kind: "create", sessionId, name: "", admissionId });
        await f.control.handle({ kind: "markUncertain", admissionId });
        await assertRejects(() => creating, Error, "cancelled");
        assertEquals(f.store.inspectSessionActivation(sessionId).activation?.state, "uncertain");
        const next = await f.request({ kind: "begin", sessionId, admissionId: crypto.randomUUID() });
        await f.save(next.operation, 0, "hydrate");
        await f.request({ kind: "checkpoint", operation: next.operation });
    });
});

Deno.test("repeated admission and cancellation cannot cancel the next operation on the same Session", async () => {
    await fixture(async (f) => {
        const sessionId = crypto.randomUUID();
        const admissionId = crypto.randomUUID();
        const input: RemoteSessionControlRequest = { kind: "create", sessionId, name: "", admissionId };
        const created = await f.request(input);
        assertEquals(await f.request(input), created, "A duplicate admission must not acquire another owner");
        const conflict = await f.post("/session/control", JSON.stringify({ ...input, name: "conflicting" }));
        assertEquals(conflict.status, 409);
        await conflict.text();
        await f.request({ kind: "markUncertain", admissionId });
        await f.request({ kind: "markUncertain", admissionId });
        const next = await f.request({ kind: "begin", sessionId, admissionId: crypto.randomUUID() });
        await f.request({ kind: "markUncertain", admissionId });
        assertEquals(f.store.inspectSessionActivation(sessionId).activation?.state, "active");
        // The old operation is unusable; the new one remains writable and publishable.
        const stale = await f.post(
            "/session/request",
            JSON.stringify({
                operation: created.operation,
                sequence: 0,
                kind: "hydrate",
                contents: "",
            }),
        );
        assertEquals(stale.status, 409);
        await stale.text();
        await f.save(next.operation, 0, "hydrate");
        await f.save(next.operation, 1, "append", customEntry("new-operation-only"));
        await f.request({ kind: "checkpoint", operation: next.operation });
    });
});

Deno.test("a refused busy admission cancellation leaves the existing operation active", async () => {
    await fixture(async (f) => {
        const sessionId = crypto.randomUUID();
        const created = await f.request({ kind: "create", sessionId, name: "", admissionId: crypto.randomUUID() });
        const admissionId = crypto.randomUUID();
        const busy = await f.post("/session/control", JSON.stringify({ kind: "begin", sessionId, admissionId }));
        assertEquals(busy.status, 409);
        await busy.text();
        await f.request({ kind: "markUncertain", admissionId });
        await f.save(created.operation, 0, "hydrate");
        await f.save(created.operation, 1, "append", customEntry("original-operation-only"));
        await f.request({ kind: "checkpoint", operation: created.operation });
    });
});

Deno.test("admission cancellation protocol refuses ambiguous identities and private laptop authority", async () => {
    await fixture(async (f) => {
        const admissionId = crypto.randomUUID();
        for (
            const body of [
                { kind: "begin", sessionId: crypto.randomUUID() },
                { kind: "create", sessionId: crypto.randomUUID(), name: "" },
                { kind: "markUncertain", admissionId: "not-an-admission" },
                { kind: "markUncertain", admissionId, operation: crypto.randomUUID() },
                { kind: "markUncertain", admissionId, proof: { ownerInstanceId: "remote" } },
            ]
        ) {
            const response = await f.post("/session/control", JSON.stringify(body));
            assertEquals(response.status, 400);
            await response.text();
        }
        assertEquals(listProjectsFromDisk(f.baseDir), []);
    });
});
