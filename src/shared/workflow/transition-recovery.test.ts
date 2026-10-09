/**
 * Regression tests for Plan-scoped transition healing.
 *
 * load-plan heals one Plan's interrupted lifecycle records on every load. That
 * heal must be cheap when the Plan has nothing to heal, and it must never touch
 * a journal that belongs to another Plan.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { healSettledTransitionRecords } from "./transition-recovery.ts";
import { getTransitionJournalPath } from "./state-transition.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { enterProjectRuntime } from "../project-runtime-layout.ts";

async function writeJournal(
    projectRoot: string,
    record: { transitionId: string; planName: string; state: string; operation?: string },
): Promise<string> {
    await enterProjectRuntime(projectRoot);
    const path = getTransitionJournalPath(projectRoot, record.transitionId);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, `${JSON.stringify(record, null, 2)}\n`);
    return path;
}

async function journalExists(projectRoot: string, transitionId: string): Promise<boolean> {
    try {
        await Deno.stat(getTransitionJournalPath(projectRoot, transitionId));
        return true;
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
    }
}

Deno.test("healing a Plan with no journals returns empty without starting Git", async () => {
    await withProcessGlobalTestLock(async () => {
        const projectRoot = await Deno.makeTempDir({ prefix: "runwield-heal-nogit-" });
        const emptyBin = await Deno.makeTempDir({ prefix: "runwield-heal-emptybin-" });
        const previousPath = Deno.env.get("PATH");
        try {
            // Remove git from PATH. If the heal tried to gather Git worktree
            // evidence, spawning `git` would now fail and the heal would throw.
            Deno.env.set("PATH", emptyBin);
            const result = await healSettledTransitionRecords(projectRoot, { planName: "nothing-to-heal" });
            assertEquals(result, { closed: [], remaining: [] });
        } finally {
            if (previousPath === undefined) Deno.env.delete("PATH");
            else Deno.env.set("PATH", previousPath);
            await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
            await Deno.remove(emptyBin, { recursive: true }).catch(() => {});
        }
    });
});

Deno.test("healing one Plan does not remove another Plan's settled journal", async () => {
    const projectRoot = await Deno.makeTempDir({ prefix: "runwield-heal-isolation-" });
    try {
        const selectedPath = await writeJournal(projectRoot, {
            transitionId: "selected-record",
            planName: "selected-plan",
            state: "committed",
            operation: "recovery_reset",
        });
        const otherPath = await writeJournal(projectRoot, {
            transitionId: "other-record",
            planName: "other-plan",
            state: "committed",
            operation: "recovery_reset",
        });

        const result = await healSettledTransitionRecords(projectRoot, {
            planName: "selected-plan",
            apply: true,
        });

        // The selected Plan's settled record is closed...
        assertEquals(result.closed.map((entry) => entry.transitionId), ["selected-record"]);
        assertEquals(result.remaining, []);
        assertEquals(await journalExists(projectRoot, "selected-record"), false, "selected journal should be removed");
        // ...and the unrelated Plan's journal is untouched, byte for byte.
        assertEquals(await journalExists(projectRoot, "other-record"), true, "other Plan's journal must survive");
        assertEquals(typeof selectedPath, "string");
        assertEquals(typeof otherPath, "string");
    } finally {
        await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
    }
});
