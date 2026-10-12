import process from "node:process";
import { rm as fsRm } from "node:fs/promises";
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { loadArchivedPlan, loadPlan, savePlan } from "../../plan-store.js";
import { runPlansCommand } from "./index.ts";
import { addEntry } from "../../shared/worktree-registry.js";
import { defineCommittedGitFixture, git } from "../../shared/git-test-fixture.ts";
import { getCwd } from "../../constants.js";
import { type PlanCommandFixture, withPlanCommandFixture } from "./plans-command-test-fixture.ts";

type PlanSeedAttrs = NonNullable<Parameters<typeof savePlan>[3]>;

interface PlanSeed {
    name: string;
    attrs: PlanSeedAttrs;
}

function plansTest(name: string, run: (fixture: PlanCommandFixture) => Promise<void>): void {
    test(name, () => withPlanCommandFixture("runwield-plans-command-", run));
}

async function seedPlans(projectRoot: string, seeds: PlanSeed[]): Promise<void> {
    for (const seed of seeds) {
        await savePlan(
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
    await seedPlans(projectRoot, [{
        name: "standalone-feature",
        attrs: {
            status: "approved",
            classification: "PLANNED_CHANGE",
            complexity: "LOW",
            summary: "Standalone slice",
            affectedPaths: [],
        },
    }]);

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

        await git(projectRoot, ["add", "docs"]);
        await git(projectRoot, ["commit", "-m", "Epic and children"]);
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

plansTest("plans keeps done-enough and orphaned fixture state visible", async ({ projectRoot }) => {
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
        assertEquals(logs.some((message) => message.includes("1 on hold")), true);
        assertEquals(logs.slice(onHoldIndex).some((message) => message.includes("held-epic/01-child")), true);
        assertEquals(logs.some((message) => message.includes("Reason: priority shifted")), true);
    },
);

plansTest("plans archive executes the real archive transaction", async ({ projectRoot }) => {
    await seedPlans(projectRoot, [{
        name: "completed",
        attrs: {
            status: "verified",
            classification: "PLANNED_CHANGE",
            complexity: "LOW",
            summary: "Completed",
            affectedPaths: [],
            planId: "completed-plan-id",
        },
    }]);

    await captureOutput(() => runPlansCommand(["archive", "completed", "--reason", "shipped"]));

    assertEquals(await loadPlan(projectRoot, "completed"), null);
    assertEquals((await loadArchivedPlan(projectRoot, "completed"))?.attrs.archiveReason, "shipped");
});

plansTest("plans read serves real fixture markdown through the artifact surface", async ({ projectRoot }) => {
    await seedPlans(projectRoot, [{
        name: "read-me",
        attrs: {
            status: "draft",
            classification: "PLANNED_CHANGE",
            complexity: "LOW",
            summary: "Readable",
            affectedPaths: [],
        },
    }]);

    const html = await runReadAndClose(["read", "read-me", "--no-open"]);
    assertStringIncludes(html, "artifact-read");
    assertStringIncludes(html, "# read-me");
});

plansTest("plans doctor and UI help use their real command implementations", async () => {
    const doctor = await captureOutput(() => runPlansCommand(["doctor"]));
    assertStringIncludes(doctor.join("\n"), "Your Plans look good");

    const uiHelp = await captureOutput(() => runPlansCommand(["ui", "--help"]));
    assertStringIncludes(uiHelp.join("\n"), "Usage: wld plans ui");
});

plansTest("plans collaboration subcommands expose their real help contracts without network access", async () => {
    const output = await captureOutput(async () => {
        await runPlansCommand(["share", "--help"]);
        await runPlansCommand(["pull", "--help"]);
        await runPlansCommand(["push", "--help"]);
        await runPlansCommand(["unshare", "--help"]);
    });
    const text = output.join("\n");
    assertStringIncludes(text, "plans share");
    assertStringIncludes(text, "plans pull");
    assertStringIncludes(text, "plans push");
    assertStringIncludes(text, "plans unshare");
});

plansTest("plans help uses the registered command help", async () => {
    const output = await captureOutput(() => runPlansCommand(["--help"]));
    assertStringIncludes(output.join("\n"), "Usage (plans):");
    assertStringIncludes(output.join("\n"), "wld plans archive");
});
