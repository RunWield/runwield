import { test } from "node:test";
import { deepStrictEqual, strictEqual, rejects } from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getRunWieldRuntimeDir } from "../constants.js";
import { defineCommittedGitFixture } from "./git-test-fixture.ts";
import {
    checkedProjectRuntimeLayout,
    enterProjectRuntime,
    inspectProjectRuntimeReadAccess,
    withProjectRuntimeReadScope,
} from "./project-runtime-layout.ts";

const fixture = defineCommittedGitFixture({ "README.md": "# Passive runtime\n" });

test("passive fresh and legacy inspection preserves sources and does not adopt storage", async () => {
    const root = await fixture.checkout();
    try {
        const before = await readdir(root);
        strictEqual((await inspectProjectRuntimeReadAccess(root)).kind, "fresh");
        deepStrictEqual(await readdir(root), before);
        const legacy = join(getRunWieldRuntimeDir(root), "controller/plans");
        await mkdir(legacy, { recursive: true });
        const bytes = JSON.stringify({ version: 1, revision: 1, planName: "draft", state: { status: "draft" } });
        await writeFile(join(legacy, "name%3Adraft.json"), bytes);
        await writeFile(join(legacy, "name%3Adraft.json.lock"), "");
        strictEqual((await inspectProjectRuntimeReadAccess(root)).kind, "pending");
        strictEqual((await inspectProjectRuntimeReadAccess(root)).kind, "pending");
        deepStrictEqual(await readdir(getRunWieldRuntimeDir(root)), ["controller"]);
        strictEqual(await readFile(join(legacy, "name%3Adraft.json"), "utf8"), bytes);
    } finally {
        await rm(root, { recursive: true });
    }
});

test("adopted passive authority ignores returning legacy input without recovering it", async () => {
    const root = await fixture.checkout();
    try {
        const layout = await enterProjectRuntime(root);
        const legacy = join(getRunWieldRuntimeDir(root), "controller/plans");
        await mkdir(legacy, { recursive: true });
        await writeFile(join(legacy, "name%3Adraft.json"), "returning recovery input");
        const marker = await readFile(layout.primary.layoutMarkerPath, "utf8");
        strictEqual((await inspectProjectRuntimeReadAccess(root)).kind, "ready");
        strictEqual(await readFile(layout.primary.layoutMarkerPath, "utf8"), marker);
        strictEqual(await readFile(join(legacy, "name%3Adraft.json"), "utf8"), "returning recovery input");
    } finally {
        await rm(root, { recursive: true });
    }
});

test("passive operation reuse never admits a writer and expires before the next request", async () => {
    const root = await fixture.checkout();
    try {
        const layout = await enterProjectRuntime(root);
        const marker = await readFile(layout.primary.layoutMarkerPath, "utf8");
        await withProjectRuntimeReadScope(async () => {
            const first = inspectProjectRuntimeReadAccess(root);
            strictEqual(inspectProjectRuntimeReadAccess(root), first);
            await first;
            await writeFile(layout.primary.layoutMarkerPath, JSON.stringify({ version: 999 }));
            await rejects(() => enterProjectRuntime(root), /newer/);
        });
        strictEqual((await inspectProjectRuntimeReadAccess(root)).kind, "blocked");
        await writeFile(layout.primary.layoutMarkerPath, marker);
        strictEqual((await checkedProjectRuntimeLayout(root)).primary.checkoutRoot, layout.primary.checkoutRoot);
    } finally {
        await rm(root, { recursive: true });
    }
});

test("adopted passive inspection blocks unsupported registry versions", async () => {
    const root = await fixture.checkout();
    try {
        const layout = await enterProjectRuntime(root);
        await writeFile(layout.primary.worktreeRegistryPath, JSON.stringify({ version: 999, entries: [] }));
        const result = await inspectProjectRuntimeReadAccess(root);
        strictEqual(result.kind, "blocked");
        if (result.kind === "blocked") {
            strictEqual(result.reason, "malformed_registry");
            strictEqual(/999|unsupported|schema/i.test(result.message), true);
        }
    } finally {
        await rm(root, { recursive: true });
    }
});
