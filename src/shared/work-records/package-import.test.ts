import { test } from "node:test";
import { equal, rejects, ok } from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { packageFixture } from "../testing/plan-package-fixture.ts";
import { withWorkRecordOwner, workRecordOwnerLayout } from "./owner.ts";
import { importWorkRecords, readWorkRecordLocations } from "./import.ts";
import { listWorkRecords } from "./store.ts";
import { recordAttrs, recordBody } from "./test-fixtures/package-records.ts";
import { formatWorkRecordMarkdown } from "./markdown.js";
import { createWorkRecordMnemotecaFixture } from "./test-fixtures/mnemoteca-port.ts";
import { runWorkRecordsCommand } from "../../cmd/wr/index.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { getCwd } from "../../constants.js";

test("explicit command directory import preserves exact status bytes and repeat identity", async () => {
    await withProcessGlobalTestLock(async () => {
        const f = await packageFixture();
        const before = getCwd();
        try {
            process.chdir(f.root);
            const source = join(f.root, "imports");
            await fs.mkdir(source);
            const markdown = ["approved", "draft", "pending_verification", "superseded"].map((status) =>
                formatWorkRecordMarkdown(
                    recordAttrs({
                        status: status as "approved" | "draft" | "pending_verification" | "superseded",
                        ...(status === "superseded" ? { supersededBy: crypto.randomUUID() } : {}),
                    }),
                    recordBody,
                ),
            );
            markdown.push(formatWorkRecordMarkdown(recordAttrs({ archivedAt: "2026-11-02" }), recordBody));
            for (const [index, text] of markdown.entries()) await fs.writeFile(join(source, `${index}.md`), text);
            await withWorkRecordOwner(f.root, f.identity, async () => {
                const options = { mnemotecaPort: createWorkRecordMnemotecaFixture() };
                await runWorkRecordsCommand(["import", source], options);
                await runWorkRecordsCommand(["import", source], options);
                const records = await listWorkRecords(f.root);
                equal(records.length, 5);
                for (const record of records) {
                    ok(markdown.includes(record.markdown));
                    const evidence = await readWorkRecordLocations(record.attrs.recordId);
                    equal(evidence?.locations.length, 1);
                    equal(evidence?.locations[0].repositoryId, f.identity.repositoryId);
                    equal(await fs.readFile(evidence!.locations[0].sourcePath, "utf8"), record.markdown);
                }
            });
        } finally {
            process.chdir(before);
            await f.cleanup();
        }
    });
});

test("imports preserve canonical bytes through conflicts, collisions and metadata interruption", async () => {
    const f = await packageFixture();
    const external = await fs.mkdtemp(join(f.root, "../external-import-"));
    try {
        await withWorkRecordOwner(f.root, f.identity, async () => {
            const options = { mnemotecaPort: createWorkRecordMnemotecaFixture() };
            const path = join(external, "record.md");
            const attrs = recordAttrs();
            const text = formatWorkRecordMarkdown(attrs, recordBody);
            await fs.writeFile(path, text);
            const [first] = await importWorkRecords(f.root, path, options);
            const ledger = join(workRecordOwnerLayout()!.internal, "locations", `${attrs.recordId}.json`);
            await fs.unlink(ledger); // Same state as interruption after canonical publication.
            await importWorkRecords(f.root, path, options);
            equal((await listWorkRecords(f.root)).length, 1);
            equal((await readWorkRecordLocations(attrs.recordId))!.locations[0].repositoryPath, undefined);
            await fs.writeFile(path, formatWorkRecordMarkdown(attrs, recordBody + "Editor change\n"));
            await rejects(() => importWorkRecords(f.root, path, options), /Conflicting content/);
            equal(await fs.readFile(first.record.path, "utf8"), text);
            await fs.writeFile(path, formatWorkRecordMarkdown(recordAttrs(), recordBody));
            await importWorkRecords(f.root, path, options);
            equal((await listWorkRecords(f.root)).length, 2);
            await fs.writeFile(path, "malformed");
            await rejects(() => importWorkRecords(f.root, path, options), /record.md/);
            const link = join(external, "link.md");
            await fs.symlink(first.record.path, link);
            await rejects(() => importWorkRecords(f.root, link, options), /Symbolic link/);
            equal(await fs.readFile(first.record.path, "utf8"), text);
        });
    } finally {
        await fs.rm(external, { recursive: true, force: true });
        await f.cleanup();
    }
});

test("a fresh process resumes import after canonical publication and before location settlement", async () => {
    const f = await packageFixture();
    try {
        const path = join(f.root, "import.md");
        const attrs = recordAttrs({ status: "pending_verification" });
        const text = formatWorkRecordMarkdown(attrs, recordBody);
        await fs.writeFile(path, text);
        const { captureForegroundProcess } = await import("../captured-process.ts");
        const invoke = (interrupt = false) =>
            captureForegroundProcess(process.execPath, {
                cwd: f.root,
                args: [
                    new URL("./test-fixtures/package-record-process.ts", import.meta.url).pathname,
                    JSON.stringify({ identity: f.identity, path, interrupt }),
                ],
            });
        equal((await invoke(true)).code, 86);
        const resumed = await invoke();
        equal(resumed.code, 0, new TextDecoder().decode(resumed.stderr));
        await withWorkRecordOwner(f.root, f.identity, async () => {
            const records = await listWorkRecords(f.root);
            equal(records.length, 1);
            equal(records[0].markdown, text);
            equal((await readWorkRecordLocations(attrs.recordId))?.locations.length, 1);
        });
        equal(await fs.readFile(path, "utf8"), text);
    } finally {
        await f.cleanup();
    }
});
