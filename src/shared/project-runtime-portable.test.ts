import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { getRunWieldRuntimeDir } from "../constants.js";
import { defineCommittedGitFixture } from "./git-test-fixture.ts";
import {
    enterProjectRuntime,
    migrateLegacyProjectRuntimeState,
    resolveProjectRuntimeLayout,
} from "./project-runtime-layout.ts";
import {
    controllerRecordPath,
    readControllerRecord,
    StaleControllerWriteError,
    writeControllerState,
} from "./workflow/controller-registry.ts";

const fixture = defineCommittedGitFixture();

async function writeText(path: string, text: string) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
}
async function archiveContents(path: string): Promise<string[]> {
    const result: string[] = [];
    for (const entry of await readdir(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) result.push(...await archiveContents(child));
        else result.push(await readFile(child, "utf8"));
    }
    return result.sort();
}

test("returning legacy controller writes recover reports while preserving decisions and source evidence", async () => {
    const root = await fixture.checkout();
    try {
        const legacy = join(getRunWieldRuntimeDir(root), "controller", "plans", "plan.json");
        const current = {
            version: 1,
            revision: 5,
            planId: "plan",
            planName: "demo",
            state: { validationCiAttempts: 2, humanReviewDecision: "approved" },
        };
        const old = {
            ...current,
            revision: 1,
            state: { validationCiAttempts: 0, humanReviewDecision: null, executionReport: "Implementation completed." },
        };
        await writeText(legacy, JSON.stringify(current));
        equal((await migrateLegacyProjectRuntimeState(root)).kind, "ready");
        const layout = resolveProjectRuntimeLayout(root);
        const destination = join(layout.primary.controllerPlansDir, "plan.json");
        deepEqual(JSON.parse(await readFile(destination, "utf8")), current);
        await writeText(legacy, JSON.stringify(old));
        equal((await migrateLegacyProjectRuntimeState(root)).kind, "ready");
        const expected = {
            ...current,
            revision: 6,
            state: { ...current.state, executionReport: old.state.executionReport },
        };
        deepEqual(JSON.parse(await readFile(destination, "utf8")), expected);
        await rejects(() => stat(legacy), { code: "ENOENT" });
        const archive = await archiveContents(join(layout.primary.internalRoot, "legacy-recovery"));
        ok(archive.includes(JSON.stringify(old)));
        ok(archive.includes(JSON.stringify(current)));
        await writeText(legacy, JSON.stringify(old));
        equal((await migrateLegacyProjectRuntimeState(root)).kind, "ready");
        deepEqual(JSON.parse(await readFile(destination, "utf8")), expected);
        deepEqual(await archiveContents(join(layout.primary.internalRoot, "legacy-recovery")), archive);
    } finally {
        await rm(root, { recursive: true });
    }
});

test("concurrent controller writes retain both independent updates and reject stale revisions", async () => {
    const root = await fixture.checkout();
    const identity = { planId: "plan", planName: "demo" };
    try {
        await enterProjectRuntime(root);
        await writeControllerState(root, identity, { validationCiAttempts: 1 });
        const lockPath = `${controllerRecordPath(root, identity)}.lock`;
        const inode = (await stat(lockPath)).ino;
        await Promise.all([
            writeControllerState(root, identity, { validationSemanticRounds: 3 }),
            writeControllerState(root, identity, { executionReport: "Ready for review." }),
        ]);
        const saved = await readControllerRecord(root, identity);
        equal(saved?.revision, 3);
        deepEqual(saved?.state, {
            validationCiAttempts: 1,
            validationSemanticRounds: 3,
            executionReport: "Ready for review.",
        });
        equal((await stat(lockPath)).ino, inode);
        await rejects(
            () => writeControllerState(root, identity, { validationCiAttempts: 0 }, { expectedRevision: 1 }),
            StaleControllerWriteError,
        );
        deepEqual(await readControllerRecord(root, identity), saved);
    } finally {
        await rm(root, { recursive: true });
    }
});
