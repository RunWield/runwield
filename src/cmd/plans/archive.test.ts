import { mkdir as fsMkdir, readdir as fsReaddir, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { archivePlan, listArchivedPlans, listPlans, loadArchivedPlan, loadPlan, savePlan } from "../../plan-store.js";
import { getTransitionJournalDir, getTransitionJournalPath } from "../../shared/workflow/state-transition.ts";
import { runPlansArchiveCommand } from "./archive.ts";
import { type PlanCommandFixture, withPlanCommandFixture } from "./plans-command-test-fixture.ts";

async function captureLogs(run: () => Promise<void>): Promise<string[]> {
    const logs: string[] = [];
    const original = console.log;
    console.log = (message = "") => logs.push(String(message));
    try {
        await run();
    } finally {
        console.log = original;
    }
    return logs;
}

function archiveTest(name: string, run: (fixture: PlanCommandFixture) => Promise<void>): void {
    test(name, () => withPlanCommandFixture("runwield-plans-archive-command-", run));
}

archiveTest("archive command lists archived fixture Plans", async ({ projectRoot }) => {
    await savePlan(projectRoot, "done", "# Done\n\nFinished work.", {
        status: "verified",
        summary: "Done plan",
        planId: "done-id",
    });
    await archivePlan(projectRoot, "done", { reason: "complete" });

    const logs = await captureLogs(() => runPlansArchiveCommand([]));

    assertEquals(logs.some((line) => line.includes("Archived plans")), true);
    assertEquals(logs.some((line) => line.includes("done-id")), true);
    assertEquals(logs.some((line) => line.includes("Reason: complete")), true);
});

archiveTest("archive command resolves a planId and runs the real archive transaction", async ({ projectRoot }) => {
    await savePlan(projectRoot, "canonical-plan", "# Draft\n\nKeep this body.", {
        status: "draft",
        summary: "Draft plan",
        planId: "plan-id-1",
    });

    const logs = await captureLogs(() => runPlansArchiveCommand(["plan-id-1", "--reason", "stale", "--force"]));

    assertEquals(await loadPlan(projectRoot, "canonical-plan"), null);
    const archived = await loadArchivedPlan(projectRoot, "canonical-plan");
    assertEquals(archived?.body, "# Draft\n\nKeep this body.");
    assertEquals(archived?.attrs.archiveReason, "stale");
    assertEquals(archived?.attrs.archivedFromStatus, "draft");
    assertEquals(logs.some((line) => line.includes("docs/plans/archived/canonical-plan.md")), true);
    assertEquals(
        await fsReaddir(getTransitionJournalDir(projectRoot), { withFileTypes: true }).catch(
            () => [],
        ),
        [],
    );
});

archiveTest("archive command cannot bypass a stranded lifecycle transaction", async ({ projectRoot }) => {
    await savePlan(projectRoot, "blocked", "# Blocked", {
        status: "draft",
        planId: "blocked-id",
    });
    await fsMkdir(getTransitionJournalDir(projectRoot), { recursive: true });
    await fsWriteFile(
        getTransitionJournalPath(projectRoot, "stranded-archive"),
        JSON.stringify({
            version: 1,
            transitionId: "stranded-archive",
            operation: "plan_archive",
            planName: "blocked",
            state: "needs_recovery",
        }),
    );

    await assertRejects(
        () => runPlansArchiveCommand(["blocked-id", "--force"]),
        Error,
        "needs recovery",
    );
    assertEquals((await loadPlan(projectRoot, "blocked"))?.body, "# Blocked");
    assertEquals(await loadArchivedPlan(projectRoot, "blocked"), null);
});

archiveTest("archive command restores archived Plans through the real transaction", async ({ projectRoot }) => {
    await savePlan(projectRoot, "done", "# Done\n\nPreserved.", {
        status: "verified",
        planId: "done-id",
    });
    await archivePlan(projectRoot, "done", { reason: "done" });

    const logs = await captureLogs(() => runPlansArchiveCommand(["restore", "done-id", "--to", "done-restored"]));

    assertEquals(await loadArchivedPlan(projectRoot, "done"), null);
    const restored = await loadPlan(projectRoot, "done-restored");
    assertEquals(restored?.body, "# Done\n\nPreserved.");
    assertEquals(restored?.attrs.restoredFromPath, "docs/plans/archived/done.md");
    assertEquals(logs.some((line) => line.includes("Restored done-id to docs/plans/done-restored.md")), true);
});

archiveTest("bulk archive moves matching parents, their children, and standalone Plans", async ({ projectRoot }) => {
    await savePlan(projectRoot, "epic", "# Epic", {
        classification: "PROJECT",
        status: "verified",
        summary: "Done epic",
    });
    await savePlan(projectRoot, "epic/01-child", "# Child", {
        classification: "FEATURE",
        parentPlan: "epic",
        status: "draft",
        summary: "Child",
    });
    await savePlan(projectRoot, "standalone", "# Standalone", {
        status: "verified",
        summary: "Done",
    });
    await savePlan(projectRoot, "keep", "# Keep", { status: "draft" });

    const logs = await captureLogs(() =>
        runPlansArchiveCommand(["--all", "--status", "verified", "--reason", "batch done"])
    );

    assertEquals((await listArchivedPlans(projectRoot)).map((plan) => plan.name), [
        "epic",
        "epic/01-child",
        "standalone",
    ]);
    assertEquals((await listPlans(projectRoot)).map((plan) => plan.name), ["keep"]);
    assertEquals((await loadArchivedPlan(projectRoot, "epic/01-child"))?.attrs.archiveReason, "batch done");
    assertEquals(logs.some((line) => line.includes("Archived 3/3 matching Plan(s); 0 failed")), true);
});

archiveTest("archive command reports an empty bulk match without writing Plans", async ({ projectRoot }) => {
    await savePlan(projectRoot, "keep", "# Keep", { status: "draft" });

    const logs = await captureLogs(() => runPlansArchiveCommand(["--all", "--status", "verified"]));

    assertEquals(logs, ["[RunWield] No active Plans with status verified found."]);
    assertEquals((await listPlans(projectRoot)).map((plan) => plan.name), ["keep"]);
    assertEquals(await listArchivedPlans(projectRoot), []);
});

archiveTest("archive command validates its argument combinations before filesystem work", async () => {
    await assertRejects(() => runPlansArchiveCommand(["restore"]), Error, "Missing archived Plan name");
    await assertRejects(() => runPlansArchiveCommand(["--all"]), Error, "Missing --status");
    await assertRejects(
        () => runPlansArchiveCommand(["--status", "verified"]),
        Error,
        "--status requires --all",
    );
    await assertRejects(
        () => runPlansArchiveCommand(["some-plan", "--all", "--status", "verified"]),
        Error,
        "Unexpected archive argument with --all",
    );
    await assertRejects(
        () => runPlansArchiveCommand(["restore", "done", "--all"]),
        Error,
        "Cannot use --all",
    );

    const logs = await captureLogs(() => runPlansArchiveCommand(["--help"]));
    assertStringIncludes(logs.join("\n"), "plans archive restore");
});
