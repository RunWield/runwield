import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { recordingFixture } from "./testing/package-recording-fixture.ts";
import { listWorkRecords } from "../work-records/store.ts";
import { git } from "../git-test-fixture.ts";
import { filterWorkRecordsForList } from "../work-records/list.ts";
import { searchWorkRecords } from "../work-records/search.ts";
import { createWorkRecordMnemotecaFixture } from "../work-records/test-fixtures/mnemoteca-port.ts";
import { writeWorkRecord, findWorkRecordById } from "../work-records/store.ts";
import { recordAttrs, recordBody } from "../work-records/test-fixtures/package-records.ts";
import { readWorkRecordLocations } from "../work-records/import.ts";

for (const boundary of ["locations", "supersession", "before_approval", "approval"]) {
    test(`interrupted ${boundary} never exposes a successor before all declared relationships settle`, async () => {
        const predecessors: string[] = [crypto.randomUUID(), crypto.randomUUID()];
        const f = await recordingFixture(undefined, undefined, false, predecessors);
        try {
            await f.scope(async () => {
                for (const recordId of predecessors)
                    await writeWorkRecord(f.root, recordAttrs({ recordId }), recordBody);
            });
            const stopped = await f.validate({ boundary });
            equal(stopped.code, 86, stopped.text);
            const target = await git(f.remote, ["rev-parse", "main"]);
            const [successorId] = await f.recorderIds();
            await f.scope(async () => {
                const records = await listWorkRecords(f.root);
                const predecessorRecords = records.filter((record) => predecessors.includes(record.attrs.recordId));
                const relationshipsSettled = predecessorRecords.every(
                    (record) => record.attrs.status === "superseded" && record.attrs.supersededBy === successorId,
                );
                const current = filterWorkRecordsForList(records);
                const found = await searchWorkRecords(f.root, "outcome", {
                    mnemotecaPort: createWorkRecordMnemotecaFixture(),
                });
                equal(found.bootstrapped, true);
                if (!relationshipsSettled) {
                    equal(
                        current.some((record) => record.attrs.recordId === successorId),
                        false,
                    );
                    equal(
                        found.records.some((record) => record.recordId === successorId),
                        false,
                    );
                }
                if (current.some((record) => record.attrs.recordId === successorId)) {
                    ok(relationshipsSettled);
                    equal((await readWorkRecordLocations(successorId))?.locations.length, 1);
                }
            });
            const resumed = await f.validate();
            equal(resumed.code, 0, resumed.text);
            equal(resumed.outcome?.kind, "verified", resumed.text);
            await f.scope(async () => {
                const records = filterWorkRecordsForList(await listWorkRecords(f.root));
                equal(records.length, 1);
                equal(records[0].attrs.recordId, successorId);
                for (const id of predecessors)
                    equal((await findWorkRecordById(f.root, id))?.attrs.supersededBy, successorId);
                const found = await searchWorkRecords(f.root, "outcome", {
                    mnemotecaPort: createWorkRecordMnemotecaFixture(),
                });
                equal(found.records.length, 1);
                equal(found.records[0].recordId, successorId);
            });
            equal(await f.turns(), 1);
            equal(await git(f.remote, ["rev-parse", "main"]), target);
        } finally {
            await f.cleanup();
        }
    });
}

test("interrupted declared supersession preserves a later explicit relationship and editor body", async () => {
    const predecessorId = crypto.randomUUID();
    const f = await recordingFixture(undefined, undefined, false, [predecessorId]);
    try {
        await f.scope(async () => {
            const { writeWorkRecord } = await import("../work-records/store.ts");
            const { recordAttrs, recordBody } = await import("../work-records/test-fixtures/package-records.ts");
            await writeWorkRecord(f.root, recordAttrs({ recordId: predecessorId }), recordBody);
        });
        const stopped = await f.validate({ boundary: "supersession" });
        equal(stopped.code, 86, stopped.text);
        const head = await git(f.remote, ["rev-parse", "main"]);
        await f.scope(async () => {
            const { writeWorkRecord, replaceWorkRecord, findWorkRecordById } = await import("../work-records/store.ts");
            const { recordAttrs, recordBody } = await import("../work-records/test-fixtures/package-records.ts");
            const { formatWorkRecordMarkdown } = await import("../work-records/markdown.js");
            const later = await writeWorkRecord(f.root, recordAttrs(), recordBody);
            const predecessor = await findWorkRecordById(f.root, predecessorId);
            ok(predecessor);
            await replaceWorkRecord(
                f.root,
                predecessor,
                formatWorkRecordMarkdown(
                    { ...predecessor.attrs, supersededBy: later.attrs.recordId },
                    predecessor.body + "\nLater editor note.\n",
                ),
            );
            const { retryWorkRecordForPlan } = await import("../work-records/auto-generation.ts");
            const { createWorkRecordMnemotecaFixture } =
                await import("../work-records/test-fixtures/mnemoteca-port.ts");
            const result = await retryWorkRecordForPlan({
                cwd: f.root,
                planName: "one",
                mnemotecaPort: createWorkRecordMnemotecaFixture(),
                runRecorderStep: () => Promise.reject(new Error("Settlement must reuse accepted output")),
            });
            equal(result.status, "linked", JSON.stringify(result));
            const preserved = await findWorkRecordById(f.root, predecessorId);
            equal(preserved?.attrs.supersededBy, later.attrs.recordId);
            ok(preserved?.body.includes("Later editor note."));
            equal((await listWorkRecords(f.root)).length, 3);
        });
        equal(await git(f.remote, ["rev-parse", "main"]), head);
        equal(await f.turns(), 1);
    } finally {
        await f.cleanup();
    }
});
