import { assertEquals } from "@std/assert";
import { makeControlFixture } from "./session-save-test-fixture.ts";
import { verificationClient } from "./session-save-verification-fixture.ts";

for (const mode of ["oversized", "allocation-fault"] as const) {
    Deno.test(`remote ${mode} refuses memory use and leaves the operation sticky`, async () => {
        const f = await makeControlFixture();
        await f.ready();
        const child = verificationClient(f, f.baseUrl, { mode });
        try {
            assertEquals(await child.result(), {
                failed: true,
                allocationAttempted: mode === "allocation-fault",
                readStopped: true,
                writeStopped: true,
                checkpointStopped: true,
            });
            assertEquals(f.owner.inspect().contents, f.initial);
            f.owner.markUncertain();
            f.owner.recoverUncertain();
            assertEquals(f.store.inspectSessionActivation(f.session.runwieldSessionId).activation?.state, "idle");
        } finally {
            await child.close();
            await f.close();
        }
    });
}
