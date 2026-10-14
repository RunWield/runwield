import { test } from "node:test";
import { writeFile as fsWriteFile, utimes as fsUtimes, readFile as fsReadFile } from "node:fs/promises";
import { assertEquals } from "../../testing/assertions.ts";
import { notDeepStrictEqual as assertNotEquals } from "node:assert/strict";
import { join } from "node:path";
import { git } from "../git-test-fixture.ts";
import { coverage, hostFixture, hostRequest } from "./testing/validation-host-fixture.ts";

test("review identity uses actual file contents even when Git's cached stat data still matches", async () => {
    const fixture = await hostFixture();
    try {
        await fsWriteFile(join(fixture.cwd, "marker"), "fixed");
        const path = join(fixture.cwd, "implementation.ts");
        const time = new Date("2025-01-01T00:00:00.000Z");
        await git(fixture.cwd, ["config", "core.trustctime", "false"]);
        await fsUtimes(path, time, time);
        await git(fixture.cwd, ["add", "implementation.ts"]);
        const reviewer = hostRequest(await fixture.processTurn(), "reviewer");
        const plan = await fixture.plan();
        const evidence = await fixture.evidence();
        const metrics = await fixture.metrics();
        const original = await fsReadFile(path, "utf8");
        const changed = original.replace("value = 1", "value = 2");
        assertNotEquals(changed, original);
        assertEquals(changed.length, original.length);
        await fsWriteFile(path, changed);
        await fsUtimes(path, time, time);
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
