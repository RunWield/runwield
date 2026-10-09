import { assertEquals } from "./assertions.ts";
import process from "node:process";
import { stat as fsStat } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { withProcessGlobalTestLock } from "./process-global-lock.ts";

// Tripwire. The suite writes to ~/.wld through both a live Deno.env.get("HOME")
// and a HOME_DIR snapshot taken when each test realm loads src/constants.js, so
// running it against a real home silently rewrites the developer's global
// settings, sessions and workflow metrics. scripts/run-tests.js sandboxes HOME;
// this fails loudly when the suite is launched some other way.

test("suite runs against a sandboxed HOME", async () => {
    const sandbox = process.env["WLD_TEST_SANDBOX_HOME"];
    assert(
        sandbox,
        "Tests must run via `bun run test` (or scripts/run-tests.js), which points HOME at a sandbox. " +
            "Running `deno test` directly lets tests write to the real ~/.wld.",
    );

    // Sampled under the lock so a test that is mid-HOME-swap cannot trip this,
    // while a test that leaked its swap still does.
    await withProcessGlobalTestLock(async () => {
        assertEquals(
            process.env["HOME"],
            sandbox,
            "HOME escaped the sandbox — a test swapped HOME and did not restore it.",
        );
        assertEquals(await fsStat(sandbox).then((s) => s.isDirectory()).catch(() => false), true);
    });
});

test("mnemoteca is pointed at a sandbox database", () => {
    // work-records cleanup shells out to the real mnemoteca binary
    // (`mnemoteca forget`). Without this it operates on the developer's own
    // memory database, which HOME sandboxing alone does not prevent because
    // mnemoteca resolves its default path itself.
    const sandbox = process.env["WLD_TEST_SANDBOX_HOME"];
    const dbPath = process.env["MNEMOTECA_DB_PATH"];
    assert(sandbox, "Expected the suite to be sandboxed.");
    assert(dbPath, "MNEMOTECA_DB_PATH must be set so tests never touch the real memory database.");
    assert(
        dbPath.startsWith(sandbox),
        `MNEMOTECA_DB_PATH (${dbPath}) must live inside the sandbox (${sandbox}).`,
    );
});
