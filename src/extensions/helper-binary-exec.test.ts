import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { kill, platform } from "node:process";
import { assertEquals, assertRejects, assertThrows } from "../testing/assertions.ts";
import { getCwd } from "../constants.js";
import { denoHelperBinaryExec } from "./helper-binary-exec.ts";

test("helper execution preserves literal arguments, both output streams and exit status", {
    skip: platform === "win32",
}, async () => {
    const result = await denoHelperBinaryExec("sh", [
        "-c",
        'printf "%s" "$1"; printf error >&2; exit 7',
        "fixture",
        "$(touch BAD); literal",
    ], { cwd: getCwd() });
    assertEquals(result, { code: 7, stdout: "$(touch BAD); literal", stderr: "error" });
});

test("missing helper executable returns the established command-not-found result", async () => {
    const command = `missing-helper-${crypto.randomUUID()}`;
    assertEquals(await denoHelperBinaryExec(command, [], { cwd: getCwd() }), {
        code: 127,
        stdout: "",
        stderr: `${command}: command not found`,
    });
});

test("helper cancellation rejects after the running process is stopped", { skip: platform === "win32" }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "helper-cancel-"));
    const abort = new AbortController();
    const started = join(cwd, "started");
    const pending = denoHelperBinaryExec("sh", ["-c", "echo $$ > started; sleep 30"], {
        cwd,
        signal: abort.signal,
    });
    let pid = 0;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const settled = pending.then((result) => ({ result }), (error: Error) => ({ error }));
    try {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
            pid = Number((await readFile(started, "utf8").catch(() => "")).trim());
            if (pid > 0) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assertEquals(pid > 0, true, "Helper did not start");
        kill(pid, 0);
        abort.abort();
        const result = await Promise.race([
            settled,
            new Promise<never>((_, reject) => {
                deadlineTimer = setTimeout(
                    () => reject(new Error("Helper did not stop promptly after cancellation")),
                    2_000,
                );
            }),
        ]);
        const gone = assertThrows(() => kill(pid, 0), Error);
        assertEquals("code" in gone ? gone.code : "missing-code", "ESRCH");
        assertEquals("error" in result ? result.error.name : "resolved", "AbortError");
        await assertRejects(() => denoHelperBinaryExec("sh", ["-c", "exit 0"], { cwd, signal: abort.signal }), Error);
    } finally {
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        abort.abort();
        if (pid > 0) {
            try {
                kill(-pid, "SIGKILL");
            } catch { /* Owned group already gone. */ }
        }
        await settled;
        await rm(cwd, { recursive: true });
    }
});
