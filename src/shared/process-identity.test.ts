import { equal, ok } from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import process from "node:process";
import { test } from "node:test";
import { isRecordedProcessAlive, readProcessIdentity } from "./process-identity.ts";

test("process birth identity is stable and a different saved birth cannot own a live PID", async () => {
    const child = spawn(process.execPath, ["-e", 'console.log("ready"); setInterval(() => {}, 1000);'], {
        stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = once(child, "close");
    try {
        await once(child.stdout, "data", { signal: AbortSignal.timeout(5_000) });
        ok(child.pid);
        const identity = await readProcessIdentity(child.pid);
        ok(identity, "the platform must expose birth evidence for an ordinary child");
        equal((await readProcessIdentity(child.pid))?.key, identity.key);
        equal(await isRecordedProcessAlive(child.pid, new Date().toISOString(), identity), true);
        equal(
            await isRecordedProcessAlive(child.pid, "2000-01-01T00:00:00.000Z", identity),
            true,
            "matching birth identity wins over wall-clock timestamps",
        );
        equal(
            await isRecordedProcessAlive(child.pid, new Date().toISOString(), { key: `${identity.key}-old-birth` }),
            false,
        );
        equal(await isRecordedProcessAlive(child.pid, "2000-01-01T00:00:00.000Z"), false);
        equal(child.exitCode, null, "probing ownership must not signal the child");
        child.kill("SIGTERM");
        await closed;
        equal(await isRecordedProcessAlive(child.pid, new Date().toISOString(), identity), false);
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await closed;
    }
});

test("legacy self ownership predating this process is reclaimed without discarding a current owner", async () => {
    const identity = await readProcessIdentity(process.pid);
    ok(identity);
    equal(await isRecordedProcessAlive(process.pid, "2000-01-01T00:00:00.000Z", identity), true);
    equal(await isRecordedProcessAlive(process.pid, new Date().toISOString()), true);
    equal(
        await isRecordedProcessAlive(process.pid, new Date(Date.now() - (process.uptime() + 60) * 1000).toISOString()),
        false,
    );
    equal(await isRecordedProcessAlive(process.pid, "invalid timestamp"), true);
    equal(await isRecordedProcessAlive(NaN, new Date().toISOString()), true);
    equal(await readProcessIdentity(-1), undefined);
});

for (const queryAvailable of [true, false]) {
    test(
        queryAvailable
            ? "process birth queries use UTC across runtime timezones"
            : "unavailable process birth query preserves a live legacy owner",
        async () => {
            const moduleUrl = new URL("./process-identity.ts", import.meta.url).href;
            const source = `
            import { readProcessIdentity, isRecordedProcessAlive } from ${JSON.stringify(moduleUrl)};
            const identity = await readProcessIdentity(process.pid);
            const alive = await isRecordedProcessAlive(process.pid, new Date(Date.now() - 60_000).toISOString());
            console.log(JSON.stringify({ startedAt: identity?.startedAt ?? null, alive }));
        `;
            const child = spawn(process.execPath, ["-e", source], {
                env: {
                    ...process.env,
                    TZ: "Pacific/Honolulu",
                    ...(queryAvailable ? {} : { PATH: "/runwield-missing-process-query-command" }),
                },
                stdio: ["ignore", "pipe", "pipe"],
            });
            let output = "";
            child.stdout.on("data", (chunk) => {
                output += chunk;
            });
            const [code] = await once(child, "close");
            equal(code, 0);
            const result = JSON.parse(output);
            if (queryAvailable) equal(typeof result.startedAt, "string");
            else equal(result.startedAt, null);
            equal(result.alive, !queryAvailable);
        },
    );
}
