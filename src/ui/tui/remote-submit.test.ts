import { assertEquals, assertStringIncludes } from "@std/assert";
import { withRemoteSubmitFixture } from "./testing/remote-submit-fixture.ts";
import { assertRemoteStorageAbsent } from "../../shared/remote/remote-runtime-test-fixture.ts";

Deno.test("normal remote TUI submits the first ordinary prompt and a later turn", async () => {
    await withRemoteSubmitFixture(async (f) => {
        const child = await f.startTui();
        const ready = await child.read();
        assertStringIncludes(ready.screen, "laptop-http/remote-model");
        assertEquals(await f.control.list(), []);
        await child.send({ text: "Remember amber-741.", expect: "TUI-TURN-1-741" });
        const first = await child.read();
        assertStringIncludes(first.screen, "TUI-TURN-1-741");
        const saved = await f.control.list();
        assertEquals(saved.length, 1);
        assertStringIncludes((await f.control.list(saved[0].id))[0].contents || "", "Remember amber-741.");
        await child.send({ text: "What did we say earlier?", expect: "TUI-TURN-2-741" });
        assertStringIncludes((await child.read()).screen, "TUI-TURN-2-741");
        assertStringIncludes(f.requests[1], "Remember amber-741.");
        assertEquals((await f.control.list())[0].id, saved[0].id);
        await assertRemoteStorageAbsent(f);
    });
});

Deno.test("normal remote TUI selects a custom root Agent before the first prompt", async () => {
    await withRemoteSubmitFixture(async (f) => {
        const child = await f.startTui();
        await child.read();
        await child.send({ text: "/agent remote-runtime", expect: "Remote Runtime" });
        assertStringIncludes((await child.read()).screen, "Remote Runtime");
        await child.send({ text: "Remember amber-741.", expect: "TUI-TURN-1-741" });
        assertStringIncludes((await child.read()).screen, "TUI-TURN-1-741");
        assertEquals((await f.control.list()).length, 1);
    });
});
