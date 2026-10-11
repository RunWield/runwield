import { assert, assertEquals } from "@std/assert";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { withRemoteRuntimeFixture } from "./remote-runtime-test-fixture.ts";

Deno.test("remote resume picker restores the conversation selected by its presented session id", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        const contexts: string[] = [];
        f.setModelResponseFactory((context) => {
            contexts.push(JSON.stringify(context));
            return fauxAssistantMessage(fauxText("Remember amber-418."));
        });
        const original = await f.start();
        await original.read();
        await original.send({ kind: "turn", text: "Keep amber-418 in this conversation." });
        const saved = await original.read();
        assertEquals(saved.ok, true, saved.error);
        assert(saved.savedId);
        const fresh = await f.start();
        await fresh.read();
        await fresh.send({ kind: "resume-command", sessionId: saved.savedId });
        const resumed = await fresh.read();
        assertEquals(resumed.ok, true, resumed.error);
        assertEquals(resumed.selectedId, saved.savedId);
        assertEquals(resumed.savedId, saved.savedId);
        assert(resumed.notices?.some((notice) => notice.includes("restored")), JSON.stringify(resumed));
        assertEquals(contexts.length, 1, "Resume must not run the saved request again");
        await fresh.send({ kind: "turn", text: "Continue with the saved memory." });
        const continued = await fresh.read();
        assertEquals(continued.ok, true, continued.error);
        assertEquals(continued.savedId, saved.savedId);
        assert(contexts.at(-1)?.includes("amber-418"));
    });
});
