import { captureScriptProcess } from "./script-process.ts";
import { delimiter } from "node:path";
import { runtimeSourceArgs } from "../src/testing/runtime-source-args.ts";
import { makeTempFile } from "../src/testing/temp-file.ts";
import { test } from "node:test";
import {
    chmod as fsChmod,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { assertEquals, assertStringIncludes } from "../src/testing/assertions.ts";
import { join } from "node:path";
import { runBoundedTest, runWithSnip } from "./run-with-snip.ts";

async function writeSnipFixture(root: string, stdout: string, stderr: string, code = 0): Promise<void> {
    if (process.platform === "win32") {
        const source = join(root, "snip-fixture.ts");
        const binary = join(root, "snip.exe");
        await fsWriteFile(
            source,
            `import process from "node:process"; process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = ${code};`,
        );
        const args = process.versions.bun
            ? [
                  "build",
                  "--compile",
                  "--no-compile-autoload-dotenv",
                  "--no-compile-autoload-bunfig",
                  source,
                  "--outfile",
                  binary,
              ]
            : ["compile", "-A", "--no-check", "--output", binary, source];
        const result = await captureScriptProcess(process.execPath, {
            args,
            cwd: root,
        });
        assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
        return;
    }
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const path = join(root, "snip");
    await fsWriteFile(
        path,
        `#!/bin/sh\nprintf '%s' ${quote(stdout)}\nprintf '%s' ${quote(stderr)} >&2\nexit ${code}\n`,
    );
    await fsChmod(path, 0o755);
}

test("runWithSnip preserves compact success output", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-snip-command-success-"));
    try {
        await writeSnipFixture(root, "all tests passed\n", "snip: tracking error: ignored\n");

        const result = await runWithSnip("deno", ["test"], {
            env: { PATH: `${root}${delimiter}${process.env["PATH"] || ""}` },
            failureLabel: "tests",
        });

        assertEquals(result, { code: 0, stdout: "all tests passed\n", stderr: "" });
    } finally {
        await fsRm(root, { recursive: true }).catch(() => {});
    }
});

test("runWithSnip stores only Deno failure diagnostics", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-snip-command-failure-"));
    let failureLogPath = "";
    try {
        await writeSnipFixture(
            root,
            "Check src/pass.ts\nrunning 2 tests from ./sample.test.ts\npassing ... ok (1ms)\nfailure ... FAILED (2ms)\nAssertionError: expected true\nFAILED | 1 passed | 1 failed (3ms)\n",
            "snip: tracking error: test database is read-only\n",
            1,
        );

        const result = await runWithSnip("deno", ["test", "sample.test.ts"], {
            env: { PATH: `${root}${delimiter}${process.env["PATH"] || ""}` },
            failureLabel: "tests",
        });
        failureLogPath = result.failureLogPath || "";

        assertEquals(result.code, 1);
        assertEquals(result.stdout, "");
        assertStringIncludes(result.stderr, `tests failed, read the failure log here: ${failureLogPath}`);
        const failureLog = await fsReadFile(failureLogPath, "utf8");
        assertStringIncludes(failureLog, "failure ... FAILED");
        assertStringIncludes(failureLog, "AssertionError: expected true");
        assertEquals(failureLog.includes("Check src/pass.ts"), false);
        assertEquals(failureLog.includes("passing ... ok"), false);
        assertEquals(failureLog.includes("passed"), false);
        assertEquals(failureLog.includes("tracking error"), false);
    } finally {
        if (failureLogPath) await fsRm(failureLogPath).catch(() => {});
        await fsRm(root, { recursive: true }).catch(() => {});
    }
});

test("a timed-out test reaps a SIGTERM-resistant process and reports the timeout", async () => {
    const pidPath = await makeTempFile({ prefix: "runwield-test-timeout-" });
    let failureLogPath = "";
    try {
        const startedAt = performance.now();
        const result = await runBoundedTest(
            runtimeSourceArgs([
                "eval",
                `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(
                    pidPath,
                )}, String(process.pid)); if (process.platform !== "win32") process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`,
            ]),
            { failureLabel: "tests", timeoutMs: 500, command: process.execPath },
        );
        failureLogPath = result.failureLogPath || "";
        assertEquals(result.code, 124);
        assertEquals(performance.now() - startedAt < 10_000, true);
        assertStringIncludes(result.stderr, "tests timed out");
        assertStringIncludes(await fsReadFile(failureLogPath, "utf8"), "exceeded 0.5s");
        const pid = Number(await fsReadFile(pidPath, "utf8"));
        let stopped = false;
        try {
            process.kill(pid, "SIGTERM");
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
            stopped = true;
        }
        assertEquals(stopped, true);
    } finally {
        if (failureLogPath) await fsRm(failureLogPath).catch(() => {});
        await fsRm(pidPath).catch(() => {});
    }
});

test("quiet Snip commands preserve failures from real subprocesses", async () => {
    const success = await runWithSnip(process.execPath, runtimeSourceArgs(["eval", 'console.log("verbose success")']), {
        failureLabel: "quiet success",
        quietOnSuccess: true,
    });
    assertEquals(success, { code: 0, stdout: "", stderr: "" });
    const failure = await runWithSnip(
        process.execPath,
        runtimeSourceArgs(["eval", 'console.error("real failure evidence"); process.exit(7)']),
        {
            failureLabel: "quiet failure",
            quietOnSuccess: true,
        },
    );
    try {
        assertEquals(failure.code, 7);
        assertStringIncludes(await fsReadFile(failure.failureLogPath!, "utf8"), "real failure evidence");
        assertStringIncludes(failure.stderr, failure.failureLogPath!);
    } finally {
        if (failure.failureLogPath) await fsRm(failure.failureLogPath);
    }
});

test("Snip filter verification accepts actual temporary paths requiring TOML escaping", async () => {
    const prefix = process.platform === "win32" ? "snip config-" : String.raw`snip \" quote-`;
    const root = await fsMkdtemp(join(tmpdir(), prefix));
    try {
        const result = await captureScriptProcess(process.execPath, {
            args: runtimeSourceArgs(["run", "-A", "scripts/check-snip-filters.ts"]),
            env: { ...process.env, TMPDIR: root, TEMP: root, TMP: root },
        });
        assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
        assertStringIncludes(new TextDecoder().decode(result.stdout), "Snip verified all generic Deno filters.");
    } finally {
        await fsRm(root, { recursive: true });
    }
});
