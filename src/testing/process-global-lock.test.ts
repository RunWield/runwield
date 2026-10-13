import { test } from "node:test";
import { stat } from "node:fs/promises";
import { cwd, pid } from "node:process";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "./assertions.ts";
import { HEARTBEAT_MS, LOCK_DIR, withProcessGlobalTestLock } from "./process-global-lock.ts";

// Every case here goes through withProcessGlobalTestLock rather than touching
// LOCK_DIR directly: backdating or removing a lock that another test file is
// legitimately holding would corrupt that file's run, which is the exact class
// of bug this lock exists to prevent.

test("lock is keyed on the process, not the working directory", () => {
    // Regression: keying on cwd() meant each test-file realm computed its
    // own lock path whenever it initialized during another file's chdir window,
    // so two files could hold the lock at once and clobber each other's cwd.
    assertStringIncludes(LOCK_DIR, `pid-${pid}`);
    assertEquals(LOCK_DIR.includes(encodeURIComponent(cwd()).replaceAll("%", "-")), false);
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
