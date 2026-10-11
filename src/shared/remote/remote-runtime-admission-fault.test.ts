import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import {
    assertRemoteStorageAbsent,
    assertSmallControlBodies,
    latch,
    withRemoteRuntimeFixture,
} from "./remote-runtime-test-fixture.ts";

for (const kind of ["create", "begin"] as const) {
    for (const fault of ["held", "lost"] as const) {
        Deno.test(`${fault} ${kind} admission reply stops work and releases the laptop writer with live heartbeats`, async () => {
            await withRemoteRuntimeFixture(async (f) => {
                let modelRequests = 0;
                f.setModelResponseFactory(() => {
                    modelRequests++;
                    return fauxAssistantMessage(fauxText("Saved seed answer."));
                });
                const child = await f.start();
                await child.read();
                if (kind === "begin") {
                    await child.send({ kind: "turn", text: "Seed conversation." });
                    const seeded = await child.read();
                    assertEquals(seeded.ok, true, seeded.error);
                }
                const requestsBeforeFault = modelRequests;
                const held = latch();
                let admittedSession = "";
                let admittedOperation = "";
                f.policy.handle = async (input, path, response) => {
                    if (path === "/session/control" && input.kind === kind && "sessionId" in input) {
                        admittedSession = input.sessionId;
                        // The laptop has completely sent its reply to the proxy. A laptop
                        // Request.signal listener cannot detect loss on the remaining hop.
                        const body = await response.text();
                        admittedOperation = JSON.parse(body).operation;
                        if (fault === "held") await held.promise;
                        else return new Response("Admission acknowledgement lost", { status: 503 });
                        return new Response(body, { headers: { "Content-Type": "application/json" } });
                    }
                    return response;
                };
                let stopHeartbeat = false;
                let heartbeats = 0;
                const heartbeat = (async () => {
                    while (!stopHeartbeat) {
                        const response = await fetch(`http://127.0.0.1:${f.control.connection.port}/health`, {
                            method: "POST",
                            headers: { Authorization: `Bearer ${f.control.connection.credential}` },
                        });
                        assertEquals(await response.json(), { shutdown: false });
                        heartbeats++;
                        await new Promise((resolve) => setTimeout(resolve, 500));
                    }
                })();
                try {
                    await child.send({ kind: "turn", text: "Never replay admission violet-926 or edit sentinel.txt." });
                    const failed = await child.read();
                    assert(admittedSession);
                    assert(admittedOperation);
                    assertEquals(failed.ok, false, JSON.stringify(failed));
                    assertEquals(
                        modelRequests,
                        requestsBeforeFault,
                        "Admission failure must not start a model or tool",
                    );
                    assertEquals(f.store.inspectSessionActivation(admittedSession).activation?.state, "uncertain");
                    assertEquals(await Deno.readTextFile(join(f.remoteProject, "sentinel.txt")), "remote initial\n");
                    assertEquals(await Deno.readTextFile(join(f.projectRoot, "sentinel.txt")), "laptop initial\n");
                    assertEquals(
                        f.controls.filter((entry) => entry.request.kind === kind).length,
                        1,
                        "The failed admission must not be replayed",
                    );
                    assert(heartbeats > 0);
                    held.release();
                    f.policy.handle = undefined;
                    // Same connection, new admission: recovery must not need SSH closure.
                    const next = await f.control.begin(admittedSession);
                    const hydrated = await fetch(`http://127.0.0.1:${f.control.connection.port}/session/request`, {
                        method: "POST",
                        headers: { Authorization: `Bearer ${f.control.connection.credential}` },
                        body: JSON.stringify({ operation: next, sequence: 0, kind: "hydrate", contents: "" }),
                    });
                    assertEquals(hydrated.ok, true);
                    const contents = (await hydrated.json()).contents;
                    assertEquals(
                        contents.includes("violet-926"),
                        false,
                        "Failed admission must not save or replay the request",
                    );
                    assertEquals(contents.split("Seed conversation.").length - 1, kind === "begin" ? 1 : 0);
                    await f.control.checkpoint(next);
                    assertEquals(modelRequests, requestsBeforeFault, "Recovery must not replay effects");
                    assertSmallControlBodies(f);
                    await assertRemoteStorageAbsent(f);
                } finally {
                    stopHeartbeat = true;
                    held.release();
                    await heartbeat;
                }
            });
        });
    }
}
