import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import process from "node:process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { ok as assert, rejects } from "node:assert/strict";
import { assertEquals } from "../../testing/assertions.ts";
import { defineCommittedGitFixture } from "../git-test-fixture.ts";
import { configureRemotePersonalResources } from "../remote/personal-resources.ts";
import { resolveProjectRuntimeLayout } from "../project-runtime-layout.ts";
import { restoreWorkRecordDocument } from "./store.ts";
import { rebuildWorkRecordIndex, runMnemotecaWorkRecordCommand, syncWorkRecordToIndex } from "./index-adapter.ts";
import { searchWorkRecords } from "./search.ts";
import { createWorkRecordMnemotecaFixture } from "./test-fixtures/mnemoteca-port.ts";
import { SYSTEM_WORK_RECORD_MNEMOTECA_PORT, type WorkRecordMnemotecaCommandOptions } from "./mnemoteca-port.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { installMemoryProcessFixture } from "../remote/memory-process-fixture.ts";
import { withRetainedPlanFixture } from "../testing/retained-plan-fixture.ts";

const fixture = defineCommittedGitFixture();

test("retained remote Work Record rebuild, search, and sync use only the project-internal database", () =>
    withProcessGlobalTestLock(async () => {
        const root = await fixture.checkout();
        const mount = await mkdtemp(join(tmpdir(), "remote-work-record-index-"));
        const path = process.env["PATH"] || "";
        const personalDatabase = process.env["MNEMOTECA_DB_PATH"];
        const calls: WorkRecordMnemotecaCommandOptions[] = [];
        const external = createWorkRecordMnemotecaFixture();
        const port = {
            run: (args: string[], options?: WorkRecordMnemotecaCommandOptions) => {
                calls.push(options || {});
                return external.run(args, options);
            },
        };
        try {
            configureRemotePersonalResources({
                globalRoot: mount,
                personalOwner: { kind: "managed-remote", identity: "test-laptop" },
            });
            await withRetainedPlanFixture(root, async () => {
                const record = await restoreWorkRecordDocument(
                    root,
                    {
                        kind: "work_record",
                        recordId: crypto.randomUUID(),
                        status: "approved",
                        scope: "planned_change",
                        origin: "internal",
                        provenance: { sourcePlans: [crypto.randomUUID()] },
                        completionMode: "verified",
                        createdAt: "2026-10-01T00:00:00Z",
                    },
                    "# Remote Work\n\n## Summary\n\nDurable knowledge.\n",
                );
                const rebuild = await rebuildWorkRecordIndex(root, { mnemotecaPort: port });
                assertEquals(rebuild.added, 1);
                const search = await searchWorkRecords(root, "knowledge", { mnemotecaPort: port });
                assertEquals(
                    search.records.map((hit) => hit.recordId),
                    [record.attrs.recordId],
                );
                await syncWorkRecordToIndex(root, record, { mnemotecaPort: port });
                const database = resolveProjectRuntimeLayout(root).primary.workRecordIndexDatabasePath;
                assert(calls.length > 0);
                for (const call of calls) assertEquals(call, { cwd: root, env: { MNEMOTECA_DB_PATH: database } });
                assert((await stat(dirname(database))).isDirectory());
                assertEquals(process.env["MNEMOTECA_DB_PATH"], personalDatabase);
                const bin = await installMemoryProcessFixture(mount);
                process.env["PATH"] = `${bin}:${path}`;
                await runMnemotecaWorkRecordCommand(root, ["add", "--name", "derived", "Project-only data"], {
                    mnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
                });
                assert((await stat(database)).isFile());
                const output = await runMnemotecaWorkRecordCommand(root, ["list", "--name", "derived"], {
                    mnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
                });
                assertEquals(output.includes("Project-only data"), true);
                if (personalDatabase) {
                    try {
                        assertEquals((await readFile(personalDatabase, "utf8")).includes("Project-only data"), false);
                    } catch (error) {
                        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
                    }
                }
            });
            const retainedCallCount = calls.length;
            await rejects(rebuildWorkRecordIndex(root, { mnemotecaPort: port }), /Managed Plan owner is unavailable/i);
            await rejects(
                searchWorkRecords(root, "knowledge", { mnemotecaPort: port }),
                /Managed Plan owner is unavailable/i,
            );
            assertEquals(calls.length, retainedCallCount);
        } finally {
            process.env["PATH"] = path;
            await rm(root, { recursive: true });
            await rm(mount, { recursive: true });
        }
    }));
