import { type FileHandle, open } from "node:fs/promises";
import { mkdtemp as fsMkdtemp, readFile as fsReadFile, rm as fsRm } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { HostedSession } from "./hosted-session.js";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";

interface FileWritePrototype {
    write(this: FileHandle, data: Uint8Array): Promise<{ bytesWritten: number; buffer: Uint8Array }>;
}

test("a partial task log write reports stored bytes and a visible failure", async () => {
    await withProcessGlobalTestLock(async () => {
        const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
        const session = new HostedSession({ id: crypto.randomUUID(), cwd });
        const probe = await open(join(cwd, "prototype-probe"), "wx");
        const prototype = Object.getPrototypeOf(probe) as FileWritePrototype;
        await probe.close();
        const original = prototype.write;
        let writes = 0;
        try {
            prototype.write = function (data) {
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
            assertEquals(await fsReadFile(result.log_path, "utf8"), "par");
        } finally {
            prototype.write = original;
            await session.dispose();
            await fsRm(cwd, { recursive: true });
        }
    });
});
