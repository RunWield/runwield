import { SessionRuntime } from "../session/session-runtime.ts";
import { SessionHost } from "../session/session-host.ts";
import { RemoteSessionControl } from "./session-control-client.ts";
import { renderSessionExportHtml } from "../../ui/session-export/session-export-html.ts";
import { strict as assert } from "node:assert";
import { writeFileSync, statSync, existsSync } from "node:fs";
import { rm as fsRm } from "node:fs/promises";
import { openNativeFileLock } from "../native-file-lock.ts";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { assertEquals, assertRejects, assertThrows } from "../../testing/assertions.ts";
import { join } from "node:path";
import { defineCommittedGitFixture } from "../git-test-fixture.ts";
import { openFileSessionStore } from "../session/file-session-store.ts";
import {
    listManifests,
    listProjectsFromDisk,
    lockPath,
    manifestPath,
    sessionDirForProject,
} from "../session/file-session-storage.ts";
import { startRemoteControlService } from "./control.ts";
import { LaptopSessionControl, listSavedRemoteSessions } from "./laptop-session-control.ts";
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
        f.control.close();
        f.store.close();
        await fsRm(f.root, { recursive: true });
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
    const connection = { baseDir: store.path, target, targetLabel: `alias:${root}` };
    const service = startRemoteControlService(identity, connection);
    const control = new LaptopSessionControl(connection);
    async function post(path: string, body: string) {
        return await fetch(`http://127.0.0.1:${service.port}${path}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${service.credential}` },
            body,
        });
    }
    for (const [path, body] of [
        ["/handshake", JSON.stringify(identity)],
        ["/readiness", ""],
    ]) {
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
    return { root, store, target, service, control, request, post, save, baseDir };
}

test("a dormant laptop connection and empty remote list create no project or Session evidence", async () => {
    await fixture(async (f) => {
        assertEquals(await f.request({ kind: "list" }), { sessions: [] });
        assertEquals(listProjectsFromDisk(f.baseDir), []);
        assertEquals(readdirSync(f.baseDir), []);
    });
});

test("first message ownership stays on the laptop and publication releases the native writer", async () => {
    await fixture(async (f) => {
        const sessionId = crypto.randomUUID();
        const created = await f.request({ kind: "create", sessionId, name: "", admissionId: crypto.randomUUID() });
        assertEquals(Object.keys(created), ["operation"]);
        const hydrated = await f.save(created.operation, 0, "hydrate");
        assertEquals(JSON.parse(hydrated.contents.split("\n")[0]).cwd, f.target.cwd);
        const project = listProjectsFromDisk(f.baseDir)[0];
        const directory = sessionDirForProject(f.baseDir, project);
        const file = openNativeFileLock(lockPath(directory, sessionId));
        try {
            assertEquals(file.tryLockSync(true), false);
            const user =
                JSON.stringify({
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

test("remote control rejects paths, proofs and lock handles", async () => {
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

test("remote begin and list refuse another target's Session", async () => {
    await fixture(async (f) => {
        const sessionId = crypto.randomUUID();
        const created = await f.control.handle({
            kind: "create",
            sessionId,
            name: "",
            admissionId: crypto.randomUUID(),
        });
        const operation = created.operation!;
        f.control.handleSave({ operation, sequence: 0, kind: "hydrate", contents: "" });
        f.control.handleSave({ operation, sequence: 1, kind: "append", contents: customEntry() });
        await f.control.handle({ kind: "checkpoint", operation });
        for (const changed of [
            { ...f.target.host, hostname: "other.example" },
            { ...f.target.host, user: "other" },
            { ...f.target.host, port: 2222 },
            { ...f.target.host, hostKeyFingerprint: "SHA256:other" },
        ]) {
            const other = new LaptopSessionControl({
                baseDir: f.store.path,
                target: { ...f.target, host: changed },
                targetLabel: "other",
            });
            assertEquals(await other.handle({ kind: "list" }), { sessions: [] });
            await assertRejects(
                () => other.handle({ kind: "begin", sessionId, admissionId: crypto.randomUUID() }),
                Error,
                "does not belong",
            );
            await assertRejects(() => other.handle({ kind: "list", sessionId }), Error, "does not belong");
            await assertRejects(() => other.handle({ kind: "export", sessionId }), Error, "does not belong");
            other.close();
        }
        const otherRoot = new LaptopSessionControl({
            baseDir: f.store.path,
            target: { ...f.target, primaryRoot: join(f.root, "other") },
            targetLabel: "other",
        });
        await assertRejects(
            () => otherRoot.handle({ kind: "begin", sessionId, admissionId: crypto.randomUUID() }),
            Error,
            "does not belong",
        );
        await assertRejects(() => otherRoot.handle({ kind: "export", sessionId }), Error, "does not belong");
        otherRoot.close();
    });
});

test("connection loss preserves durable entries, releases ownership, and recovers without repeating effects", async () => {
    await fixture(async (f) => {
        const sessionId = crypto.randomUUID();
        const created = await f.control.handle({
            kind: "create",
            sessionId,
            name: "",
            admissionId: crypto.randomUUID(),
        });
        const operation = created.operation!;
        f.control.handleSave({ operation, sequence: 0, kind: "hydrate", contents: "" });
        f.control.handleSave({
            operation,
            sequence: 1,
            kind: "append",
            contents: customEntry("saved-effect"),
        });
        f.control.close();
        assertEquals(f.store.inspectSessionActivation(sessionId).activation?.state, "uncertain");

        const next = new LaptopSessionControl({ baseDir: f.store.path, target: f.target, targetLabel: "alias" });
        const reopened = await next.handle({ kind: "begin", sessionId, admissionId: crypto.randomUUID() });
        assertEquals(typeof reopened.operation, "string");
        const project = listProjectsFromDisk(f.baseDir)[0];
        const manifest = listManifests(sessionDirForProject(f.baseDir, project), false)[0].manifest;
        assertEquals(readFileSync(manifest.segments[0].transcriptPath, "utf8").split('"saved-effect"').length - 1, 1);
        next.close();
        assertThrows(
            () =>
                f.control.handleSave({
                    operation,
                    sequence: 2,
                    kind: "append",
                    contents: customEntry("repeat"),
                }),
            Error,
            "Stale",
        );
    });
});

test("offline history reads only the committed prefix while another turn holds the writer", async () => {
    await fixture(async (f) => {
        const sessionId = crypto.randomUUID();
        const created = await f.request({ kind: "create", sessionId, name: "", admissionId: crypto.randomUUID() });
        await f.save(created.operation, 0, "hydrate");
        const user =
            JSON.stringify({
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

test("cancelling before admission arrives refuses both create and begin without acquiring a writer", async () => {
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

test("cancelling an in-flight first creation releases the real native acquisition when it finishes", async () => {
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

test("repeated admission and cancellation cannot cancel the next operation on the same Session", async () => {
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

test("a refused busy admission cancellation leaves the existing operation active", async () => {
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

test("admission cancellation protocol refuses ambiguous identities and private laptop authority", async () => {
    await fixture(async (f) => {
        const admissionId = crypto.randomUUID();
        for (const body of [
            { kind: "begin", sessionId: crypto.randomUUID() },
            { kind: "create", sessionId: crypto.randomUUID(), name: "" },
            { kind: "markUncertain", admissionId: "not-an-admission" },
            { kind: "markUncertain", admissionId, operation: crypto.randomUUID() },
            { kind: "markUncertain", admissionId, proof: { ownerInstanceId: "remote" } },
        ]) {
            const response = await f.post("/session/control", JSON.stringify(body));
            assertEquals(response.status, 400);
            await response.text();
        }
        assertEquals(listProjectsFromDisk(f.baseDir), []);
    });
});

test("laptop control owns persistence and its operation registry despite extra constructor inputs", async () => {
    await fixture(async (f) => {
        const suppliedOwners = new Map();
        const connection = {
            baseDir: f.baseDir,
            target: f.target,
            targetLabel: "alias",
            store: {
                ...f.store,
                ensureSessionCatalogRecordAndAcquire() {
                    throw new Error("Caller replaced storage");
                },
            },
        };
        // Exercise a JavaScript caller, which can pass fields and arguments outside the TS contract.
        const control: LaptopSessionControl = Reflect.construct(LaptopSessionControl, [connection, suppliedOwners]);
        try {
            const sessionId = crypto.randomUUID();
            const created = await control.handle({
                kind: "create",
                sessionId,
                name: "",
                admissionId: crypto.randomUUID(),
            });
            const operation = created.operation!;
            assertEquals(suppliedOwners.size, 0, "The caller must not own the active operation registry");
            control.handleSave({ operation, sequence: 0, kind: "hydrate", contents: "" });
            control.handleSave({ operation, sequence: 1, kind: "append", contents: customEntry("real-owned-save") });
            await control.handle({ kind: "checkpoint", operation });
            assertEquals(suppliedOwners.size, 0);
            assertEquals(f.store.inspectSessionActivation(sessionId).activation?.state, "idle");
        } finally {
            control.close();
        }
    });
});

function exportMessage(text: string): string {
    return (
        JSON.stringify({
            type: "message",
            id: text,
            parentId: null,
            timestamp: new Date().toISOString(),
            message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
        }) + "\n"
    );
}

async function createExportSession(f: Awaited<ReturnType<typeof setup>>) {
    const sessionId = crypto.randomUUID();
    const created = await f.request({
        kind: "create",
        sessionId,
        name: "Complete remote export",
        admissionId: crypto.randomUUID(),
    });
    await f.save(created.operation, 0, "hydrate");
    await f.save(created.operation, 1, "append", exportMessage("predecessor-export-sentinel"));
    await f.save(
        created.operation,
        2,
        "artifact",
        JSON.stringify({ kind: "report", path: "report.md", title: "Export report", registeredBy: "test" }),
    );
    const segment = f.store.getCurrentSessionSegment(sessionId)!;
    await f.save(
        created.operation,
        3,
        "plan-association",
        JSON.stringify({
            planId: "export-plan",
            planName: "remote-export",
            purpose: "planning",
            segmentId: segment.segmentId,
            segmentKind: segment.kind,
            recordedAt: new Date().toISOString(),
        }),
    );
    await f.request({ kind: "checkpoint", operation: created.operation });
    const begun = await f.request({ kind: "begin", sessionId, admissionId: crypto.randomUUID() });
    await f.save(begun.operation, 0, "hydrate");
    const rolled = await f.save(
        begun.operation,
        1,
        "rollover",
        JSON.stringify({ kind: "execution", continuation: { next: "engineer" } }),
    );
    const successor = JSON.parse(rolled.contents).operation;
    await f.save(successor, 0, "hydrate");
    await f.save(successor, 1, "append", exportMessage("successor-export-sentinel"));
    await f.request({ kind: "checkpoint", operation: successor });
    const control = new RemoteSessionControl({ port: f.service.port, credential: f.service.credential });
    const host = new SessionHost();
    const runtime = new SessionRuntime({
        sessionHost: host,
        sessionStore: null,
        remoteSessionControl: control,
        ownerInstanceId: "export-test",
        ownerProcessKind: "test",
    });
    const hosted = host.createSession({ cwd: f.target.cwd });
    const current = f.store.getCurrentSessionSegment(sessionId)!;
    hosted.setManagedMetadata({
        runwieldSessionId: sessionId,
        projectId: current.projectId,
        piSessionId: current.piSessionId,
        transcriptPath: "",
        currentSegmentId: current.segmentId,
        generation: null,
        name: null,
        activeAgent: null,
        workflowContext: null,
    });
    return { sessionId, runtime, runtimeId: hosted.id, control };
}

function exportEvidenceSnapshot(f: Awaited<ReturnType<typeof setup>>, sessionId: string) {
    const project = listProjectsFromDisk(f.baseDir).find(
        (project) => project.projectId === f.store.getCurrentSessionSegment(sessionId)!.projectId,
    )!;
    const paths = [
        ...f.store.listSessionTranscriptSegments(sessionId).map((segment) => segment.transcriptPath),
        manifestPath(sessionDirForProject(f.store.path, project), sessionId),
    ];
    return paths.map((path) =>
        existsSync(path)
            ? { path, bytes: readFileSync(path, "utf8"), modified: statSync(path).mtimeMs }
            : { path, missing: true },
    );
}

test("remote runtime exports complete committed multi-segment JSON and HTML without a local store", async () => {
    await fixture(async (f) => {
        const exported = await createExportSession(f);
        try {
            const segment = f.store.getCurrentSessionSegment(exported.sessionId)!;
            writeFileSync(
                segment.transcriptPath,
                readFileSync(segment.transcriptPath, "utf8") + customEntry("uncommitted-export-sentinel"),
            );
            const before = exportEvidenceSnapshot(f, exported.sessionId);
            const snapshot = await exported.runtime.readSessionExport(exported.runtimeId);
            assertEquals(snapshot.document.segments.length, 2);
            assertEquals(snapshot.document.artifacts.length, 1);
            assertEquals(snapshot.document.planAssociations.length, 1);
            assertEquals(snapshot.document.session.runwieldSessionId, exported.sessionId);
            assert(snapshot.timeline.every((event) => event.sessionId === exported.runtimeId));
            for (const output of [JSON.stringify(snapshot.document), renderSessionExportHtml(snapshot)]) {
                assert(output.includes("predecessor-export-sentinel"));
                assert(output.includes("successor-export-sentinel"));
                assert(!output.includes("uncommitted-export-sentinel"));
                assert(!output.includes(segment.transcriptPath));
            }
            assertEquals(exportEvidenceSnapshot(f, exported.sessionId), before);
        } finally {
            await exported.runtime.closeAllSessions();
        }
    });
});

for (const damage of ["missing", "corrupt"] as const) {
    test(`remote export refuses ${damage} predecessor evidence without partial output or storage mutation`, async () => {
        await fixture(async (f) => {
            const exported = await createExportSession(f);
            try {
                const predecessor = f.store.listSessionTranscriptSegments(exported.sessionId)[0];
                if (damage === "missing") await fsRm(predecessor.transcriptPath);
                else
                    writeFileSync(
                        predecessor.transcriptPath,
                        readFileSync(predecessor.transcriptPath, "utf8").replace(
                            "predecessor-export-sentinel",
                            "predecessor-export-CORRUPT!",
                        ),
                    );
                const before = {
                    evidence: exportEvidenceSnapshot(f, exported.sessionId),
                    activation: f.store.inspectSessionActivation(exported.sessionId),
                };
                await assert.rejects(() => exported.runtime.readSessionExport(exported.runtimeId));
                const response = await f.post(
                    "/session/control",
                    JSON.stringify({ kind: "export", sessionId: exported.sessionId }),
                );
                assertEquals(response.status, 409);
                assert(!(await response.text()).includes("successor-export-sentinel"));
                assertEquals(
                    {
                        evidence: exportEvidenceSnapshot(f, exported.sessionId),
                        activation: f.store.inspectSessionActivation(exported.sessionId),
                    },
                    before,
                );
            } finally {
                await exported.runtime.closeAllSessions();
            }
        });
    });
}

test("remote export does not publish or repair an unpublished first turn", async () => {
    await fixture(async (f) => {
        const sessionId = crypto.randomUUID();
        const created = await f.request({ kind: "create", sessionId, name: "", admissionId: crypto.randomUUID() });
        await f.save(created.operation, 0, "hydrate");
        await f.save(created.operation, 1, "append", exportMessage("not-published"));
        const before = {
            evidence: exportEvidenceSnapshot(f, sessionId),
            activation: f.store.inspectSessionActivation(sessionId),
        };
        const response = await f.post("/session/control", JSON.stringify({ kind: "export", sessionId }));
        assertEquals(response.status, 409);
        assert(!(await response.text()).includes("not-published"));
        assertEquals(
            { evidence: exportEvidenceSnapshot(f, sessionId), activation: f.store.inspectSessionActivation(sessionId) },
            before,
        );
        await f.request({ kind: "markUncertain", operation: created.operation });
    });
});
