import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { archivePlan, loadArchivedPlan, savePlan } from "../../plan-store.js";
import { setCustomSetting } from "../../shared/settings.js";
import { writeWorkRecord } from "../../shared/work-records/store.js";
import type { WorkRecordFrontMatter } from "../../shared/work-records/schema.ts";
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
    test(name, () => withPlanCommandFixture("runwield-plans-prune-command-", run));
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
    await savePlan(projectRoot, "old", "# Old", { status: "verified", planId: "old-id" });
    await savePlan(projectRoot, "no-record", "# No Record", { status: "verified", planId: "no-record-id" });
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
    await savePlan(projectRoot, "old", "# Old", { status: "verified", planId: "old-id" });
    await archivePlan(projectRoot, "old", { now: "2026-08-01T00:00:00Z" });
    await writeRecord(projectRoot, "22222222-2222-4222-8222-222222222222", "old-id");

    const output = await captureLogs(() => runPlansPruneCommand(["--dry-run"]));

    assertEquals((await loadArchivedPlan(projectRoot, "old"))?.body, "# Old");
    assertStringIncludes(output, "Dry run only");
});

pruneTest("plans prune honors repository retention and keepLast settings", async ({ projectRoot }) => {
    await setCustomSetting("plans", { archiveRetentionDays: 14, archiveKeepLast: 1 }, "project", projectRoot);
    await savePlan(projectRoot, "old", "# Old", { status: "verified", planId: "old-id" });
    await savePlan(projectRoot, "new", "# New", { status: "verified", planId: "new-id" });
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
