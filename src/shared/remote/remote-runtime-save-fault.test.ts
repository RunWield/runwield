import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { listSavedRemoteSessions } from "./laptop-session-control.ts";
import {
    assertRemoteStorageAbsent,
    assertSmallControlBodies,
    withRemoteRuntimeFixture,
} from "./remote-runtime-test-fixture.ts";

test("lost first user-save acknowledgement stops the remote turn and resume does not replay the submitted request", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        let modelRequests = 0;
        f.setModelResponseFactory(() => {
            modelRequests++;
            return fauxAssistantMessage(fauxText("This request must not run."));
        });
        let interrupted = false;
        f.policy.handle = async (input, path, response) => {
            if (
                path === "/session/request" &&
                input.kind === "append" &&
                "contents" in input &&
                input.contents.includes('"role":"user"')
            ) {
                interrupted = true;
                await response.text();
                return new Response("User save acknowledgement lost", { status: 503 });
            }
            return response;
        };
        const child = await f.start();
        await child.read();
        await child.send({ kind: "turn", text: "Never replay request violet-925." });
        const failed = await child.read();
        assert(interrupted);
        assert(failed.savedId, JSON.stringify(failed));
        assertEquals(failed.ok, false, JSON.stringify(failed));
        assertEquals(modelRequests, 0);
        assertEquals(f.store.inspectSessionActivation(failed.savedId).activation?.state, "uncertain");
        assert(f.controls.some((entry) => entry.request.kind === "markUncertain"));
        f.policy.handle = undefined;
        // Offline history must not repair unpublished data. Connected discovery must
        // find this first interrupted turn without the caller knowing its id.
        assertEquals(listSavedRemoteSessions(f.store.path), []);
        const discovered = await f.control.list();
        assertEquals(
            discovered.map((session) => session.id),
            [failed.savedId],
        );
        assertEquals(discovered[0].firstMessage, "Never replay request violet-925.");
        assertEquals(discovered[0].messageCount, 2);
        assertEquals(f.store.inspectSessionActivation(failed.savedId).activation?.state, "idle");
        assertEquals(
            listSavedRemoteSessions(f.store.path).map((session) => session.summary.id),
            [failed.savedId],
        );
        const fresh = await f.start();
        await fresh.read();
        await fresh.send({ kind: "load", sessionId: discovered[0].id });
        const loaded = await fresh.read();
        assertEquals(loaded.ok, true, loaded.error);
        assertEquals(loaded.savedId, failed.savedId);
        assertEquals(modelRequests, 0);
        assertEquals(f.store.inspectSessionActivation(failed.savedId).activation?.state, "idle");
        const contents = (await f.control.list(failed.savedId))[0].contents || "";
        assertStringIncludes(contents, "Never replay request violet-925.");
        assertEquals(contents.split("violet-925").length - 1, 1);
        assertEquals(contents.includes('"role":"assistant"'), false);
        assertSmallControlBodies(f);
        await assertRemoteStorageAbsent(f);
    });
});
