import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { assertRemoteStorageAbsent, withRemoteRuntimeFixture } from "./remote-runtime-test-fixture.ts";

for (const manager of ["unbridged root", "persisted"]) {
    test(`remote agent guard rejects a ${manager} manager`, async () => {
        await withRemoteRuntimeFixture(async (f) => {
            let models = 0;
            f.setModelResponseFactory(() => {
                models++;
                throw new Error("Guard must stop before model execution");
            });
            const child = await f.start();
            await child.read();
            await child.send({ kind: "guard", text: manager });
            const result = await child.read();
            assertEquals(result.kind, "guard");
            assertEquals(result.errors?.length, 1, JSON.stringify(result));
            assertStringIncludes(result.errors![0], "Remote managed agent sessions require an in-memory manager");
            assertEquals(models, 0);
            assertEquals(
                f.saves.filter((entry) => entry.kind === "append"),
                [],
            );
            await assertRemoteStorageAbsent(f);
        });
    });
}

test("remote agent guard admits an in-memory non-root manager", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        const child = await f.start();
        await child.read();
        await child.send({ kind: "guard", text: "child" });
        const result = await child.read();
        assertEquals(result.errors, [], JSON.stringify(result));
        await child.close();
        await assertRemoteStorageAbsent(f);
    });
});
