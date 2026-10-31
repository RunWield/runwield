import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { withRemoteSubmitFixture } from "./testing/remote-submit-fixture.ts";
import { assertRemoteStorageAbsent } from "../../shared/remote/remote-runtime-test-fixture.ts";

test("normal remote TUI resumes through the actual selector and submits with saved context", async () => {
    await withRemoteSubmitFixture(async (f) => {
        const first = await f.startTui();
        await first.read();
        await first.send({ text: "Remember amber-741.", expect: "TUI-TURN-1-741" });
        assertStringIncludes((await first.read()).screen, "TUI-TURN-1-741");
        const savedId = (await f.control.list())[0].id;
        await first.close();
        const fresh = await f.startTui();
        await fresh.read();
        await fresh.send({ text: "/resume", expect: "Select a session to resume:", waitForIdle: false });
        assertStringIncludes((await fresh.read()).screen, "Select a session to resume:");
        await fresh.send({ expect: "TUI-TURN-1-741" });
        assertStringIncludes((await fresh.read()).screen, "TUI-TURN-1-741");
        assertEquals(f.requests.length, 1, "Selecting saved history must not call the model");
        await fresh.send({ text: "Continue our conversation.", expect: "TUI-TURN-2-741" });
        assertStringIncludes((await fresh.read()).screen, "TUI-TURN-2-741");
        assertStringIncludes(f.requests[1], "Remember amber-741.");
        assertStringIncludes(f.requests[1], "TUI-TURN-1-741");
        assertEquals(
            (await f.control.list()).map((session) => session.id),
            [savedId],
        );
        await assertRemoteStorageAbsent(f);
    });
});
