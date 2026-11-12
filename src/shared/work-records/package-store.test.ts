import { withRetainedPlanFixture } from "../testing/retained-plan-fixture.ts";
import { test } from "node:test";
import { equal, ok, rejects } from "node:assert/strict";
import fs from "node:fs/promises";
import { basename, join } from "node:path";
import { packageFixture, create, read } from "../testing/plan-package-fixture.ts";
import { withPlanAccess, selectPlanAccess } from "../../plan-store/index.ts";
import { runWorkRecordBackfill } from "./generation.js";
import { loadArchivedPlan } from "../../plan-store/index.ts";
import { withWorkRecordOwner, workRecordOwnerLayout, withWorkRecordMutation } from "./owner.ts";
import { writeWorkRecord, listWorkRecords, readWorkRecord, replaceWorkRecord, deleteWorkRecord } from "./store.ts";
import { recordAttrs, recordBody } from "./test-fixtures/package-records.ts";
import { formatWorkRecordMarkdown } from "./markdown.js";
import { applyWorkRecordSupersession } from "./supersession.ts";
import { createWorkRecordMnemotecaFixture } from "./test-fixtures/mnemoteca-port.ts";
import { importPlans } from "../../plan-store/index.ts";
import { retryWorkRecordForPlan } from "./auto-generation.ts";

for (const operation of ["retry", "backfill"] as const) {
    test(`admitted ${operation} refuses a verified import without retained publication evidence`, async () => {
        const f = await packageFixture();
        try {
            const path = join(f.root, "docs/plans/imported.md");
            await fs.mkdir(join(f.root, "docs/plans"), { recursive: true });
            await fs.writeFile(
                path,
                `---
planId: imported-plan
classification: PLANNED_CHANGE
status: verified
---
# Imported outcome

Mutable live prose.
`,
            );
            equal((await importPlans(f.root, path)).kind, "committed");
            const plan = await read(f.identity, "imported-plan");
            equal(plan.metadata.definition.status, "verified");
            const port = createWorkRecordMnemotecaFixture();
            await withPlanAccess(f.root, (await selectPlanAccess(f.root, plan.metadata.planId))!, async () => {
                const options = {
                    mnemotecaPort: port,
                    runRecorderStep: () => Promise.resolve({ title: "Unproved outcome", summary: "Live content." }),
                };
                const result =
                    operation === "retry"
                        ? await retryWorkRecordForPlan({ cwd: f.root, planName: "imported", ...options })
                        : (await runWorkRecordBackfill(f.root, options)).outcomes[0];
                equal(result?.status, "failed", JSON.stringify(result));
                ok(result.error?.includes("retained publication source"), JSON.stringify(result));
                equal((await listWorkRecords(f.root, { createDir: false })).length, 0);
                equal(port.snapshot().length, 0);
            });
            equal((await read(f.identity, "imported-plan")).metadata.workflow?.workRecord, undefined);
        } finally {
            await f.cleanup();
        }
    });
}

test("admitted backfill excludes repository archives while legacy backfill retains their ownership", async () => {
    const f = await packageFixture();
    try {
        const plan = await create(f.identity, {
            definition: { classification: "PLANNED_CHANGE", status: "draft" },
        });
        const archivePath = join(f.root, "docs/plans/archived/legacy.md");
        const archive = `---
planId: plan-one
classification: PLANNED_CHANGE
status: verified
archivedAt: "2026-11-01T00:00:00.000Z"
---
# Edited repository archive

Untrusted archive prose.
`;
        await fs.mkdir(join(f.root, "docs/plans/archived"), { recursive: true });
        await fs.writeFile(archivePath, archive);
        const port = createWorkRecordMnemotecaFixture();
        const options = {
            mnemotecaPort: port,
            runRecorderStep: () => Promise.resolve({ title: "Legacy outcome", summary: "Legacy archive outcome." }),
        };
        await withPlanAccess(f.root, (await selectPlanAccess(f.root, plan.metadata.planId))!, async () => {
            const result = await runWorkRecordBackfill(f.root, options);
            equal((await listWorkRecords(f.root, { createDir: false })).length, 0);
            equal(port.snapshot().length, 0);
            equal(result.outcomes.length, 0, JSON.stringify(result.outcomes));
            equal(
                result.sources.some((source) => source.sourceKind === "archived"),
                false,
            );
        });
        equal(await fs.readFile(archivePath, "utf8"), archive);
        equal((await runWorkRecordBackfill(f.root, options)).outcomes.length, 0);
        await withRetainedPlanFixture(f.root, async () => {
            const legacy = await runWorkRecordBackfill(f.root, options);
            equal(legacy.outcomes.length, 1);
            equal(legacy.outcomes[0].status, "generated", JSON.stringify(legacy.outcomes));
            const record = (await listWorkRecords(f.root))[0];
            ok(record.path.startsWith(join(f.root, "docs/work-records/")));
            equal((await loadArchivedPlan(f.root, "legacy"))?.attrs.workRecord?.recordId, record.attrs.recordId);
        });
        await withWorkRecordOwner(f.root, f.identity, async () => {
            equal((await listWorkRecords(f.root, { createDir: false })).length, 0);
        });
    } finally {
        await f.cleanup();
    }
});

test("ordinary canonical mutations ignore retained repository copies", async () => {
    const f = await packageFixture();
    try {
        const legacy = await withRetainedPlanFixture(f.root, () => writeWorkRecord(f.root, recordAttrs(), recordBody));
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
