import { mkdir as fsMkdir, mkdtemp as fsMkdtemp, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { getHomeDir } from "../../constants.js";
import { HostedSession } from "./hosted-session.js";

test("an unwritable log location fails before spawning and frees the slot", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    const id = crypto.randomUUID();
    const blocked = join(getHomeDir(), ".wld", "sessions", "local", id);
    await fsMkdir(join(getHomeDir(), ".wld", "sessions", "local"), { recursive: true });
    await fsWriteFile(blocked, "not a directory");
    const session = new HostedSession({ id, cwd });
    try {
        const status = await session.backgroundTasks.wait(
            session.backgroundTasks.startShell({ command: "echo should-not-run", cwd }).task_id,
        );
        assertEquals(status.state, "failed");
        assertStringIncludes(status.error ?? "", "Task failed");
        assertEquals(session.backgroundTasks.activeCount, 0);
    } finally {
        await session.backgroundTasks.cancelAllAndSuppress();
        await fsRm(blocked);
        await fsRm(cwd, { recursive: true });
    }
});
