import { assertEquals } from "../../testing/assertions.ts";
import { ok as assert } from "node:assert/strict";
import { terminateOwnedLinuxGroup } from "../linux-process-group.ts";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { kill, platform } from "node:process";
import { test } from "node:test";

const linux = platform === "linux";

interface ChildStatus {
    code: number | null;
}

async function startProcess(command: string, args: string[], detached = false) {
    const child = spawn(command, args, { detached, stdio: "ignore" });
    await once(child, "spawn");
    assert(child.pid);
    const status = new Promise<ChildStatus>((resolve, reject) => {
        child.once("exit", (code) => resolve({ code }));
        child.once("error", reject);
    });
    return { pid: child.pid, status, kill: child.kill.bind(child) };
}

async function running(pid: number): Promise<boolean> {
    try {
        const stat = await readFile(`/proc/${pid}/stat`, "utf8");
        const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
        return state !== "Z" && state !== "X";
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
    }
}

async function groupFixture(ignoreTerm: boolean, exitLeader = false) {
    const directory = await mkdtemp(join(tmpdir(), "runwield-process-group-"));
    const pidFile = `${directory}/descendant`;
    const script = `${ignoreTerm ? 'trap "" TERM; ' : ""}sleep 30 & echo $! > "$1"; ${exitLeader ? "exit 0" : "wait"}`;
    const child = await startProcess("sh", ["-c", script, "sh", pidFile], true);
    let descendant = 0;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        descendant = Number(await readFile(pidFile, "utf8").catch(() => ""));
        if (descendant && await running(descendant)) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!descendant) throw new Error("Child did not start a descendant");
    return { child, descendant, directory };
}

test("remote-owned process cleanup confirms child and grandchild exit without stopping an unrelated process", {
    skip: !linux,
}, async () => {
    const { child, descendant, directory } = await groupFixture(false);
    const unrelated = await startProcess("sleep", ["30"]);
    try {
        assertEquals(await terminateOwnedLinuxGroup(child), true);
        assertEquals(await running(child.pid), false);
        assertEquals(await running(descendant), false);
        assert(await running(unrelated.pid));
    } finally {
        if (await running(child.pid)) child.kill("SIGKILL");
        if (await running(descendant)) kill(descendant, "SIGKILL");
        if (await running(unrelated.pid)) unrelated.kill("SIGKILL");
        await Promise.all([child.status, unrelated.status]);
        await rm(directory, { recursive: true });
    }
});

test(
    "remote-owned process cleanup forces a blocked child and grandchild after the graceful deadline",
    { skip: !linux },
    async () => {
        const { child, descendant, directory } = await groupFixture(true);
        try {
            const started = Date.now();
            const pending = terminateOwnedLinuxGroup(child, 1_000);
            await new Promise((resolve) => setTimeout(resolve, 50));
            assert(await running(child.pid), "leader must survive during the graceful interval");
            assert(await running(descendant), "descendant must survive during the graceful interval");
            assertEquals(await pending, true);
            assert(Date.now() - started >= 1_000);
            assertEquals(await running(child.pid), false);
            assertEquals(await running(descendant), false);
        } finally {
            if (await running(child.pid)) child.kill("SIGKILL");
            if (await running(descendant)) kill(descendant, "SIGKILL");
            await child.status;
            await rm(directory, { recursive: true });
        }
    },
);

test("remote group cleanup reports uncertainty after its leader has exited without signaling descendants", {
    skip: !linux,
}, async () => {
    const { child, descendant, directory } = await groupFixture(false, true);
    try {
        await child.status;
        assert(await running(descendant));
        assertEquals(await terminateOwnedLinuxGroup(child, 0), false);
        assert(await running(descendant), "a departed leader does not authorize another group signal");
    } finally {
        if (await running(descendant)) kill(descendant, "SIGKILL");
        await child.status;
        await rm(directory, { recursive: true });
    }
});
