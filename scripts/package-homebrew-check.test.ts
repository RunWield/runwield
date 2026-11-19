import { delimiter } from "node:path";
import { spawn } from "node:child_process";
import { captureScriptProcess, waitForScriptExit } from "./script-process.ts";
import { runtimeSourceArgs } from "../src/testing/runtime-source-args.ts";
import { test } from "node:test";
import { getCwd } from "../src/constants.ts";
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
test(
    "package:homebrew:check registers a tap when brew reports a missing conventional path",
    {
        skip: process.platform !== "darwin",
    },
    async () => {
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
                runtimeSourceArgs(["run", "-A", "scripts/package-homebrew-check.ts", "--tap", tap]),
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
                    await new Promise<void>((resolve) => setTimeout(resolve, 50));
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
    },
);

interface InstalledMnemotecaResponse {
    stdout: string;
    exitCode: number;
}

async function checkInstalledMnemoteca(response: InstalledMnemotecaResponse) {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-homebrew-version-"));
    const tap = join(root, "tap");
    const bin = join(root, "bin");
    const prefix = join(root, "installed-wld");
    const home = join(root, "home");
    const log = join(root, "brew.log");
    try {
        await fsMkdir(join(tap, "Formula"), { recursive: true });
        await fsMkdir(join(prefix, "libexec"), { recursive: true });
        await fsMkdir(bin);
        await fsMkdir(home);
        await fsWriteFile(join(tap, "Formula", "wld.rb"), "class Wld < Formula\nend\n");
        await fsWriteFile(join(tap, "Formula", "mnemoteca.rb"), "class Mnemoteca < Formula\nend\n");
        await fsWriteFile(
            join(tap, "runwield-homebrew-package.json"),
            JSON.stringify({ wldTag: "v1.2.3", mnemotecaTag: "v0.3.4" }),
        );
        await fsWriteFile(
            join(prefix, "libexec", "runwield-install.json"),
            JSON.stringify({
                packageManager: "homebrew",
                packageIdentifier: "gandazgul/tap/wld",
                version: "v1.2.3",
                updateCommand: "brew upgrade gandazgul/tap/wld",
            }),
        );
        const wld = join(root, "wld");
        await fsWriteFile(
            wld,
            `#!/bin/sh
case "$*" in
    --version) printf 'wld v1.2.3\\n' ;;
    update|upgrade) printf 'Use brew upgrade gandazgul/tap/wld\\n' ;;
    *) exit 97 ;;
esac
`,
        );
        await fsChmod(wld, 0o755);
        const brew = join(bin, "brew");
        await fsWriteFile(
            brew,
            `#!/bin/sh
printf '%s\\n' "$*" >> "$BREW_LOG"
case "$*" in
    '--repo gandazgul/tap') printf '%s\\n' "$FIXTURE_TAP" ;;
    'audit --strict --formula gandazgul/tap/wld gandazgul/tap/mnemoteca') exit 0 ;;
    'install gandazgul/tap/mnemoteca') exit 0 ;;
    'install gandazgul/tap/wld')
        mkdir -p "$FIXTURE_PREFIX/bin"
        cp "$FIXTURE_WLD" "$FIXTURE_PREFIX/bin/wld"
        ;;
    '--prefix gandazgul/tap/wld') printf '%s\\n' "$FIXTURE_PREFIX" ;;
    'list --versions gandazgul/tap/mnemoteca')
        printf '%s' "$INSTALLED_MNEMOTECA_OUTPUT"
        exit "$INSTALLED_MNEMOTECA_EXIT"
        ;;
    'test gandazgul/tap/mnemoteca'|'test gandazgul/tap/wld')
        printf 'formula test passed: %s\\n' "$2"
        ;;
    'upgrade gandazgul/tap/mnemoteca gandazgul/tap/wld') exit 0 ;;
    'uninstall gandazgul/tap/wld') rm "$FIXTURE_PREFIX/bin/wld" ;;
    'uninstall gandazgul/tap/mnemoteca') exit 0 ;;
    *) printf 'Unexpected brew arguments: %s\\n' "$*" >&2; exit 98 ;;
esac
`,
        );
        await fsChmod(brew, 0o755);
        const output = await captureScriptProcess(process.execPath, {
            args: runtimeSourceArgs(["run", "-A", "scripts/package-homebrew-check.ts", "--tap", tap]),
            cwd: getCwd(),
            env: {
                HOME: home,
                PATH: `${bin}${delimiter}${process.env["PATH"] || ""}`,
                BREW_LOG: log,
                FIXTURE_TAP: tap,
                FIXTURE_PREFIX: prefix,
                FIXTURE_WLD: wld,
                INSTALLED_MNEMOTECA_OUTPUT: response.stdout,
                INSTALLED_MNEMOTECA_EXIT: String(response.exitCode),
            },
        });
        return {
            success: output.success,
            stdout: new TextDecoder().decode(output.stdout),
            stderr: new TextDecoder().decode(output.stderr),
            calls: (await fsReadFile(log, "utf8")).trim().split("\n"),
        };
    } finally {
        await fsRm(root, { recursive: true, force: true });
    }
}

test(
    "package:homebrew:check completes the full lifecycle when the installed Mnemoteca version matches its tag",
    { skip: process.platform !== "darwin" },
    async () => {
        const output = await checkInstalledMnemoteca({ stdout: "mnemoteca 0.3.4\n", exitCode: 0 });
        assertEquals(output.success, true, output.stderr);
        assertStringIncludes(
            output.stdout,
            "Homebrew formulas audited, installed, tested, upgraded, uninstalled, and ownership-checked.",
        );
        assertStringIncludes(output.stdout, "formula test passed: gandazgul/tap/mnemoteca");
        assertStringIncludes(output.stdout, "formula test passed: gandazgul/tap/wld");
        assertEquals(output.calls.slice(-8), [
            "upgrade gandazgul/tap/mnemoteca gandazgul/tap/wld",
            "list --versions gandazgul/tap/mnemoteca",
            "--prefix gandazgul/tap/wld",
            "uninstall gandazgul/tap/wld",
            "uninstall gandazgul/tap/mnemoteca",
            "install gandazgul/tap/wld",
            "list --versions gandazgul/tap/mnemoteca",
            "--prefix gandazgul/tap/wld",
        ]);
    },
);

for (const version of ["0.3.3", "0.3.5", "0.3.40", "0.3.4_1"]) {
    test(
        `package:homebrew:check rejects installed Mnemoteca ${version} despite passing formula tests`,
        { skip: process.platform !== "darwin" },
        async () => {
            const output = await checkInstalledMnemoteca({ stdout: `mnemoteca ${version}\n`, exitCode: 0 });
            assertEquals(output.success, false, output.stdout);
            assertStringIncludes(output.stdout, "formula test passed: gandazgul/tap/mnemoteca");
            assertStringIncludes(output.stdout, "formula test passed: gandazgul/tap/wld");
            assertStringIncludes(output.stderr, `Installed Mnemoteca version ${version} does not match v0.3.4.`);
            assertEquals(output.stdout.includes("ownership-checked."), false);
        },
    );
}

for (const scenario of [
    { name: "empty", stdout: "", exitCode: 0 },
    { name: "whitespace-only", stdout: " \n\t", exitCode: 0 },
    { name: "missing package name", stdout: "0.3.4\n", exitCode: 0 },
    { name: "wrong package", stdout: "wld 0.3.4\n", exitCode: 0 },
    { name: "malformed version", stdout: "mnemoteca not-a-version\n", exitCode: 0 },
    { name: "multiple installed versions", stdout: "mnemoteca 0.3.3 0.3.4\n", exitCode: 0 },
    { name: "failed", stdout: "mnemoteca 0.3.4\n", exitCode: 42 },
]) {
    test(
        `package:homebrew:check cannot qualify Mnemoteca with ${scenario.name} installed-package metadata`,
        { skip: process.platform !== "darwin" },
        async () => {
            const output = await checkInstalledMnemoteca(scenario);
            assertEquals(output.success, false, output.stdout);
            assertStringIncludes(output.stderr, "Cannot determine the installed Mnemoteca version from Homebrew.");
            assertEquals(output.stdout.includes("ownership-checked."), false);
        },
    );
}
