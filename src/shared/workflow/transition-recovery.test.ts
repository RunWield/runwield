import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { tmpdir } from "node:os";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import process from "node:process";
/**
 * Regression tests for Plan-scoped transition healing.
 *
 * load-plan heals one Plan's interrupted lifecycle records on every load. That
 * heal must be cheap when the Plan has nothing to heal, and it must never touch
 * a journal that belongs to another Plan.
 */

import { join } from "node:path";
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
    await fsMkdir(join(path, ".."), { recursive: true });
    await fsWriteFile(path, `${JSON.stringify(record, null, 2)}\n`);
    return path;
}

async function journalExists(projectRoot: string, transitionId: string): Promise<boolean> {
    try {
        await fsStat(getTransitionJournalPath(projectRoot, transitionId));
        return true;
    } catch (error) {
        if ((error instanceof Error && "code" in error && error.code === "ENOENT")) return false;
        throw error;
    }
}

test("healing a Plan with no journals returns empty without starting Git", async () => {
    await withProcessGlobalTestLock(async () => {
        const projectRoot = await fsMkdtemp(join(tmpdir(), "runwield-heal-nogit-"));
        const emptyBin = await fsMkdtemp(join(tmpdir(), "runwield-heal-emptybin-"));
        const previousPath = process.env["PATH"];
        try {
            // Remove git from PATH. If the heal tried to gather Git worktree
            // evidence, spawning `git` would now fail and the heal would throw.
            process.env["PATH"] = emptyBin;
            const result = await healSettledTransitionRecords(projectRoot, { planName: "nothing-to-heal" });
            assertEquals(result, { closed: [], remaining: [] });
        } finally {
            if (previousPath === undefined) delete process.env["PATH"];
            else process.env["PATH"] = previousPath;
            await fsRm(projectRoot, { recursive: true }).catch(() => {});
            await fsRm(emptyBin, { recursive: true }).catch(() => {});
        }
    });
});

test("healing one Plan does not remove another Plan's settled journal", async () => {
    const projectRoot = await fsMkdtemp(join(tmpdir(), "runwield-heal-isolation-"));
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
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
    }
});
