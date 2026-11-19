import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { stat, copyFile, mkdtemp, rm } from "node:fs/promises";
import { cwd, chdir } from "node:process";
import { ok as assert } from "node:assert/strict";
import { assertEquals } from "./assertions.ts";
import { HEARTBEAT_MS, LOCK_DIR, withProcessGlobalTestLock } from "./process-global-lock.ts";

// Every case here goes through withProcessGlobalTestLock rather than touching
// LOCK_DIR directly: backdating or removing a lock that another test file is
// legitimately holding would corrupt that file's run, which is the exact class
// of bug this lock exists to prevent.

test("a lock module initialized during a cwd change still waits for the existing holder", async () => {
    const root = await mkdtemp(join(tmpdir(), "process-lock-realm-"));
    let entered = false;
    let waiter: Promise<void> | undefined;
    try {
        await withProcessGlobalTestLock(async () => {
            const previous = cwd();
            try {
                chdir(root);
                const freshModule = join(root, "process-global-lock.ts");
                await copyFile(new URL("./process-global-lock.ts", import.meta.url), freshModule);
                const isolated = await import(pathToFileURL(freshModule).href);
                waiter = isolated.withProcessGlobalTestLock(() => {
                    entered = true;
                    return Promise.resolve();
                });
                await new Promise((resolve) => setTimeout(resolve, 80));
                assertEquals(entered, false);
            } finally {
                chdir(previous);
            }
        });
        await waiter;
        assertEquals(entered, true);
    } finally {
        await waiter;
        await rm(root, { recursive: true, force: true });
    }
});

test("concurrent acquisitions serialize", async () => {
    let inside = 0;
    let maxInside = 0;
    const enter = () =>
        withProcessGlobalTestLock(async () => {
            inside += 1;
            maxInside = Math.max(maxInside, inside);
            await new Promise((resolve) => setTimeout(resolve, 50));
            inside -= 1;
        });
    await Promise.all([enter(), enter(), enter()]);
    assertEquals(maxInside, 1);
});

test("holder heartbeat keeps its lock fresh", async () => {
    // Without this, a critical section outliving STALE_LOCK_MS would be reaped
    // by a waiter and two holders would run at once.
    await withProcessGlobalTestLock(async () => {
        const before = (await stat(LOCK_DIR)).mtime?.getTime() ?? 0;
        await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_MS + 1000));
        const after = (await stat(LOCK_DIR)).mtime?.getTime() ?? 0;
        assert(after > before, `Expected heartbeat to advance lock mtime (${before} -> ${after}).`);
    });
});
