import { test } from "node:test";
import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { assertEquals, assertThrows } from "../../testing/assertions.ts";
import { notDeepStrictEqual as assertNotEquals } from "node:assert/strict";
import { customEntry, makeSessionFixture } from "../remote/session-save-test-fixture.ts";
import { openFileSessionStore } from "./file-session-store.ts";
import { RemoteSessionOwner } from "./remote-session-owner.ts";
import { parseRemoteSessionTranscript, sessionDigest } from "../remote/session-protocol.ts";

test("remote owner hydrates exact laptop evidence under a real exclusive activation", async () => {
    const f = await makeSessionFixture();
    const contender = openFileSessionStore({ baseDir: f.baseDir });
    try {
        assertEquals(f.owner.inspect().contents, f.initial);
        const response = f.owner.handle(f.request("hydrate", 0));
        assertEquals(response.contents, f.initial);
        assertEquals(response.evidence.digestHex, sessionDigest(f.initial));
        assertEquals(response.evidence.byteLength, new TextEncoder().encode(f.initial).length);
        assertEquals(f.store.inspectSessionActivation(f.session.runwieldSessionId).activation?.phase, "hydrated");
        assertThrows(
            () =>
                contender.acquireSessionActivation({
                    runwieldSessionId: f.session.runwieldSessionId,
                    projectId: f.session.projectId,
                    ownerInstanceId: "contender",
                    ownerProcessKind: "test",
                    expectedGeneration: null,
                }),
            Error,
        );
    } finally {
        contender.close();
        await f.close();
    }
});

test("remote owner rejects saves before hydration and skipped sequence identities", async () => {
    const f = await makeSessionFixture();
    try {
        assertThrows(() => f.owner.handle(f.request("append", 0, customEntry())), Error, "not been hydrated");
        assertThrows(() => f.owner.handle(f.request("hydrate", 1)), Error, "Out-of-order");
        f.owner.handle(f.request("hydrate", 0));
        assertThrows(() => f.owner.handle(f.request("append", 2, customEntry())), Error, "Out-of-order");
        assertEquals(f.owner.inspect().contents, f.initial);
    } finally {
        await f.close();
    }
});

test("remote owner retries one identity without duplicating or normalizing exact bytes", async () => {
    const f = await makeSessionFixture();
    try {
        f.owner.handle(f.request("hydrate", 0));
        const bytes = customEntry();
        const request = f.request("append", 1, bytes);
        const first = f.owner.handle(request);
        assertEquals(f.owner.handle({ ...request }), first);
        assertEquals(f.owner.inspect().contents, f.initial + bytes);
        assertEquals(first.evidence.digestHex, sessionDigest(f.initial + bytes));
        f.owner.handle(f.request("append", 2, customEntry("effect-2", "effect-1")));
        assertEquals(f.owner.handle(request), first);
        assertEquals(parseRemoteSessionTranscript(f.owner.inspect().contents).length, 3);
    } finally {
        await f.close();
    }
});

test("remote owner rejects a conflicting retry without changing committed bytes", async () => {
    const f = await makeSessionFixture();
    try {
        f.owner.handle(f.request("hydrate", 0));
        f.owner.handle(f.request("append", 1, customEntry()));
        const saved = f.owner.inspect().contents;
        assertThrows(() => f.owner.handle(f.request("append", 1, customEntry("different"))), Error, "Conflicting");
        assertThrows(() => f.owner.handle(f.request("inspect", 1)), Error, "Conflicting");
        assertEquals(f.owner.inspect().contents, saved);
    } finally {
        await f.close();
    }
});

test("remote owner rejects foreign operation and expired native-lock authority", async () => {
    const f = await makeSessionFixture();
    try {
        assertThrows(
            () => f.owner.handle({ ...f.request("hydrate", 0), operation: crypto.randomUUID() }),
            Error,
            "Stale",
        );
        f.owner.handle(f.request("hydrate", 0));
        f.store.close();
        assertThrows(() => f.owner.handle(f.request("hydrate", 0)), Error);
        assertEquals(await fsReadFile(f.transcriptPath, "utf8"), f.initial);
    } finally {
        await f.close();
    }
});

test("remote owner rechecks laptop evidence even on duplicate requests", async () => {
    const f = await makeSessionFixture();
    try {
        f.owner.handle(f.request("hydrate", 0));
        await fsWriteFile(f.transcriptPath, f.initial + customEntry("outside-writer"));
        assertThrows(() => f.owner.handle(f.request("hydrate", 0)), Error, "evidence changed");
    } finally {
        await f.close();
    }
});

test("remote owner refuses malformed identities and history replacement", async () => {
    const f = await makeSessionFixture();
    try {
        f.owner.handle(f.request("hydrate", 0));
        assertThrows(() => f.owner.handle(f.request("append", 1, customEntry("orphan", "missing"))), Error, "parent");
        assertThrows(
            () => f.owner.handle(f.request("append", 1, customEntry() + customEntry("two", "effect-1"))),
            Error,
            "exactly one",
        );
        f.owner.handle(f.request("append", 1, customEntry()));
        assertThrows(() => f.owner.handle(f.request("append", 2, customEntry())), Error, "identity");
        assertThrows(() => f.owner.handle(f.request("rewrite", 2, f.initial)), Error, "laptop lifecycle");
        const saved = f.owner.inspect().contents;
        f.owner.handle(f.request("rewrite", 2, saved));
        assertEquals(f.owner.inspect().contents, saved);
    } finally {
        await f.close();
    }
});

test("remote owner checkpoint publishes digest and releases for a fresh operation", async () => {
    const f = await makeSessionFixture();
    try {
        f.owner.handle(f.request("hydrate", 0));
        f.owner.handle(f.request("append", 1, customEntry()));
        const saved = f.owner.inspect().contents;
        const receipt = f.owner.handle(f.request("checkpoint", 2));
        const state = f.store.inspectSessionActivation(f.session.runwieldSessionId);
        assertEquals(state.activation?.state, "idle");
        assertEquals(state.generation?.generation, 0);
        assertEquals(state.generation?.digestHex, receipt.evidence.digestHex);
        assertEquals(state.generation?.terminalEntryId, "effect-1");
        assertThrows(() => f.owner.handle(f.request("checkpoint", 2)), Error, "Stale");
        const proof = f.store.acquireSessionActivation({
            runwieldSessionId: f.session.runwieldSessionId,
            projectId: f.session.projectId,
            ownerInstanceId: "fresh",
            ownerProcessKind: "test",
            phase: "preparing",
            expectedGeneration: 0,
        });
        const fresh = new RemoteSessionOwner(f.store, proof);
        assertNotEquals(fresh.operation, f.owner.operation);
        assertEquals(
            fresh.handle({ operation: fresh.operation, kind: "hydrate", sequence: 0, contents: "" }).contents,
            saved,
        );
        fresh.markUncertain();
    } finally {
        await f.close();
    }
});

test("remote owner uncertainty recovers saved evidence without replaying the effect", async () => {
    const f = await makeSessionFixture();
    const reloaded = openFileSessionStore({ baseDir: f.baseDir });
    try {
        f.owner.handle(f.request("hydrate", 0));
        const append = f.request("append", 1, customEntry());
        f.owner.handle(append);
        f.owner.handle(f.request("uncertain", 2));
        assertEquals(f.store.inspectSessionActivation(f.session.runwieldSessionId).activation?.state, "uncertain");
        assertThrows(() => f.owner.handle(append), Error, "Stale");
        f.owner.recoverUncertain();
        const state = reloaded.inspectSessionActivation(f.session.runwieldSessionId);
        assertEquals(state.activation?.state, "idle");
        const proof = reloaded.acquireSessionActivation({
            runwieldSessionId: f.session.runwieldSessionId,
            projectId: f.session.projectId,
            ownerInstanceId: "reload",
            ownerProcessKind: "test",
            phase: "preparing",
            expectedGeneration: state.generation?.generation ?? null,
        });
        const fresh = new RemoteSessionOwner(reloaded, proof);
        const loaded = fresh.handle({ operation: fresh.operation, sequence: 0, kind: "hydrate", contents: "" });
        assertEquals(loaded.contents, f.initial + customEntry());
        assertEquals(parseRemoteSessionTranscript(loaded.contents).length, 2);
        assertThrows(() => fresh.handle(append), Error, "Stale");
        fresh.markUncertain();
    } finally {
        reloaded.close();
        await f.close();
    }
});

test("remote owner requires trusted preparing proof instead of a hydrated activation", async () => {
    const f = await makeSessionFixture();
    try {
        const proof = f.store.changeSessionActivationPhase(f.proof, "hydrated");
        assertThrows(() => new RemoteSessionOwner(f.store, proof), Error, "preparing phase");
        assertThrows(() => f.owner.handle(f.request("hydrate", 0)), Error);
    } finally {
        await f.close();
    }
});
