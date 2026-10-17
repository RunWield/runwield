import { readFile as fsReadFile, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { getCwd } from "../../constants.js";
import { test } from "node:test";
import { mkdtempSync as fsMkdtempSync, rmSync as fsRmSync } from "node:fs";
import { tmpdir } from "node:os";
/**
 * @module cmd/init/init-state_test
 * Tests for the global init-state module.
 *
 * IMPORTANT: These tests override the state path to a temp directory
 * to avoid polluting the user's real ~/.wld/init-state.json.
 */

import { partialDeepStrictEqual as assertObjectMatch } from "node:assert/strict";
import { assertEquals, assertExists } from "../../testing/assertions.ts";
import { join } from "node:path";
import { _setTestStatePath } from "./init-state.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import {
    getCwdHash,
    getInitState,
    isInitDone,
    isInitOffered,
    recordInitDone,
    recordInitOffered,
    recordSnipMissingWarningShown,
    shouldShowSnipMissingWarning,
} from "./init-state.ts";

// Isolate all state operations to a temp directory so we never touch
// the user's real ~/.wld/init-state.json.
const testDir = fsMkdtempSync(join(tmpdir(), "runwield-fixture-"));
const testStatePath = join(testDir, "init-state.json");
_setTestStatePath(testStatePath);

type InitStateTestBody = () => Promise<void> | void;

function initStateTest(name: string, fn: InitStateTestBody) {
    test(name, () => withProcessGlobalTestLock(async () => await fn()));
}

// ── init-state unit tests ──────────────────────────────────────────

initStateTest("getCwdHash returns a 64-char hex string", async () => {
    const hash = await getCwdHash();
    assertEquals(typeof hash, "string");
    assertEquals(hash.length, 64);
    // Must be valid hex
    assertEquals(/^[0-9a-f]{64}$/.test(hash), true);
});

initStateTest("getCwdHash is deterministic for the same CWD", async () => {
    const a = await getCwdHash();
    const b = await getCwdHash();
    assertEquals(a, b);
});

initStateTest("getInitState returns empty object when no state file exists", async () => {
    await cleanupState();
    const state = await getInitState();
    assertObjectMatch(state, {});
});

initStateTest("recordInitDone creates state file with correct structure", async () => {
    await cleanupState();

    const cwdHash = await getCwdHash();
    await recordInitDone();

    const state = await getInitState();
    assertExists(state[cwdHash]);
    assertEquals(state[cwdHash].initOffered, true);
    assertEquals(state[cwdHash].initDone, true);
    assertEquals(state[cwdHash].path, getCwd());
    assertEquals(typeof state[cwdHash].offeredAt, "string");
    assertEquals(typeof state[cwdHash].doneAt, "string");

    // Verify raw file content
    const raw = await readRawState();
    assertExists(raw);
    assertExists(raw[cwdHash]);
    assertEquals(raw[cwdHash].initOffered, true);
    assertEquals(raw[cwdHash].initDone, true);
    assertEquals(raw[cwdHash].path, getCwd());
    assertEquals(typeof raw[cwdHash].offeredAt, "string");
    assertEquals(typeof raw[cwdHash].doneAt, "string");
    assertEquals(raw[cwdHash].snipMissingWarningCount, 0);
    assertEquals(raw[cwdHash].snipMissingWarningLastShownAt, null);

    await cleanupState();
});

initStateTest("recordInitOffered marks only initOffered without initDone", async () => {
    await cleanupState();

    const cwdHash = await getCwdHash();
    await recordInitOffered();

    const state = await getInitState();
    assertExists(state[cwdHash]);
    assertEquals(state[cwdHash].initOffered, true);
    assertEquals(state[cwdHash].initDone, false);
    assertEquals(state[cwdHash].path, getCwd());
    assertEquals(typeof state[cwdHash].offeredAt, "string");
    assertEquals(state[cwdHash].doneAt, null);

    await cleanupState();
});

initStateTest("isInitDone returns true after recordInitDone", async () => {
    await cleanupState();

    assertEquals(await isInitDone(), false);
    await recordInitDone();
    assertEquals(await isInitDone(), true);

    await cleanupState();
});

initStateTest("isInitDone returns false when state file does not exist", async () => {
    await cleanupState();
    assertEquals(await isInitDone(), false);
});

initStateTest("isInitOffered returns false when state file does not exist", async () => {
    await cleanupState();
    assertEquals(await isInitOffered(), false);
});

initStateTest("isInitOffered returns true after recordInitOffered", async () => {
    await cleanupState();

    assertEquals(await isInitOffered(), false);
    await recordInitOffered();
    assertEquals(await isInitOffered(), true);
    // But initDone should still be false
    assertEquals(await isInitDone(), false);

    await cleanupState();
});

initStateTest("isInitOffered returns true after recordInitDone (implicit offer)", async () => {
    await cleanupState();

    await recordInitDone();
    assertEquals(await isInitOffered(), true);
    assertEquals(await isInitDone(), true);

    await cleanupState();
});

initStateTest("state file is isolated per CWD hash", async () => {
    await cleanupState();

    const cwdHash = await getCwdHash();
    await recordInitDone();

    // Simulate a different project by manually writing another hash
    const state = await getInitState();
    state["0000000000000000000000000000000000000000000000000000000000000000"] = {
        path: "/tmp/other-project",
        initOffered: false,
        initDone: true,
        offeredAt: null,
        doneAt: new Date().toISOString(),
    };
    await fsWriteFile(testStatePath, JSON.stringify(state, null, 2));

    // Reading the full state should contain both entries
    const updated = await getInitState();
    assertExists(updated[cwdHash]);
    assertExists(updated["0000000000000000000000000000000000000000000000000000000000000000"]);

    // isInitDone for our CWD should still be true
    assertEquals(await isInitDone(), true);

    await cleanupState();
});

initStateTest("recordInitDone preserves other CWD entries (no overwrite)", async () => {
    await cleanupState();

    // First, record init done for the current CWD
    await recordInitDone();

    // Manually add another entry
    const state = await getInitState();
    state["abcdef0123456789"] = {
        path: "/tmp/another-project",
        initOffered: true,
        initDone: false,
        offeredAt: new Date().toISOString(),
        doneAt: null,
    };
    await fsWriteFile(testStatePath, JSON.stringify(state, null, 2));

    // Call recordInitOffered (for the same CWD) — should not clobber the other entry
    await recordInitOffered();
    const updated = await getInitState();
    assertExists(updated["abcdef0123456789"]);
    assertEquals(updated["abcdef0123456789"].initOffered, true);

    await cleanupState();
});

initStateTest("Snip missing warning counter is capped by limit", async () => {
    await cleanupState();

    assertEquals(await shouldShowSnipMissingWarning(2), true);
    await recordSnipMissingWarningShown();
    assertEquals(await shouldShowSnipMissingWarning(2), true);
    await recordSnipMissingWarningShown();
    assertEquals(await shouldShowSnipMissingWarning(2), false);

    const cwdHash = await getCwdHash();
    const state = await getInitState();
    assertEquals(state[cwdHash].snipMissingWarningCount, 2);
    assertEquals(typeof state[cwdHash].snipMissingWarningLastShownAt, "string");
    assertEquals(state[cwdHash].initOffered, false);
    assertEquals(state[cwdHash].initDone, false);

    await cleanupState();
});

// ── Helpers ──────────────────────────────────────────────────────

async function readRawState() {
    try {
        const raw = await fsReadFile(testStatePath, "utf8");
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

async function cleanupState() {
    try {
        await fsRm(testStatePath);
    } catch {
        // ignore
    }
}

// Cleanup temp directory after all tests
globalThis.addEventListener("unload", () => {
    try {
        fsRmSync(testDir, { recursive: true });
    } catch {
        // ignore
    }
});
