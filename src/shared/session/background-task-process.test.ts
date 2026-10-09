import { assertEquals } from "../../testing/assertions.ts";
import { kill, platform } from "node:process";
import { mkdtemp as fsMkdtemp, readFile as fsReadFile, rm as fsRm } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ok as assert } from "node:assert/strict";
import { HostedSession } from "./hosted-session.js";

test("cancelling a shell background task stops its descendant", { skip: platform === "win32" }, async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    const session = new HostedSession({ id: crypto.randomUUID(), cwd });
    const pidFile = `${cwd}/descendant.pid`;
    const task = session.backgroundTasks.startShell({ command: `sleep 30 & echo $! > '${pidFile}'; wait`, cwd });
    try {
        let pid = 0;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            pid = Number((await fsReadFile(pidFile, "utf8").catch(() => "")).trim());
            if (pid) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert(pid > 0, "shell did not start a descendant");
        assertEquals((await session.backgroundTasks.cancel(task.task_id)).state, "cancelled");
        let alive = true;
        const exitDeadline = Date.now() + 5000;
        while (Date.now() < exitDeadline) {
            try {
                kill(pid, 0);
            } catch (error) {
                if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
                alive = false;
                break;
            }
            if (platform === "linux") {
                // Minimal container PID 1 may not reap orphaned children. Only
                // an observed zombie state proves this existing pid terminated.
                const stat = await fsReadFile(`/proc/${pid}/stat`, "utf8").catch((error) => {
                    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
                    throw error;
                });
                if (stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] === "Z") {
                    alive = false;
                    break;
                }
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assertEquals(alive, false, "descendant survived task cancellation");
    } finally {
        await session.backgroundTasks.cancelAllAndSuppress();
        await fsRm(cwd, { recursive: true });
    }
});
