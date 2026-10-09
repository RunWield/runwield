import { equal, match, ok } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { execPath } from "node:process";
import { test } from "node:test";

const guardsURL = new URL("./tui-crash-guards.ts", import.meta.url).href;
const eventsURL = new URL("./tui-crash-events.ts", import.meta.url).href;
const setup = `import { createTuiCrashGuards } from ${JSON.stringify(guardsURL)};
import { SYSTEM_TUI_CRASH_EVENTS } from ${JSON.stringify(eventsURL)};
import process, { exit } from "node:process";
const guards = createTuiCrashGuards({
 stop: () => console.error("terminal restored"),
 eventTarget: SYSTEM_TUI_CRASH_EVENTS,
 signalRuntime: { addSignalListener: (s,h) => process.on(s,h), removeSignalListener: (s,h) => process.off(s,h) },
 os: "linux", exit,
}); guards.install();`;

for (const source of [
    'setTimeout(() => { throw new Error("fatal fixture"); }, 0);',
    'Promise.reject(new Error("fatal fixture"));',
]) {
    test(`fatal event restores terminal and retains fatal exit: ${source}`, () => {
        const result = spawnSync(execPath, ["--eval", `${setup}\n${source}`], {
            encoding: "utf8",
            timeout: 10_000,
        });
        if (result.error) throw result.error;
        equal(result.signal, null);
        ok(result.status && result.status !== 0);
        equal(result.stderr.split(/\r?\n/).includes("terminal restored"), true);
        match(result.stderr, /fatal fixture/);
    });
}

test("uninstall removes fatal-event listeners without suppressing the default error", () => {
    const result = spawnSync(
        execPath,
        [
            "--eval",
            `${setup}
guards.uninstall(); guards.uninstall(); setTimeout(() => { throw new Error("fatal fixture"); }, 0);`,
        ],
        {
            encoding: "utf8",
            timeout: 10_000,
        },
    );
    if (result.error) throw result.error;
    equal(result.signal, null);
    ok(result.status && result.status !== 0);
    equal(result.stderr.split(/\r?\n/).includes("terminal restored"), false);
    match(result.stderr, /fatal fixture/);
});
