import { assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import { git } from "../git-test-fixture.ts";
import { coverage, hostFixture, hostRequest } from "./testing/validation-host-fixture.ts";

Deno.test("review identity uses actual file contents even when Git's cached stat data still matches", async () => {
    const fixture = await hostFixture();
    try {
        await Deno.writeTextFile(join(fixture.cwd, "marker"), "fixed");
        const path = join(fixture.cwd, "implementation.ts");
        const time = new Date("2025-01-01T00:00:00.000Z");
        await git(fixture.cwd, ["config", "core.trustctime", "false"]);
        await Deno.utime(path, time, time);
        await git(fixture.cwd, ["add", "implementation.ts"]);
        const reviewer = hostRequest(await fixture.processTurn(), "reviewer");
        const plan = await fixture.plan();
        const evidence = await fixture.evidence();
        const metrics = await fixture.metrics();
        const original = await Deno.readTextFile(path);
        const changed = original.replace("value = 1", "value = 2");
        assertNotEquals(changed, original);
        assertEquals(changed.length, original.length);
        await Deno.writeTextFile(path, changed);
        await Deno.utime(path, time, time);
        const result = await fixture.processTurn({
            kind: "reviewer",
            identity: reviewer.identity,
            outcome: { approved: true },
            coverage: coverage(reviewer),
        });
        assertEquals(result.kind, "failed");
        assertEquals((await fixture.plan()).attrs.status, plan.attrs.status);
        assertEquals(
            (await fixture.plan()).attrs.validationCheckpoint?.reviewState,
            plan.attrs.validationCheckpoint?.reviewState,
        );
        assertEquals(await fixture.evidence(), evidence);
        assertEquals(await fixture.metrics(), metrics);
        const fresh = hostRequest(await fixture.processTurn(), "reviewer");
        assertNotEquals(fresh.identity.diffHash, reviewer.identity.diffHash);
    } finally {
        await fixture.close();
    }
});
