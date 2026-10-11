import { assertEquals } from "@std/assert";
import { customEntry, makeControlFixture } from "./session-save-test-fixture.ts";

Deno.test("Session HTTP rejects bad credentials without hydrating laptop authority", async () => {
    const f = await makeControlFixture();
    try {
        await f.ready();
        const response = await f.post("/session/request", JSON.stringify(f.request("hydrate", 0)), "wrong-credential");
        assertEquals(response.status, 401);
        await response.text();
        assertEquals(f.store.inspectSessionActivation(f.session.runwieldSessionId).activation?.phase, "preparing");
        assertEquals(f.owner.inspect().contents, f.initial);
    } finally {
        await f.close();
    }
});

Deno.test("Session HTTP requires connection readiness and rejects stale operation identities", async () => {
    const f = await makeControlFixture();
    try {
        const notReady = await f.post("/session/request", JSON.stringify(f.request("hydrate", 0)));
        assertEquals(notReady.status, 403);
        await notReady.text();
        await f.ready();
        const stale = await f.post(
            "/session/request",
            JSON.stringify({ ...f.request("hydrate", 0), operation: crypto.randomUUID() }),
        );
        assertEquals(stale.status, 409);
        await stale.text();
        f.control.unregisterSessionOwner(f.owner.operation);
        const removed = await f.post("/session/request", JSON.stringify(f.request("hydrate", 0)));
        assertEquals(removed.status, 409);
        await removed.text();
        assertEquals(f.owner.inspect().contents, f.initial);
    } finally {
        await f.close();
    }
});

Deno.test("Session HTTP does not accept paths or caller writer proofs", async () => {
    const f = await makeControlFixture();
    try {
        await f.ready();
        for (
            const input of [
                { ...f.request("hydrate", 0), proof: f.proof },
                { ...f.request("hydrate", 0), path: f.transcriptPath },
                { ...f.request("hydrate", 0), sequence: -1 },
                { ...f.request("hydrate", 0), contents: "unexpected" },
            ]
        ) {
            const response = await f.post("/session/request", JSON.stringify(input));
            assertEquals(response.status, 400);
            await response.text();
        }
        assertEquals(f.owner.inspect().contents, f.initial);
    } finally {
        await f.close();
    }
});

Deno.test("Session HTTP returns duplicate receipt but refuses conflicting exact bytes", async () => {
    const f = await makeControlFixture();
    try {
        await f.ready();
        const hydrate = await f.post("/session/request", JSON.stringify(f.request("hydrate", 0)));
        assertEquals(hydrate.status, 200);
        await hydrate.text();
        const input = JSON.stringify(f.request("append", 1, customEntry()));
        const first = await f.post("/session/request", input);
        const receipt = await first.text();
        assertEquals(first.status, 200);
        const duplicate = await f.post("/session/request", input);
        assertEquals(duplicate.status, 200);
        assertEquals(await duplicate.text(), receipt);
        const conflict = await f.post("/session/request", JSON.stringify(f.request("append", 1, customEntry("other"))));
        assertEquals(conflict.status, 409);
        await conflict.text();
        assertEquals(f.owner.inspect().contents, f.initial + customEntry());
    } finally {
        await f.close();
    }
});

Deno.test("Session HTTP shutdown refuses further save and checkpoint admission", async () => {
    const f = await makeControlFixture();
    try {
        await f.ready();
        const hydrate = await f.post("/session/request", JSON.stringify(f.request("hydrate", 0)));
        await hydrate.text();
        f.control.requestShutdown();
        for (const input of [f.request("append", 1, customEntry()), f.request("checkpoint", 1)]) {
            const response = await f.post("/session/request", JSON.stringify(input));
            assertEquals(response.status, 403);
            await response.text();
        }
        assertEquals(f.owner.inspect().contents, f.initial);
        assertEquals(f.store.inspectSessionActivation(f.session.runwieldSessionId).generation, null);
    } finally {
        await f.close();
    }
});
