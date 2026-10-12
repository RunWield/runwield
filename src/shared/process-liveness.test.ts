import { equal, ok } from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { hostname } from "node:os";
import { execPath, pid } from "node:process";
import { test } from "node:test";
import { getLockHostname, isLockHolderGone, isLockHolderUnattributable, isPidAlive } from "./process-liveness.ts";

test("process liveness recognizes this host and rejects invalid process identities", async () => {
    equal(getLockHostname(), hostname());
    equal(await isPidAlive(pid), true);
    for (const invalid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
        equal(await isPidAlive(invalid), false, String(invalid));
    }
});

test("lock holder follows a real child from live to exited without signaling it", async () => {
    const source = 'console.log("ready"); setInterval(() => {}, 1000);';
    const child = spawn(execPath, ["-e", source], {
        stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = once(child, "close");
    try {
        await once(child.stdout, "data", { signal: AbortSignal.timeout(5_000) });
        ok(child.pid);
        const identity = JSON.stringify({ pid: child.pid, hostname: getLockHostname() });
        equal(await isPidAlive(child.pid), true);
        equal(await isLockHolderGone(identity), false);
        equal(child.exitCode, null);
        child.kill("SIGTERM");
        await closed;
        equal(await isPidAlive(child.pid), false);
        equal(await isLockHolderGone(identity), true);
        equal(
            await isLockHolderGone(JSON.stringify({ pid: child.pid, hostname: `${getLockHostname()}-other` })),
            false,
        );
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await closed;
    }
});

test("unreadable and unattributable locks never prove a holder is gone", async () => {
    for (const contents of ["", "broken json", "null", "[]", "{}", '{"pid":0}', '{"pid":-1}', '{"pid":1}']) {
        equal(isLockHolderUnattributable(contents), true, contents);
        equal(await isLockHolderGone(contents), false, contents);
    }
    const identity = JSON.stringify({ pid, hostname: getLockHostname() });
    equal(isLockHolderUnattributable(identity), false);
    equal(isLockHolderUnattributable(JSON.stringify({ pid, hostname: "other-host" })), false);
});
