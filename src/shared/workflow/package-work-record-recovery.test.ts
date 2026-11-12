import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { recordingFixture } from "./testing/package-recording-fixture.ts";
import { read } from "../testing/plan-package-fixture.ts";
import { readPlanPackagePublication } from "../../plan-store/packages.ts";
import { listWorkRecords } from "../work-records/store.ts";
import { withWorkRecordOwner } from "../work-records/owner.ts";
import { git } from "../git-test-fixture.ts";
import { setExactProjectCustomSetting } from "../settings.js";
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

for (const boundary of [
    "source",
    "sections",
    "pending",
    "backlink",
    "manifest",
    "approval",
    "locations",
    "settled",
    "index",
]) {
    test(`fresh validation resumes after durable ${boundary} without a second accepted Recorder output`, async () => {
        const f = await recordingFixture();
        try {
            const stopped = await f.validate({ boundary });
            equal(stopped.code, 86, stopped.text);
            const count = await f.turns();
            const target = await git(f.remote, ["rev-parse", "main"]);
            setExactProjectCustomSetting("plans", { deliveryCopies: true }, f.root);
            setExactProjectCustomSetting("workRecords", { deliveryCopies: false }, f.root);
            await fs.writeFile(join(f.p.path, "context.md"), "# Later editor prose\n");
            const resumed = await f.validate();
            equal(resumed.code, 0, resumed.text);
            equal(resumed.outcome?.kind, "verified", resumed.text);
            equal(await f.turns(), boundary === "source" ? count + 1 : count);
            const receipt = (await read(f.identity)).metadata.workflow!.delivery!;
            const manifest = await readPlanPackagePublication(f.identity, receipt.source);
            equal(manifest.planCopies, false);
            equal(manifest.workRecordCopies, true);
            equal(await fs.readFile(join(f.p.path, "context.md"), "utf8"), "# Later editor prose\n");
            await withWorkRecordOwner(f.root, f.identity, async () => {
                const records = await listWorkRecords(f.root);
                equal(records.length, 1);
                equal(records[0].attrs.status, "approved");
                equal(records[0].attrs.recordId, (await f.recorderIds())[0]);
            });
            equal(
                (await git(f.remote, ["log", "--format=%B", "main"])).split("RunWield-Publication-Attempt:").length - 1,
                1,
            );
            if (["approval", "locations", "settled", "index"].includes(boundary))
                equal(await git(f.remote, ["rev-parse", "main"]), target);
        } finally {
            await f.cleanup();
        }
    });
}

test("a failed Recorder leaves no copy and backfill after cleanup uses retained source without Git changes", async () => {
    const f = await recordingFixture();
    try {
        const result = await f.validate({ failRecorder: true });
        equal(result.code, 0, result.text);
        equal(result.outcome?.kind, "verified", result.text);
        const receipt = (await read(f.identity)).metadata.workflow!.delivery!;
        const manifest = await readPlanPackagePublication(f.identity, receipt.source);
        equal(manifest.preparedRecord, undefined);
        equal(manifest.copies.length, 0);
        const head = await git(f.remote, ["rev-parse", "main"]);
        await fs.writeFile(join(f.p.path, "context.md"), "# New live Plan\n");
        await f.scope(async () => {
            const { runWorkRecordBackfill } = await import("../work-records/generation.js");
            const { createWorkRecordMnemotecaFixture } =
                await import("../work-records/test-fixtures/mnemoteca-port.ts");
            const backfill = await runWorkRecordBackfill(f.root, {
                mnemotecaPort: createWorkRecordMnemotecaFixture(),
                runRecorderStep: (prompt) => {
                    ok(prompt.includes("Prose — 世界"));
                    return Promise.resolve({ title: "Late outcome", summary: "Retained delivery." });
                },
            });
            equal(backfill.outcomes.length, 1);
            equal(backfill.outcomes[0].status, "generated", JSON.stringify(backfill.outcomes));
            equal((await listWorkRecords(f.root))[0].attrs.status, "approved");
        });
        equal(await git(f.remote, ["rev-parse", "main"]), head);
    } finally {
        await f.cleanup();
    }
});

test("pending records require proof and no-copy recovery survives execution cleanup and later edits", async () => {
    const f = await recordingFixture({ plans: false, workRecords: false });
    try {
        const pending = await f.validate({ boundary: "pending" });
        equal(pending.code, 86, pending.text);
        await withWorkRecordOwner(f.root, f.identity, async () => {
            const records = await listWorkRecords(f.root);
            equal(records.length, 1);
            equal(records[0].attrs.status, "pending_verification");
            const { searchWorkRecords } = await import("../work-records/search.ts");
            const { createWorkRecordMnemotecaFixture } =
                await import("../work-records/test-fixtures/mnemoteca-port.ts");
            equal(
                (await searchWorkRecords(f.root, "Recorded", { mnemotecaPort: createWorkRecordMnemotecaFixture() }))
                    .records.length,
                0,
            );
        });
        const stopped = await f.validate({ boundary: "approval" });
        equal(stopped.code, 86, stopped.text);
        const head = await git(f.remote, ["rev-parse", "main"]);
        await git(f.root, ["worktree", "remove", "--force", f.workflow.executionCwd!]);
        await f.scope(async () => {
            const { replaceWorkRecord } = await import("../work-records/store.ts");
            const { formatWorkRecordMarkdown } = await import("../work-records/markdown.js");
            const record = (await listWorkRecords(f.root))[0];
            await replaceWorkRecord(
                f.root,
                record,
                formatWorkRecordMarkdown(
                    { ...record.attrs, archivedAt: "2026-11-03" },
                    record.body + "\nEditor note.\n",
                ),
            );
            const { recordPlanEvent } = await import("./plan-lifecycle.js");
            await recordPlanEvent({
                cwd: f.root,
                planName: "one",
                event: "review_reopened",
                currentStatus: "verified",
            });
        });
        // Explicit recording retry follows the retained receipt even though the Plan was reopened.
        await f.scope(async () => {
            const { retryWorkRecordForPlan } = await import("../work-records/auto-generation.ts");
            const { createWorkRecordMnemotecaFixture } =
                await import("../work-records/test-fixtures/mnemoteca-port.ts");
            const result = await retryWorkRecordForPlan({
                cwd: f.root,
                planName: "one",
                mnemotecaPort: createWorkRecordMnemotecaFixture(),
                runRecorderStep: () => Promise.reject(new Error("Accepted Recorder output must be reused")),
            });
            equal(result.status, "linked", JSON.stringify(result));
            const record = (await listWorkRecords(f.root))[0];
            equal(record.attrs.archivedAt, "2026-11-03");
            ok(record.body.includes("Editor note."));
        });
        equal((await read(f.identity)).metadata.definition.status, "draft");
        equal(await git(f.remote, ["rev-parse", "main"]), head);
    } finally {
        await f.cleanup();
    }
});

test("pending retry refuses lost target proof and damaged retained input, then recovers from restored evidence", async () => {
    const f = await recordingFixture({ plans: false, workRecords: false });
    try {
        const original = await git(f.remote, ["rev-parse", "main"]);
        const stopped = await f.validate({ boundary: "before_approval" });
        equal(stopped.code, 86, stopped.text);
        const delivered = await git(f.remote, ["rev-parse", "main"]);
        await f.scope(async () => {
            const { retryWorkRecordForPlan } = await import("../work-records/auto-generation.ts");
            const { loadPublishedWorkRecordSource } = await import("../../plan-store/index.ts");
            const { createWorkRecordMnemotecaFixture } =
                await import("../work-records/test-fixtures/mnemoteca-port.ts");
            const args = {
                cwd: f.root,
                planName: "one",
                mnemotecaPort: createWorkRecordMnemotecaFixture(),
                runRecorderStep: () => Promise.reject(new Error("Accepted output must be reused")),
            };
            equal((await listWorkRecords(f.root))[0].attrs.status, "pending_verification");
            await git(f.remote, ["update-ref", "refs/heads/main", original]);
            const refused = await retryWorkRecordForPlan(args);
            equal(refused.status, "failed", JSON.stringify(refused));
            equal((await listWorkRecords(f.root))[0].attrs.status, "pending_verification");
            await git(f.remote, ["update-ref", "refs/heads/main", delivered]);
            const source = await loadPublishedWorkRecordSource(f.root, "one");
            ok(source);
            const bytes = await fs.readFile(source.path);
            await fs.writeFile(source.path, "damaged retained input");
            equal((await retryWorkRecordForPlan(args)).status, "failed");
            equal((await listWorkRecords(f.root))[0].attrs.status, "pending_verification");
            await fs.writeFile(source.path, bytes);
            const recovered = await retryWorkRecordForPlan(args);
            equal(recovered.status, "linked", JSON.stringify(recovered));
            const records = await listWorkRecords(f.root);
            equal(records.length, 1);
            equal(records[0].attrs.status, "approved");
            equal(recovered.path, records[0].path);
        });
        equal(await git(f.remote, ["rev-parse", "main"]), delivered);
        equal(await f.turns(), 1);
    } finally {
        await f.cleanup();
    }
});

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
