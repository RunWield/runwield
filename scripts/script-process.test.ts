import { test } from "node:test";
import { spawn } from "node:child_process";
import { constants } from "node:os";
import process from "node:process";
import { assertEquals, assertRejects } from "../src/testing/assertions.ts";
import { captureScriptProcess, waitForScriptExit } from "./script-process.ts";

test(
    "script processes preserve signal exit codes across capture and inherited I/O",
    {
        skip: process.platform === "win32",
    },
    async () => {
        const args = ["-c", "kill -TERM $$"];
        const expected = 128 + constants.signals.SIGTERM;
        const captured = await captureScriptProcess("/bin/sh", { args });
        const inherited = await waitForScriptExit(spawn("/bin/sh", args, { stdio: "ignore" }));
        for (const output of [captured, inherited]) {
            assertEquals(output.code, expected);
            assertEquals(output.success, false);
        }
    },
);

test("script process capture transports stdin bytes and starts with only the requested environment", async () => {
    const options = {
        args: [
            "--eval",
            'process.stdin.setEncoding("utf8"); let text=""; process.stdin.on("data", part=>text+=part); process.stdin.on("end",()=>process.stdout.write(JSON.stringify({text, marker:process.env.WLD_CAPTURE_MARKER, home:process.env.HOME})));',
        ],
        input: "literal $() stdin\nβ",
        clearEnv: true,
        env: { WLD_CAPTURE_MARKER: "only requested" },
    };
    // Deno's eval spelling differs, while the fixture itself uses the portable node API.

    const output = await captureScriptProcess(process.execPath, options);
    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
    assertEquals(JSON.parse(new TextDecoder().decode(output.stdout)), {
        text: options.input,
        marker: "only requested",
    });
});

test("script capture reports a missing executable instead of a successful exit", async () => {
    await assertRejects(() => captureScriptProcess("runwield-missing-executable-for-capture-test"));
});
