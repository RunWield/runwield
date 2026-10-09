import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { HEARTBEAT_MS, LOCK_DIR, withProcessGlobalTestLock } from "./process-global-lock.ts";

// Every case here goes through withProcessGlobalTestLock rather than touching
// LOCK_DIR directly: backdating or removing a lock that another test file is
// legitimately holding would corrupt that file's run, which is the exact class
// of bug this lock exists to prevent.

Deno.test("lock is keyed on the process, not the working directory", () => {
    // Regression: keying on Deno.cwd() meant each test-file realm computed its
    // own lock path whenever it initialized during another file's chdir window,
    // so two files could hold the lock at once and clobber each other's cwd.
    assertStringIncludes(LOCK_DIR, `pid-${Deno.pid}`);
    assertEquals(LOCK_DIR.includes(encodeURIComponent(Deno.cwd()).replaceAll("%", "-")), false);
});

Deno.test("concurrent acquisitions serialize", async () => {
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

Deno.test("holder heartbeat keeps its lock fresh", async () => {
    // Without this, a critical section outliving STALE_LOCK_MS would be reaped
    // by a waiter and two holders would run at once.
    await withProcessGlobalTestLock(async () => {
        const before = (await Deno.stat(LOCK_DIR)).mtime?.getTime() ?? 0;
        await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_MS + 1000));
        const after = (await Deno.stat(LOCK_DIR)).mtime?.getTime() ?? 0;
        assert(after > before, `Expected heartbeat to advance lock mtime (${before} -> ${after}).`);
    });
});
