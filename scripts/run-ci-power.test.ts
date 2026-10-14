import { getCwd } from "../src/constants.js";
import { captureForegroundProcess } from "../src/shared/captured-process.ts";
import { test } from "node:test";
import { assertEquals } from "../src/testing/assertions.ts";
import { runCi } from "./run-ci.ts";

import process from "node:process";

async function ciSleepAssertions(): Promise<number[]> {
    const output = await captureForegroundProcess("/usr/bin/pmset", { args: ["-g", "assertions"], cwd: getCwd() });
    assertEquals(output.code, 0);
    const text = new TextDecoder().decode(output.stdout);
    const processes = await captureForegroundProcess("/bin/ps", { args: ["-axo", "pid,ppid"], cwd: getCwd() });
    assertEquals(processes.code, 0);
    const children = new TextDecoder()
        .decode(processes.stdout)
        .split("\n")
        .flatMap((line) => {
            const [pid, parent] = line.trim().split(/\s+/).map(Number);
            return parent === process.pid ? [pid] : [];
        });
    return [...text.matchAll(/pid (\d+)\(caffeinate\):.*PreventUserIdleSystemSleep/g)]
        .map((match) => Number(match[1]))
        .filter((pid) => children.includes(pid));
}

async function waitForCiAssertion(previous: number[]): Promise<number> {
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline) {
        const pid = (await ciSleepAssertions()).find((pid) => !previous.includes(pid));
        if (pid !== undefined) return pid;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("CI did not prevent automatic idle sleep");
}

for (const [taskName, code, exitCode] of [
    ["test:all:suite", 0, 0],
    ["test:all:suite", 7, 7],
    ["lint", 2, 1],
] as const) {
    test(
        `CI prevents macOS idle sleep and releases its assertion after ${taskName} exit ${code}`,
        { skip: (process.platform === "win32" ? "windows" : process.platform) !== "darwin" },
        async () => {
            const previous = await ciSleepAssertions();
            const gate = Promise.withResolvers<void>();
            const run = runCi(async (name) => {
                if (name === taskName) await gate.promise;
                return { name, code: name === taskName ? code : 0 };
            });
            let inhibitorPid = 0;
            try {
                inhibitorPid = await waitForCiAssertion(previous);
            } finally {
                gate.resolve();
                assertEquals((await run).exitCode, exitCode);
            }
            assertEquals((await ciSleepAssertions()).includes(inhibitorPid), false);
        },
    );
}
