import { seedPlanAttemptReference } from "../../shared/testing/plan-state-fixture.ts";
import { seedPlan } from "../../shared/testing/plan-state-fixture.ts";
import process from "node:process";
import {
    mkdir as fsMkdir,
    readFile as fsReadFile,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { archivePlan } from "../../plan-store/index.ts";
import { listFixturePlanHistory, loadArchivedPlan, loadPlan } from "../../shared/testing/plan-query-fixture.ts";

import { runPlansCommand } from "./index.ts";
import { addEntry } from "../../shared/worktree-registry.ts";
import { defineCommittedGitFixture, git } from "../../shared/git-test-fixture.ts";
import { join } from "node:path";
import { resolveProjectRuntimeLayout } from "@runwield/project-runtime/layout";
import { getCwd } from "../../constants.ts";
import { getRunWieldRuntimeDir } from "@runwield/project-runtime/legacy-paths";
import { type PlanCommandFixture, withPlanCommandFixture } from "./plans-command-test-fixture.ts";

type PlanSeedAttrs = NonNullable<Parameters<typeof seedPlan>[3]>;

interface PlanSeed {
    name: string;
    attrs: PlanSeedAttrs;
}

function plansTest(name: string, run: (fixture: PlanCommandFixture) => Promise<void>): void {
    test(name, () => withPlanCommandFixture("runwield-plans-command-", run));
}

async function seedPlans(projectRoot: string, seeds: PlanSeed[]): Promise<void> {
    for (const seed of seeds) {
        await seedPlan(
            projectRoot,
            seed.name,
            `# ${seed.name}\n\n## Context\n\n${seed.attrs.summary || "Fixture body."}\n`,
            seed.attrs,
        );
    }
}

async function captureOutput(run: () => Promise<void>): Promise<string[]> {
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

async function runReadAndClose(argv: string[]): Promise<string> {
    let surfaceUrl = "";
    let commandError: Error | undefined;
    const original = console.log;
    console.log = (message = "") => {
        const line = String(message);
        const prefix = "[RunWield] Plan read-only view: ";
        if (line.startsWith(prefix)) surfaceUrl = line.slice(prefix.length);
    };
    const command = runPlansCommand(argv).catch((error) => {
        commandError = error instanceof Error ? error : new Error(String(error));
    });
    try {
        for (let attempt = 0; attempt < 200 && !surfaceUrl && !commandError; attempt += 1) {
            await new Promise<void>((resolve) => setTimeout(resolve, 5));
        }
        if (!surfaceUrl) {
            await command;
            throw commandError || new Error("Plan read surface did not start.");
        }
        const url = new URL(surfaceUrl);
        const token = url.searchParams.get("token");
        if (!token) throw new Error("Plan read surface URL did not include its access token.");
        const html = await (await fetch(url)).text();
        const exitUrl = new URL("/api/review/exit", url);
        exitUrl.searchParams.set("token", token);
        const response = await fetch(exitUrl, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-runwield-review-token": token,
            },
            body: JSON.stringify({ reviewType: "plan" }),
        });
        assertEquals(response.status, 200);
        await command;
        if (commandError) throw commandError;
        return html;
    } finally {
        console.log = original;
    }
}

plansTest("plans reports an empty real Plan store", async () => {
    const output = await captureOutput(() => runPlansCommand([]));
    assertStringIncludes(output.join("\n"), "No saved plans found");
});

plansTest("plans lists a standalone Planned Change from the fixture store", async ({ projectRoot }) => {
    await seedPlans(projectRoot, [
        {
            name: "standalone-feature",
            attrs: {
                status: "approved",
                classification: "PLANNED_CHANGE",
                complexity: "LOW",
                summary: "Standalone slice",
                affectedPaths: [],
            },
        },
    ]);

    const output = await captureOutput(() => runPlansCommand([]));
    assertStringIncludes(output.join("\n"), "Standalone plans:");
    assertStringIncludes(output.join("\n"), "standalone-feature");
});

plansTest("plans renders real Epic child progress and worktree metadata", async () => {
    const projectRoot = await defineCommittedGitFixture({ ".gitignore": ".wld/\ndelivered-tree/\n" }).checkout();
    const previousCwd = getCwd();
    process.chdir(projectRoot);
    try {
        await seedPlans(projectRoot, [
            {
                name: "big-project",
                attrs: {
                    status: "ready_for_work",
                    classification: "PROJECT",
                    complexity: "HIGH",
                    summary: "Large project",
                    affectedPaths: [],
                },
            },
            {
                name: "big-project/01-first",
                attrs: {
                    planId: "first-child",
                    status: "verified",
                    classification: "PLANNED_CHANGE",
                    complexity: "MEDIUM",
                    summary: "First child",
                    affectedPaths: [],
                    parentPlan: "big-project",
                    order: 1,
                },
            },
            {
                name: "big-project/02-second",
                attrs: {
                    status: "implemented",
                    classification: "PLANNED_CHANGE",
                    complexity: "LOW",
                    summary: "Second child",
                    affectedPaths: [],
                    parentPlan: "big-project",
                    order: 2,
                },
            },
        ]);

        await git(projectRoot, ["worktree", "add", "-b", "feature/first", `${projectRoot}/delivered-tree`]);
        await addEntry(projectRoot, {
            id: "first-attempt",
            planId: "first-child",
            planName: "big-project/01-first",
            path: `${projectRoot}/delivered-tree`,
            branch: "feature/first",
            baseBranch: "main",
            baseRef: "refs/heads/main",
            baseCommit: await git(projectRoot, ["rev-parse", "HEAD"]),
            status: "completed",
            createdAt: "2026-08-25T00:00:00Z",
            updatedAt: "2026-08-25T00:00:00Z",
        });

        await seedPlanAttemptReference(projectRoot, "big-project/01-first", "first-attempt");
        const output = (await captureOutput(() => runPlansCommand([]))).join("\n");
        assertStringIncludes(output, "Epics:");
        assertStringIncludes(output, "Progress: 1/2 Planned Changes verified");
        assertStringIncludes(output, "- big-project/01-first");
        assertStringIncludes(output, "Worktree: completed (feature/first)");
    } finally {
        process.chdir(previousCwd);
        await fsRm(projectRoot, { recursive: true });
    }
});

plansTest("plans keeps done-enough and archived-parent child state visible", async ({ projectRoot }) => {
    await seedPlan(projectRoot, "missing-parent", "# Archived parent\n", { classification: "PROJECT" });
    await seedPlans(projectRoot, [
        {
            name: "done-enough-epic",
            attrs: {
                status: "verified",
                classification: "PROJECT",
                complexity: "HIGH",
                summary: "Large project",
                affectedPaths: [],
                epicCompletionMode: "done_enough",
                epicDoneEnoughSummary: "One slice delivered.",
            },
        },
        {
            name: "done-enough-epic/01-first",
            attrs: {
                status: "verified",
                classification: "PLANNED_CHANGE",
                complexity: "MEDIUM",
                summary: "First child",
                affectedPaths: [],
                parentPlan: "done-enough-epic",
                order: 1,
            },
        },
        {
            name: "missing-parent/01-orphan",
            attrs: {
                status: "draft",
                classification: "PLANNED_CHANGE",
                complexity: "MEDIUM",
                summary: "Orphan child",
                affectedPaths: [],
                parentPlan: "missing-parent",
                order: 1,
            },
        },
    ]);

    await archivePlan(projectRoot, "missing-parent", { force: true });
    const output = (await captureOutput(() => runPlansCommand([]))).join("\n");
    assertStringIncludes(output, "done enough for now");
    assertStringIncludes(output, "Done enough: One slice delivered.");
    assertStringIncludes(output, "Orphaned child plans:");
    assertStringIncludes(output, "missing-parent/01-orphan");
});

plansTest(
    "plans groups held top-level Plans while retaining held children under their Epic",
    async ({ projectRoot }) => {
        await seedPlans(projectRoot, [
            {
                name: "active-epic",
                attrs: {
                    status: "ready_for_work",
                    classification: "PROJECT",
                    complexity: "HIGH",
                    summary: "Active epic",
                    affectedPaths: [],
                },
            },
            {
                name: "active-epic/01-held",
                attrs: {
                    status: "on_hold",
                    classification: "PLANNED_CHANGE",
                    complexity: "LOW",
                    summary: "Held child",
                    affectedPaths: [],
                    parentPlan: "active-epic",
                    order: 1,
                    heldFromStatus: "ready_for_work",
                    holdReason: "later",
                },
            },
            {
                name: "held-epic",
                attrs: {
                    status: "on_hold",
                    classification: "PROJECT",
                    complexity: "HIGH",
                    summary: "Held epic",
                    affectedPaths: [],
                    heldFromStatus: "ready_for_work",
                    holdReason: "priority shifted",
                },
            },
            {
                name: "held-epic/01-child",
                attrs: {
                    status: "draft",
                    classification: "PLANNED_CHANGE",
                    complexity: "LOW",
                    summary: "Child stays draft",
                    affectedPaths: [],
                    parentPlan: "held-epic",
                    order: 1,
                },
            },
        ]);

        const logs = await captureOutput(() => runPlansCommand([]));
        const onHoldIndex = logs.findIndex((message) => message.includes("On Hold:"));
        assertEquals(onHoldIndex >= 0, true);
        assertEquals(
            logs.some((message) => message.includes("1 on hold")),
            true,
        );
        assertEquals(
            logs.slice(onHoldIndex).some((message) => message.includes("held-epic/01-child")),
            true,
        );
        assertEquals(
            logs.some((message) => message.includes("Reason: priority shifted")),
            true,
        );
    },
);

plansTest("plans archive executes the real archive transaction", async ({ projectRoot }) => {
    await seedPlans(projectRoot, [
        {
            name: "completed",
            attrs: {
                status: "verified",
                classification: "PLANNED_CHANGE",
                complexity: "LOW",
                summary: "Completed",
                affectedPaths: [],
                planId: "completed-plan-id",
            },
        },
    ]);

    await captureOutput(() => runPlansCommand(["archive", "completed", "--reason", "shipped"]));

    assertEquals(await loadPlan(projectRoot, "completed"), null);
    assertEquals((await loadArchivedPlan(projectRoot, "completed"))?.attrs.archiveReason, "shipped");
});

plansTest("plans read serves real fixture markdown through the artifact surface", async ({ projectRoot }) => {
    await seedPlans(projectRoot, [
        {
            name: "read-me",
            attrs: {
                status: "draft",
                classification: "PLANNED_CHANGE",
                complexity: "LOW",
                summary: "Readable",
                affectedPaths: [],
            },
        },
    ]);

    const html = await runReadAndClose(["read", "read-me", "--no-open"]);
    assertStringIncludes(html, "artifact-read");
    assertStringIncludes(html, "# read-me");
});

plansTest("Plans list and read preserve unimported sources without live discovery", async ({ projectRoot }) => {
    await fsMkdir(join(projectRoot, "docs/plans"), { recursive: true });
    const planPath = join(projectRoot, "docs/plans/pending.md");
    const markdown = "---\nclassification: PLANNED_CHANGE\nstatus: draft\n---\n# Pending source\n";
    await fsWriteFile(planPath, markdown);
    await fsWriteFile(join(projectRoot, ".gitignore"), "user-owned-rule\n");
    const legacy = join(getRunWieldRuntimeDir(projectRoot), "debug");
    await fsMkdir(legacy, { recursive: true });
    await fsWriteFile(join(legacy, "source.txt"), "Legacy input\n");
    const output = (await captureOutput(() => runPlansCommand([]))).join("\n");
    assertEquals(output.includes("Pending source"), false);
    assertEquals(await loadPlan(projectRoot, "pending"), null);
    assertEquals(await fsReadFile(planPath, "utf8"), markdown);
    assertEquals(await fsReadFile(join(projectRoot, ".gitignore"), "utf8"), "user-owned-rule\n");
    assertEquals(await fsReadFile(join(legacy, "source.txt"), "utf8"), "Legacy input\n");
    assertEquals(
        await fsStat(resolveProjectRuntimeLayout(projectRoot).primary.layoutMarkerPath)
            .then(() => true)
            .catch(() => false),
        false,
    );
});

plansTest("plans history lists and shows the approved documents and restores their prose", async ({ projectRoot }) => {
    const { authorLocalPlan, recordPlanEvent, savePlanProse } = await import("../../plan-store/index.ts");
    await authorLocalPlan(projectRoot, {
        planName: "proposal",
        contextMarkdown: "# Approved\n",
        validationMarkdown: "Check it\n",
    });
    assertStringIncludes(
        (await captureOutput(() => runPlansCommand(["history", "proposal"]))).join("\n"),
        "No milestones",
    );
    await recordPlanEvent({ cwd: projectRoot, planName: "proposal", event: "review_approved", currentStatus: "draft" });
    const history = await listFixturePlanHistory(projectRoot, "proposal");
    const version = history.milestones[0].version;
    assertStringIncludes((await captureOutput(() => runPlansCommand(["history", history.planId]))).join("\n"), version);
    await savePlanProse(projectRoot, "proposal", "# Changed\n", history.revision);
    const shown = (await captureOutput(() => runPlansCommand(["history", "show", "proposal", version]))).join("\n");
    assertStringIncludes(shown, "validation.md");
    assertStringIncludes(shown, "# Approved");
    await captureOutput(() => runPlansCommand(["history", "restore", history.planId, version]));
    assertEquals((await loadPlan(projectRoot, "proposal"))!.body, "# Approved\n");
});
