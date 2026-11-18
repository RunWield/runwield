import { withRetainedPlanFixture } from "../testing/retained-plan-fixture.ts";
import { test } from "node:test";
import { deepEqual, equal, ok, rejects } from "node:assert/strict";
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

test("Work Record retention keeps the count floor first and every record inside the age window", async () => {
    const f = await packageFixture();
    try {
        const { previewRecordRetention } = await import("../../plan-store/index.ts");
        const { setCustomSetting } = await import("../settings.js");
        await withWorkRecordOwner(f.root, f.identity, async () => {
            const dir = workRecordOwnerLayout()!.records;
            await fs.mkdir(dir, { recursive: true });
            async function seed(count: number, createdAt: string) {
                await Promise.all(
                    Array.from({ length: count }, async (_, i) => {
                        const attrs = recordAttrs({
                            recordId: `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`,
                            createdAt,
                        });
                        await fs.writeFile(
                            join(dir, `${attrs.recordId}.md`),
                            formatWorkRecordMarkdown(attrs, recordBody),
                        );
                    }),
                );
            }
            await seed(30, "2000-01-01T00:00:00Z");
            equal((await previewRecordRetention(f.root)).due.length, 0);
            await seed(400, new Date().toISOString());
            equal((await previewRecordRetention(f.root)).due.length, 0);
            await setCustomSetting("workRecords", { retentionDays: 0 }, "project", f.root);
            const { due } = await previewRecordRetention(f.root);
            equal(due.length, 300);
            equal(due[0].recordId, "11111111-1111-4111-8111-000000000100");
        });
    } finally {
        await f.cleanup();
    }
});

test("a new Recorder pin survives earlier confirmation and its release restores eligibility", async () => {
    const f = await packageFixture();
    try {
        const { previewRecordRetention, confirmRetention } = await import("../../plan-store/index.ts");
        const { setCustomSetting } = await import("../settings.js");
        const { reservePreparedPackageRecord } = await import("./package-recording.ts");
        await setCustomSetting("workRecords", { retentionDays: 0, retentionKeepLast: 0 }, "project", f.root);
        await withWorkRecordOwner(f.root, f.identity, async () => {
            const reserved = {
                ...(await reservePreparedPackageRecord("recording-fixture")),
                recordId: "abcdefab-1111-4111-8111-111111111111",
            };
            const path = join(workRecordOwnerLayout()!.internal, "preparations", "recording-fixture.json");
            await fs.unlink(path);
            await writeWorkRecord(f.root, recordAttrs({ recordId: reserved.recordId }), recordBody);
            const [approved] = (await previewRecordRetention(f.root)).due;
            await fs.writeFile(path, "");
            await rejects(previewRecordRetention(f.root), /preparation is empty/);
            await rejects(confirmRetention(f.root, "records", approved.token), /preparation is empty/);
            equal((await listWorkRecords(f.root)).length, 1);
            await fs.writeFile(
                path,
                JSON.stringify({
                    ...reserved,
                    recordId: crypto.randomUUID(),
                    sections: {
                        title: "Updated outcome",
                        summary: "Revises the earlier outcome.",
                        supersessionProposals: [{ recordId: reserved.recordId.toUpperCase(), reason: "Revised" }],
                    },
                }),
            );
            equal(await confirmRetention(f.root, "records", approved.token), false);
            await fs.writeFile(path, JSON.stringify(reserved));
            equal(await confirmRetention(f.root, "records", approved.token), false);
            equal((await previewRecordRetention(f.root)).due.length, 0);
            await fs.writeFile(path, JSON.stringify({ ...reserved, settled: true }));
            equal(await confirmRetention(f.root, "records", approved.token), true);
        });
    } finally {
        await f.cleanup();
    }
});

test("retry after canonical unlink clears the old index and copy locations before reimport", async () => {
    const f = await packageFixture();
    try {
        const { previewRecordRetention, confirmRetention } = await import("../../plan-store/index.ts");
        const { setCustomSetting } = await import("../settings.js");
        const { importWorkRecords, readWorkRecordLocations } = await import("./import.ts");
        const options = { mnemotecaPort: createWorkRecordMnemotecaFixture() };
        await setCustomSetting("workRecords", { retentionDays: 0, retentionKeepLast: 0 }, "project", f.root);
        await withWorkRecordOwner(f.root, f.identity, async () => {
            const path = join(f.root, "original.md");
            const attrs = recordAttrs();
            const markdown = formatWorkRecordMarkdown(attrs, recordBody);
            await fs.writeFile(path, markdown);
            const [{ record }] = await importWorkRecords(f.root, path, options);
            const oldLocations = await readWorkRecordLocations(attrs.recordId);
            const [approved] = (await previewRecordRetention(f.root)).due;
            const owner = workRecordOwnerLayout()!;
            const receipts = join(owner.root, "internal", "retention", "records");
            await fs.mkdir(receipts, { recursive: true });
            await fs.writeFile(
                join(receipts, approved.token + ".json"),
                JSON.stringify({
                    projectId: f.identity.projectId,
                    owner: f.identity.personalOwner.identity,
                    repositoryId: f.identity.repositoryId,
                    kind: "records",
                    token: approved.token,
                    identity: attrs.recordId,
                    copies: [],
                    completed: false,
                }),
            );
            await fs.unlink(record.path);
            equal(options.mnemotecaPort.snapshot().length, 1);
            equal(await confirmRetention(f.root, "records", approved.token, options.mnemotecaPort), true);
            equal(await readWorkRecordLocations(attrs.recordId), null);
            equal(options.mnemotecaPort.snapshot().length, 0);
            const replacement = join(f.root, "replacement.md");
            await fs.writeFile(replacement, markdown);
            // A reimport may also be the first writer after the interruption.
            await fs.writeFile(
                join(owner.internal, "locations", attrs.recordId + ".json"),
                JSON.stringify(oldLocations),
            );
            await importWorkRecords(f.root, replacement, options);
            await confirmRetention(f.root, "records", approved.token, options.mnemotecaPort);
            const locations = (await readWorkRecordLocations(attrs.recordId))?.locations;
            equal(locations?.length, 1);
            equal(locations?.[0].sourcePath, replacement);
            equal(options.mnemotecaPort.snapshot().length, 1);
            const [next] = (await previewRecordRetention(f.root)).due;
            await confirmRetention(f.root, "records", next.token, options.mnemotecaPort);
            equal(await fs.readFile(path, "utf8"), markdown);
        });
    } finally {
        await f.cleanup();
    }
});

test(
    "a read-only copy directory still allows the whole confirmed batch to finish",
    { skip: process.platform === "win32" || process.getuid?.() === 0 },
    async () => {
        const f = await packageFixture();
        const directory = join(f.root, "read-only");
        try {
            const { previewRecordRetention, confirmPruneRequest, pendingPruneRequest } =
                await import("../../plan-store/index.ts");
            const { setCustomSetting } = await import("../settings.js");
            const { importWorkRecords } = await import("./import.ts");
            const port = createWorkRecordMnemotecaFixture();
            await setCustomSetting("workRecords", { retentionDays: 0, retentionKeepLast: 0 }, "project", f.root);
            await fs.mkdir(directory);
            await withWorkRecordOwner(f.root, f.identity, async () => {
                const path = join(directory, "copy.md");
                const attrs = recordAttrs({ createdAt: "2001-01-01T00:00:00Z" });
                const markdown = formatWorkRecordMarkdown(attrs, recordBody);
                await fs.writeFile(path, markdown);
                await importWorkRecords(f.root, path, { mnemotecaPort: port });
                await writeWorkRecord(f.root, recordAttrs({ createdAt: "2000-01-01T00:00:00Z" }), recordBody);
                const approved = (await previewRecordRetention(f.root)).due.map(({ recordId, token }) => ({
                    label: recordId,
                    token,
                }));
                equal(approved.length, 2);
                equal(approved[0].label, attrs.recordId);
                await fs.chmod(directory, 0o555);
                try {
                    const result = await confirmPruneRequest(f.root, "records", approved, port);
                    deepEqual(result, { deleted: approved.map((item) => item.label), skipped: [] });
                    equal((await listWorkRecords(f.root)).length, 0);
                    equal(await pendingPruneRequest(f.root, "records"), undefined);
                    equal(await fs.readFile(path, "utf8"), markdown);
                } finally {
                    await fs.chmod(directory, 0o755);
                }
            });
        } finally {
            await f.cleanup();
        }
    },
);

test("interrupted confirmation resumes its original set and skips unsafe, moved or missing copies", async () => {
    const f = await packageFixture();
    try {
        const { previewRecordRetention, confirmPruneRequest, pendingPruneRequest } =
            await import("../../plan-store/index.ts");
        const { setCustomSetting } = await import("../settings.js");
        const { retainWorkRecordLocation, workRecordDigest } = await import("./import.ts");
        const port = createWorkRecordMnemotecaFixture();
        await setCustomSetting("workRecords", { retentionDays: 0, retentionKeepLast: 0 }, "project", f.root);
        await withWorkRecordOwner(f.root, f.identity, async () => {
            const first = await writeWorkRecord(f.root, recordAttrs({ createdAt: "2001-01-01T00:00:00Z" }), recordBody);
            const second = await writeWorkRecord(
                f.root,
                recordAttrs({ createdAt: "2000-01-01T00:00:00Z" }),
                recordBody,
            );
            const outside = join(f.root, "protected.md");
            const decoy = join(f.root, "moved.md");
            await fs.writeFile(outside, first.markdown);
            await fs.writeFile(decoy, first.markdown);
            await fs.symlink(outside, join(f.root, "link.md"));
            const location = {
                kind: "copy" as const,
                repositoryPath: "link.md",
                repositoryId: f.identity.repositoryId,
                sourcePath: join(f.root, "link.md"),
                digest: workRecordDigest(first.markdown),
            };
            await retainWorkRecordLocation(first.attrs.recordId, location);
            const path = join(workRecordOwnerLayout()!.internal, "locations", first.attrs.recordId + ".json");
            const stored: import("./import.ts").WorkRecordLocations = JSON.parse(await fs.readFile(path, "utf8"));
            for (const relative of ["../" + basename(f.root) + "/protected.md", "missing.md", "old-name.md"])
                stored.locations.push({ ...location, repositoryPath: relative, sourcePath: join(f.root, relative) });
            stored.locations.push({
                ...location,
                repositoryPath: "protected.md",
                sourcePath: outside,
                repositoryId: crypto.randomUUID(),
            });
            const edited = join(f.root, "edited.md");
            await fs.writeFile(edited, first.markdown);
            stored.locations.push({ ...location, repositoryPath: "edited.md", sourcePath: edited });
            await fs.writeFile(path, JSON.stringify(stored));
            const secondLocation = join(
                workRecordOwnerLayout()!.internal,
                "locations",
                second.attrs.recordId + ".json",
            );
            await fs.writeFile(secondLocation, "incomplete");
            const approved = (await previewRecordRetention(f.root)).due.map(({ recordId, token }) => ({
                label: recordId,
                token,
            }));
            const editorSave = join(f.root, "editor-save.md");
            await fs.writeFile(editorSave, "Local editor changes.");
            await fs.rename(editorSave, edited);
            await rejects(confirmPruneRequest(f.root, "records", approved, port));
            equal((await listWorkRecords(f.root)).length, 1);
            const reserved = await pendingPruneRequest(f.root, "records");
            equal(reserved?.length, 1);
            const newer = await writeWorkRecord(f.root, recordAttrs(), recordBody);
            await fs.unlink(secondLocation);
            const result = await confirmPruneRequest(f.root, "records", reserved!, port);
            equal(result.deleted[0], second.attrs.recordId);
            equal((await listWorkRecords(f.root))[0].attrs.recordId, newer.attrs.recordId);
            equal(await fs.readFile(outside, "utf8"), first.markdown);
            equal(await fs.readFile(decoy, "utf8"), first.markdown);
            equal(await fs.readFile(edited, "utf8"), "Local editor changes.");
            ok((await fs.lstat(join(f.root, "link.md"))).isSymbolicLink());
            equal(await pendingPruneRequest(f.root, "records"), undefined);
        });
    } finally {
        await f.cleanup();
    }
});
