import { assertEquals, assertStringIncludes } from "@std/assert";
import { withRemoteRuntimeFixture } from "./remote-runtime-test-fixture.ts";

Deno.test("remote agent guard rejects a root without a laptop save bridge and a nonroot manager with a real bridge", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        let models = 0;
        f.setModelResponseFactory(() => {
            models++;
            throw new Error("Guard must stop before model execution");
        });
        const child = await f.start();
        await child.read();
        await child.send({ kind: "guard" });
        const result = await child.read();
        assertEquals(result.kind, "guard");
        assertEquals(result.errors?.length, 2, JSON.stringify(result));
        for (const error of result.errors || []) {
            assertStringIncludes(error, "Remote managed agent sessions are not approved");
        }
        assertEquals(models, 0);
        assertEquals(f.saves.filter((entry) => entry.kind === "append"), []);
    });
});
