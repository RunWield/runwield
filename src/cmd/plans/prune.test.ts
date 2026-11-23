import { projects } from "@runwield/projects";
import { seedPlan } from "../../shared/testing/plan-state-fixture.ts";
import { withRetainedPlanFixture } from "../../shared/testing/retained-plan-fixture.ts";
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { archivePlan, loadArchivedPlan } from "../../plan-store/index.ts";

import { setCustomSetting } from "../../shared/settings.ts";
import { writeWorkRecord } from "../../shared/work-records/store.ts";
import type { WorkRecordFrontMatter } from "@runwield/plans/work-record-schema";
import { runPlansPruneCommand } from "./prune.ts";
import { type PlanCommandFixture, withPlanCommandFixture } from "./plans-command-test-fixture.ts";

async function captureLogs(run: () => Promise<void>): Promise<string> {
    const logs: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (message = "") => logs.push(String(message));
    console.error = (message = "") => logs.push(String(message));
    try {
        await run();
    } finally {
        console.log = originalLog;
        console.error = originalError;
    }
    return logs.join("\n");
}

function pruneTest(name: string, run: (fixture: PlanCommandFixture) => Promise<void>): void {
    test(name, () =>
        withPlanCommandFixture("runwield-plans-prune-command-", (fixture) =>
            withRetainedPlanFixture(fixture.projectRoot, () => run(fixture)),
        ),
    );
}

function recordAttrs(recordId: string, sourcePlan: string): WorkRecordFrontMatter {
    return {
        kind: "work_record",
        recordId,
        status: "approved",
        scope: "planned_change",
        origin: "internal",
        completionMode: "verified",
        createdAt: "2026-08-01T00:00:00Z",
        provenance: { sourcePlans: [sourcePlan] },
    };
}

async function writeRecord(projectRoot: string, recordId: string, sourcePlan: string): Promise<void> {
    await writeWorkRecord(
        projectRoot,
        recordAttrs(recordId, sourcePlan),
        `# Record ${recordId}\n\n## Summary\n\nCompleted work.`,
        { fileName: `${recordId}.md` },
    );
}

pruneTest("plans prune --yes deletes old archived Plans that have Work Records", async ({ projectRoot }) => {
    await setCustomSetting("plans", { archiveRetentionDays: 14, archiveKeepLast: 0 }, "project", projectRoot);
    await seedPlan(projectRoot, "old", "# Old", { status: "verified", planId: "old-id" });
    await seedPlan(projectRoot, "no-record", "# No Record", { status: "verified", planId: "no-record-id" });
    await archivePlan(projectRoot, "old", { now: "2026-08-01T00:00:00Z" });
    await archivePlan(projectRoot, "no-record", { now: "2026-08-01T00:00:00Z" });
    await writeRecord(projectRoot, "11111111-1111-4111-8111-111111111111", "old-id");

    const output = await captureLogs(() => runPlansPruneCommand(["--yes"]));

    assertEquals(await loadArchivedPlan(projectRoot, "old"), null);
    assertEquals((await loadArchivedPlan(projectRoot, "no-record"))?.body, "# No Record");
    assertStringIncludes(output, "Due: 1");
    assertStringIncludes(output, "Ineligible: 1");
    assertStringIncludes(output, "Pruned 1 archived Plan unit");
});

pruneTest("plans prune --dry-run reports due Plans without deleting", async ({ projectRoot }) => {
    await setCustomSetting("plans", { archiveRetentionDays: 14, archiveKeepLast: 0 }, "project", projectRoot);
    await seedPlan(projectRoot, "old", "# Old", { status: "verified", planId: "old-id" });
    await archivePlan(projectRoot, "old", { now: "2026-08-01T00:00:00Z" });
    await writeRecord(projectRoot, "22222222-2222-4222-8222-222222222222", "old-id");

    const output = await captureLogs(() => runPlansPruneCommand(["--dry-run"]));

    assertEquals((await loadArchivedPlan(projectRoot, "old"))?.body, "# Old");
    assertStringIncludes(output, "Dry run only");
});

pruneTest("plans prune honors repository retention and keepLast settings", async ({ projectRoot }) => {
    await setCustomSetting("plans", { archiveRetentionDays: 14, archiveKeepLast: 1 }, "project", projectRoot);
    await seedPlan(projectRoot, "old", "# Old", { status: "verified", planId: "old-id" });
    await seedPlan(projectRoot, "new", "# New", { status: "verified", planId: "new-id" });
    await archivePlan(projectRoot, "old", { now: "2026-08-01T00:00:00Z" });
    await archivePlan(projectRoot, "new", { now: new Date().toISOString() });
    await writeRecord(projectRoot, "33333333-3333-4333-8333-333333333333", "old-id");
    await writeRecord(projectRoot, "44444444-4444-4444-8444-444444444444", "new-id");

    const output = await captureLogs(() => runPlansPruneCommand(["--yes"]));

    assertEquals(await loadArchivedPlan(projectRoot, "old"), null);
    assertEquals((await loadArchivedPlan(projectRoot, "new"))?.body, "# New");
    assertStringIncludes(output, "archiveRetentionDays=14, archiveKeepLast=1");
    assertStringIncludes(output, "Spared by keepLast: 1");
});

test("canonical archived families retain records and remove only confirmed, covered milestone histories", async () => {
    await withPlanCommandFixture("prune-canonical-family-", async ({ projectRoot }) => {
        const { create } = await import("../../shared/testing/plan-package-fixture.ts");
        const { listPlanHistory, previewRecordRetention, previewPlanRetention, confirmRetention } =
            await import("../../plan-store/index.ts");
        const admission = await projects.checkout.admit(projectRoot);
        if (admission.kind !== "existing") throw new Error("Project fixture needs a stable identity.");
        await setCustomSetting("plans", { archiveKeepLast: 0, archiveRetentionDays: 0 }, "project", projectRoot);
        await setCustomSetting("workRecords", { retentionKeepLast: 0, retentionDays: 0 }, "project", projectRoot);
        const identity = admission.identity;
        await create(identity, {
            name: "family",
            planId: "family",
            definition: { classification: "PROJECT", type: "epic", status: "verified" },
        });
        await create(identity, { name: "family/child", planId: "member", parentPlanId: "family" });
        await create(identity, { name: "uncovered", planId: "uncovered" });
        for (const name of ["family/child", "family", "uncovered"])
            await archivePlan(projectRoot, name, { force: true });
        await writeRecord(projectRoot, "33333333-1111-4111-8111-111111111111", "family");
        const preview = await previewPlanRetention(projectRoot);
        assertEquals(
            preview.due.map((p) => p.name),
            ["family"],
        );
        assertEquals((await previewRecordRetention(projectRoot)).due, []);
        assertStringIncludes(await captureLogs(() => runPlansPruneCommand(["--dry-run"])), "Due: 1");
        const before = await listPlanHistory(projectRoot, "uncovered");
        assertEquals(before.milestones.length, 1);
        const { readLocalHomeStore } = await import("../../plan-store/index.ts");
        const { workRecordOwnerLayout } = await import("../../shared/work-records/owner.ts");
        const { formatWorkRecordMarkdown } = await import("../../shared/work-records/markdown.ts");
        const { mkdir, writeFile, unlink, stat } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const pinPath = await readLocalHomeStore(
            projectRoot,
            async () => {
                const dir = join(workRecordOwnerLayout()!.internal, "preparations");
                await mkdir(dir, { recursive: true });
                return join(dir, "unfinished.json");
            },
            () => {
                throw new Error("Missing fixture owner.");
            },
        );
        const attrs = recordAttrs("33333333-1111-4111-8111-222222222222", "member");
        await writeFile(
            pinPath,
            JSON.stringify({
                version: 1,
                attemptId: "unfinished",
                recordId: attrs.recordId,
                createdAt: attrs.createdAt,
                record: {
                    kind: "work-record",
                    path: "docs/work-records/member.md",
                    text: formatWorkRecordMarkdown(attrs, "# Member\n\n## Summary\n\nRetained input."),
                },
            }),
        );
        assertEquals(await confirmRetention(projectRoot, "plans", preview.due[0].token!), false);
        assertEquals((await listPlanHistory(projectRoot, "member")).milestones.length, 1);
        await unlink(pinPath);
        await setCustomSetting("plans", { archiveKeepLast: 1, archiveRetentionDays: 0 }, "project", projectRoot);
        assertEquals(await confirmRetention(projectRoot, "plans", preview.due[0].token!), false);
        await setCustomSetting("plans", { archiveKeepLast: 0, archiveRetentionDays: 0 }, "project", projectRoot);
        const { read } = await import("../../shared/testing/plan-package-fixture.ts");
        const { createHash } = await import("node:crypto");
        const { readFile } = await import("node:fs/promises");
        const family = await Promise.all(["member", "family"].map((id) => read(identity, id)));
        const journal = await Promise.all(
            family.map(async ({ metadata, path, documents }) => ({
                planId: metadata.planId,
                name: metadata.name,
                metadataDigest: createHash("sha256")
                    .update(await readFile(join(path, "plan.wld.json")))
                    .digest("hex"),
                documents: documents.map(({ name, hash }) => ({ name, hash })),
                versions: metadata.history!.map((m) => m.version),
            })),
        );
        const internal = join(
            identity.executionAccountHome,
            ".wld",
            "projects",
            identity.projectId,
            "internal",
            "plan-packages",
        );
        const journalPath = join(internal, "pruning.json");
        const original = await readFile(join(family[1].path, "context.md"), "utf8");
        await writeFile(journalPath, JSON.stringify({ phase: "staging", members: journal }));
        await setCustomSetting("plans", { archiveKeepLast: 1, archiveRetentionDays: 0 }, "project", projectRoot);
        assertEquals(await confirmRetention(projectRoot, "plans", preview.due[0].token!), false);
        assertEquals((await listPlanHistory(projectRoot, "member")).milestones.length, 1);
        await setCustomSetting("plans", { archiveKeepLast: 0, archiveRetentionDays: 0 }, "project", projectRoot);
        await writeFile(join(family[1].path, "context.md"), original + "Edited before replay.");
        await writeFile(journalPath, JSON.stringify(journal));
        const stage = join(internal, "prune-staging");
        await mkdir(stage);
        await (await import("node:fs/promises")).rename(family[1].path, join(stage, "0"));
        const { rejects } = await import("node:assert/strict");
        await rejects(previewPlanRetention(projectRoot), /pending prune recovery/);
        await rejects(read(identity, "member"), /pending_recovery/);
        assertEquals(await confirmRetention(projectRoot, "plans", preview.due[0].token!), false);
        for (const id of ["family", "member"])
            assertEquals((await listPlanHistory(projectRoot, id)).milestones.length, 1);
        assertEquals(await readFile(join(family[1].path, "context.md"), "utf8"), original + "Edited before replay.");
        await writeFile(join(family[1].path, "context.md"), original);
        assertStringIncludes(await captureLogs(() => runPlansPruneCommand(["--yes"])), "Pruned 1");
        assertEquals(await loadArchivedPlan(projectRoot, "family"), null);
        assertEquals(await loadArchivedPlan(projectRoot, "member"), null);
        for (const id of ["family", "member"])
            assertEquals(
                await stat(
                    join(identity.executionAccountHome, ".wld", "projects", identity.projectId, "history", id),
                ).catch(() => null),
                null,
            );
        await create(identity, { name: "family", planId: "replacement" });
        await archivePlan(projectRoot, "family", { force: true });
        await writeRecord(projectRoot, "33333333-1111-4111-8111-333333333333", "replacement");
        await confirmRetention(projectRoot, "plans", preview.due[0].token!);
        assertEquals((await loadArchivedPlan(projectRoot, "replacement"))?.attrs.planId, "replacement");
        assertEquals(await listPlanHistory(projectRoot, "uncovered"), before);
        assertEquals((await previewRecordRetention(projectRoot)).due.length, 1);
    });
});
