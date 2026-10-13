/** Qualify native lock ownership across the current Deno and candidate Bun runtimes. */
import { equal, match, ok } from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argv, env } from "node:process";
import { createInterface } from "node:readline";
import { openNativeFileLock } from "../src/shared/native-file-lock.ts";
import { requirePinnedBun } from "./check-bun-runtime.ts";

requirePinnedBun();
const deno = argv[2];
if (!deno || argv.length !== 3) throw new Error("Usage: check-lock-interoperability.ts <deno-executable>");
const home = await mkdtemp(join(tmpdir(), "runwield-lock-interop-"));
const path = join(home, "shared-λ守🔒.lock");
const childEnv = {
    ...(env.PATH ? { PATH: env.PATH } : {}),
    ...(env.SystemRoot ? { SystemRoot: env.SystemRoot } : {}),
    ...(env.COMSPEC ? { COMSPEC: env.COMSPEC } : {}),
    ...(env.PATHEXT ? { PATHEXT: env.PATHEXT } : {}),
    HOME: home,
    USERPROFILE: home,
    DENO_DIR: join(home, "deno-cache"),
    DENO_NO_UPDATE_CHECK: "1",
};
try {
    const version = spawnSync(deno, ["--version"], { encoding: "utf8", timeout: 10_000, env: childEnv, cwd: home });
    equal(version.status, 0, version.stderr);
    match(version.stdout, /^deno 2\.9\.7\b/);
    const open = `const file = Deno.openSync(${JSON.stringify(path)}, { read: true, write: true, create: true });`;
    const owner = openNativeFileLock(path);
    try {
        owner.lockSync(true);
        const attempt = spawnSync(deno, [
            "eval",
            "--no-config",
            `${open} console.log(file.tryLockSync(true)); file.close();`,
        ], { encoding: "utf8", timeout: 10_000, env: childEnv, cwd: home });
        equal(attempt.status, 0, attempt.stderr);
        equal(attempt.stdout.trim(), "false", "Deno must respect Bun ownership");
    } finally {
        owner.close();
    }
    for (const exit of ["close", "crash"]) {
        const child = spawn(deno, [
            "eval",
            "--no-config",
            `${open}
file.lockSync(true); console.log("held");
await Deno.stdin.read(new Uint8Array(1)); file.close(); console.log("released");
await Deno.stdin.read(new Uint8Array(1));`,
        ], { stdio: ["pipe", "pipe", "pipe"], env: childEnv, cwd: home });
        const finished = once(child, "close");
        let errors = "";
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => errors += chunk);
        const lines = createInterface({ input: child.stdout });
        const held = once(lines, "line", { signal: AbortSignal.timeout(10_000) });
        const contender = openNativeFileLock(path);
        try {
            equal((await held)[0], "held", errors);
            equal(contender.tryLockSync(true), false, "Bun must respect Deno ownership");
            if (exit === "close") {
                const released = once(lines, "line", { signal: AbortSignal.timeout(10_000) });
                child.stdin.write("\n");
                equal((await released)[0], "released", errors);
                equal(child.exitCode, null, "Deno remains alive after explicitly closing its lock");
            } else {
                ok(child.kill("SIGKILL"));
                await finished;
            }
            equal(contender.tryLockSync(true), true, `Bun acquires ownership after Deno ${exit}`);
            contender.replaceTextSync("complete metadata λ");
            equal(contender.readSnapshotSync().text, "complete metadata λ");
        } finally {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            await finished;
            lines.close();
            contender.close();
        }
    }
    console.log("Bun/Deno native lock interoperability passed: two-way exclusion, close/crash release, metadata I/O.");
} finally {
    await rm(home, { recursive: true, force: true });
}
