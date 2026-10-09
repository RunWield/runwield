import { assertEquals, assertStringIncludes } from "@std/assert";
import { HostedSession } from "./hosted-session.js";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";

Deno.test("a partial task log write reports stored bytes and a visible failure", async () => {
    await withProcessGlobalTestLock(async () => {
        const cwd = await Deno.makeTempDir();
        const session = new HostedSession({ id: crypto.randomUUID(), cwd });
        const original = Deno.FsFile.prototype.write;
        let writes = 0;
        try {
            Deno.FsFile.prototype.write = function (data) {
                writes++;
                if (writes === 1) return original.call(this, data.subarray(0, 3));
                throw Error("disk full");
            };
            const result = await session.backgroundTasks.wait(
                session.backgroundTasks.startShell({ command: "printf 'partial output'", cwd }).task_id,
            );
            assertEquals(result.state, "failed");
            assertStringIncludes(result.error || "", "disk full");
            assertEquals(result.byte_count, 3);
            assertEquals(result.output, "par");
            assertEquals(await Deno.readTextFile(result.log_path), "par");
        } finally {
            Deno.FsFile.prototype.write = original;
            await session.dispose();
            await Deno.remove(cwd, { recursive: true });
        }
    });
});
