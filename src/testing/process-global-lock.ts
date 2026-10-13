/**
 * Serialize tests that temporarily mutate process-wide state such as Deno.env
 * or Deno.cwd while Deno test modules run concurrently.
 */

import { rmSync } from "node:fs";
import { mkdir, readdir, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { env, pid, platform } from "node:process";
import { clearInterval, setInterval } from "node:timers";

// The state this guards (cwd, env) is per-process, but Deno gives each test
// module its own realm, so an in-memory mutex would not be shared and the lock
// has to live on disk. That makes the key load-bearing in two directions: it
// must be identical across every realm of this process, and distinct from any
// other process (notably the Golden TUI child processes, which have their own
// cwd and must not serialize against the test runner). Deno.pid is both.
//
// It was previously keyed on Deno.cwd(), evaluated once per realm at import
// time. A file that initialized during another file's chdir window computed a
// different path and the lock excluded nobody.
// The lock path must be identical for every realm in this process, and nothing
// in the repo mutates these temporary-directory variables.
const LOCK_ROOT = env.TMPDIR || env.TEMP || env.TMP ||
    (platform === "win32" ? "C:\\Windows\\Temp" : "/tmp");
const LOCK_PREFIX = "runwield-process-global-test-pid-";
const LOCK_SUFFIX = ".lock";
export const LOCK_DIR = join(LOCK_ROOT, `${LOCK_PREFIX}${pid}${LOCK_SUFFIX}`);
// The holder refreshes the lock's mtime while it works, so a lock that stops
// advancing was abandoned by a process that died holding it — most often a
// previous run that was killed, whose pid this process later reused. That makes
// reaping safe and immediate, instead of a fixed timeout that has to out-wait
// the longest legitimate critical section before a leftover clears.
export const HEARTBEAT_MS = 3_000;
const STALE_LOCK_MS = 30_000;

function delay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function startLockHeartbeat() {
    const timer = setInterval(() => {
        const now = new Date();
        utimes(LOCK_DIR, now, now).catch(() => {});
    }, HEARTBEAT_MS);
    // Never let the heartbeat hold the test runner's event loop open.
    timer.unref();
    return timer;
}

let reapedAbandonedLocks = false;

/**
 * Remove locks left by processes that died holding one.
 *
 * Because the key is this process's pid, nothing else ever contends for our
 * path — which also means the reaping below never fires for a lock belonging to
 * a pid that is simply gone, and those directories accumulate in TMPDIR
 * indefinitely. Sweep the siblings once per process instead. mtime is a
 * sufficient liveness test without inspecting pids: a live holder refreshes its
 * lock every HEARTBEAT_MS, and a process not currently holding one has no
 * directory at all, so a stale mtime means the owner is gone.
 */
async function reapAbandonedLocks() {
    if (reapedAbandonedLocks) return;
    reapedAbandonedLocks = true;
    try {
        for (const entry of await readdir(LOCK_ROOT, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            if (!entry.name.startsWith(LOCK_PREFIX) || !entry.name.endsWith(LOCK_SUFFIX)) continue;
            const path = join(LOCK_ROOT, entry.name);
            if (path === LOCK_DIR) continue;
            try {
                const info = await stat(path);
                if (info.mtime && Date.now() - info.mtime.getTime() > STALE_LOCK_MS) {
                    await rm(path, { recursive: true });
                }
            } catch {
                // Raced with the owner or another reaper; either way it is handled.
            }
        }
    } catch {
        // Reaping is opportunistic hygiene, never a reason to fail a test run.
    }
}

async function acquireProcessGlobalTestLock() {
    await reapAbandonedLocks();
    while (true) {
        try {
            await mkdir(LOCK_DIR);
            return startLockHeartbeat();
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
            try {
                const info = await stat(LOCK_DIR);
                if (info.mtime && Date.now() - info.mtime.getTime() > STALE_LOCK_MS) {
                    await rm(LOCK_DIR, { recursive: true });
                    continue;
                }
            } catch (statError) {
                if (!(statError instanceof Error && "code" in statError && statError.code === "ENOENT")) {
                    throw statError;
                }
            }
            await delay(20);
        }
    }
}

/**
 * Release this process's lock synchronously.
 *
 * For termination handlers, which cannot await and whose `Deno.exit` skips the
 * `finally` in `withProcessGlobalTestLock`. Reaping would clear the directory
 * eventually; releasing here means the next run does not have to wait out
 * STALE_LOCK_MS to find that out.
 */
export function releaseProcessGlobalTestLockSync() {
    try {
        rmSync(LOCK_DIR, { recursive: true });
    } catch {
        // Not held, or already released.
    }
}

export async function withProcessGlobalTestLock<T>(fn: () => Promise<T>): Promise<T> {
    const heartbeat = await acquireProcessGlobalTestLock();
    try {
        return await fn();
    } finally {
        clearInterval(heartbeat);
        await rm(LOCK_DIR, { recursive: true }).catch(() => {});
    }
}
