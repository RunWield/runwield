import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { packageFixture } from "../testing/plan-package-fixture.ts";
import { withWorkRecordOwner } from "./owner.ts";
import { writeWorkRecord, replaceWorkRecord } from "./store.ts";
import { recordAttrs, recordBody } from "./test-fixtures/package-records.ts";
import { formatWorkRecordMarkdown } from "./markdown.js";
import { getWorkRecordIndexCollectionName, rebuildWorkRecordIndex } from "./index-adapter.ts";
import { searchWorkRecords } from "./search.ts";
import { createWorkRecordMnemotecaFixture } from "./test-fixtures/mnemoteca-port.ts";
import { admitProjectIdentity } from "../project-identity.ts";

test("index rebuild and stale candidates hydrate canonical status and absolute paths after a Project move", async () => {
    const f = await packageFixture();
    const moved = `${f.root}-renamed`;
    try {
        const port = createWorkRecordMnemotecaFixture();
        const options = { mnemotecaPort: port };
        let collection = "";
        let recordId = "";
        await withWorkRecordOwner(f.root, f.identity, async () => {
            const record = await writeWorkRecord(f.root, recordAttrs(), recordBody);
            recordId = record.attrs.recordId;
            collection = await getWorkRecordIndexCollectionName(f.root);
            await rebuildWorkRecordIndex(f.root, options);
            const found = await searchWorkRecords(f.root, "Canonical", options);
            equal(found.records[0].path, record.path);
            await replaceWorkRecord(
                f.root,
                record,
                formatWorkRecordMarkdown({ ...record.attrs, archivedAt: "2026-11-02" }, record.body),
            );
            equal((await searchWorkRecords(f.root, "Canonical", options)).records.length, 0);
        });
        await fs.rename(f.root, moved);
        const admitted = await admitProjectIdentity(moved);
        ok(admitted.kind === "existing");
        await withWorkRecordOwner(moved, admitted.identity, async () => {
            equal(await getWorkRecordIndexCollectionName(moved), collection);
            const fresh = { mnemotecaPort: createWorkRecordMnemotecaFixture() };
            await rebuildWorkRecordIndex(moved, fresh);
            const result = await searchWorkRecords(moved, "Canonical", { ...fresh, accessMode: "all" });
            equal(result.records[0].recordId, recordId);
            ok(result.records[0].notices.length);
            ok(!result.records[0].path.startsWith(join(moved, "docs")));
        });
    } finally {
        await fs.rm(moved, { recursive: true, force: true });
        await f.cleanup();
    }
});

test("accepted linked clones share record identity while unrelated Projects stay isolated", async () => {
    const f = await packageFixture();
    const clone = `${f.root}-clone`;
    const unrelated = await packageFixture();
    try {
        const { git } = await import("../git-test-fixture.ts");
        await git(f.root, ["remote", "add", "origin", "https://example.test/shared/project.git"]);
        await admitProjectIdentity(f.root);
        await git(f.root, ["clone", f.root, clone]);
        await git(clone, ["remote", "set-url", "origin", "https://example.test/shared/project.git"]);
        const pending = await admitProjectIdentity(clone);
        ok(pending.kind === "pending");
        const admitted = await admitProjectIdentity(clone, {
            choice: { kind: "link", candidates: pending.candidates, projectId: f.identity.projectId },
        });
        ok(admitted.kind === "existing");
        let recordId = "";
        let collection = "";
        await withWorkRecordOwner(f.root, f.identity, async () => {
            recordId = (await writeWorkRecord(f.root, recordAttrs(), recordBody)).attrs.recordId;
            collection = await getWorkRecordIndexCollectionName(f.root);
        });
        await withWorkRecordOwner(clone, admitted.identity, async () => {
            equal(await getWorkRecordIndexCollectionName(clone), collection);
            const { findWorkRecordById } = await import("./store.ts");
            equal((await findWorkRecordById(clone, recordId))?.attrs.recordId, recordId);
            await git(clone, ["remote", "set-url", "origin", "https://example.test/changed.git"]);
            equal(await getWorkRecordIndexCollectionName(clone), collection);
        });
        await withWorkRecordOwner(unrelated.root, unrelated.identity, async () => {
            ok((await getWorkRecordIndexCollectionName(unrelated.root)) !== collection);
            const { findWorkRecordById } = await import("./store.ts");
            equal(await findWorkRecordById(unrelated.root, recordId), null);
        });
    } finally {
        await fs.rm(clone, { recursive: true, force: true });
        await unrelated.cleanup();
        await f.cleanup();
    }
});
