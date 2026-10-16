import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    realpath as fsRealpath,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { unsharePlan } from "../../cmd/plans/unshare.ts";
import { pushPlanRevision } from "../../cmd/plans/push.ts";
import { sharePlanForReview } from "../../cmd/plans/share.ts";
import { tmpdir } from "node:os";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { dirname, join } from "node:path";
import { listPlans, loadPlan, updatePlanCollaborationMetadata } from "../../plan-store.js";
import { runLoadPlanCommand } from "../../cmd/load-plan/index.ts";
import { resolvePlanWithPrimaryRecovery } from "../../cmd/load-plan/primary-plan-recovery.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { createSessionRuntime } from "../session/session-runtime.ts";
import { HostedSession } from "../session/hosted-session.js";
import { defineGitFixture, git } from "../git-test-fixture.ts";
import { COLLABORATION_LOCK_BYPASS } from "../collaboration/lock.ts";
import { listEntries } from "../worktree-registry.js";
import { createExecutionStartPorts, startActiveExecutionWorkflow } from "./execution-start.ts";
import { resolveEpicContinuation, runEpicChildContinuation } from "./epic-continuation.ts";
import { recordPlanEvent } from "./plan-lifecycle.js";
import { PlanningNotStartedError, resolveWorkflowPlanLocation } from "./plan-location.ts";
import { prepareSessionPlanningWorktree } from "./session-planning-worktree.ts";
import { findTargetBranchPlansByParent, preparePlanningWorktreeForPlan } from "./planning-worktree.ts";
import { executePlan } from "./plan-executor.ts";
import { executePlanAction, loadPlanActionEvidence } from "./plan-actions.ts";

type PlanFixtureAttribute = string | number | boolean | string[];
type PlanFixtureAttributes = Record<string, PlanFixtureAttribute>;

async function writePlan(cwd: string, name: string, attrs: PlanFixtureAttributes, body: string) {
    const path = join(cwd, "docs", "plans", `${name}.md`);
    await fsMkdir(dirname(path), { recursive: true });
    const lines = ["---"];
    for (const [key, value] of Object.entries(attrs)) {
        if (Array.isArray(value)) {
            lines.push(`${key}:`);
            for (const item of value) lines.push(`  - ${JSON.stringify(item)}`);
        } else {
            lines.push(`${key}: ${JSON.stringify(value)}`);
        }
    }
    lines.push("---", "", body);
    await fsWriteFile(path, lines.join("\n"));
}

function makeLoadUi(selections: Array<string | null>) {
    const pending = [...selections];
    const messages: string[] = [];
    const editor = {
        disableSubmit: true,
        setText: () => {},
        setAutocompleteProvider: () => {},
        handleInput: () => {},
    };
    const uiAPI = {
        abortActivePrompt: () => {},
        appendSystemMessage: (message: string) => messages.push(message),
        appendAgentMessageStart: () => ({ appendText: () => {} }),
        requestRender: () => {},
        promptSelect: (_title: string, options: Array<{ value: string }>) => {
            const selection = pending.shift() ?? null;
            if (selection && !options.some((option) => option.value === selection)) {
                throw new Error(`Fixture selection was not offered: ${selection}`);
            }
            return Promise.resolve(selection);
        },
        promptText: (): Promise<string | null> => Promise.resolve(null),
        showModelSelector: () => {},
    };
    return { editor, messages, uiAPI };
}

const journeyFixture = defineGitFixture(async (repo) => {
    await writePlan(
        repo,
        "epic",
        {
            planId: "plan-epic",
            classification: "PROJECT",
            complexity: "HIGH",
            status: "ready_for_work",
            targetBranch: "epic-target",
            affectedPaths: [],
            createdAt: "2026-01-01T00:00:00.000Z",
        },
        "# Epic\n",
    );
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "primary epic only"]);
    await git(repo, ["switch", "-c", "epic-target"]);
    await writePlan(
        repo,
        "epic/01-done",
        {
            planId: "plan-child-01",
            classification: "FEATURE",
            complexity: "MEDIUM",
            status: "validated",
            parentPlan: "epic",
            order: 1,
            targetBranch: "epic-target",
            affectedPaths: [],
            createdAt: "2026-01-01T00:00:00.000Z",
        },
        "# Done child\n",
    );
    await writePlan(
        repo,
        "epic/02-next",
        {
            planId: "plan-child-02",
            classification: "FEATURE",
            complexity: "MEDIUM",
            status: "ready_for_work",
            parentPlan: "epic",
            order: 2,
            dependencies: ["01-done"],
            targetBranch: "epic-target",
            affectedPaths: ["next.js"],
            createdAt: "2026-01-01T00:00:00.000Z",
        },
        "# Next child\n\nTARGET NEXT BODY\n",
    );
    await fsWriteFile(join(repo, "target-only.js"), "target only\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "target child family"]);
    await git(repo, ["switch", "main"]);
});

test("Epic next-child loading uses its existing default branch when the Epic has no recorded target", async () => {
    await withRuntimeCommandFixture("epic-default-branch-load-", async () => {
        const repo = await journeyFixture.checkout();
        await git(repo, ["branch", "-m", "epic-target", "epic/epic"]);
        const epicPath = join(repo, "docs/plans/epic.md");
        await fsWriteFile(epicPath, (await fsReadFile(epicPath, "utf8")).replace('targetBranch: "epic-target"\n', ""));
        for (const name of ["01-done", "02-next"]) {
            const source = await git(repo, ["show", `epic/epic:docs/plans/epic/${name}.md`]);
            await fsMkdir(join(repo, "docs/plans/epic"), { recursive: true });
            await fsWriteFile(join(repo, `docs/plans/epic/${name}.md`), source.replaceAll("epic-target", "epic/epic"));
        }
        await git(repo, ["add", "."]);
        await git(repo, ["commit", "-m", "stale primary family without Epic target"]);
        await git(repo, ["switch", "epic/epic"]);
        await fsWriteFile(epicPath, (await fsReadFile(epicPath, "utf8")).replace('targetBranch: "epic-target"\n', ""));
        const nextPath = join(repo, "docs/plans/epic/02-next.md");
        await fsWriteFile(nextPath, (await fsReadFile(nextPath, "utf8")).replaceAll("epic-target", "epic/epic"));
        await git(repo, ["mv", "docs/plans/epic/02-next.md", "docs/plans/epic/03-next.md"]);
        await git(repo, ["add", "."]);
        await git(repo, ["commit", "-m", "renumber next child on existing Epic branch"]);
        await git(repo, ["switch", "main"]);
        const runtime = createSessionRuntime();
        const sessionId = await runtime.createPromptReadySession({ cwd: repo, agentName: "router" });
        const ui = makeLoadUi(["pick_child", "__next_child__", "cancel"]);
        const promptSelect = ui.uiAPI.promptSelect;
        ui.uiAPI.promptSelect = (title, options) => {
            if (title === "Load child Plan:") {
                assertEquals(
                    options.map((option) => option.value),
                    ["__next_child__", "epic/01-done", "epic/03-next"],
                );
            }
            return promptSelect(title, options);
        };
        const branchHead = await git(repo, ["rev-parse", "epic/epic"]);
        try {
            await runLoadPlanCommand(["epic"], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: ui.uiAPI,
                editor: ui.editor,
            });
            assertStringIncludes(ui.messages.join("\n"), "Plan loaded: epic/03-next");
            assertEquals(
                ui.messages.some((message) => message.includes("does not exist on target")),
                false,
            );
            assertEquals(await git(repo, ["rev-parse", "epic/epic"]), branchHead);
        } finally {
            runtime.closeAllSessions();
        }
    });
});

test("Starting an anonymous Epic child session creates a durable identity and reuses its planning worktree", async () => {
    await withRuntimeCommandFixture("epic-child-identity-load-", async () => {
        const repo = await journeyFixture.checkout();
        await git(repo, ["switch", "epic-target"]);
        const childPath = join(repo, "docs/plans/epic/02-next.md");
        await fsWriteFile(childPath, (await fsReadFile(childPath, "utf8")).replace('planId: "plan-child-02"\n', ""));
        await git(repo, ["add", "."]);
        await git(repo, ["commit", "-m", "child saved without identity"]);
        await git(repo, ["switch", "main"]);
        const branchHead = await git(repo, ["rev-parse", "epic-target"]);
        const runtime = createSessionRuntime();
        const sessionId = await runtime.createPromptReadySession({ cwd: repo, agentName: "router" });
        const ui = makeLoadUi(["pick_child", "__next_child__", "cancel"]);
        try {
            await runLoadPlanCommand(["epic"], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: ui.uiAPI,
                editor: ui.editor,
            });
            assertStringIncludes(ui.messages.join("\n"), "Plan loaded: epic/02-next");
            const unstarted = await resolvePlanWithPrimaryRecovery(repo, "epic/02-next");
            assertEquals(Boolean(unstarted.plan?.attrs.planId), false);
            assertEquals(await listEntries(repo), []);
            const first = await prepareSessionPlanningWorktree(repo, "epic/02-next");
            assert(first.plan?.attrs.planId);
            assertStringIncludes(first.plan.markdown, "TARGET NEXT BODY");
            const second = await resolvePlanWithPrimaryRecovery(repo, "epic/02-next");
            assertEquals(second.plan?.attrs.planId, first.plan.attrs.planId);
            assertEquals(second.plan?.path, first.plan.path);
            assertEquals((await listEntries(repo)).length, 1);
            assertEquals(await git(repo, ["rev-parse", "epic-target"]), branchHead);
            assertEquals(await loadPlan(repo, "epic/02-next"), null);
        } finally {
            runtime.closeAllSessions();
        }
    });
});

test("Concurrent preparation assigns one identity to an anonymous target child", async () => {
    const repo = await journeyFixture.checkout();
    await git(repo, ["switch", "epic-target"]);
    const childPath = join(repo, "docs/plans/epic/02-next.md");
    await fsWriteFile(childPath, (await fsReadFile(childPath, "utf8")).replace('planId: "plan-child-02"\n', ""));
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "child saved without identity"]);
    await git(repo, ["switch", "main"]);

    const [first, second] = await Promise.all([
        preparePlanningWorktreeForPlan(repo, "epic/02-next", { targetBranch: "epic-target" }),
        preparePlanningWorktreeForPlan(repo, "epic/02-next", { targetBranch: "epic-target" }),
    ]);
    assert(first.plan.attrs.planId);
    assertEquals(second.plan.attrs.planId, first.plan.attrs.planId);
    assertEquals(second.entry.id, first.entry.id);
    assertEquals((await listEntries(repo)).length, 1);

    await git(repo, ["switch", "epic-target"]);
    await fsWriteFile(join(repo, "new-target-code.js"), "published later\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "new target code before identity publication"]);
    await git(repo, ["switch", "main"]);
    const refreshed = await preparePlanningWorktreeForPlan(repo, "epic/02-next", { targetBranch: "epic-target" });
    assertEquals(refreshed.plan.attrs.planId, first.plan.attrs.planId);
    assertEquals(refreshed.entry.id, first.entry.id);
    assertStringIncludes(await fsReadFile(join(refreshed.entry.path, "new-target-code.js"), "utf8"), "published later");
});

test("Epic child selection excludes a saved planning name removed from the Epic branch", async () => {
    const repo = await journeyFixture.checkout();
    const planning = await preparePlanningWorktreeForPlan(repo, "epic/02-next", {
        planId: "plan-child-02",
        targetBranch: "epic-target",
    });
    const savedPath = join(planning.entry.path, "docs/plans/epic/02-next.md");
    await fsWriteFile(savedPath, (await fsReadFile(savedPath, "utf8")) + "\nSAVED PLANNING EDIT\n");
    await git(repo, ["switch", "epic-target"]);
    await git(repo, ["mv", "docs/plans/epic/02-next.md", "docs/plans/epic/03-next.md"]);
    await git(repo, ["commit", "-m", "renumber child"]);
    await git(repo, ["switch", "main"]);

    const children = await findTargetBranchPlansByParent(repo, "epic-target", "epic");
    assertEquals(children.map((child) => child.name).sort(), ["epic/01-done", "epic/03-next"]);
    const snapshot = await resolveWorkflowPlanLocation(repo, "epic/03-next", { readOnly: true });
    assertEquals(snapshot.plan?.attrs.planId, "plan-child-02");
    assertEquals((await listEntries(repo))[0].planName, "epic/02-next");
    const renamed = await prepareSessionPlanningWorktree(repo, "epic/03-next");
    assertEquals(renamed.plan?.attrs.planId, "plan-child-02");
    assertStringIncludes(renamed.plan?.markdown || "", "TARGET NEXT BODY");
    assertStringIncludes(renamed.plan?.markdown || "", "SAVED PLANNING EDIT");
    assertEquals(renamed.documentRoot, planning.entry.path);
    assertEquals(
        (await listEntries(repo)).map((entry) => entry.planName),
        ["epic/03-next"],
    );
});

test("Epic child loading rejects a primary-only name removed from the target", async () => {
    const repo = await journeyFixture.checkout();
    await writePlan(
        repo,
        "epic/02-obsolete",
        {
            planId: "obsolete-child",
            classification: "FEATURE",
            complexity: "MEDIUM",
            status: "ready_for_work",
            parentPlan: "epic",
            targetBranch: "epic-target",
            affectedPaths: [],
        },
        "# Stale primary child\n",
    );
    await assertRejects(
        () => resolvePlanWithPrimaryRecovery(repo, "epic/02-obsolete"),
        Error,
        "does not exist on target",
    );
    assertStringIncludes(await fsReadFile(join(repo, "docs/plans/epic/02-obsolete.md"), "utf8"), "Stale primary child");
});

test("Loading an Epic does not publish stale primary children back to its branch", async () => {
    await withRuntimeCommandFixture("epic-stale-primary-load-", async () => {
        const repo = await journeyFixture.checkout();
        await writePlan(
            repo,
            "epic/02-obsolete",
            {
                planId: "obsolete-child",
                classification: "FEATURE",
                complexity: "MEDIUM",
                status: "ready_for_work",
                parentPlan: "epic",
                targetBranch: "epic-target",
                affectedPaths: [],
            },
            "# Removed child\n",
        );
        const targetChild = await git(repo, ["show", "epic-target:docs/plans/epic/02-next.md"]);
        await fsWriteFile(join(repo, "docs/plans/epic/02-next.md"), targetChild.replace("next.js", "stale.js"));
        const head = await git(repo, ["rev-parse", "epic-target"]);
        const runtime = createSessionRuntime();
        const sessionId = await runtime.createPromptReadySession({ cwd: repo, agentName: "router" });
        const ui = makeLoadUi(["pick_child", "epic/02-next", "view", "back", null, "cancel"]);
        try {
            await runLoadPlanCommand(["epic"], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: ui.uiAPI,
                editor: ui.editor,
            });
            assertStringIncludes(ui.messages.join("\n"), "Planned Change: epic/02-next");
            assertStringIncludes(ui.messages.join("\n"), "next.js");
            assertEquals(await git(repo, ["rev-parse", "epic-target"]), head);
            const children = await findTargetBranchPlansByParent(repo, "epic-target", "epic");
            assertEquals(children.map((child) => child.name).sort(), ["epic/01-done", "epic/02-next"]);
        } finally {
            runtime.closeAllSessions();
        }
    });
});

test("Epic branch collaboration uses the session-started child document", async () => {
    const repo = await journeyFixture.checkout();

    await prepareSessionPlanningWorktree(repo, "epic/02-next");
    const updated = await updatePlanCollaborationMetadata(
        repo,
        "epic/02-next",
        { collaborationRevision: 7 },
        COLLABORATION_LOCK_BYPASS.pull,
    );
    const loaded = await resolveWorkflowPlanLocation(repo, "epic/02-next");
    const primary = await loadPlan(repo, "epic/02-next");

    assertEquals(primary, null);
    assertEquals(updated.planId, "plan-child-02");
    assertEquals(updated.collaborationRevision, 7);
    assert(loaded.documentRoot !== repo);
    assertEquals(loaded.plan?.attrs.collaborationRevision, 7);
});

test("Epic branch target lookup preserves non-Git child Plan loading", async () => {
    const repo = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    await writePlan(
        repo,
        "epic/02-next",
        {
            planId: "plain-child",
            classification: "FEATURE",
            complexity: "MEDIUM",
            status: "ready_for_work",
            parentPlan: "epic",
            targetBranch: "epic-target",
            affectedPaths: [],
            createdAt: "2026-01-01T00:00:00.000Z",
        },
        "# Plain child\n",
    );

    const loaded = await resolveWorkflowPlanLocation(repo, "epic/02-next");

    assertEquals(loaded.documentRoot, repo);
    assertEquals(loaded.plan?.attrs.planId, "plain-child");
});

test("Epic branch manual load and cancel creates no child worktree", async () => {
    await withRuntimeCommandFixture("epic-branch-manual-load-", async () => {
        const repo = await journeyFixture.checkout();
        const runtime = createSessionRuntime();
        const sessionId = await runtime.createPromptReadySession({ cwd: repo, agentName: "router" });
        const ui = makeLoadUi(["cancel"]);
        try {
            await runLoadPlanCommand(["epic/02-next"], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: ui.uiAPI,
                editor: ui.editor,
            });
            const loaded = await resolveWorkflowPlanLocation(repo, "epic/02-next", { readOnly: true });
            const snapshot = runtime.getSessionSnapshot(sessionId);

            assertStringIncludes(ui.messages.join("\n"), "Plan loaded: epic/02-next");
            assertEquals(loaded.documentRoot, repo);
            assertEquals(snapshot?.cwd, await fsRealpath(repo));
            assertEquals(await listEntries(repo), []);
        } finally {
            runtime.closeAllSessions();
        }
    });
});

test("Epic branch manual load uses target child documents and saved planning edits", async () => {
    const repo = await journeyFixture.checkout();
    const plansBefore = await listPlans(repo);
    assert(plansBefore.some((plan) => plan.name === "epic/02-next"));

    const planning = await preparePlanningWorktreeForPlan(repo, "epic/02-next", {
        planId: "plan-child-02",
        targetBranch: "epic-target",
    });
    const planPath = join(planning.entry.path, "docs", "plans", "epic", "02-next.md");
    await fsWriteFile(planPath, (await fsReadFile(planPath, "utf8")).replace("TARGET NEXT BODY", "SAVED PLANNER BODY"));

    const loaded = await resolveWorkflowPlanLocation(repo, "epic/02-next");
    const catalog = await listPlans(repo);
    const listed = catalog.find((plan) => plan.name === "epic/02-next");

    assertEquals(loaded.documentRoot, planning.entry.path);
    assertStringIncludes(loaded.plan?.markdown || "", "SAVED PLANNER BODY");
    assertEquals(listed?.path, planPath);
});

test("Epic branch execution promotion rollback restores planning state", async () => {
    const repo = await journeyFixture.checkout();
    const planning = await preparePlanningWorktreeForPlan(repo, "epic/02-next", {
        planId: "plan-child-02",
        targetBranch: "epic-target",
    });
    const planPath = join(planning.entry.path, "docs", "plans", "epic", "02-next.md");
    await fsWriteFile(
        planPath,
        (await fsReadFile(planPath, "utf8")).replace('status: "ready_for_work"', 'status: "feedback"'),
    );
    const plan = await loadPlan(planning.entry.path, "epic/02-next");
    assert(plan);
    const hostedSession = new HostedSession({ id: "epic-branch-promotion-rollback", cwd: repo, sessionManager: null });

    await startActiveExecutionWorkflow({
        planName: "epic/02-next",
        triageMeta: plan.attrs,
        currentStatus: plan.attrs.status,
        hostedSession,
        ports: createExecutionStartPorts(),
    }).catch(() => null);
    const entries = await listEntries(repo);

    assertEquals(entries.length, 1);
    assertEquals(entries[0].id, planning.entry.id);
    assertEquals(entries[0].status, "planning");
    assertEquals(entries[0].executionBaselineTree, undefined);
});

test("Epic branch execution promotes the saved planning worktree", async () => {
    const repo = await journeyFixture.checkout();
    const planning = await preparePlanningWorktreeForPlan(repo, "epic/02-next", {
        planId: "plan-child-02",
        targetBranch: "epic-target",
    });
    const plan = await loadPlan(planning.entry.path, "epic/02-next");
    assert(plan);
    const hostedSession = new HostedSession({ id: "epic-branch-promotion", cwd: repo, sessionManager: null });

    await startActiveExecutionWorkflow({
        planName: "epic/02-next",
        triageMeta: plan.attrs,
        currentStatus: plan.attrs.status,
        hostedSession,
        ports: createExecutionStartPorts(),
    });
    const workflow = hostedSession.getActiveExecutionWorkflow();
    const entries = await listEntries(repo);

    assertEquals(workflow?.worktreeId, planning.entry.id);
    assertEquals(workflow?.executionCwd, planning.entry.path);
    assertEquals(entries.length, 1);
    assertEquals(entries[0].status, "active");
});

test("A published sequence keeps its parent open while a target-only child remains", async () => {
    const repo = await journeyFixture.checkout();
    await writePlan(
        repo,
        "epic",
        {
            planId: "plan-epic",
            classification: "PROJECT",
            type: "sequence",
            complexity: "HIGH",
            status: "ready_for_work",
            targetBranch: "epic-target",
            affectedPaths: [],
            createdAt: "2026-01-01T00:00:00.000Z",
        },
        "# Epic\n",
    );
    await writePlan(
        repo,
        "epic/01-done",
        {
            planId: "plan-child-01",
            classification: "FEATURE",
            complexity: "MEDIUM",
            status: "reviewed",
            parentPlan: "epic",
            order: 1,
            targetBranch: "epic-target",
            affectedPaths: [],
            createdAt: "2026-01-01T00:00:00.000Z",
        },
        "# First child\n",
    );
    await recordPlanEvent({
        cwd: repo,
        planName: "epic/01-done",
        event: "validation_passed",
        currentStatus: "reviewed",
        details: {
            executionMode: "worktree",
            deliveryEvidence: {
                version: 1,
                mode: "worktree_merge",
                executionCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                targetBranch: "epic-target",
                targetHeadBeforeMerge: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            },
        },
    });
    assertEquals((await loadPlan(repo, "epic"))?.attrs.status, "ready_for_work");
    const result = await resolveEpicContinuation({ cwd: repo, completedPlanName: "epic/01-done" });
    assertEquals(result.kind, "execute");
    assertEquals(result.childPlanName, "epic/02-next");
});

test("Sequence continuation follows the ready target parent when the primary copy is stale", async () => {
    const repo = await journeyFixture.checkout();
    const parent = await loadPlan(repo, "epic");
    assert(parent);
    await writePlan(
        repo,
        "epic",
        {
            planId: "plan-epic",
            classification: "PROJECT",
            type: "sequence",
            complexity: "HIGH",
            status: "draft",
            targetBranch: "epic-target",
            affectedPaths: [],
            createdAt: "2026-01-01T00:00:00.000Z",
        },
        "# Epic\n",
    );
    // The target branch holds the approved sequence and its published children.
    await git(repo, ["switch", "epic-target"]);
    await writePlan(
        repo,
        "epic",
        {
            planId: "plan-epic",
            classification: "PROJECT",
            type: "sequence",
            complexity: "HIGH",
            status: "ready_for_work",
            targetBranch: "epic-target",
            affectedPaths: [],
            createdAt: "2026-01-01T00:00:00.000Z",
        },
        "# Epic\n",
    );
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "approve sequence"]);
    await git(repo, ["switch", "main"]);

    const result = await resolveEpicContinuation({ cwd: repo, completedPlanName: "epic/01-done" });
    assertEquals(result.kind, "execute");
    assertEquals(result.childPlanName, "epic/02-next");
});

test("Epic branch continuation selects the next child from target state", async () => {
    const repo = await journeyFixture.checkout();

    const resolution = await resolveEpicContinuation({ cwd: repo, completedPlanName: "epic/01-done" });

    assertEquals(resolution.kind, "execute");
    assertEquals(resolution.parentPlanName, "epic");
    assertEquals(resolution.childPlanName, "epic/02-next");
    assertEquals(resolution.childAttrs?.planId, "plan-child-02");
    assertEquals(await listEntries(repo), [], "reading the completed child must not create a planning worktree");
});

test("Epic continuation refreshes a preplanned child before execution promotion", async () => {
    await withRuntimeCommandFixture("epic-child-continuation-", async ({ setModelMessages }) => {
        setModelMessages([fauxAssistantMessage(fauxText("Execution session started."))]);
        const repo = await journeyFixture.checkout();
        const remote = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
        await git(remote, ["init", "--bare", "--initial-branch=main"]);
        await git(repo, ["remote", "add", "origin", remote]);
        await git(repo, ["push", "origin", "main", "epic-target"]);
        const first = await preparePlanningWorktreeForPlan(repo, "epic/02-next", {
            planId: "plan-child-02",
            targetBranch: "epic-target",
        });
        const publisher = await journeyFixture.checkout();
        await git(publisher, ["remote", "add", "origin", remote]);
        await git(publisher, ["switch", "epic-target"]);
        await fsWriteFile(join(publisher, "first-child.js"), "published implementation\n");
        await git(publisher, ["add", "."]);
        await git(publisher, ["commit", "-m", "publish first child from isolated checkout"]);
        await git(publisher, ["push", "origin", "epic-target"]);
        const published = await git(publisher, ["rev-parse", "HEAD"]);

        const resolution = await resolveEpicContinuation({ cwd: repo, completedPlanName: "epic/01-done" });
        assertEquals(resolution.kind, "execute");
        assert(resolution.childAttrs);
        const sessionManager = SessionManager.inMemory(repo);
        const hostedSession = new HostedSession({ id: "epic-remote-continuation", cwd: repo, sessionManager });
        hostedSession.setRootSessionManager(sessionManager);
        await runEpicChildContinuation({ hostedSession, resolution, sessionManager });

        const workflow = hostedSession.getActiveExecutionWorkflow();
        assertEquals(workflow?.worktreeId, first.entry.id);
        assertEquals((await listEntries(repo))[0].baseCommit, published);
        assertEquals((await listEntries(repo))[0].status, "active");
        assertEquals(await fsReadFile(join(first.entry.path, "first-child.js"), "utf8"), "published implementation\n");
        assertEquals((await loadPlan(first.entry.path, "epic/02-next"))?.attrs.status, "in_progress");
    });
});

test("Epic branch continuation ignores stale primary completed child status", async () => {
    const repo = await journeyFixture.checkout();
    await writePlan(
        repo,
        "epic/01-done",
        {
            planId: "plan-child-01",
            classification: "FEATURE",
            complexity: "MEDIUM",
            status: "ready_for_work",
            parentPlan: "epic",
            order: 1,
            targetBranch: "epic-target",
            affectedPaths: [],
            createdAt: "2026-01-01T00:00:00.000Z",
        },
        "# Stale done child\n",
    );

    const resolution = await resolveEpicContinuation({ cwd: repo, completedPlanName: "epic/01-done" });

    assertEquals(resolution.kind, "execute");
    assertEquals(resolution.childPlanName, "epic/02-next");
});

test("Epic child lookups and session-less writes leave all Git documents and worktrees unchanged", async () => {
    const repo = await journeyFixture.checkout();
    await git(repo, ["switch", "epic-target"]);
    for (const name of ["03-later", "04-last"]) {
        await writePlan(
            repo,
            `epic/${name}`,
            {
                planId: `plan-${name}`,
                classification: "PLANNED_CHANGE",
                status: "draft",
                parentPlan: "epic",
                targetBranch: "epic-target",
            },
            `# ${name}\n`,
        );
    }
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "add unstarted children"]);
    await git(repo, ["switch", "main"]);
    const worktrees = await git(repo, ["worktree", "list", "--porcelain"]);
    const branches = await git(repo, ["show-ref"]);
    for (const name of ["02-next", "03-later", "04-last"]) {
        const planName = `epic/${name}`;
        const bytes = await git(repo, ["show", `epic-target:docs/plans/${planName}.md`]);
        const location = await resolveWorkflowPlanLocation(repo, planName, { readOnly: true });
        assertEquals(location.planningNotStarted, true);
        assert(location.plan);
        await assertRejects(
            () =>
                recordPlanEvent({
                    cwd: repo,
                    planName,
                    event: "plan_held",
                    currentStatus: location.plan!.attrs.status,
                }),
            PlanningNotStartedError,
            `Start planning ${planName} first`,
        );
        await assertRejects(
            () =>
                updatePlanCollaborationMetadata(
                    repo,
                    planName,
                    { collaborationRevision: 7 },
                    COLLABORATION_LOCK_BYPASS.pull,
                ),
            PlanningNotStartedError,
            "Nothing was changed.",
        );
        await assertRejects(() => pushPlanRevision({ cwd: repo, target: planName }), PlanningNotStartedError);
        await assertRejects(() => sharePlanForReview({ cwd: repo, target: planName }), PlanningNotStartedError);
        await assertRejects(() => unsharePlan({ cwd: repo, target: planName, force: true }), PlanningNotStartedError);
        await assertRejects(
            () => pushPlanRevision({ cwd: repo, target: location.plan!.attrs.planId! }),
            PlanningNotStartedError,
        );
        await assertRejects(
            () => sharePlanForReview({ cwd: repo, target: location.plan!.attrs.planId! }),
            PlanningNotStartedError,
        );
        assertEquals(await git(repo, ["show", `epic-target:docs/plans/${planName}.md`]), bytes);
        assertEquals(await loadPlan(repo, planName), null);
    }
    assertEquals(await listEntries(repo), []);
    assertEquals(await git(repo, ["worktree", "list", "--porcelain"]), worktrees);
    assertEquals(await git(repo, ["show-ref"]), branches);
});

for (const action of ["view", "hold", "user_verify"]) {
    test(`Epic child load and ${action} creates nothing`, async () => {
        await withRuntimeCommandFixture("epic-child-navigation-", async () => {
            const repo = await journeyFixture.checkout();
            const runtime = createSessionRuntime();
            const sessionId = await runtime.createPromptReadySession({ cwd: repo, agentName: "router" });
            const ui = makeLoadUi(action === "hold" ? ["hold", "confirm"] : [action, "cancel"]);
            if (action === "user_verify") ui.uiAPI.promptText = () => Promise.resolve("Checked by user");
            const before = await git(repo, ["show-ref"]);
            try {
                await runLoadPlanCommand(["epic/02-next"], {
                    sessionRuntime: runtime,
                    sessionId,
                    uiAPI: ui.uiAPI,
                    editor: ui.editor,
                });
                if (action !== "view")
                    assertStringIncludes(ui.messages.join("\n"), "Start planning epic/02-next first");
                assertEquals(await listEntries(repo), []);
                assertEquals(await git(repo, ["show-ref"]), before);
                assertEquals((await git(repo, ["worktree", "list", "--porcelain"])).split("worktree ").length, 2);
            } finally {
                await runtime.closeAllSessionsWhenIdle();
            }
        });
    });
}

async function advanceRemoteEpic(repo: string, status: string) {
    const remote = await fsMkdtemp(join(tmpdir(), "epic-session-remote-"));
    await git(remote, ["init", "--bare", "--initial-branch=main"]);
    await git(repo, ["remote", "add", "origin", remote]);
    await git(repo, ["push", "origin", "main", "epic-target"]);
    const publisher = await journeyFixture.checkout();
    await git(publisher, ["remote", "add", "origin", remote]);
    await git(publisher, ["fetch", "origin", "epic-target"]);
    await git(publisher, ["switch", "epic-target"]);
    await git(publisher, ["merge", "--ff-only", "origin/epic-target"]);
    const path = join(publisher, "docs/plans/epic/02-next.md");
    await fsWriteFile(
        path,
        (await fsReadFile(path, "utf8")).replace('status: "ready_for_work"', `status: "${status}"`),
    );
    await fsWriteFile(join(publisher, "published.js"), "latest published code\n");
    await git(publisher, ["add", "."]);
    await git(publisher, ["commit", "-m", "publish preceding child"]);
    await git(publisher, ["push", "origin", "epic-target"]);
    return await git(publisher, ["rev-parse", "HEAD"]);
}

for (const action of ["resume", "planner_re_review", "review", "proceed"]) {
    test(`Epic child ${action} starts its session from the newest remote head`, async () => {
        await withRuntimeCommandFixture("epic-session-start-", async ({ setModelMessages }) => {
            const repo = await journeyFixture.checkout();
            // The locally known child state supplies the menu; only session start fetches the new head.
            if (action === "resume") {
                await git(repo, ["switch", "epic-target"]);
                const path = join(repo, "docs/plans/epic/02-next.md");
                await fsWriteFile(
                    path,
                    (await fsReadFile(path, "utf8")).replace('status: "ready_for_work"', 'status: "draft"'),
                );
                await git(repo, ["add", "."]);
                await git(repo, ["commit", "-m", "draft next child"]);
                await git(repo, ["switch", "main"]);
            }
            const head = await advanceRemoteEpic(repo, action === "resume" ? "draft" : "ready_for_work");
            setModelMessages([fauxAssistantMessage(fauxText("Planning session started."))]);
            const runtime = createSessionRuntime();
            const sessionId = await runtime.createPromptReadySession({ cwd: repo, agentName: "router" });
            runtime.setInteractionAdapter(sessionId, { requestInteraction: () => ({ outcome: "canceled" }) });
            const ui = makeLoadUi([action]);
            try {
                await runLoadPlanCommand(["epic/02-next"], {
                    sessionRuntime: runtime,
                    sessionId,
                    uiAPI: ui.uiAPI,
                    editor: ui.editor,
                });
                const entries = await listEntries(repo);
                assertEquals(entries.length, 1);
                assertEquals(entries[0].baseCommit, head);
                assertEquals(runtime.getSessionSnapshot(sessionId)?.cwd, entries[0].path);
                assertEquals(
                    await fsReadFile(join(entries[0].path, "published.js"), "utf8"),
                    "latest published code\n",
                );
                if (action === "planner_re_review")
                    assertEquals((await loadPlan(entries[0].path, "epic/02-next"))?.attrs.status, "feedback");
            } finally {
                await runtime.closeAllSessionsWhenIdle();
            }
        });
    });
}

for (const status of ["approved", "ready_for_work"]) {
    test(`${status} Sequence child execution creates and promotes a worktree from the newest remote head`, async () => {
        const repo = await journeyFixture.checkout();
        const head = await advanceRemoteEpic(repo, status);
        const hostedSession = new HostedSession({ id: "missing-child-worktree", cwd: repo, sessionManager: null });
        await startActiveExecutionWorkflow({
            planName: "epic/02-next",
            triageMeta: {},
            currentStatus: status,
            hostedSession,
            ports: createExecutionStartPorts(),
        });
        const entries = await listEntries(repo);
        assertEquals(entries.length, 1);
        assertEquals(entries[0].baseCommit, head);
        assertEquals(entries[0].status, "active");
        assertEquals(hostedSession.getActiveExecutionWorkflow()?.executionCwd, entries[0].path);
        assertEquals((await loadPlan(entries[0].path, "epic/02-next"))?.attrs.status, "in_progress");
    });
}

test("published target-only child lookup selects the delivered snapshot without a worktree", async () => {
    const repo = await journeyFixture.checkout();
    await git(repo, ["switch", "epic-target"]);
    const path = join(repo, "docs/plans/epic/02-next.md");
    await fsWriteFile(path, (await fsReadFile(path, "utf8")).replace('status: "ready_for_work"', 'status: "verified"'));
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "deliver child"]);
    await git(repo, ["switch", "main"]);
    const before = await git(repo, ["show-ref"]);
    const location = await resolveWorkflowPlanLocation(repo, "epic/02-next");
    assertEquals(location.plan?.attrs.status, "verified");
    assertEquals(location.publishedSnapshot, true);
    assertEquals(await listEntries(repo), []);
    assertEquals(await git(repo, ["show-ref"]), before);
});

test("Plan location reads do not fetch an advanced remote into project refs", async () => {
    const repo = await journeyFixture.checkout();
    const published = await advanceRemoteEpic(repo, "ready_for_work");
    const refs = await git(repo, ["show-ref"]);
    const worktrees = await git(repo, ["worktree", "list", "--porcelain"]);
    await resolveWorkflowPlanLocation(repo, "epic/02-next", { readOnly: true });
    await assertRejects(() => resolveWorkflowPlanLocation(repo, "epic/02-next"), PlanningNotStartedError);
    assertEquals(await git(repo, ["show-ref"]), refs);
    assertEquals(await git(repo, ["worktree", "list", "--porcelain"]), worktrees);
    assertEquals(await listEntries(repo), []);
    const started = await prepareSessionPlanningWorktree(repo, "epic/02-next");
    assertEquals((await listEntries(repo))[0].baseCommit, published);
    assert(started.documentRoot !== repo);
});

test("Workspace saved review starts an unstarted target-only child session", async () => {
    await withRuntimeCommandFixture("epic-workspace-review-", async () => {
        const repo = await journeyFixture.checkout();
        const runtime = createSessionRuntime();
        const sessionId = await runtime.createPromptReadySession({ cwd: repo, agentName: "router" });
        let reviewRoot = "";
        runtime.setInteractionAdapter(sessionId, {
            requestInteraction: async () => {
                const entries = await listEntries(repo);
                assertEquals(entries.length, 1);
                reviewRoot = entries[0].path;
                const plan = await loadPlan(reviewRoot, "epic/02-next");
                assert(plan);
                return { outcome: "canceled" };
            },
        });
        try {
            await runtime.reviewSavedPlan(sessionId, "plan-child-02");
            assert(reviewRoot && reviewRoot !== repo);
            assertEquals(runtime.getSessionSnapshot(sessionId)?.cwd, reviewRoot);
            assertEquals(await loadPlan(repo, "epic/02-next"), null);
        } finally {
            await runtime.closeAllSessionsWhenIdle();
        }
    });
});

for (const parentDocument of [false, true]) {
    test(`unstarted child refuses lifecycle and collaboration writes with parent document ${parentDocument}`, async () => {
        const repo = await journeyFixture.checkout();
        if (parentDocument) {
            await preparePlanningWorktreeForPlan(repo, "epic", { planId: "plan-epic", targetBranch: "epic-target" });
        }
        const location = await resolveWorkflowPlanLocation(repo, "epic/02-next", { readOnly: true });
        assert(location.plan);
        const before = location.plan.markdown;
        const entries = await listEntries(repo);
        const refs = await git(repo, ["show-ref"]);
        await assertRejects(
            () =>
                recordPlanEvent({
                    cwd: repo,
                    planName: "epic/02-next",
                    event: "plan_held",
                    currentStatus: "ready_for_work",
                }),
            PlanningNotStartedError,
        );
        await assertRejects(
            () =>
                updatePlanCollaborationMetadata(
                    repo,
                    "epic/02-next",
                    {
                        collaborationRevision: 7,
                    },
                    COLLABORATION_LOCK_BYPASS.pull,
                ),
            PlanningNotStartedError,
        );
        const evidence = await loadPlanActionEvidence(repo, "plan-child-02");
        assert(evidence.kind === "success", JSON.stringify(evidence));
        const result = await executePlanAction(repo, {
            planId: evidence.evidence.planId,
            expectedRevision: evidence.evidence.revision,
            expectedStatus: evidence.evidence.status,
            expectedWorktree: evidence.evidence.worktree,
            action: "put_on_hold",
        });
        assertEquals(result.kind, "invalid_action");
        assertStringIncludes(result.message, "Start planning epic/02-next first");
        assertStringIncludes(result.message, "Nothing was changed.");
        assertEquals(
            (await resolveWorkflowPlanLocation(repo, "epic/02-next", { readOnly: true })).plan?.markdown,
            before,
        );
        assertEquals(await listEntries(repo), entries);
        assertEquals(await git(repo, ["show-ref"]), refs);
    });
}

test("execution sends Engineer the fetched child scope instead of the primary snapshot", async () => {
    await withRuntimeCommandFixture("epic-engineer-scope-", async ({ setModelResponseFactory }) => {
        const repo = await journeyFixture.checkout();
        const target = await resolveWorkflowPlanLocation(repo, "epic/02-next", { readOnly: true });
        assert(target.plan);
        await fsMkdir(join(repo, "docs/plans/epic"), { recursive: true });
        await fsWriteFile(
            join(repo, "docs/plans/epic/02-next.md"),
            target.plan.markdown.replace("TARGET NEXT BODY", "STALE PRIMARY SCOPE"),
        );
        await advanceRemoteEpic(repo, "ready_for_work");
        const remote = await git(repo, ["remote", "get-url", "origin"]);
        const publisher = await journeyFixture.checkout();
        await git(publisher, ["remote", "add", "origin", remote]);
        await git(publisher, ["fetch", "origin"]);
        await git(publisher, ["switch", "epic-target"]);
        await git(publisher, ["merge", "--ff-only", "origin/epic-target"]);
        const path = join(publisher, "docs/plans/epic/02-next.md");
        await fsWriteFile(path, (await fsReadFile(path, "utf8")).replace("TARGET NEXT BODY", "NEW REMOTE SCOPE"));
        await git(publisher, ["add", "."]);
        await git(publisher, ["commit", "-m", "update child scope"]);
        await git(publisher, ["push", "origin", "epic-target"]);
        let prompt = "";
        setModelResponseFactory((context) => {
            prompt = JSON.stringify(context.messages);
            return fauxAssistantMessage(fauxText("Paused after reading the Plan."));
        });
        const sessionManager = SessionManager.inMemory(repo);
        const hostedSession = new HostedSession({ id: "fresh-engineer-scope", cwd: repo, sessionManager });
        hostedSession.setRootSessionManager(sessionManager);
        try {
            const result = await executePlan({ planName: "epic/02-next", sessionManager, hostedSession });
            assert(!result.error, result.error || "Execution should start");
            assertStringIncludes(prompt, "NEW REMOTE SCOPE");
            assertEquals(prompt.includes("STALE PRIMARY SCOPE"), false);
            assertEquals(prompt.includes("TARGET NEXT BODY"), false);
        } finally {
            hostedSession.dispose();
        }
    });
});

test("load-plan can cancel missing checkout recovery then continue from the saved execution branch", async () => {
    await withRuntimeCommandFixture("epic-lost-checkout-", async ({ setModelMessages }) => {
        const repo = await journeyFixture.checkout();
        const hostedSession = new HostedSession({ id: "lost-checkout", cwd: repo, sessionManager: null });
        await startActiveExecutionWorkflow({
            planName: "epic/02-next",
            triageMeta: {},
            currentStatus: "ready_for_work",
            hostedSession,
            ports: createExecutionStartPorts(),
        });
        const workflow = hostedSession.getActiveExecutionWorkflow();
        assert(workflow?.executionCwd);
        await fsWriteFile(join(workflow.executionCwd, "saved-work.js"), "saved execution work\n");
        await git(workflow.executionCwd, ["add", "."]);
        await git(workflow.executionCwd, ["commit", "-m", "save execution work"]);
        await fsRm(workflow.executionCwd, { recursive: true });
        const runtime = createSessionRuntime();
        const sessionId = await runtime.createPromptReadySession({ cwd: repo, agentName: "router" });
        try {
            const cancelled = makeLoadUi(["cancel"]);
            await runLoadPlanCommand(["epic/02-next"], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: cancelled.uiAPI,
                editor: cancelled.editor,
            });
            assertStringIncludes(cancelled.messages.join("\n"), "Plan loaded: epic/02-next");
            assertEquals(
                await fsStat(workflow.executionCwd)
                    .then(() => true)
                    .catch(() => false),
                false,
            );
            setModelMessages([fauxAssistantMessage(fauxText("Saved execution resumed."))]);
            const resumed = makeLoadUi(["continue"]);
            await runLoadPlanCommand(["epic/02-next"], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI: resumed.uiAPI,
                editor: resumed.editor,
            });
            assertEquals(
                await fsStat(workflow.executionCwd)
                    .then(() => true)
                    .catch(() => false),
                true,
            );
            assertEquals((await listEntries(repo))[0].id, workflow.worktreeId);
            assertEquals((await loadPlan(workflow.executionCwd, "epic/02-next"))?.attrs.status, "in_progress");
        } finally {
            await runtime.closeAllSessionsWhenIdle();
            hostedSession.dispose();
        }
    });
});

test("Epic child session start does not replace published scope with a stale parent planning copy", async () => {
    const repo = await journeyFixture.checkout();
    const parent = await preparePlanningWorktreeForPlan(repo, "epic", {
        planId: "plan-epic",
        targetBranch: "epic-target",
    });
    const parentChild = join(parent.entry.path, "docs/plans/epic/02-next.md");
    await fsWriteFile(
        parentChild,
        (await fsReadFile(parentChild, "utf8")).replace("TARGET NEXT BODY", "STALE PARENT SCOPE"),
    );
    await git(repo, ["switch", "epic-target"]);
    const targetChild = join(repo, "docs/plans/epic/02-next.md");
    await fsWriteFile(
        targetChild,
        (await fsReadFile(targetChild, "utf8")).replace("TARGET NEXT BODY", "PUBLISHED CHILD SCOPE"),
    );
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "publish newer child scope"]);
    await git(repo, ["switch", "main"]);

    const prepared = await prepareSessionPlanningWorktree(repo, "epic/02-next");
    assertStringIncludes(prepared.plan?.markdown || "", "PUBLISHED CHILD SCOPE");
    assertEquals(prepared.plan?.markdown.includes("STALE PARENT SCOPE"), false);
    assertStringIncludes(await fsReadFile(parentChild, "utf8"), "STALE PARENT SCOPE");
});

test("anonymous Sequence child keeps its prepared identity when importing the reviewed parent document", async () => {
    const repo = await journeyFixture.checkout();
    await git(repo, ["switch", "epic-target"]);
    const parentPath = join(repo, "docs/plans/epic.md");
    await fsWriteFile(
        parentPath,
        (await fsReadFile(parentPath, "utf8")).replace(
            'classification: "PROJECT"',
            'classification: "PROJECT"\ntype: "sequence"',
        ),
    );
    const targetChild = join(repo, "docs/plans/epic/02-next.md");
    await fsWriteFile(targetChild, (await fsReadFile(targetChild, "utf8")).replace('planId: "plan-child-02"\n', ""));
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "anonymous Sequence child"]);
    await git(repo, ["switch", "main"]);
    const parent = await preparePlanningWorktreeForPlan(repo, "epic", {
        planId: "plan-epic",
        targetBranch: "epic-target",
    });
    const parentChild = join(parent.entry.path, "docs/plans/epic/02-next.md");
    await fsWriteFile(
        parentChild,
        (await fsReadFile(parentChild, "utf8")).replace("TARGET NEXT BODY", "REVIEWED SEQUENCE SCOPE"),
    );

    const prepared = await prepareSessionPlanningWorktree(repo, "epic/02-next");
    assert(prepared.plan?.attrs.planId);
    assertStringIncludes(prepared.plan.markdown, "REVIEWED SEQUENCE SCOPE");
    const child = (await listEntries(repo)).find((entry) => entry.planName === "epic/02-next");
    assertEquals(prepared.plan.attrs.planId, child?.planId);
    const loaded = await resolvePlanWithPrimaryRecovery(repo, "epic/02-next");
    assertEquals(loaded.plan.attrs.planId, prepared.plan.attrs.planId);
    const resumed = await prepareSessionPlanningWorktree(repo, "epic/02-next");
    assertEquals(resumed.documentRoot, prepared.documentRoot);
    assertEquals(resumed.plan?.attrs.planId, prepared.plan.attrs.planId);
});
