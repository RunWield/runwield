import { assert, assertEquals } from "@std/assert";
import { latch, within, withRemoteRuntimeFixture } from "./remote-runtime-test-fixture.ts";

for (const held of ["begin", "checkpoint"] as const) {
    Deno.test(`remote close waits for resume's ${held} acknowledgement and leaves no writer`, async () => {
        await withRemoteRuntimeFixture(async (f) => {
            f.setModelResponse("Saved history for a close during resume.");
            const original = await f.start();
            await original.read();
            await original.send({ kind: "turn", text: "Remember this before closing." });
            const saved = await original.read();
            assertEquals(saved.ok, true, saved.error);
            assert(saved.savedId);
            const reached = latch();
            const release = latch();
            f.policy.handle = async (input, path, response) => {
                if (path === "/session/control" && input.kind === held) {
                    // The laptop performed the operation. Delay only the network acknowledgement.
                    await response.clone().text();
                    reached.release();
                    await release.promise;
                }
                return response;
            };
            try {
                const fresh = await f.start();
                await fresh.read();
                await fresh.send({ kind: "load-start", sessionId: saved.savedId });
                assertEquals((await fresh.read()).kind, "load-started");
                await within(reached.promise);
                await fresh.send({ kind: "snapshots" });
                const loading = (await fresh.read()).snapshots || [];
                assertEquals(loading.length, 1);
                assertEquals(loading[0].disposed, false);
                await fresh.send({ kind: "close-session", sessionId: loading[0].id });
                assertEquals((await fresh.read()).kind, "close-requested");
                // A subsequent command is processed while close is pending. No timing sleep
                // is needed: close must still not have emitted its completion report.
                await fresh.send({ kind: "snapshots" });
                const during = await fresh.read();
                assertEquals(during.kind, "snapshots", "Close must not finish before the acknowledgement");
                assertEquals(during.snapshots, loading);
                assertEquals(during.snapshots?.[0].busy, true, "Resume must not be idle before acknowledgement");
                release.release();
                const settled = [await fresh.read(), await fresh.read()];
                assertEquals(settled.find((report) => report.kind === "load")?.ok, true);
                assertEquals(settled.find((report) => report.kind === "close-session")?.closed, true);
                await fresh.send({ kind: "snapshots" });
                assertEquals((await fresh.read()).snapshots, []);
                f.policy.handle = undefined;
                assertEquals(f.store.inspectSessionActivation(saved.savedId).activation?.state, "idle");
                // Reacquisition is public proof that no stale writer survived shutdown.
                await fresh.send({ kind: "load", sessionId: saved.savedId });
                const reloaded = await fresh.read();
                assertEquals(reloaded.ok, true, reloaded.error);
                assertEquals(reloaded.savedId, saved.savedId);
                assertEquals(f.store.inspectSessionActivation(saved.savedId).activation?.state, "idle");
            } finally {
                release.release();
                f.policy.handle = undefined;
            }
        });
    });
}
