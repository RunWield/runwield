import { deepEqual, equal, notEqual, ok, rejects } from "node:assert/strict";
import { copyFile, mkdir, stat, symlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { packageFixture } from "../shared/testing/plan-package-fixture.ts";
import { withRetainedPlanFixture } from "../shared/testing/retained-plan-fixture.ts";
import { workRecordFiles } from "@runwield/plans/work-record-files";
import { withWorkRecordOwner } from "../shared/work-records/owner.ts";
import { restoreWorkRecordDocument } from "../shared/work-records/store.ts";
import { recordAttrs, recordBody } from "../shared/work-records/test-fixtures/package-records.ts";
import { openProjectPlanStore } from "./index.ts";
import { withPackageProject } from "./workflows.ts";

test("project Work Record reads stay passive and resolve the same record ID within each owner", async () => {
    const first = await packageFixture();
    const second = await packageFixture();
    try {
        const records = openProjectPlanStore(first.identity.projectId, { admitted: first.identity }).workRecords;
        const other = openProjectPlanStore(second.identity.projectId, { admitted: second.identity }).workRecords;
        const attrs = recordAttrs();
        const directory = workRecordFiles.forOwner(first.identity).layout.records;
        deepEqual(await records.list(), []);
        equal(await records.read(attrs.recordId), null);
        await rejects(stat(directory), { code: "ENOENT" });

        const written = await withWorkRecordOwner(first.root, first.identity, () =>
            restoreWorkRecordDocument(first.root, attrs, recordBody),
        );
        const elsewhere = await withWorkRecordOwner(second.root, second.identity, () =>
            restoreWorkRecordDocument(
                second.root,
                { ...attrs, archivedAt: "2026-11-12" },
                recordBody.replace("Durable outcome", "Another Project"),
            ),
        );
        const record = await records.read(attrs.recordId.toUpperCase());
        ok(record);
        equal(record.markdown, written.markdown);
        equal(record.relativePath, `work-records/${basename(written.path)}`);
        ok(!("path" in record));
        deepEqual(await records.list(), [record]);
        equal((await other.read(attrs.recordId))?.markdown, elsewhere.markdown);

        await copyFile(written.path, join(dirname(written.path), "duplicate.md"));
        equal((await records.list()).length, 2);
        await rejects(records.read(attrs.recordId), /ambiguous/i);
        equal((await other.read(attrs.recordId))?.title, "Another Project");
    } finally {
        await Promise.all([first.cleanup(), second.cleanup()]);
    }
});

test("an explicit retained Work Record read sees its checkout under an ambient canonical Project", async () => {
    const fixture = await packageFixture();
    try {
        const records = openProjectPlanStore(fixture.identity.projectId, { admitted: fixture.identity }).workRecords;
        const attrs = recordAttrs();
        await withWorkRecordOwner(fixture.root, fixture.identity, () =>
            restoreWorkRecordDocument(fixture.root, attrs, recordBody),
        );
        await withRetainedPlanFixture(fixture.root, async () => {
            const retained = await restoreWorkRecordDocument(
                fixture.root,
                attrs,
                recordBody.replace("Durable outcome", "Retained outcome"),
            );
            await withPackageProject(fixture.root, fixture.identity, async () => {
                const result = await records.read(attrs.recordId);
                equal(result?.markdown, retained.markdown);
                equal(result?.relativePath, `docs/work-records/${basename(retained.path)}`);
            });
        });
        equal((await records.read(attrs.recordId))?.title, "Durable outcome");
    } finally {
        await fixture.cleanup();
    }
});

test("Project Work Record diagnostics describe a rejected link without exposing the owner's directory", async () => {
    const fixture = await packageFixture();
    try {
        const records = openProjectPlanStore(fixture.identity.projectId, { admitted: fixture.identity }).workRecords;
        const directory = workRecordFiles.forOwner(fixture.identity).layout.records;
        await mkdir(dirname(directory), { recursive: true });
        await symlink(fixture.root, directory, "dir");
        const diagnostic = (error: Error) =>
            error.message === "Work Record path contains a symbolic link." && error.cause === undefined;
        await rejects(records.list(), diagnostic);
        await rejects(records.read("missing"), diagnostic);
    } finally {
        await fixture.cleanup();
    }
});

test("the bound store assigns independent Work Record identities and returns the persisted documents", async () => {
    const fixture = await packageFixture();
    try {
        const records = openProjectPlanStore(fixture.identity.projectId, { admitted: fixture.identity }).workRecords;
        const { status, scope, origin, completionMode, provenance } = recordAttrs();
        const input = { status, scope, origin, completionMode, provenance, body: recordBody };
        const [first, second] = await Promise.all([records.create(input), records.create(input)]);
        notEqual(first.attrs.recordId, second.attrs.recordId);
        notEqual(first.relativePath, second.relativePath);
        for (const record of [first, second]) {
            ok(record.attrs.recordId);
            ok(!("path" in record));
            deepEqual(await records.read(record.attrs.recordId), record);
        }
        equal((await records.list()).length, 2);
    } finally {
        await fixture.cleanup();
    }
});
