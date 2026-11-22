import { projectAggregateTranscript } from "../shared/session/session-transcript-manifest.ts";
import { getRunWieldSessionDir } from "../shared/session/root-session.js";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openFileSessionStore } from "../shared/session/file-session-store.ts";
import { test } from "node:test";
import { equal, ok, deepEqual, rejects } from "node:assert/strict";
import { readFile, writeFile, readdir, stat, rename, mkdir, rmdir } from "node:fs/promises";
import { join } from "node:path";
import {
    makeSessionProcessFixture,
    waitForSession,
    launchContinuationOwner,
} from "./client/testing/session-process-fixture.ts";

test(
    "saved history and archive discovery need no provider and do not activate a writer",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        try {
            const runtime = fixture.launch(true);
            const registered = await runtime.client.registerProject({ root: fixture.project });
            ok(registered.status === "ok");
            const projectId = registered.project.projectId;
            const { context } = await runtime.client.openProject({ projectId });
            await runtime.client.create();
            const empty = await runtime.client.listSessions({ context });
            equal(empty.sessions.length, 0, "opening New Session must not save an empty conversation");
            fixture.provider.enqueue({ text: "Canonical saved response." });
            await runtime.client.send(
                runtime.binding(),
                "A saved conversation with no provider requirement for reads.",
            );
            const durable = runtime.view().durableSessionId;
            ok(durable);
            const before = await runtime.client.history({ context, sessionId: durable });
            equal(before.configuration.model, "fixture");
            await runtime.client.archive({ context, sessionId: durable });
            await runtime.client.close(runtime.binding());
            await runtime.shutdown();
            await writeFile(
                join(fixture.home, ".wld", "settings.json"),
                JSON.stringify({ onboardingTutorialOfferHandled: true }),
            );
            await writeFile(join(fixture.home, ".wld", "auth.json"), "{}");
            const reader = fixture.launch(true);
            const next = await reader.client.readProject({ projectId });
            equal((await reader.client.listSessions({ context: next.context })).sessions.length, 0);
            const archived = await reader.client.listSessions({
                context: next.context,
                archiveState: "archived",
                limit: 1,
            });
            deepEqual(
                archived.sessions.map((row) => row.sessionId),
                [durable],
            );
            const base = join(fixture.home, ".wld", "sessions");
            const files = (await readdir(base, { recursive: true })).filter(
                (path) => path.endsWith("manifest.json") || path.endsWith(".jsonl"),
            );
            const evidenceBefore = await Promise.all(
                files.map(async (path) => ({
                    path,
                    bytes: await readFile(join(base, path), "utf8"),
                    modified: (await stat(join(base, path))).mtimeMs,
                })),
            );
            const saved = await reader.client.history({ context: next.context, sessionId: durable });
            const firstPage = await reader.client.history({ context: next.context, sessionId: durable, limit: 1 });
            ok(firstPage.previousCursor);
            const olderPage = await reader.client.history({
                context: next.context,
                sessionId: durable,
                limit: 1,
                cursor: firstPage.previousCursor,
            });
            equal(olderPage.events.length, 1);
            ok(olderPage.events[0].eventId !== firstPage.events[0].eventId);
            await rejects(
                reader.client.history({
                    context: next.context,
                    sessionId: "foreign-session",
                    cursor: firstPage.previousCursor,
                }),
            );
            const evidenceAfter = await Promise.all(
                files.map(async (path) => ({
                    path,
                    bytes: await readFile(join(base, path), "utf8"),
                    modified: (await stat(join(base, path))).mtimeMs,
                })),
            );
            deepEqual(
                evidenceAfter,
                evidenceBefore,
                "initialized passive reads must not modify transcript or manifest evidence",
            );
            deepEqual(saved.events, before.events);
            deepEqual(saved.configuration, before.configuration);
            equal(saved.generation, before.generation);
            ok(saved.archivedAt);
            await reader.client.load(durable).catch(async () => {
                await reader.client.openProject({ projectId });
                await reader.client.load(durable);
            });
            equal(reader.view().archivedAt, saved.archivedAt);
            equal(fixture.provider.requests.length, 1);
            await reader.client.unarchive({ context: next.context, sessionId: durable });
            const restored = await reader.client.history({ context: next.context, sessionId: durable });
            equal(restored.archivedAt, null);
            deepEqual(restored.events, saved.events);
            equal(restored.generation, saved.generation);
        } finally {
            await fixture.cleanup();
        }
    },
);

test("saved Session discovery reports transcript read failures and supports retry", { timeout: 60000 }, async () => {
    const fixture = await makeSessionProcessFixture();
    try {
        const runtime = fixture.launch(true);
        const registered = await runtime.client.registerProject({ root: fixture.project });
        ok(registered.status === "ok");
        const { context } = await runtime.client.openProject({ projectId: registered.project.projectId });
        await runtime.client.create();
        fixture.provider.enqueue({ text: "Preserved saved response." });
        await runtime.client.send(runtime.binding(), "Preserve this saved conversation.");
        const sessionId = runtime.view().durableSessionId;
        await runtime.client.close(runtime.binding());
        const store = openFileSessionStore({ baseDir: join(fixture.home, ".wld", "sessions") });
        const transcriptPath = store.listSessionTranscriptSegments(sessionId)[0].transcriptPath;
        store.close();
        const original = await readFile(transcriptPath, "utf8");
        const listed = await runtime.client.listSessions({ context });
        deepEqual(
            listed.sessions.map((session) => session.sessionId),
            [sessionId],
        );
        const backup = `${transcriptPath}.saved`;
        await rename(transcriptPath, backup);
        try {
            await rejects(runtime.client.listSessions({ context }), "a missing transcript is not an empty page");
            await mkdir(transcriptPath);
            try {
                await rejects(
                    runtime.client.listSessions({ context }),
                    "an unreadable transcript is not an empty page",
                );
            } finally {
                await rmdir(transcriptPath);
            }
        } finally {
            await rename(backup, transcriptPath);
        }
        deepEqual(await runtime.client.listSessions({ context }), listed);
        equal(await readFile(transcriptPath, "utf8"), original);
        equal(fixture.provider.requests.length, 1);
    } finally {
        await fixture.cleanup();
    }
});

test(
    "ordinary session/list uses cwd and file authority without Workspace registration or database",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        try {
            const ordinary = fixture.launch();
            await ordinary.client.create();
            fixture.provider.enqueue({ text: "Ordinary saved work." });
            await ordinary.client.send(ordinary.binding(), "Ordinary file-only discovery.");
            const store = openFileSessionStore({ baseDir: join(fixture.home, ".wld", "sessions") });
            const durable = store.findSessionByLocator({
                piSessionId: ordinary.view().durableSessionId,
            })!.runwieldSessionId;
            store.close();
            await ordinary.client.close(ordinary.binding());
            await ordinary.shutdown();
            await writeFile(join(fixture.home, ".wld", "settings.json"), "{}");
            await writeFile(join(fixture.home, ".wld", "auth.json"), "{}");
            const reader = fixture.launch();
            const result = await reader.client.listSessions({
                context: {
                    connectionId: "ordinary-not-admitted",
                    projectId: "no-registration",
                    canonicalRoot: fixture.project,
                },
            });
            deepEqual(
                result.sessions.map((session) => session.sessionId),
                [durable],
            );
            equal(result.sessions[0].title, "Ordinary file-only discovery.");
            equal(fixture.provider.requests.length, 1);
            const files = await readdir(join(fixture.home, ".wld"));
            ok(
                !files.some((file) => file.startsWith("owner-coordination.sqlite")),
                "ordinary discovery must not open Workspace SQLite",
            );
        } finally {
            await fixture.cleanup();
        }
    },
);

test(
    "discovery pages stable IDs after archive filtering and rejects stale history cursors",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        try {
            const runtime = fixture.launch(true);
            const registered = await runtime.client.registerProject({ root: fixture.project });
            ok(registered.status === "ok");
            const { context } = await runtime.client.openProject({ projectId: registered.project.projectId });
            const ids: string[] = [];
            for (let index = 0; index < 3; index++) {
                await runtime.client.create();
                fixture.provider.enqueue({ text: `Saved response ${index}.` });
                await runtime.client.send(runtime.binding(), "Duplicate display name.");
                ids.push(runtime.view().durableSessionId);
                await runtime.client.close(runtime.binding());
            }
            await runtime.client.archive({ context, sessionId: ids[1] });
            const first = await runtime.client.listSessions({ context, limit: 1 });
            ok(first.nextCursor);
            equal(first.sessions[0].sessionId, ids[2]);
            const second = await runtime.client.listSessions({ context, limit: 1, cursor: first.nextCursor });
            equal(second.sessions[0].sessionId, ids[0]);
            equal(second.nextCursor, null);
            equal(first.sessions[0].title, second.sessions[0].title);
            const archived = await runtime.client.listSessions({ context, limit: 1, archiveState: "archived" });
            deepEqual(
                archived.sessions.map((session) => session.sessionId),
                [ids[1]],
            );
            await rejects(
                runtime.client.listSessions({ context, limit: 1, archiveState: "archived", cursor: first.nextCursor }),
            );
            const page = await runtime.client.history({ context, sessionId: ids[2], limit: 1 });
            ok(page.previousCursor);
            await runtime.client.load(ids[2]);
            fixture.provider.enqueue({ text: "A newer committed generation." });
            await runtime.client.send(runtime.binding(), "Invalidate the older cursor.");
            await rejects(
                runtime.client.history({ context, sessionId: ids[2], cursor: page.previousCursor, limit: 1 }),
            );
        } finally {
            await fixture.cleanup();
        }
    },
);

test(
    "generation-less history bootstraps without provider setup and preserves a conflicting writer",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        let writer: import("node:child_process").ChildProcessWithoutNullStreams | null = null;
        try {
            const runtime = fixture.launch(true);
            const registered = await runtime.client.registerProject({ root: fixture.project });
            ok(registered.status === "ok");
            const projectId = registered.project.projectId;
            await runtime.shutdown();
            await writeFile(join(fixture.home, ".wld", "settings.json"), "{}");
            await writeFile(join(fixture.home, ".wld", "auth.json"), "{}");
            await writeFile(join(fixture.home, ".wld", "models.json"), "{}");
            const helper = fileURLToPath(
                new URL("../shared/session/testing/history-runtime-process.ts", import.meta.url),
            );
            const run = (action: string, identity: string) => {
                const result = spawnSync(fixture.bunExecutable, [helper, action, identity], {
                    cwd: fixture.project,
                    env: fixture.env,
                    encoding: "utf8",
                });
                equal(result.status, 0, result.stderr);
                return result.stdout.trim();
            };
            const seeded: { sessionId: string; transcriptPath: string } = JSON.parse(run("seed", projectId));
            const uninitialized = run("inspect", seeded.sessionId);
            ok(uninitialized.includes('"generation":null'), uninitialized);
            const transcriptBefore = await readFile(seeded.transcriptPath, "utf8");
            writer = spawn(fixture.bunExecutable, [helper, "hold", seeded.sessionId], {
                cwd: fixture.project,
                env: fixture.env,
                stdio: ["pipe", "pipe", "pipe"],
            });
            let ready = "";
            let stderr = "";
            writer.stdout.on("data", (chunk: Buffer) => (ready += chunk.toString()));
            writer.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
            await waitForSession(
                () => ready.includes("\n"),
                () => stderr,
            );
            const heldBefore = run("inspect", seeded.sessionId);
            const reader = fixture.launch(true);
            const { context } = await reader.client.readProject({ projectId });
            await rejects(reader.client.history({ context, sessionId: seeded.sessionId }));
            equal(
                run("inspect", seeded.sessionId),
                heldBefore,
                "a read must not replace or settle another process's writer",
            );
            equal(await readFile(seeded.transcriptPath, "utf8"), transcriptBefore);
            const exited = new Promise<void>((resolve) => writer!.once("close", () => resolve()));
            writer.stdin.end("release\n");
            await exited;
            writer = null;
            const history = await reader.client.history({ context, sessionId: seeded.sessionId });
            equal(history.generation, 0);
            ok(
                history.events.some((event) => JSON.stringify(event).includes("Saved without a model.")),
                JSON.stringify(history),
            );
            const committed = run("inspect", seeded.sessionId);
            equal(await readFile(seeded.transcriptPath, "utf8"), transcriptBefore);
            await reader.client.history({ context, sessionId: seeded.sessionId });
            equal(
                run("inspect", seeded.sessionId),
                committed,
                "initialized reads preserve generation and writer state",
            );
            await reader.client.openProject({ projectId });
            await reader.client.load(seeded.sessionId);
            ready = "";
            writer = spawn(fixture.bunExecutable, [helper, "hold", seeded.sessionId], {
                cwd: fixture.project,
                env: fixture.env,
                stdio: ["pipe", "pipe", "pipe"],
            });
            writer.stdout.on("data", (chunk: Buffer) => (ready += chunk.toString()));
            writer.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
            await waitForSession(
                () => ready.includes("\n"),
                () => stderr,
            );
            const otherWriter = run("inspect", seeded.sessionId);
            await reader.client.close(reader.binding());
            equal(reader.view().sessionId, "", "Close detaches this client's binding");
            equal(
                run("inspect", seeded.sessionId),
                otherWriter,
                "Close must not stop or change another process's writer",
            );
            equal(writer.exitCode, null, "the separate owner remains alive after Close");
            equal(await readFile(seeded.transcriptPath, "utf8"), transcriptBefore);
            const released = new Promise<void>((resolve) => writer!.once("close", () => resolve()));
            writer.stdin.end("release\n");
            await released;
            writer = null;
            equal(fixture.provider.requests.length, 0);
            deepEqual(fixture.provider.failures, []);
        } finally {
            writer?.kill("SIGKILL");
            await fixture.cleanup();
        }
    },
);

test(
    "multi-segment passive history preserves exact canonical order, images and Plan associations through Unarchive restart",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        const owner = launchContinuationOwner(fixture);
        try {
            const writer = fixture.launch(true);
            const registered = await writer.client.registerProject({ root: fixture.project });
            ok(registered.status === "ok");
            const projectId = registered.project.projectId;
            const { context } = await writer.client.openProject({ projectId });
            await writer.client.create();
            const png = {
                mimeType: "image/png",
                base64: (await readFile(new URL("../ui/workspace/static/pwa/icon-192.png", import.meta.url))).toString(
                    "base64",
                ),
            };
            fixture.provider.enqueue({ text: "First canonical answer." });
            await writer.client.sendImages(writer.binding(), "First canonical image.", [png]);
            const durable = writer.view().durableSessionId;
            equal(await owner.command("open", durable), "opened");
            equal(await owner.command("associate"), "associated");
            equal(await owner.command("roll"), "rolled");
            fixture.provider.enqueue({ text: "Second canonical answer." });
            await writer.client.sendImages(writer.binding(), "Second canonical image.", [png]);
            const original = await writer.client.history({ context, sessionId: durable });
            await writer.client.close(writer.binding());
            equal(await owner.command("close"), "closed");
            await owner.shutdown();
            await writer.client.archive({ context, sessionId: durable });
            await writer.shutdown();
            for (const name of ["settings", "auth", "models"])
                await writeFile(join(fixture.home, ".wld", `${name}.json`), "{}");
            const store = openFileSessionStore({ baseDir: join(fixture.home, ".wld", "sessions") });
            const segments = store.listSessionTranscriptSegments(durable);
            equal(segments.length, 2);
            const associations = store.listSessionPlanAssociations(durable);
            equal(associations.length, 1);
            equal(associations[0].planId, "saved-plan-id");
            const inspected = store.inspectSessionActivation(durable);
            ok(inspected.generation);
            const canonical = await projectAggregateTranscript({
                cwd: fixture.project,
                sessionDir: getRunWieldSessionDir(fixture.project),
                runwieldSessionId: durable,
                generation: inspected.generation,
                segments,
                latest: true,
                limit: 200,
            });
            ok(canonical.ok);
            const expected = canonical.events.map((event) =>
                Array.isArray(event.images)
                    ? { ...event, images: event.images.map(() => png), imagesOmitted: 0 }
                    : event,
            );
            deepEqual(
                original.events
                    .filter((event) => ["user_message", "assistant_text_delta"].includes(event.type))
                    .map((event) => event.text ?? event.delta),
                [
                    "First canonical image.",
                    "First canonical answer.",
                    "Second canonical image.",
                    "Second canonical answer.",
                ],
            );
            deepEqual(original.events, expected, "all event identities and order must match verified segment evidence");
            const base = join(fixture.home, ".wld", "sessions");
            const evidence = async () =>
                Promise.all(
                    (await readdir(base, { recursive: true }))
                        .filter((path) => path.endsWith("manifest.json") || path.endsWith(".jsonl"))
                        .sort()
                        .map(async (path) => ({
                            path,
                            bytes: await readFile(join(base, path), "utf8"),
                            modified: (await stat(join(base, path))).mtimeMs,
                        })),
                );
            const before = await evidence();
            const reader = fixture.launch(true);
            const next = await reader.client.openProject({ projectId });
            const archived = await reader.client.history({ context: next.context, sessionId: durable });
            ok(archived.archivedAt);
            await reader.client.load(durable);
            equal(reader.view().durableSessionId, durable);
            equal(reader.view().archivedAt, archived.archivedAt);
            deepEqual(archived.events, expected);
            deepEqual(archived.configuration, original.configuration);
            deepEqual(await evidence(), before, "passive open and reads must not write canonical files");
            deepEqual(store.inspectSessionActivation(durable), inspected, "no passive writer may be acquired");
            deepEqual(store.listSessionPlanAssociations(durable), associations);
            await reader.client.unarchive({ context: next.context, sessionId: durable });
            await reader.client.close(reader.binding());
            await reader.shutdown();
            const restarted = fixture.launch(true);
            const last = await restarted.client.openProject({ projectId });
            await restarted.client.load(durable);
            const restored = await restarted.client.history({ context: last.context, sessionId: durable });
            equal(restored.sessionId, durable);
            equal(restored.archivedAt, null);
            deepEqual(restored.events, expected);
            deepEqual(restored.configuration, original.configuration);
            equal(restored.generation, original.generation);
            deepEqual(store.listSessionPlanAssociations(durable), associations);
            equal(store.getSessionById(durable)!.archivedAt, null);
            equal(fixture.provider.requests.length, 2);
            deepEqual(fixture.provider.failures, []);
            store.close();
        } finally {
            await owner.shutdown();
            await fixture.cleanup();
        }
    },
);

test(
    "first bootstrap writer stays protected and its settled history is fresh without a provider",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        try {
            const writer = fixture.launch(true);
            const registered = await writer.client.registerProject({ root: fixture.project });
            ok(registered.status === "ok");
            const projectId = registered.project.projectId;
            await writer.client.openProject({ projectId });
            const reader = fixture.launch(true);
            const { context } = await reader.client.readProject({ projectId });
            await writer.client.create();
            fixture.provider.enqueue({ text: "First bootstrap held response.", hold: true });
            const turn = writer.client.send(writer.binding(), "First bootstrap accepted prompt.");
            await writer.wait((view) => view.items.some((item) => item.text === "First bootstrap held response."));
            const sessionId = writer.view().durableSessionId;
            ok(sessionId);
            equal(writer.view().generation, null);
            const store = openFileSessionStore({ baseDir: join(fixture.home, ".wld", "sessions") });
            try {
                const active = store.inspectSessionActivation(sessionId);
                equal(active.activation?.state, "active");
                equal(active.generation, null);
                await rejects(
                    reader.client.history({ context, sessionId }),
                    "uncommitted live output is not saved history",
                );
                deepEqual(
                    store.inspectSessionActivation(sessionId),
                    active,
                    "passive history cannot settle the bootstrap writer",
                );
                fixture.provider.release();
                await turn;
                for (const name of ["settings", "auth", "models"])
                    await writeFile(join(fixture.home, ".wld", `${name}.json`), "{}");
                const committed = store.inspectSessionActivation(sessionId);
                ok(committed.generation);
                const history = await reader.client.history({ context, sessionId });
                equal(history.generation, committed.generation.generation);
                deepEqual(
                    history.events
                        .filter((event) => ["user_message", "assistant_text_delta"].includes(event.type))
                        .map((event) => event.text ?? event.delta),
                    ["First bootstrap accepted prompt.", "First bootstrap held response."],
                );
                deepEqual(await reader.client.history({ context, sessionId }), history);
                deepEqual(
                    store.inspectSessionActivation(sessionId),
                    committed,
                    "fresh committed reads do not acquire a writer",
                );
                equal(fixture.provider.requests.length, 1);
                deepEqual(fixture.provider.failures, []);
            } finally {
                store.close();
            }
        } finally {
            fixture.provider.release();
            await fixture.cleanup();
        }
    },
);
