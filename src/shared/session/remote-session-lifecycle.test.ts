import { assert, assertEquals, assertNotEquals, assertRejects, assertThrows } from "@std/assert";
import { customEntry, makeSessionFixture, within } from "../remote/session-save-test-fixture.ts";
import { RemoteSessionOwner } from "./remote-session-owner.ts";
import { parseRemoteSessionTranscript, sessionDigest } from "../remote/session-protocol.ts";
import { HostedSession } from "./hosted-session.js";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { getHomeDir } from "../../constants.js";
import { dirname, join } from "@std/path";
import { lockPath, manifestPath, writeJsonAtomically, writeTextAtomically } from "./file-session-storage.ts";
import type { FileSessionManifest } from "./file-session-store-types.ts";
import { openFileSessionStore } from "./file-session-store.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
function lines() {
    let pending = "";
    return new TransformStream<string, string>({
        transform(chunk, controller) {
            pending += chunk;
            for (let index = pending.indexOf("\n"); index >= 0; index = pending.indexOf("\n")) {
                controller.enqueue(pending.slice(0, index));
                pending = pending.slice(index + 1);
            }
        },
        flush(controller) {
            if (pending) controller.enqueue(pending);
        },
    });
}

interface ProcessReply {
    excluded?: boolean;
    reason?: string;
    pid?: number;
    operation?: string;
    saved?: string;
    monitoring?: boolean;
    excludedSamples?: number;
    idleSamples?: number;
    violations?: number;
    migrationRefused?: boolean;
    originalUnchanged?: boolean;
}
type SessionFixture = Awaited<ReturnType<typeof makeSessionFixture>>;
function processOptions(f: SessionFixture, mode: "contend" | "owner" | "monitor" | "migration-refusal") {
    const state = f.store.inspectSessionActivation(f.session.runwieldSessionId);
    return {
        args: [
            "run",
            "-A",
            "--node-modules-dir=manual",
            "--quiet",
            new URL("./remote-session-process-fixture.ts", import.meta.url).pathname,
            JSON.stringify({
                baseDir: f.baseDir,
                runwieldSessionId: f.session.runwieldSessionId,
                projectId: f.session.projectId,
                expectedGeneration: state.generation?.generation ?? null,
                mode,
                lockFile: lockPath(dirname(f.transcriptPath), f.session.runwieldSessionId),
                effectPath: join(f.remoteProject, "death-effect"),
            }),
        ],
        env: { HOME: f.home, MNEMOTECA_DB_PATH: join(f.home, "memory.sqlite3") },
        stdin: "piped" as const,
        stdout: "piped" as const,
        stderr: "piped" as const,
    };
}
async function contender(f: SessionFixture): Promise<ProcessReply> {
    const output = await within(
        new Deno.Command(Deno.execPath(), { ...processOptions(f, "contend"), stdin: "null" }).output(),
    );
    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
    return JSON.parse(new TextDecoder().decode(output.stdout));
}
function freshOwner(f: SessionFixture) {
    const state = f.store.inspectSessionActivation(f.session.runwieldSessionId);
    return new RemoteSessionOwner(
        f.store,
        f.store.acquireSessionActivation({
            runwieldSessionId: f.session.runwieldSessionId,
            projectId: f.session.projectId,
            ownerInstanceId: "fresh-laptop-owner",
            ownerProcessKind: "test",
            phase: "preparing",
            expectedGeneration: state.generation?.generation ?? null,
        }),
    );
}

Deno.test("legacy laptop bytes migrate durably before remote hydration is admitted", async () => {
    const legacy = JSON.stringify({
        type: "custom",
        timestamp: "2026-01-01T00:00:00.000Z",
        customType: "legacy-effect",
        data: { effect: "finished" },
    }) + "\n";
    const f = await makeSessionFixture({ version: 1, legacyContents: legacy });
    try {
        const migrated = f.owner.inspect().contents;
        assertNotEquals(migrated, f.initial);
        assertEquals(await Deno.readTextFile(f.transcriptPath), migrated);
        const entries = parseRemoteSessionTranscript(migrated);
        assertEquals(entries[0].type === "session" && entries[0].version, 3);
        assert(entries[1].type !== "session" && entries[1].id);
        assertEquals(f.store.inspectSessionActivation(f.session.runwieldSessionId).activation?.phase, "preparing");
        assertEquals(f.owner.handle(f.request("hydrate", 0)).contents, migrated);
        f.owner.handle(f.request("checkpoint", 1));
        const fresh = freshOwner(f);
        assertEquals(
            fresh.handle({ operation: fresh.operation, sequence: 0, kind: "hydrate", contents: "" }).contents,
            migrated,
        );
        fresh.markUncertain();
    } finally {
        await f.close();
    }
});

Deno.test("an actual second OS process is excluded before saves and before generation publication", async () => {
    const f = await makeSessionFixture();
    try {
        assertEquals((await contender(f)).excluded, true);
        f.owner.handle(f.request("hydrate", 0));
        f.owner.handle(f.request("append", 1, customEntry()));
        assertEquals((await contender(f)).excluded, true);
        assertEquals(f.store.inspectSessionActivation(f.session.runwieldSessionId).generation, null);
        f.owner.handle(f.request("checkpoint", 2));
        assertEquals((await contender(f)).excluded, false);
    } finally {
        await f.close();
    }
});

Deno.test("remote rollover keeps native lock exclusion and rejects stale old payload after successor", async () => {
    await withProcessGlobalTestLock(async () => {
        const f = await makeSessionFixture({ homeSessions: true });
        const home = getHomeDir();
        Deno.env.set("HOME", f.home);
        const monitor = new Deno.Command(Deno.execPath(), processOptions(f, "monitor")).spawn();
        const reader = monitor.stdout.pipeThrough(new TextDecoderStream()).pipeThrough(lines())
            .getReader();
        const errors = new Response(monitor.stderr).text();
        try {
            const ready = await within(reader.read());
            assert(ready.value);
            assertEquals(JSON.parse(ready.value).monitoring, true);
            f.owner.handle(f.request("hydrate", 0));
            f.owner.handle(f.request("append", 1, customEntry()));
            const segment = f.store.getCurrentSessionSegment(f.session.runwieldSessionId);
            assert(segment);
            const hosted = new HostedSession({
                id: "laptop-owned-remote",
                cwd: f.remoteProject,
                managed: {
                    runwieldSessionId: f.session.runwieldSessionId,
                    projectId: f.session.projectId,
                    piSessionId: segment.piSessionId,
                    transcriptPath: segment.transcriptPath,
                    currentSegmentId: segment.segmentId,
                    generation: null,
                    acknowledgedGeneration: null,
                    acknowledgedEventId: null,
                    name: null,
                    activeAgent: null,
                    workflowContext: null,
                    tutorialContext: null,
                },
                sessionManager: SessionManager.inMemory(
                    f.remoteProject,
                    undefined,
                    parseRemoteSessionTranscript(f.owner.inspect().contents),
                ),
            });
            const rolling = f.owner.rollover({
                hostedSession: hosted,
                transcriptCwd: f.cwd,
                kind: "semantic_repair",
                continuation: {
                    kind: "review-continue",
                    planName: "owned-plan",
                    maxCycles: 2,
                    nextCycle: 1,
                    lastFindingsText: "saved findings",
                },
            });
            assertThrows(() => f.owner.handle(f.request("append", 2, customEntry("late", "effect-1"))), Error, "Stale");
            const result = await within(rolling);
            const writer = monitor.stdin.getWriter();
            await writer.write(new Uint8Array([1]));
            await writer.close();
            writer.releaseLock();
            const sample = await within(reader.read());
            assert(sample.value);
            const observations: ProcessReply = JSON.parse(sample.value);
            assert((observations.excludedSamples ?? 0) > 0);
            assertEquals(observations.violations, 0);
            assertEquals((await within(monitor.status)).code, 0, await errors);
            const fresh = freshOwner(f);
            const successor = fresh.inspect().contents;
            assertEquals(
                f.store.getCurrentSessionSegment(f.session.runwieldSessionId)?.segmentId,
                result.successorSegmentId,
            );
            assertNotEquals(result.transcriptPath, f.transcriptPath);
            assertEquals((await contender(f)).excluded, true);
            assertThrows(() => fresh.handle(f.request("append", 2, customEntry("late", "effect-1"))), Error, "Stale");
            assertEquals(fresh.inspect().contents, successor);
            assertEquals(await Deno.readTextFile(f.transcriptPath), f.initial + customEntry());
            fresh.markUncertain();
        } finally {
            try {
                monitor.kill("SIGKILL");
            } catch { /* Exited. */ }
            await monitor.status;
            await reader.cancel();
            reader.releaseLock();
            await errors;
            Deno.env.set("HOME", home);
            await f.close();
        }
    });
});

Deno.test("owner OS-process death recovers exact laptop evidence and a fresh operation without effect replay", async () => {
    const f = await makeSessionFixture();
    f.owner.markUncertain();
    f.owner.recoverUncertain();
    const child = new Deno.Command(Deno.execPath(), processOptions(f, "owner")).spawn();
    const reader = child.stdout.getReader();
    let stderr = "";
    const errors = new Response(child.stderr).text().then((text) => {
        stderr = text;
    });
    try {
        const first = await within(reader.read());
        assert(first.value, stderr);
        const reply: ProcessReply = JSON.parse(new TextDecoder().decode(first.value).trim());
        assertEquals(reply.pid, child.pid);
        assertEquals(await Deno.readTextFile(join(f.remoteProject, "death-effect")), "effect\n");
        assertEquals((await contender(f)).excluded, true);
        child.kill("SIGKILL");
        await within(child.status);
        await errors;
        const state = f.store.inspectSessionActivation(f.session.runwieldSessionId);
        assert(state.activation);
        const saved = await Deno.readTextFile(f.transcriptPath);
        assertEquals(saved, reply.saved);
        const last = parseRemoteSessionTranscript(saved).at(-1);
        assert(last && last.type !== "session");
        f.store.recoverSessionControl({
            runwieldSessionId: f.session.runwieldSessionId,
            projectId: f.session.projectId,
            expectedFence: state.activation.fence,
            expectedGeneration: state.generation?.generation ?? null,
            expectedCurrentSegmentId: state.activation.currentSegmentId,
            ownerInstanceId: "recovery",
            ownerProcessKind: "test",
            transcriptEvidence: {
                byteLength: new TextEncoder().encode(saved).length,
                digestHex: sessionDigest(saved),
                terminalEntryId: last.id,
            },
        });
        const fresh = freshOwner(f);
        assertEquals(
            fresh.handle({ operation: fresh.operation, sequence: 0, kind: "hydrate", contents: "" }).contents,
            saved,
        );
        assertThrows(
            () =>
                fresh.handle({
                    operation: reply.operation ?? "missing",
                    sequence: 1,
                    kind: "append",
                    contents: customEntry("saved-before-death"),
                }),
            Error,
            "Stale",
        );
        fresh.handle({
            operation: fresh.operation,
            sequence: 1,
            kind: "append",
            contents: customEntry("fresh-effect", "saved-before-death"),
        });
        fresh.handle({ operation: fresh.operation, sequence: 2, kind: "checkpoint", contents: "" });
        assertEquals(parseRemoteSessionTranscript(fresh.inspect().contents).length, 3);
        assertEquals(await Deno.readTextFile(join(f.remoteProject, "death-effect")), "effect\n");
    } finally {
        try {
            child.kill("SIGKILL");
        } catch { /* Exited. */ }
        await child.status;
        await reader.cancel();
        reader.releaseLock();
        await errors;
        await f.close();
    }
});

for (const committedLegacy of [false, true]) {
    Deno.test(`laptop migration ${committedLegacy ? "committed" : "initial"} baseline recovers after remote save uncertainty`, async () => {
        const f = await makeSessionFixture({ version: 2, committedLegacy });
        try {
            const migrated = f.owner.inspect().contents;
            f.owner.handle(f.request("hydrate", 0));
            f.owner.handle(f.request("append", 1, customEntry()));
            f.owner.markUncertain();
            f.owner.recoverUncertain();
            const fresh = freshOwner(f);
            assertEquals(fresh.inspect().contents, migrated + customEntry());
            assertEquals(f.store.inspectSessionActivation(f.session.runwieldSessionId).activation?.phase, "preparing");
            fresh.markUncertain();
        } finally {
            await f.close();
        }
    });
}

for (const replaced of [false, true]) {
    for (const committedLegacy of [false, true]) {
        Deno.test(`interrupted migration ${replaced ? "after" : "before"} replacement reconciles ${committedLegacy ? "committed" : "initial"} evidence`, async () => {
            const f = await makeSessionFixture({ committedLegacy });
            const path = manifestPath(dirname(f.transcriptPath), f.session.runwieldSessionId);
            try {
                const before = await Deno.readTextFile(f.transcriptPath);
                const after = before.trimEnd() + " \n";
                // A durable crash snapshot with the real manifest, bytes and native lock.
                const manifest: FileSessionManifest = JSON.parse(await Deno.readTextFile(path));
                manifest.activation.pendingMigration = {
                    beforeByteLength: new TextEncoder().encode(before).length,
                    beforeDigestHex: sessionDigest(before),
                    headerVersion: 3,
                    after: {
                        byteLength: new TextEncoder().encode(after).length,
                        digestHex: sessionDigest(after),
                        terminalEntryId: null,
                    },
                };
                writeJsonAtomically(path, manifest);
                if (replaced) writeTextAtomically(f.transcriptPath, after);
                f.store.close();
                const restarted = openFileSessionStore({ baseDir: f.baseDir });
                try {
                    const state = restarted.inspectSessionActivation(f.session.runwieldSessionId);
                    assertEquals(state.activation?.state, committedLegacy ? "idle" : "uninitialized");
                    assertEquals(state.generation?.generation ?? null, committedLegacy ? (replaced ? 1 : 0) : null);
                    const owner = new RemoteSessionOwner(
                        restarted,
                        restarted.acquireSessionActivation({
                            runwieldSessionId: f.session.runwieldSessionId,
                            projectId: f.session.projectId,
                            ownerInstanceId: "migration-recovery",
                            ownerProcessKind: "test",
                            phase: "preparing",
                            expectedGeneration: state.generation?.generation ?? null,
                        }),
                    );
                    assertEquals(owner.inspect().contents, replaced ? after : before);
                    owner.markUncertain();
                    owner.recoverUncertain();
                } finally {
                    restarted.close();
                }
            } finally {
                await f.close();
            }
        });
    }
}

for (const tail of ["partial-json", "partial-utf8", "complete-without-newline"] as const) {
    Deno.test(`uncertain ${tail} recovery retains complete laptop entries without replay`, async () => {
        const f = await makeSessionFixture();
        try {
            f.owner.handle(f.request("hydrate", 0));
            f.owner.handle(f.request("append", 1, customEntry()));
            const partial = new TextEncoder().encode('{"type":"custom","data":"🌍');
            const fragment = tail === "complete-without-newline"
                ? new TextEncoder().encode(customEntry("tail-entry", "effect-1").slice(0, -1))
                : tail === "partial-utf8"
                ? partial.slice(0, -2)
                : new TextEncoder().encode('{"type":"custom","data":"cut');
            await Deno.writeFile(f.transcriptPath, fragment, { append: true });
            await Deno.writeTextFile(join(f.remoteProject, "effect"), "finished once");
            f.owner.markUncertain();
            f.owner.recoverUncertain();
            const fresh = freshOwner(f);
            assertEquals(
                fresh.inspect().contents,
                f.initial + customEntry() +
                    (tail === "complete-without-newline" ? customEntry("tail-entry", "effect-1") : ""),
            );
            assertEquals(await Deno.readTextFile(join(f.remoteProject, "effect")), "finished once");
            fresh.markUncertain();
        } finally {
            await f.close();
        }
    });
}

Deno.test("rollover after committed laptop migration uses authoritative proof rather than stale hosted generation", async () => {
    await withProcessGlobalTestLock(async () => {
        const f = await makeSessionFixture({ version: 2, committedLegacy: true, homeSessions: true });
        const home = getHomeDir();
        Deno.env.set("HOME", f.home);
        try {
            f.owner.handle(f.request("hydrate", 0));
            const segment = f.store.getCurrentSessionSegment(f.session.runwieldSessionId);
            assert(segment);
            const hosted = new HostedSession({
                id: "legacy-hosted",
                cwd: f.cwd,
                managed: {
                    runwieldSessionId: f.session.runwieldSessionId,
                    projectId: f.session.projectId,
                    piSessionId: segment.piSessionId,
                    transcriptPath: segment.transcriptPath,
                    currentSegmentId: segment.segmentId,
                    generation: 0,
                    acknowledgedGeneration: 0,
                    acknowledgedEventId: null,
                    name: null,
                    activeAgent: null,
                    workflowContext: null,
                    tutorialContext: null,
                },
                sessionManager: SessionManager.inMemory(
                    f.cwd,
                    undefined,
                    parseRemoteSessionTranscript(f.owner.inspect().contents),
                ),
            });
            const result = await f.owner.rollover({
                hostedSession: hosted,
                kind: "semantic_repair",
                continuation: {
                    kind: "review-continue",
                    planName: "legacy-plan",
                    maxCycles: 2,
                    nextCycle: 1,
                    lastFindingsText: "saved",
                },
            });
            assertEquals(result.generation, 2);
            assertEquals(f.store.inspectSessionActivation(f.session.runwieldSessionId).activation?.state, "idle");
            assertEquals(f.store.inspectSessionActivation(f.session.runwieldSessionId).generation?.generation, 2);
        } finally {
            Deno.env.set("HOME", home);
            await f.close();
        }
    });
});

Deno.test({
    name: "migration refuses storage-intent failure before changing any transcript bytes",
    ignore: Deno.build.os !== "darwin",
    fn: async () => {
        const f = await makeSessionFixture();
        try {
            f.store.releaseUnchangedActivation(f.proof);
            const output = await within(new Deno.Command(Deno.execPath(), {
                ...processOptions(f, "migration-refusal"),
                stdin: "null",
            }).output());
            assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
            const reply: ProcessReply = JSON.parse(new TextDecoder().decode(output.stdout));
            assertEquals(reply.migrationRefused, true);
            assertEquals(reply.originalUnchanged, true);
            assertEquals(await Deno.readTextFile(f.transcriptPath), f.initial);
        } finally {
            await f.close();
        }
    },
});

for (const failure of ["missing-metadata", "missing-segment", "wrong-project"] as const) {
    Deno.test(`remote rollover ${failure} releases ownership and permits fresh recovery`, async () => {
        const f = await makeSessionFixture();
        try {
            f.owner.handle(f.request("hydrate", 0));
            f.owner.handle(f.request("append", 1, customEntry()));
            const segment = f.store.getCurrentSessionSegment(f.session.runwieldSessionId);
            assert(segment);
            const hosted = new HostedSession({
                id: "failed-rollover",
                cwd: f.remoteProject,
                managed: failure === "missing-metadata" ? undefined : {
                    runwieldSessionId: f.session.runwieldSessionId,
                    projectId: failure === "wrong-project" ? "other-project" : f.session.projectId,
                    piSessionId: segment.piSessionId,
                    transcriptPath: segment.transcriptPath,
                    currentSegmentId: failure === "missing-segment" ? "missing" : segment.segmentId,
                    generation: null,
                    acknowledgedGeneration: null,
                    acknowledgedEventId: null,
                    name: null,
                    activeAgent: null,
                    workflowContext: null,
                    tutorialContext: null,
                },
            });
            await assertRejects(() =>
                f.owner.rollover({
                    hostedSession: hosted,
                    transcriptCwd: f.cwd,
                    kind: "semantic_repair",
                    continuation: {
                        kind: "review-continue",
                        planName: "owned-plan",
                        maxCycles: 2,
                        nextCycle: 1,
                        lastFindingsText: "saved findings",
                    },
                })
            );
            assertEquals(f.store.inspectSessionActivation(f.session.runwieldSessionId).activation?.state, "uncertain");
            f.owner.recoverUncertain();
            assertEquals((await contender(f)).excluded, false);
            const fresh = freshOwner(f);
            assertEquals(fresh.inspect().contents, f.initial + customEntry());
            fresh.markUncertain();
        } finally {
            await f.close();
        }
    });
}
