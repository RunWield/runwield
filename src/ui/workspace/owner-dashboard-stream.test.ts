import { assertEquals, assertStrictEquals } from "@std/assert";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { getHomeDir } from "../../constants.js";
import { dirname } from "@std/path";
import { getWorktreeRegistryPath } from "../../shared/worktree-registry.js";
import { makeManagedSessionFixture, readTranscriptEvidence } from "../../testing/managed-session-fixture.ts";
import { savePlan } from "../../plan-store.js";
import { defineCommittedGitFixture } from "../../shared/git-test-fixture.ts";
import { enterProjectRuntime } from "../../shared/project-runtime-layout.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { createOwnerWorkspaceApp } from "./server.js";
import { loadOwnerDashboard, subscribeOwnerDashboard } from "./server/owner-dashboard.ts";

type StreamFrame = {
    type: string;
    progress: { pending: boolean };
    sectionProgress: Record<string, { pending: boolean; failed: boolean }>;
    sections: Array<{ items: Array<{ planId: string }> }>;
};

Deno.test("owner dashboard stream authenticates and completes with verified rows", async () => {
    const dir = await Deno.makeTempDir({ prefix: "rw-dashboard-stream-" });
    const root = `${dir}/project`;
    await Deno.mkdir(root);
    const store = openOwnerCoordinationStore({ dbPath: `${dir}/owner.sqlite3` });
    const appObject = createOwnerWorkspaceApp({ mode: "owner", publicOrigin: "http://127.0.0.1:8787", store });
    try {
        await savePlan(root, "finished", "# Finished\n", {
            planId: "stream-plan",
            classification: "FEATURE",
            status: "user_verified",
            userVerifiedAt: new Date().toISOString(),
        });
        store.registerProject({ root, displayName: "Test Project" });
        const app = appObject.handler();
        const url = "http://127.0.0.1:8787/api/owner/dashboard/stream";
        assertEquals((await app(new Request(url))).status, 401);
        const pairing = store.createPairingRequest({ codeFactory: () => "STR123", proofFactory: () => "proof" });
        store.approvePairingRequest(pairing.code);
        const claimed = store.claimPairingRequest(pairing.proof, {
            credentialFactory: () => "stream-credential",
            csrfFactory: () => "stream-csrf",
        });
        const headers = { cookie: `rw_owner_device=${claimed.credential}; rw_owner_csrf=stream-csrf` };
        const response = await app(new Request(url, { headers }));
        assertEquals(response.status, 200);
        assertEquals(response.headers.get("cache-control"), "no-store");
        assertEquals(response.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
        const frames = (await response.text()).trim().split("\n").map((line: string) => JSON.parse(line));
        assertEquals(frames[0].type, "snapshot");
        assertEquals(frames.at(-1).type, "complete");
        assertEquals(frames.at(-1).progress.pending, false);
        assertEquals(
            frames.some((frame: StreamFrame) =>
                frame.type === "snapshot" && frame.progress.pending &&
                frame.sections.some((section: { items: Array<{ planId: string }> }) =>
                    section.items.some((item) => item.planId === "stream-plan")
                )
            ),
            true,
        );
        assertEquals(JSON.stringify(frames).includes(dir), false);
        const json = await (await app(new Request(url.replace("/stream", ""), { headers }))).json();
        assertEquals(frames.at(-1).sections, json.dashboard.sections);
    } finally {
        if ("close" in appObject && typeof appObject.close === "function") await appObject.close();
        store.close();
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("dashboard keeps Promise identity and publishes later Project while first waits", async () => {
    const dir = await Deno.makeTempDir({ prefix: "rw-dashboard-progress-" });
    const first = `${dir}/first`;
    const second = `${dir}/second`;
    await Deno.mkdir(first);
    await Deno.mkdir(second);
    const store = openOwnerCoordinationStore({ dbPath: `${dir}/owner.sqlite3` });
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
        release = resolve;
    });
    try {
        const firstProject = store.registerProject({ root: first, displayName: "Blocked" });
        store.registerProject({ root: second, displayName: "Available" });
        await savePlan(second, "finished", "# Finished\n", {
            planId: "available-plan",
            classification: "FEATURE",
            status: "user_verified",
            userVerifiedAt: new Date().toISOString(),
        });
        // The Session catalog is an external read boundary; Plan and Project readers stay real.
        const continuation = {
            operations: new Map(),
            async listSessions(projectId: string) {
                if (projectId === firstProject.projectId) await blocked;
                return { sessions: [] };
            },
        };
        const frames: Array<{ type: string; sections: Array<{ items: Array<{ planId: string }> }> }> = [];
        let rowSeen = () => {};
        const row = new Promise<void>((resolve) => {
            rowSeen = resolve;
        });
        const unsubscribe = subscribeOwnerDashboard(store, continuation, (frame) => {
            frames.push(frame);
            if (frame.sections.some((section) => section.items.some((item) => item.planId === "available-plan"))) {
                rowSeen();
            }
        });
        const a = loadOwnerDashboard(store, continuation);
        assertStrictEquals(a, loadOwnerDashboard(store, continuation));
        await Promise.race([
            row,
            new Promise((_, reject) => setTimeout(() => reject(new Error("No early row")), 5000)),
        ]);
        assertEquals(frames.at(-1)?.type, "snapshot");
        release();
        const payload = await a;
        assertEquals(payload.dashboard.sections.flatMap((section) => section.items).length, 1);
        unsubscribe();
        assertEquals(loadOwnerDashboard(store, continuation) === a, false);
        await loadOwnerDashboard(store, continuation);
    } finally {
        release();
        store.close();
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("one Project streams a finished row and registry failure before its unrelated live socket responds", async () => {
    if (Deno.build.os === "windows") return; // The live connection uses a named pipe there.
    const fixture = await makeManagedSessionFixture();
    const { store, session, project } = fixture;
    const operationId = "dashboard-blocked-operation";
    const socketKey = createHash("sha256")
        .update(`${getHomeDir()}:${session.runwieldSessionId}:${operationId}`).digest("hex").slice(0, 40);
    const socketPath = `/tmp/runwield-${socketKey}.sock`;
    let releaseSocket = () => {};
    const socketGate = new Promise<void>((resolve) => {
        releaseSocket = resolve;
    });
    let socketEntered = () => {};
    const entered = new Promise<void>((resolve) => {
        socketEntered = resolve;
    });
    const socket = createServer(async (_request, response) => {
        socketEntered();
        await socketGate;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ operationId, events: [], queuedMessages: [], interaction: null }));
    });
    let socketListening = false;
    const appObject = createOwnerWorkspaceApp({ mode: "owner", publicOrigin: "http://127.0.0.1:8787", store });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let lateReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
        await savePlan(fixture.projectRoot, "blocked", "# Blocked\n", {
            planId: "blocked-plan",
            classification: "FEATURE",
            status: "in_progress",
        });
        await savePlan(fixture.projectRoot, "finished", "# Finished\n", {
            planId: "early-plan",
            classification: "FEATURE",
            status: "user_verified",
            userVerifiedAt: new Date().toISOString(),
        });
        await savePlan(fixture.projectRoot, "validated", "# Validated\n", {
            planId: "validated-plan",
            classification: "FEATURE",
            status: "validated",
        });
        await enterProjectRuntime(fixture.projectRoot);
        const registryPath = getWorktreeRegistryPath(fixture.projectRoot);
        await Deno.mkdir(dirname(registryPath), { recursive: true });
        const attempt = (id: string) => ({
            id,
            planName: "validated",
            planId: "validated-plan",
            baseBranch: "main",
            baseRef: "HEAD",
            baseCommit: "abc123",
            branch: `runwield/worktree/validated-${id}`,
            path: `${fixture.projectRoot}/${id}`,
            status: "active",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        });
        await Deno.writeTextFile(registryPath, JSON.stringify({ version: 2, entries: [attempt("a"), attempt("b")] }));
        let proof = store.acquireSessionActivation({
            runwieldSessionId: session.runwieldSessionId,
            projectId: project.projectId,
            ownerInstanceId: "dashboard-test",
            ownerProcessKind: "test",
            expectedGeneration: 0,
        });
        const segment = store.getCurrentSessionSegment(session.runwieldSessionId)!;
        store.stagePlanAssociation(proof, {
            planId: "blocked-plan",
            planName: "blocked",
            purpose: "execution",
            segmentId: segment.segmentId,
            segmentKind: segment.kind,
            recordedAt: new Date().toISOString(),
        });
        proof = store.changeSessionActivationPhase(proof, "hydrated");
        proof = store.changeSessionActivationPhase(proof, "checkpointing");
        store.publishGenerationAndRelease(proof, {
            generation: 1,
            currentSegmentId: segment.segmentId,
            ...await readTranscriptEvidence(fixture.transcriptPath),
        });
        store.acquireSessionActivation({
            runwieldSessionId: session.runwieldSessionId,
            projectId: project.projectId,
            ownerInstanceId: "dashboard-test",
            ownerProcessKind: "test",
            expectedGeneration: 1,
            operationId,
        });
        await new Promise<void>((resolve, reject) => {
            socket.once("error", reject);
            socket.listen(socketPath, () => resolve());
        });
        socketListening = true;
        const pairing = store.createPairingRequest({ codeFactory: () => "EAR123", proofFactory: () => "early-proof" });
        store.approvePairingRequest(pairing.code);
        const claimed = store.claimPairingRequest(pairing.proof, {
            credentialFactory: () => "early-credential",
            csrfFactory: () => "early-csrf",
        });
        const url = "http://127.0.0.1:8787/api/owner/dashboard/stream";
        const headers = { cookie: `rw_owner_device=${claimed.credential}; rw_owner_csrf=early-csrf` };
        const app = appObject.handler();
        const response = await app(new Request(url, { headers }));
        assertEquals(response.status, 200);
        reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        const nextFrame = async (streamReader: ReadableStreamDefaultReader<Uint8Array>) => {
            while (!pending.includes("\n")) {
                const chunk = await streamReader.read();
                if (chunk.done) throw new Error("Stream ended before an early Plan row");
                pending += decoder.decode(chunk.value, { stream: true });
            }
            const boundary = pending.indexOf("\n");
            const frame: StreamFrame & {
                progress: { pending: boolean; completedProjects: number; totalProjects: number };
            } = JSON.parse(pending.slice(0, boundary));
            pending = pending.slice(boundary + 1);
            return frame;
        };
        const early = (async () => {
            for (;;) {
                const frame = await nextFrame(reader!);
                if (
                    frame.sections.some((section) => section.items.some((item) => item.planId === "early-plan")) &&
                    frame.sectionProgress["recently-finished"]?.failed &&
                    !frame.sectionProgress["recently-finished"].pending
                ) {
                    assertEquals(frame.type, "snapshot");
                    assertEquals(frame.sectionProgress["recently-finished"], { pending: false, failed: true });
                    assertEquals(frame.progress, { pending: true, completedProjects: 0, totalProjects: 1 });
                    assertEquals(
                        frame.sections.flatMap((section) => section.items).some((item) =>
                            item.planId === "blocked-plan"
                        ),
                        false,
                    );
                    return frame;
                }
                if (frame.type !== "snapshot") throw new Error("Dashboard completed before the early Plan row");
            }
        })();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                Promise.all([entered, early]),
                new Promise<never>((_, reject) => {
                    timeout = setTimeout(() => reject(new Error("No early row while live socket was held")), 2500);
                }),
            ]);
        } finally {
            clearTimeout(timeout);
        }
        // The navigation response must not wait for dashboard-only live evidence.
        const sidebar = await Promise.race([
            app(new Request(url.replace("/dashboard/stream", "/sidebar"), { headers })),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("Sidebar waited for dashboard live connection")), 2500)
            ),
        ]);
        assertEquals(sidebar.status, 200);
        const sidebarProjects = (await sidebar.json()).projects;
        assertEquals(sidebarProjects[0].plans.some((plan: { planId: string }) => plan.planId === "blocked-plan"), true);
        assertEquals(
            sidebarProjects[0].plans.find((plan: { planId: string }) => plan.planId === "blocked-plan")
                .sessions.some((listed: { runwieldSessionId: string }) =>
                    listed.runwieldSessionId === session.runwieldSessionId
                ),
            true,
        );
        // A subscriber joining mid-read receives the most recent verified row immediately.
        const late = await app(new Request(url, { headers }));
        lateReader = late.body!.getReader();
        const lateChunk = await lateReader!.read();
        assertEquals(lateChunk.done, false);
        const lateFrame: StreamFrame = JSON.parse(new TextDecoder().decode(lateChunk.value).trim().split("\n")[0]);
        assertEquals(
            lateFrame.sections.some((section) => section.items.some((item) => item.planId === "early-plan")),
            true,
        );
        await lateReader!.cancel();
        lateReader = undefined;
        releaseSocket();
        let finalFrame = await nextFrame(reader!);
        while (finalFrame.type !== "complete") finalFrame = await nextFrame(reader!);
        assertEquals(finalFrame.progress.pending, false);
        assertEquals(
            finalFrame.sections.some((section) => section.items.some((item) => item.planId === "early-plan")),
            true,
        );
        await reader!.cancel();
        reader = undefined;
        // A new request after settlement must start a fresh read, not replay the completed stream.
        const fresh = await app(new Request(url, { headers }));
        const freshFrames = (await fresh.text()).trim().split("\n").map((line: string) => JSON.parse(line));
        assertEquals(freshFrames[0].type, "snapshot");
        assertEquals(freshFrames[0].progress.pending, true);
        assertEquals(freshFrames.at(-1).type, "complete");
    } finally {
        releaseSocket();
        await reader?.cancel();
        await lateReader?.cancel();
        if (socketListening) await new Promise<void>((resolve) => socket.close(() => resolve()));
        if ("close" in appObject && typeof appObject.close === "function") await appObject.close();
        await fixture.cleanup();
    }
});

Deno.test("unreadable publication registry fails the finished card before unrelated Project checks end", async () => {
    const dir = await Deno.makeTempDir({ prefix: "rw-dashboard-registry-" });
    const first = `${dir}/first`;
    const second = `${dir}/second`;
    await Deno.mkdir(first);
    await Deno.mkdir(second);
    const store = openOwnerCoordinationStore({ dbPath: `${dir}/owner.sqlite3` });
    const gate = Promise.withResolvers<void>();
    try {
        store.registerProject({ root: first, displayName: "Publication" });
        const other = store.registerProject({ root: second, displayName: "Other" });
        await savePlan(first, "validated", "# Validated\n", {
            planId: "validated-plan",
            classification: "FEATURE",
            status: "validated",
        });
        await enterProjectRuntime(first);
        const path = getWorktreeRegistryPath(first);
        await Deno.mkdir(dirname(path), { recursive: true });
        const attempt = (id: string) => ({
            id,
            planName: "validated",
            planId: "validated-plan",
            baseBranch: "main",
            baseRef: "HEAD",
            baseCommit: "abc123",
            branch: `runwield/worktree/validated-${id}`,
            path: `${dir}/${id}`,
            status: "active",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        });
        await Deno.writeTextFile(path, JSON.stringify({ version: 2, entries: [attempt("a"), attempt("b")] }));
        const continuation = {
            operations: new Map(),
            async listSessions(projectId: string) {
                if (projectId === other.projectId) await gate.promise;
                return { sessions: [] };
            },
        };
        const seen = Promise.withResolvers<void>();
        const frames: Array<
            {
                type: string;
                progress: { pending: boolean };
                sectionProgress: Record<string, { pending: boolean; failed: boolean }>;
            }
        > = [];
        const unsubscribe = subscribeOwnerDashboard(store, continuation, (frame) => {
            frames.push(frame);
            if (frame.sectionProgress["recently-finished"].failed) seen.resolve();
        });
        try {
            await Promise.race([
                seen.promise,
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error("Registry error did not reach finished card")), 5000)
                ),
            ]);
            const progress = frames.at(-1)!;
            assertEquals(progress.type, "snapshot");
            assertEquals(progress.progress.pending, true);
            assertEquals(progress.sectionProgress["recently-finished"], { pending: true, failed: true });
        } finally {
            gate.resolve();
            unsubscribe();
        }
        await loadOwnerDashboard(store, continuation);
    } finally {
        gate.resolve();
        store.close();
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("standalone Sessions linked to one on-hold Plan remain distinct", async () => {
    const dir = await Deno.makeTempDir({ prefix: "rw-dashboard-standalone-" });
    const root = `${dir}/project`;
    await Deno.mkdir(root);
    const store = openOwnerCoordinationStore({ dbPath: `${dir}/owner.sqlite3` });
    try {
        const project = store.registerProject({ root, displayName: "Test" });
        await savePlan(root, "held", "# Held\n", { planId: "held-plan", classification: "FEATURE", status: "on_hold" });
        const operation = (sessionId: string) => ({
            projectId: project.projectId,
            runwieldSessionId: sessionId,
            status: "running",
            liveInteraction: {
                interactionId: sessionId,
                request: { type: "question", _meta: { planId: "held-plan" } },
            },
        });
        const continuation = {
            operations: new Map([["one", operation("session-one")], ["two", operation("session-two")]]),
            listSessions() {
                return Promise.resolve({ sessions: [] });
            },
        };
        const result = await loadOwnerDashboard(store, continuation);
        const rows = result.dashboard.sections.flatMap((section) => section.items);
        assertEquals(rows.length, 2);
        assertEquals(new Set(rows.map((item) => item.href)).size, 2);
    } finally {
        store.close();
        await Deno.remove(dir, { recursive: true });
    }
});

const tracedDashboardFixture = defineCommittedGitFixture({ "README.md": "# Dashboard scope\n" });

Deno.test("HTTP dashboard stream completes its producer and starts a fresh read afterward", async () => {
    if (Deno.build.os === "windows") return; // The live connection uses a named pipe there.
    await withProcessGlobalTestLock(async () => {
        const root = await tracedDashboardFixture.checkout({ prefix: "rw-dashboard-scope-" });
        const fixture = await makeManagedSessionFixture({ projectRoot: root });
        const { store, session, project } = fixture;
        const trace = await Deno.makeTempFile({ prefix: "rw-dashboard-git-trace-" });
        const previousTrace = Deno.env.get("GIT_TRACE2_EVENT");
        const operationId = "dashboard-scope-operation";
        const socketKey = createHash("sha256")
            .update(`${getHomeDir()}:${session.runwieldSessionId}:${operationId}`).digest("hex").slice(0, 40);
        const socketPath = `/tmp/runwield-${socketKey}.sock`;
        const gate = Promise.withResolvers<void>();
        const entered = Promise.withResolvers<void>();
        const socket = createServer(async (_request, response) => {
            entered.resolve();
            await gate.promise;
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ operationId, events: [], queuedMessages: [], interaction: null }));
        });
        let listening = false;
        const appObject = createOwnerWorkspaceApp({ mode: "owner", publicOrigin: "http://127.0.0.1:8787", store });
        try {
            await savePlan(root, "finished", "# Finished\n", {
                planId: "scope-plan",
                classification: "FEATURE",
                status: "user_verified",
                userVerifiedAt: new Date().toISOString(),
            });
            await enterProjectRuntime(root);
            store.acquireSessionActivation({
                runwieldSessionId: session.runwieldSessionId,
                projectId: project.projectId,
                ownerInstanceId: "dashboard-scope-test",
                ownerProcessKind: "test",
                expectedGeneration: 0,
                operationId,
            });
            await new Promise<void>((resolve, reject) => {
                socket.once("error", reject);
                socket.listen(socketPath, resolve);
            });
            listening = true;
            const pairing = store.createPairingRequest({
                codeFactory: () => "SCP123",
                proofFactory: () => "scope-proof",
            });
            store.approvePairingRequest(pairing.code);
            const claimed = store.claimPairingRequest(pairing.proof, {
                credentialFactory: () => "scope-credential",
                csrfFactory: () => "scope-csrf",
            });
            const url = "http://127.0.0.1:8787/api/owner/dashboard/stream";
            const headers = { cookie: `rw_owner_device=${claimed.credential}; rw_owner_csrf=scope-csrf` };
            const app = appObject.handler();
            const listings = async () =>
                (await Deno.readTextFile(trace)).trim().split("\n").filter(Boolean)
                    .map((line) => JSON.parse(line) as { event: string; argv?: string[] })
                    .filter((event) =>
                        event.event === "start" && event.argv?.slice(-3).join(" ") === "worktree list --porcelain"
                    )
                    .length;
            Deno.env.set("GIT_TRACE2_EVENT", trace);
            const response = await app(new Request(url, { headers }));
            assertEquals(response.status, 200);
            // The route has returned, but the live socket still holds the producer open.
            await Promise.race([
                entered.promise,
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Live socket not reached")), 5000)),
            ]);
            gate.resolve();
            const frames: StreamFrame[] = (await response.text()).trim().split("\n").map((line: string): StreamFrame =>
                JSON.parse(line)
            );
            assertEquals(frames.at(-1)?.type, "complete");
            assertEquals(
                frames.at(-1)?.sections.some((section) => section.items.some((item) => item.planId === "scope-plan")),
                true,
            );
            const completedListings = await listings();
            const fresh = await app(new Request(url, { headers }));
            assertEquals((await fresh.text()).trim().split("\n").at(-1)?.includes('"type":"complete"'), true);
            assertEquals((await listings()) > completedListings, true);
        } finally {
            gate.resolve();
            if (listening) await new Promise<void>((resolve) => socket.close(() => resolve()));
            if ("close" in appObject && typeof appObject.close === "function") await appObject.close();
            if (previousTrace === undefined) Deno.env.delete("GIT_TRACE2_EVENT");
            else Deno.env.set("GIT_TRACE2_EVENT", previousTrace);
            await Deno.remove(trace);
            await fixture.cleanup();
            await Deno.remove(root, { recursive: true });
        }
    });
});

Deno.test("archived Sessions stay under Plans in dashboard and sidebar but leave standalone history", async () => {
    const { WorkspaceSessionContinuationService } = await import("./server/session-continuation.js");
    const { loadOwnerSidebar } = await import("./server/owner-dashboard.ts");
    const fixture = await makeManagedSessionFixture();
    const { store, session, project } = fixture;
    const continuation = new WorkspaceSessionContinuationService({ store });
    try {
        await savePlan(fixture.projectRoot, "archive-plan", "# Archive Plan\n", {
            planId: "archive-plan",
            classification: "FEATURE",
            status: "on_hold",
        });
        let proof = store.acquireSessionActivation({
            runwieldSessionId: session.runwieldSessionId,
            projectId: project.projectId,
            ownerInstanceId: "archive-test",
            ownerProcessKind: "test",
        });
        const segment = store.getCurrentSessionSegment(session.runwieldSessionId)!;
        store.stagePlanAssociation(proof, {
            planId: "archive-plan",
            planName: "archive-plan",
            purpose: "execution",
            segmentId: segment.segmentId,
            segmentKind: segment.kind,
            recordedAt: new Date().toISOString(),
        });
        proof = store.changeSessionActivationPhase(proof, "hydrated");
        proof = store.changeSessionActivationPhase(proof, "checkpointing");
        store.publishGenerationAndRelease(proof, {
            generation: 1,
            currentSegmentId: segment.segmentId,
            ...await readTranscriptEvidence(fixture.transcriptPath),
        });
        const path = `${fixture.sessionDir}/2026-01-02T00-00-00-000Z_standalone-archive.jsonl`;
        await Deno.writeTextFile(
            path,
            `${
                JSON.stringify({
                    type: "session",
                    version: 3,
                    id: "standalone-archive",
                    timestamp: "2026-01-02T00:00:00.000Z",
                    cwd: fixture.projectRoot,
                })
            }\n`,
        );
        await Deno.writeTextFile(
            path,
            `${
                JSON.stringify({
                    type: "message",
                    id: "standalone-user",
                    timestamp: "2026-01-02T00:00:01.000Z",
                    message: { role: "user", content: [{ type: "text", text: "Standalone conversation" }] },
                })
            }\n`,
            { append: true },
        );
        const standalone = await store.ensureSessionCatalogRecord({
            projectId: project.projectId,
            piSessionId: "standalone-archive",
            transcriptPath: path,
            transcriptCwd: fixture.projectRoot,
        });
        assertEquals((await continuation.listSessions(project.projectId)).sessions.length, 2);
        store.archiveSession(session.runwieldSessionId);
        store.archiveSession(standalone.runwieldSessionId);
        assertEquals((await continuation.listSessions(project.projectId)).sessions.length, 0);
        const dashboard = await loadOwnerDashboard(store, continuation);
        const sidebar = await loadOwnerSidebar(store, continuation);
        for (const projects of [dashboard.projects, sidebar]) {
            const row = projects.find((item) => item.projectId === project.projectId)!;
            assertEquals(
                row.plans.find((plan) => plan.planId === "archive-plan")?.sessions.map((item) =>
                    item.runwieldSessionId
                ),
                [session.runwieldSessionId],
            );
            assertEquals(
                row.plans.find((plan) => plan.planId === "archive-plan")?.sessions[0].archivedAt != null,
                true,
            );
            assertEquals(row.sessions, []);
        }
    } finally {
        await continuation.close();
        await fixture.cleanup();
    }
});
