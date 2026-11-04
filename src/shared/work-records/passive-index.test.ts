import { test } from "node:test";
import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import { mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getRunWieldRuntimeDir } from "../../constants.js";
import { defineCommittedGitFixture } from "../git-test-fixture.ts";
import { inspectProjectIdentity } from "../project-identity.ts";
import { enterProjectRuntime, resolveProjectRuntimeLayout } from "../project-runtime-layout.ts";
import { runMnemotecaWorkRecordCommand } from "./index-adapter.ts";
import { searchWorkRecords } from "./search.ts";
import { writeWorkRecord } from "./store.ts";
import { createWorkRecordMnemotecaFixture } from "./test-fixtures/mnemoteca-port.ts";
import type { WorkRecordMnemotecaCommandOptions } from "./mnemoteca-port.ts";

const fixture = defineCommittedGitFixture();
for (const canonical of [false, true]) {
    test(`Work Record search preserves identity-free Project sources${canonical ? " during index bootstrap" : ""}`, async () => {
        const root = await realpath(await fixture.checkout());
        try {
            if (canonical)
                await writeWorkRecord(
                    root,
                    {
                        kind: "work_record",
                        recordId: crypto.randomUUID(),
                        status: "approved",
                        scope: "planned_change",
                        origin: "internal",
                        completionMode: "verified",
                        createdAt: "2026-01-01T00:00:00Z",
                        provenance: { sourcePlans: [crypto.randomUUID()] },
                    },
                    "# Example\n\n## Summary\n\nSearchable knowledge.\n",
                );
            const before = await readdir(root);
            const config = await readFile(join(root, ".git", "config"), "utf8");
            const external = createWorkRecordMnemotecaFixture();
            const options = {
                mnemotecaPort: {
                    run: async (args: string[], commandOptions?: WorkRecordMnemotecaCommandOptions) => {
                        deepEqual(commandOptions, { cwd: root });
                        return await external.run(args, commandOptions);
                    },
                },
            };
            const result = await searchWorkRecords(root, "knowledge", options);
            equal(result.records.length, canonical ? 1 : 0);
            await runMnemotecaWorkRecordCommand(root, ["list"], options);
            await runMnemotecaWorkRecordCommand(root, ["update", "--help"], options);
            equal(inspectProjectIdentity(root).kind, "fresh");
            deepEqual(await readdir(root), before);
            equal(await readFile(join(root, ".git", "config"), "utf8"), config);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
}

test("Work Record search leaves unadmitted legacy runtime intact", async () => {
    const root = await realpath(await fixture.checkout());
    try {
        const source = join(getRunWieldRuntimeDir(root), "internal", "debug", "trace");
        await mkdir(dirname(source), { recursive: true });
        await writeFile(source, "legacy bytes");
        await rejects(
            () => searchWorkRecords(root, "knowledge", { mnemotecaPort: createWorkRecordMnemotecaFixture() }),
            /pending|migration evidence/i,
        );
        equal(inspectProjectIdentity(root).kind, "fresh");
        equal(await readFile(source, "utf8"), "legacy bytes");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("Work Record search uses admitted home index without recovering returning legacy input", async () => {
    const root = await realpath(await fixture.checkout());
    try {
        const layout = await enterProjectRuntime(root);
        const source = join(getRunWieldRuntimeDir(root), "internal", "debug", "trace");
        await mkdir(dirname(source), { recursive: true });
        await writeFile(source, "returning bytes");
        const external = createWorkRecordMnemotecaFixture();
        await searchWorkRecords(root, "knowledge", {
            mnemotecaPort: {
                run: async (args, options) => {
                    equal(options?.env?.MNEMOTECA_DB_PATH, layout.primary.workRecordIndexDatabasePath);
                    return await external.run(args, options);
                },
            },
        });
        equal(await readFile(source, "utf8"), "returning bytes");
        ok(resolveProjectRuntimeLayout(root).primary.internalRoot === layout.primary.internalRoot);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
