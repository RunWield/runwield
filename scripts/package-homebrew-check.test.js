import { delimiter } from "node:path";
import { spawn } from "node:child_process";
import { waitForScriptExit } from "./script-process.ts";
import { runtimeSourceArgs } from "../src/testing/runtime-source-args.ts";
import { test } from "node:test";
import { getCwd } from "../src/constants.js";
import {
    chmod as fsChmod,
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { assertEquals, assertStringIncludes } from "../src/testing/assertions.ts";
import { join } from "node:path";

// The command intentionally refuses to run off macOS.
test("package:homebrew:check registers a tap when brew reports a missing conventional path", {
    skip: process.platform !== "darwin",
}, async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-fixture-"));
    const tap = join(root, "rendered-tap");
    const bin = join(root, "bin");
    const log = join(root, "brew.log");
    const missingTap = join(root, "missing-homebrew-tap");
    try {
        await fsMkdir(join(tap, "Formula"), { recursive: true });
        await fsMkdir(bin);
        await fsWriteFile(join(tap, "Formula", "wld.rb"), "class Wld < Formula\nend\n");
        await fsWriteFile(join(tap, "Formula", "mnemoteca.rb"), "class Mnemoteca < Formula\nend\n");
        await fsWriteFile(
            join(tap, "runwield-homebrew-package.json"),
            `${JSON.stringify({ wldTag: "v1.2.3", mnemotecaTag: "v0.3.3" })}\n`,
        );
        const brew = join(bin, "brew");
        await fsWriteFile(
            brew,
            `#!/bin/sh
printf '%s\\n' "$*" >> "$BREW_LOG"
if [ "$1" = "--repo" ]; then
    printf '%s\\n' "$MISSING_TAP"
    exit 0
fi
if [ "$1" = "trust" ]; then exit 0; fi
if [ "$1" = "tap" ]; then exit 0; fi
printf 'audit stdout is live\\n'
printf 'audit stderr is live\\n' >&2
while [ ! -f "$BREW_RELEASE" ]; do sleep 0.1; done
printf 'intentional stop after tap registration\\n' >&2
exit 42
`,
        );
        await fsChmod(brew, 0o755);

        const child = spawn(
            process.execPath,
            runtimeSourceArgs(["run", "-A", "scripts/package-homebrew-check.js", "--tap", tap]),
            {
                cwd: getCwd(),
                env: {
                    ...process.env,
                    PATH: `${bin}${delimiter}${process.env["PATH"] || ""}`,
                    BREW_LOG: log,
                    MISSING_TAP: missingTap,
                    BREW_RELEASE: join(root, "release"),
                },
                stdio: ["ignore", "pipe", "pipe"],
            },
        );
        const status = waitForScriptExit(child);
        let stdout = "";
        let stderr = "";
        const readStdout = (async () => {
            for await (const chunk of child.stdout) stdout += new TextDecoder().decode(chunk);
        })();
        const readStderr = (async () => {
            for await (const chunk of child.stderr) stderr += new TextDecoder().decode(chunk);
        })();
        let streamed = false;
        try {
            for (let attempt = 0; attempt < 100; attempt++) {
                if (stdout.includes("audit stdout is live") && stderr.includes("audit stderr is live")) {
                    streamed = true;
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
        } finally {
            await fsWriteFile(join(root, "release"), "");
        }
        const output = await status;
        await Promise.all([readStdout, readStderr]);
        assertEquals(streamed, true, "Both streams must be visible before brew exits");
        const calls = (await fsReadFile(log, "utf8")).trim().split("\n");

        assertEquals(output.success, false);
        assertStringIncludes(stderr, "intentional stop after tap registration");
        assertStringIncludes(stderr, "failed with exit code 42");
        assertEquals(stdout.includes(missingTap), false, "Query output stays captured");
        assertEquals(calls.slice(0, 3), [
            "--repo gandazgul/tap",
            `trust file://${tap}`,
            `tap gandazgul/tap file://${tap}`,
        ]);
    } finally {
        await fsRm(root, { recursive: true });
    }
});
