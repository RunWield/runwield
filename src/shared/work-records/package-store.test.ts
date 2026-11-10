import { test } from "node:test";
import { equal, ok, rejects } from "node:assert/strict";
import fs from "node:fs/promises";
import { basename, join } from "node:path";
import { packageFixture } from "../testing/plan-package-fixture.ts";
import { withWorkRecordOwner, workRecordOwnerLayout, withWorkRecordMutation } from "./owner.ts";
import { writeWorkRecord, listWorkRecords, readWorkRecord, replaceWorkRecord, deleteWorkRecord } from "./store.ts";
import { recordAttrs, recordBody } from "./test-fixtures/package-records.ts";
import { formatWorkRecordMarkdown } from "./markdown.js";
import { applyWorkRecordSupersession } from "./supersession.ts";
import { createWorkRecordMnemotecaFixture } from "./test-fixtures/mnemoteca-port.ts";

test("admitted canonical mutations ignore repository copies and ordinary calls remain legacy", async () => {
    const f = await packageFixture();
    try {
        const legacy = await writeWorkRecord(f.root, recordAttrs(), recordBody);
        await withWorkRecordOwner(f.root, f.identity, async () => {
            equal((await listWorkRecords(f.root, { createDir: false })).length, 0);
            const record = await writeWorkRecord(f.root, recordAttrs(), recordBody);
            ok(record.path.startsWith(workRecordOwnerLayout()!.records));
            await fs.writeFile(legacy.path, "poisoned repository copy");
            equal((await readWorkRecord(f.root, basename(record.path))).markdown, record.markdown);
            const replaced = await replaceWorkRecord(
                f.root,
                record,
                formatWorkRecordMarkdown({ ...record.attrs, archivedAt: "2026-11-02" }, record.body),
            );
            equal(replaced.body, record.body);
            const { formatWorkRecordListEntry } = await import("./list.ts");
            ok(formatWorkRecordListEntry(replaced).includes(`path: ${replaced.path}`));
            await rejects(() => writeWorkRecord(f.root, record.attrs, recordBody), /identity already exists/);
            await deleteWorkRecord(f.root, replaced);
            equal((await listWorkRecords(f.root)).length, 0);
        });
        equal(await fs.readFile(legacy.path, "utf8"), "poisoned repository copy");
    } finally {
        await f.cleanup();
    }
});

test("foreign owner and symbolic links cannot redirect admitted writes", async () => {
    const f = await packageFixture();
    try {
        await rejects(
            () =>
                withWorkRecordOwner(
                    f.root,
                    { ...f.identity, personalOwner: { kind: "execution-account", identity: "foreign" } },
                    async () => {},
                ),
            /admission/,
        );
        await withWorkRecordOwner(f.root, f.identity, async () => {
            const dir = workRecordOwnerLayout()!.records;
            await fs.symlink(f.root, dir);
            await rejects(() => writeWorkRecord(f.root, recordAttrs(), recordBody), /symbolic link/);
            equal(await fs.readFile(join(f.root, "README.md"), "utf8"), "package fixture\n");
        });
    } finally {
        await f.cleanup();
    }
});

test("concurrent supersession shares canonical record serialization", async () => {
    const f = await packageFixture();
    try {
        await withWorkRecordOwner(f.root, f.identity, async () => {
            const first = await writeWorkRecord(f.root, recordAttrs(), recordBody);
            const [second, third] = await Promise.all([
                writeWorkRecord(f.root, recordAttrs(), recordBody),
                writeWorkRecord(f.root, recordAttrs(), recordBody),
            ]);
            const outcomes = await Promise.allSettled(
                [second, third].map((record) =>
                    applyWorkRecordSupersession(f.root, {
                        successorRecordId: record.attrs.recordId,
                        predecessorRecordIds: [first.attrs.recordId],
                        mnemotecaPort: createWorkRecordMnemotecaFixture(),
                    }),
                ),
            );
            equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
            const actual = await readWorkRecord(f.root, basename(first.path));
            equal(actual.attrs.status, "superseded");
            ok([second.attrs.recordId, third.attrs.recordId].includes(actual.attrs.supersededBy!));
        });
    } finally {
        await f.cleanup();
    }
});

test("a linked checkout process waits for the shared native record lock", async () => {
    const f = await packageFixture();
    const clone = `${f.root}-clone`;
    try {
        const { git } = await import("../git-test-fixture.ts");
        const { admitProjectIdentity } = await import("../project-identity.ts");
        const { captureForegroundProcess } = await import("../captured-process.ts");
        await git(f.root, ["remote", "add", "origin", "https://example.test/records/shared.git"]);
        await admitProjectIdentity(f.root);
        await git(f.root, ["clone", f.root, clone]);
        await git(clone, ["remote", "set-url", "origin", "https://example.test/records/shared.git"]);
        const pending = await admitProjectIdentity(clone);
        ok(pending.kind === "pending");
        const linked = await admitProjectIdentity(clone, {
            choice: { kind: "link", candidates: pending.candidates, projectId: f.identity.projectId },
        });
        ok(linked.kind === "existing");
        const path = join(clone, "import.md");
        const readyPath = join(clone, "ready");
        await fs.writeFile(path, formatWorkRecordMarkdown(recordAttrs(), recordBody));
        await withWorkRecordOwner(f.root, f.identity, async () => {
            let child: ReturnType<typeof captureForegroundProcess>;
            await withWorkRecordMutation(async () => {
                child = captureForegroundProcess(process.execPath, {
                    cwd: clone,
                    args: [
                        new URL("./test-fixtures/package-record-process.ts", import.meta.url).pathname,
                        JSON.stringify({ identity: linked.identity, path, readyPath }),
                    ],
                });
                const deadline = Date.now() + 10000;
                while (!(await fs.stat(readyPath).catch(() => null))) {
                    if (Date.now() > deadline) throw new Error("Import process did not reach admission");
                    await new Promise((resolve) => setTimeout(resolve, 20));
                }
                equal(
                    await Promise.race([
                        child.then(() => "completed"),
                        new Promise((resolve) => setTimeout(() => resolve("waiting"), 100)),
                    ]),
                    "waiting",
                );
                equal((await listWorkRecords(f.root, { createDir: false })).length, 0);
            });
            const result = await child!;
            equal(result.code, 0, new TextDecoder().decode(result.stderr));
            equal((await listWorkRecords(f.root)).length, 1);
        });
    } finally {
        await fs.rm(clone, { recursive: true, force: true });
        await f.cleanup();
    }
});
