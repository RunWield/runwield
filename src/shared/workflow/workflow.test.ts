import { writeRuntimeExecutableFixture } from "../../testing/runtime-executable-fixture.ts";
import { delimiter } from "node:path";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    mkdir as fsMkdir,
    rename as fsRename,
    symlink as fsSymlink,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    realpath as fsRealpath,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { rmSync as fsRmSync, writeFileSync as fsWriteFileSync } from "node:fs";
import process from "node:process";
import { assertEquals, assertExists, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { createWorktreeGitArtifacts, settleWorktreeAttempt } from "../worktree.ts";
import {
    extractAssistantOutput,
    finalizePlanImplementation,
    readLatestPlanOutcome,
    runPlanningAgent,
    startActiveExecutionWorkflow,
    type FinalizePlanImplementationOptions,
} from "./workflow.ts";
import { HostedSession } from "../session/hosted-session.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { loadPlan, savePlan, type PlanFrontMatterInput } from "../../plan-store.ts";
import { getTransitionJournalDir } from "./state-transition.ts";
import { createExecutionStartPorts } from "./execution-start.ts";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";
import type { SessionRuntimeEventSink } from "../session/session-host.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { setCustomSetting } from "../settings.ts";
import { getCwd } from "../../constants.ts";
import {
    findById as findWorktreeRegistryEntryById,
    listEntries as listWorktreeRegistryEntries,
} from "../worktree-registry.ts";

function makeHostedSession(id = "workflow-test", cwd = getCwd()) {
    return new HostedSession({ id, cwd, sessionManager: null });
}

function makeAgentHostedSession(id: string, cwd: string) {
    const sessionManager = SessionManager.inMemory(cwd);
    const hostedSession = new HostedSession({ id, cwd });
    hostedSession.setRootSessionManager(sessionManager);
    return { hostedSession, sessionManager };
}

const projectsToRemove: string[] = [];
let projectCleanupRegistered = false;

function registerProjectCleanup() {
    if (projectCleanupRegistered) return;
    projectCleanupRegistered = true;
    globalThis.addEventListener("unload", () => {
        for (const path of projectsToRemove) {
            try {
                fsRmSync(path, { recursive: true });
            } catch {
                // Best effort; a leftover temp directory must not fail a passing run.
            }
        }
    });
}

const workflowRepo = defineCommittedGitFixture();

/** The durable Plan identity shared by the fixture Plan and the `triageMeta` naming it. */
const PLAN_UNDER_TEST = "plan-under-test";

interface WorkflowFixturePlan extends Pick<PlanFrontMatterInput, "status" | "classification"> {
    name: string;
    attrs?: PlanFrontMatterInput;
}

type RuntimeEventDraft = Parameters<SessionRuntimeEventSink["emit"]>[0];
type ExecutionContext = NonNullable<FinalizePlanImplementationOptions["executionContext"]>;

/**
 * A real project: a real Git repository holding real Plans.
 *
 * The Plan Lifecycle *and* the worktree registry are RunWield's own machinery, not
 * external boundaries, so these tests run them for real against a temp project rather
 * than injecting stand-ins. A faked lifecycle returns whatever the fake says and hides
 * what the transition actually wrote — which is how a workflow assertion once passed
 * against state that only existed because the lifecycle was not running.
 *
 * The repository is real for the same reason: `startActiveExecutionWorkflow` proves its
 * own work by stat-ing the worktree and re-reading the registry entry it settled, and
 * those proofs mean nothing against a directory Git never made.
 */
async function makeWorkflowProject(plans: (string | WorkflowFixturePlan)[]) {
    const cwd = await workflowRepo.checkout({ prefix: "runwield-workflow-" });
    projectsToRemove.push(cwd);
    registerProjectCleanup();
    for (const [index, entry] of plans.entries()) {
        const plan = typeof entry === "string" ? { name: entry } : entry;
        await savePlan(cwd, plan.name, `# ${plan.name}`, {
            classification: plan.classification || "PLANNED_CHANGE",
            status: plan.status || "ready_for_work",
            summary: plan.name,
            affectedPaths: [],
            // A Plan that reached execution already has its durable identity. Without
            // it, ensurePlanIdentity backfills one mid-transaction and the execution
            // preparation transaction correctly rejects its own snapshot as stale.
            //
            // The first Plan gets PLAN_UNDER_TEST because it is the one callers name
            // in `triageMeta.planId`, and those two identities have to agree: the
            // preparation transaction re-reads the Plan it materialized into the
            // worktree and rejects a copy whose id is not the one it prepared. They
            // silently disagreed while that check was gated off for injected deps.
            planId: index === 0 ? PLAN_UNDER_TEST : `plan-${plan.name.replace(/[^a-z0-9]+/gi, "-")}`,
            ...(plan.attrs || {}),
        });
    }
    return cwd;
}

test("startActiveExecutionWorkflow continues an existing in-progress worktree", async () => {
    const projectRoot = await makeWorkflowProject([
        {
            name: "continued-plan",
            status: "in_progress",
            attrs: {},
        },
    ]);
    const hostedSession = makeHostedSession("continued-workflow", projectRoot);
    const recorded = await settleWorktreeAttempt(
        projectRoot,
        await createWorktreeGitArtifacts({ projectRoot, planName: "continued-plan", planId: PLAN_UNDER_TEST }),
    );
    await savePlan(recorded.path, "continued-plan", "# continued-plan", {
        planId: PLAN_UNDER_TEST,
        status: "in_progress",
    });
    await fsWriteFile(`${recorded.path}/continued-implementation.ts`, "export const continued = true;\n");
    await git(recorded.path, ["add", "continued-implementation.ts"]);
    await git(recorded.path, ["commit", "-m", "complete continued implementation"]);

    const workflow = await startActiveExecutionWorkflow({
        planName: "continued-plan",
        triageMeta: { planId: PLAN_UNDER_TEST, worktreeId: recorded.id },
        currentStatus: "in_progress",
        hostedSession,
        ports: createExecutionStartPorts(),
    });

    assertEquals(workflow.worktreeId, recorded.id);
    assertEquals(workflow.executionCwd, recorded.path);
    assertEquals(workflow.baselineTree, recorded.baseTree);
    const plan = await loadPlan(recorded.path, "continued-plan");
    assertEquals(plan?.attrs.status, "in_progress");
    assertEquals(hostedSession.getActiveExecutionWorkflow()?.planName, "continued-plan");
});

test("startActiveExecutionWorkflow indexes a newly created execution worktree", async () => {
    await withProcessGlobalTestLock(async () => {
        const projectRoot = await makeWorkflowProject([{ name: "indexed-plan", status: "ready_for_work" }]);
        const hostedSession = makeHostedSession("indexed-workflow", projectRoot);
        const events: RuntimeEventDraft[] = [];
        hostedSession.setEventSink((event: RuntimeEventDraft) => events.push(event));
        const binDir = await fsMkdtemp(join(tmpdir(), "runwield-fake-cymbal-bin-"));
        const markerPath = `${binDir}/cymbal-marker.txt`;
        const cymbalPath = `${binDir}/cymbal`;
        const previousPath = process.env["PATH"] || "";
        const previousMarker = process.env["RUNWIELD_CYMBAL_MARKER"];
        const cymbalSource = join(binDir, "cymbal.mjs");
        await fsWriteFile(
            cymbalSource,
            `
import { writeFileSync, realpathSync } from "node:fs";
writeFileSync(process.env.RUNWIELD_CYMBAL_MARKER, realpathSync(process.cwd()) + "\\n" + process.argv.slice(2).join(" ") + "\\n");
`,
        );
        await writeRuntimeExecutableFixture(cymbalPath, cymbalSource);
        process.env["PATH"] = `${binDir}${delimiter}${previousPath}`;
        process.env["RUNWIELD_CYMBAL_MARKER"] = markerPath;
        try {
            const result = await startActiveExecutionWorkflow({
                planName: "indexed-plan",
                triageMeta: { planId: PLAN_UNDER_TEST, classification: "FEATURE" },
                currentStatus: "ready_for_work",
                hostedSession,
                ports: createExecutionStartPorts(),
            });

            const marker = (await fsReadFile(markerPath, "utf8")).trim().split("\n");
            assertExists(result.executionCwd);
            assertEquals(marker, [await fsRealpath(result.executionCwd), "index ."]);
            assertEquals(
                events.some(
                    (event) => "message" in event && event.message === "Indexing the worktree for code search...",
                ),
                true,
            );
        } finally {
            process.env["PATH"] = previousPath;
            if (previousMarker === undefined) {
                delete process.env["RUNWIELD_CYMBAL_MARKER"];
            } else {
                process.env["RUNWIELD_CYMBAL_MARKER"] = previousMarker;
            }
            await fsRm(binDir, { recursive: true }).catch(() => {});
        }
    });
});

test("startActiveExecutionWorkflow bases the execution worktree on the requested target branch", async () => {
    const projectRoot = await makeWorkflowProject([
        {
            name: "targeted-plan",
            status: "ready_for_work",
            attrs: { targetBranch: " feature-base " },
        },
    ]);
    await setCustomSetting("plans", { autoMergeIntoTargetBranch: true }, "project", projectRoot);
    const hostedSession = makeHostedSession("targeted-workflow", projectRoot);
    await fsWriteFile(`${projectRoot}/current-only-marker`, "present only in the current checkout\n");

    const result = await startActiveExecutionWorkflow({
        // Padded on purpose: the target branch arrives from Front Matter a user edited.
        planName: "targeted-plan",
        triageMeta: { planId: "plan-under-test", targetBranch: " feature-base " },
        currentStatus: "ready_for_work",
        hostedSession,
        ports: createExecutionStartPorts(),
    });

    // Asserted through Git rather than through the arguments handed to a fake: the
    // question is what the worktree was actually branched from, and only the repository
    // can answer that.
    assertEquals(result.worktreeBaseBranch, "feature-base");
    assertExists(result.worktreeId);
    const entry = await findWorktreeRegistryEntryById(projectRoot, result.worktreeId);
    assertEquals(entry?.baseRef, "refs/heads/feature-base");
    assertEquals(entry?.baseBranch, "feature-base");
    const targetCommit = await git(projectRoot, ["rev-parse", "refs/heads/feature-base"]);
    const preparationCommit = await git(projectRoot, ["rev-parse", `${result.worktreeBranch}^{commit}`]);
    assertEquals(
        await git(projectRoot, ["rev-parse", `${preparationCommit}^`]),
        targetCommit,
        "the RunWield preparation commit is based directly on the selected target",
    );
    assertEquals(preparationCommit === targetCommit, false);
    assertStringIncludes(
        await git(projectRoot, ["show", "-s", "--format=%s", preparationCommit]),
        "Prepare targeted-plan execution",
    );
    assertStringIncludes(
        await git(projectRoot, ["ls-tree", "-r", "--name-only", preparationCommit]),
        "docs/plans/targeted-plan.md",
    );
    assertExists(result.executionCwd);
    assertEquals(await git(result.executionCwd, ["status", "--porcelain"]), "");
    const plan = await loadPlan(result.executionCwd, "targeted-plan");
    assertEquals(plan?.attrs.status, "in_progress");
});

test("startActiveExecutionWorkflow uses the latest uncommitted Plan revision instead of the target branch copy", async () => {
    const projectRoot = await makeWorkflowProject([
        {
            name: "revised-before-execution",
            status: "ready_for_work",
            attrs: {},
        },
    ]);
    await git(projectRoot, ["add", "."]);
    await git(projectRoot, ["commit", "-m", "commit old Plan revision"]);
    const committedPlan = await loadPlan(projectRoot, "revised-before-execution");
    if (!committedPlan) throw new Error("committed Plan fixture disappeared");
    await savePlan(
        projectRoot,
        "revised-before-execution",
        "# Latest approved Plan\n\n## Context\n\nlatest approved Plan",
        {
            classification: "PLANNED_CHANGE",
            status: "ready_for_work",
            summary: "latest approved Plan",
            affectedPaths: [],
            planId: PLAN_UNDER_TEST,
        },
        { expectedRevision: committedPlan.revision },
    );
    const hostedSession = makeHostedSession("revised-before-execution", projectRoot);
    let executionCwd;
    try {
        const result = await startActiveExecutionWorkflow({
            planName: "revised-before-execution",
            triageMeta: { planId: PLAN_UNDER_TEST, classification: "PLANNED_CHANGE" },
            currentStatus: "ready_for_work",
            hostedSession,
            ports: createExecutionStartPorts(),
        });
        executionCwd = result.executionCwd;
        assertExists(executionCwd);
        const executionPlan = await loadPlan(executionCwd, "revised-before-execution");
        assertEquals(executionPlan?.body.trim(), "# Latest approved Plan\n\n## Context\n\nlatest approved Plan");
        assertEquals(executionPlan?.attrs.summary, "latest approved Plan");
    } finally {
        hostedSession.dispose();
        if (executionCwd) {
            await git(projectRoot, ["worktree", "remove", "--force", executionCwd]).catch(() => "");
        }
    }
});

test("startActiveExecutionWorkflow captures baseline after first Plan materialization", async () => {
    const projectRoot = await makeWorkflowProject([{ name: "p", status: "ready_for_work" }]);
    const hostedSession = makeHostedSession("baseline-after-plan-restore", projectRoot);
    // The target commit has no Plan: initial materialization must use the approved
    // source and capture the baseline afterwards. A stale Session is not authority.
    hostedSession.setActiveExecutionWorkflow({
        planName: "p",
        triageMeta: { planId: PLAN_UNDER_TEST },
        executionAgent: "engineer",
        executionMode: "worktree",
        baselineTree: "stale-tree-without-plan",
        projectRoot: hostedSession.cwd,
        executionCwd: "/not-a-registered-attempt",
        worktreeId: "retired",
        worktreeBranch: "worktree/retired",
        worktreeBaseBranch: "main",
    });

    const result = await startActiveExecutionWorkflow({
        planName: "p",
        triageMeta: { planId: PLAN_UNDER_TEST },
        currentStatus: "ready_for_work",
        hostedSession,
        ports: createExecutionStartPorts(),
    });

    // The ordering used to be asserted by spying on the Plan restore and the baseline
    // capture. It did not need to be: a baseline that contains the restored Plan can
    // only have been captured after the restore, and a stale baseline recorded on the
    // session proves it was recomputed. The evidence below says both, without making
    // either step replaceable.
    assertEquals(result.baselineTree !== "stale-tree-without-plan", true);
    assertExists(result.executionCwd);
    assertExists(result.baselineTree);
    const baselineFiles = await git(result.executionCwd, ["ls-tree", "-r", "--name-only", result.baselineTree]);
    assertStringIncludes(baselineFiles, "docs/plans/p.md");
});

test("startActiveExecutionWorkflow rejects an unsafe canonical source before worktree selection or creation", async () => {
    const projectRoot = await makeWorkflowProject([{ name: "p", status: "ready_for_work" }]);
    const hostedSession = makeHostedSession("canonical-source-before-worktree", projectRoot);
    await fsRename(join(projectRoot, "docs/plans"), join(projectRoot, "docs/saved-plans"));
    await fsSymlink("saved-plans", join(projectRoot, "docs/plans"));

    await assertRejects(
        () =>
            startActiveExecutionWorkflow({
                planName: "p",
                triageMeta: { planId: PLAN_UNDER_TEST, worktreeId: "wt-recorded" },
                currentStatus: "ready_for_work",
                hostedSession,
                ports: createExecutionStartPorts(),
            }),
        Error,
        "docs/plans/p.md",
    );

    // "Before creation" is a claim about the repository and the registry, so ask them
    // rather than a fake that was told to refuse.
    assertEquals(await listWorktreeRegistryEntries(projectRoot), []);
    assertStringIncludes(
        await git(projectRoot, ["worktree", "list", "--porcelain"]),
        projectRoot.replaceAll("\\", "/"),
    );
    assertEquals((await git(projectRoot, ["worktree", "list", "--porcelain"])).includes("refs/heads/worktree/"), false);
});

test("startActiveExecutionWorkflow preserves a malformed derived Plan and blocks", async () => {
    const projectRoot = await makeWorkflowProject([{ name: "p", status: "ready_for_work" }]);
    const hostedSession = makeHostedSession("reused-plan-block", projectRoot);
    const reused = await settleWorktreeAttempt(
        projectRoot,
        await createWorktreeGitArtifacts({ projectRoot, planName: "p", planId: PLAN_UNDER_TEST }),
    );
    // Really malformed, rather than a stand-in reporting that it would have been:
    // preparation has to parse this file and refuse on what it finds. The worktree
    // carries no Plan of its own — restoring one is the step being blocked here.
    await fsMkdir(`${reused.path}/docs/plans`, { recursive: true });
    await fsWriteFile(`${reused.path}/docs/plans/p.md`, "---\nnot: [valid\n---\n\n# broken\n");

    try {
        await assertRejects(
            () =>
                startActiveExecutionWorkflow({
                    planName: "p",
                    triageMeta: { planId: PLAN_UNDER_TEST, worktreeId: reused.id },
                    currentStatus: "ready_for_work",
                    hostedSession,
                    ports: createExecutionStartPorts(),
                }),
            Error,
            "could not be parsed",
        );

        assertEquals((await fsStat(reused.path)).isDirectory(), true);
        assertEquals((await findWorktreeRegistryEntryById(projectRoot, reused.id))?.status, "active");
        assertEquals((await loadPlan(projectRoot, "p"))?.attrs.status, "ready_for_work");
        assertStringIncludes(await fsReadFile(`${reused.path}/docs/plans/p.md`, "utf8"), "not: [valid");
    } finally {
        await fsRm(getTransitionJournalDir(hostedSession.cwd), { recursive: true }).catch(() => {});
    }
});

test("startActiveExecutionWorkflow rolls back a worktree that fails before execution begins", async () => {
    const projectRoot = await makeWorkflowProject([
        {
            name: "p",
            status: "ready_for_work",
            attrs: { targetBranch: "docs-as-file" },
        },
    ]);
    const hostedSession = makeHostedSession("fresh-cleanup-failure", projectRoot);
    // A branch whose tree has `docs` as a *file*, built with plumbing so the working
    // tree is untouched. A worktree checked out from it cannot hold docs/plans/p.md, so the
    // real Plan restore fails on the real filesystem — after the worktree exists, which
    // is what gives the rollback below something to preserve. Faking the restore's
    // return value would have skipped both the checkout and the failure.
    const branchRoot = await fsMkdtemp(join(tmpdir(), "runwield-docs-as-file-"));
    await git(projectRoot, ["worktree", "add", "--detach", branchRoot]);
    await fsWriteFile(`${branchRoot}/docs`, "not a directory\n");
    await git(branchRoot, ["add", "docs"]);
    await git(branchRoot, [
        "-c",
        "user.email=tests@example.com",
        "-c",
        "user.name=RunWield Tests",
        "commit",
        "-m",
        "docs as a file",
    ]);
    await git(branchRoot, ["branch", "docs-as-file"]);
    await git(projectRoot, ["worktree", "remove", "--force", branchRoot]);
    try {
        await assertRejects(
            () =>
                startActiveExecutionWorkflow({
                    planName: "p",
                    triageMeta: { planId: PLAN_UNDER_TEST, targetBranch: "docs-as-file" },
                    currentStatus: "ready_for_work",
                    hostedSession,
                    ports: createExecutionStartPorts(),
                }),
            Error,
            "no Agent work began",
        );

        const entries = await listWorktreeRegistryEntries(projectRoot);
        assertEquals(entries.length, 0);
    } finally {
        await fsRm(getTransitionJournalDir(hostedSession.cwd), { recursive: true }).catch(() => {});
    }
});

test("startActiveExecutionWorkflow bases untargeted plans on the repository default branch", async () => {
    const projectRoot = await makeWorkflowProject([{ name: "untargeted-plan", status: "ready_for_work" }]);
    await setCustomSetting("plans", { autoMergeIntoTargetBranch: true }, "project", projectRoot);
    const hostedSession = makeHostedSession("untargeted-workflow", projectRoot);
    const result = await startActiveExecutionWorkflow({
        planName: "untargeted-plan",
        triageMeta: { planId: PLAN_UNDER_TEST, worktreeStatus: "completed" },
        currentStatus: "ready_for_work",
        hostedSession,
        ports: createExecutionStartPorts(),
    });

    assertExists(result.worktreeId);
    const entry = await findWorktreeRegistryEntryById(projectRoot, result.worktreeId);
    // No declared target means the current branch is the target. Naming its ref
    // explicitly lets repositories with an upstream prefer the fetched remote ref
    // without ever moving the user's checkout.
    assertEquals(entry?.baseRef, "refs/heads/main");
    assertEquals(result.worktreeBaseBranch, "main");
    const targetCommit = await git(projectRoot, ["rev-parse", "HEAD"]);
    const preparationCommit = await git(projectRoot, ["rev-parse", `${result.worktreeBranch}^{commit}`]);
    assertEquals(await git(projectRoot, ["rev-parse", `${preparationCommit}^`]), targetCommit);
    assertEquals(preparationCommit === targetCommit, false);
});

test("startActiveExecutionWorkflow resolves implicit current branch before reusing a recorded worktree", async () => {
    const projectRoot = await makeWorkflowProject([{ name: "untargeted-plan", status: "ready_for_work" }]);
    const hostedSession = makeHostedSession("implicit-target-reuse-workflow", projectRoot);
    const recorded = await settleWorktreeAttempt(
        projectRoot,
        await createWorktreeGitArtifacts({ projectRoot, planName: "untargeted-plan", planId: PLAN_UNDER_TEST }),
    );
    await savePlan(recorded.path, "untargeted-plan", "# untargeted-plan", {
        status: "ready_for_work",
        planId: PLAN_UNDER_TEST,
    });
    const result = await startActiveExecutionWorkflow({
        planName: "untargeted-plan",
        triageMeta: { planId: PLAN_UNDER_TEST, worktreeId: recorded.id },
        currentStatus: "ready_for_work",
        hostedSession,
        ports: createExecutionStartPorts(),
    });

    // Reused, not recreated: same attempt, and the Plan never targeted a branch, so the
    // recorded target is the checkout's own branch resolved at reuse time.
    assertEquals(result.worktreeId, recorded.id);
    assertEquals(result.executionCwd, recorded.path);
    assertEquals(result.worktreeBaseBranch, "main");
    const entry = await findWorktreeRegistryEntryById(projectRoot, recorded.id);
    assertEquals(entry?.status, "active");
    assertEquals(entry?.executionBaselineTree, result.baselineTree);
});

test("startActiveExecutionWorkflow rejects reusable worktree target mismatches", async () => {
    const projectRoot = await makeWorkflowProject([{ name: "targeted-plan", status: "ready_for_work" }]);
    const hostedSession = makeHostedSession("mismatched-workflow", projectRoot);
    const recorded = await settleWorktreeAttempt(
        projectRoot,
        await createWorktreeGitArtifacts({ projectRoot, planName: "targeted-plan", planId: PLAN_UNDER_TEST }),
    );
    await savePlan(recorded.path, "targeted-plan", "# targeted-plan", {
        planId: PLAN_UNDER_TEST,
        status: "ready_for_work",
        targetBranch: "feature-base",
    });
    const entriesBefore = await listWorktreeRegistryEntries(projectRoot);
    const selected = await loadPlan(recorded.path, "targeted-plan");
    assertExists(selected);
    await assertRejects(
        () =>
            startActiveExecutionWorkflow({
                planName: "targeted-plan",
                triageMeta: selected.attrs,
                currentStatus: "ready_for_work",
                hostedSession,
                ports: createExecutionStartPorts(),
            }),
        Error,
        "Existing execution worktree targets main, but plan targets feature-base",
    );
    // Refused before anything durable happened.
    assertEquals(await listWorktreeRegistryEntries(projectRoot), entriesBefore);
});

test("startActiveExecutionWorkflow matches explicit remote target to recorded local reusable target", async () => {
    const projectRoot = await makeWorkflowProject([{ name: "targeted-plan", status: "ready_for_work" }]);
    const hostedSession = makeHostedSession("remote-reusable-workflow", projectRoot);
    await git(projectRoot, ["branch", "feature-base"]);
    await git(projectRoot, ["update-ref", "refs/remotes/origin/feature-base", "refs/heads/feature-base"]);
    const recorded = await settleWorktreeAttempt(
        projectRoot,
        await createWorktreeGitArtifacts({
            projectRoot,
            planName: "targeted-plan",
            planId: PLAN_UNDER_TEST,
            baseBranch: "feature-base",
        }),
    );
    await savePlan(recorded.path, "targeted-plan", "# targeted-plan", {
        planId: PLAN_UNDER_TEST,
        status: "ready_for_work",
        targetBranch: "origin/feature-base",
    });
    const result = await startActiveExecutionWorkflow({
        planName: "targeted-plan",
        triageMeta: { planId: PLAN_UNDER_TEST, worktreeId: recorded.id, targetBranch: "origin/feature-base" },
        currentStatus: "ready_for_work",
        hostedSession,
        ports: createExecutionStartPorts(),
    });

    // `origin/feature-base` and the recorded local `feature-base` are the same target, so
    // the existing worktree is reused rather than rejected as a mismatch.
    assertEquals(result.worktreeId, recorded.id);
    assertEquals(result.worktreeBaseBranch, "feature-base");
});

test("startActiveExecutionWorkflow ignores an unregistered cached attempt and uses the saved target", async () => {
    const projectRoot = await makeWorkflowProject([
        {
            name: "targeted-plan",
            status: "ready_for_work",
            attrs: { targetBranch: "feature-base" },
        },
    ]);
    await setCustomSetting("plans", { autoMergeIntoTargetBranch: true }, "project", projectRoot);
    const hostedSession = makeHostedSession("unknown-active-target-workflow", projectRoot);
    hostedSession.setActiveExecutionWorkflow({
        planName: "targeted-plan",
        triageMeta: { planId: "plan-under-test" },
        executionAgent: "engineer",
        baselineTree: "tree4",
        projectRoot: "/repo",
        executionCwd: "/tmp/wt4",
        worktreeId: "wt4",
        worktreeBranch: "runwield/worktree/targeted-plan-wt4",
    });
    const started = await startActiveExecutionWorkflow({
        planName: "targeted-plan",
        triageMeta: { planId: PLAN_UNDER_TEST, targetBranch: "stale-target" },
        currentStatus: "ready_for_work",
        hostedSession,
        ports: createExecutionStartPorts(),
    });
    assertEquals(started.worktreeId === "wt4", false);
    assertEquals(started.worktreeBaseBranch, "feature-base");
    assertExists(started.worktreeId);
    assertEquals((await findWorktreeRegistryEntryById(projectRoot, started.worktreeId))?.baseBranch, "feature-base");
});

test("startActiveExecutionWorkflow prompts once and uses CWD for non-Git in-place execution", async () => {
    const projectRoot = await makeWorkflowProject([{ name: "non-git-plan", status: "ready_for_work" }]);
    await fsRm(join(projectRoot, ".git"), { recursive: true });
    const hostedSession = makeHostedSession("non-git-feature-workflow", projectRoot);
    hostedSession.setInteractionAdapter({
        requestInteraction: () => {
            prompts.push("consent");
            return Promise.resolve({ outcome: "selected", value: "proceed" });
        },
    });
    const prompts: string[] = [];
    const result = await startActiveExecutionWorkflow({
        planName: "non-git-plan",
        triageMeta: { planId: "plan-under-test", classification: "FEATURE" },
        currentStatus: "ready_for_work",
        hostedSession,
        ports: createExecutionStartPorts(),
    });

    assertEquals(prompts, ["consent"]);
    assertEquals(result.executionCwd, projectRoot);
    assertEquals(result.nonGitInPlace, true);
    assertEquals(result.worktreeId, undefined);
    assertEquals(hostedSession.getActiveExecutionWorkflow()?.nonGitInPlace, true);
    assertEquals(hostedSession.getActiveExecutionWorkflow()?.executionStarted, true);
    // The non-Git decision is durable Plan state, not just an event payload.
    const started = await loadPlan(projectRoot, "non-git-plan");
    assertEquals(started?.attrs.status, "in_progress");
    assertEquals(started?.attrs.executionMode, "non_git_in_place");
});

test("startActiveExecutionWorkflow cancels non-Git execution without consent", async () => {
    const projectRoot = await makeWorkflowProject([{ name: "non-git-plan", status: "ready_for_work" }]);
    await fsRm(join(projectRoot, ".git"), { recursive: true });
    const hostedSession = makeHostedSession("non-git-feature-cancel-workflow", projectRoot);
    hostedSession.setInteractionAdapter({
        requestInteraction: () => {
            return Promise.resolve({ outcome: "selected", value: "cancel" });
        },
    });
    await assertRejects(
        () =>
            startActiveExecutionWorkflow({
                planName: "non-git-plan",
                triageMeta: { planId: PLAN_UNDER_TEST, classification: "FEATURE" },
                currentStatus: "ready_for_work",
                hostedSession,
                ports: createExecutionStartPorts(),
            }),
        Error,
        "in-place execution was not approved",
    );
    assertEquals(hostedSession.getActiveExecutionWorkflow(), null);
    // Refusing consent leaves the Plan exactly where it was.
    assertEquals((await loadPlan(projectRoot, "non-git-plan"))?.attrs.status, "ready_for_work");
});

test("startActiveExecutionWorkflow does not activate Frontend Engineer before non-Git consent commits", async () => {
    const projectRoot = await makeWorkflowProject([{ name: "visual-plan", status: "ready_for_work" }]);
    await fsRm(join(projectRoot, ".git"), { recursive: true });
    const hostedSession = makeHostedSession("frontend-non-git-cancel-workflow", projectRoot);
    hostedSession.setInteractionAdapter({
        requestInteraction: () => {
            return Promise.resolve({ outcome: "selected", value: "cancel" });
        },
    });
    await assertRejects(
        () =>
            startActiveExecutionWorkflow({
                planName: "visual-plan",
                triageMeta: {
                    planId: PLAN_UNDER_TEST,
                    classification: "FEATURE",
                    executionAgent: "frontend-engineer",
                },
                currentStatus: "ready_for_work",
                hostedSession,
                ports: createExecutionStartPorts(),
            }),
        Error,
        "in-place execution was not approved",
    );

    assertEquals(hostedSession.getActiveExecutionWorkflow(), null);
    assertEquals((await loadPlan(projectRoot, "visual-plan"))?.attrs.status, "ready_for_work");
});

test("readLatestPlanOutcome returns the latest plan_written outcome", () => {
    const messages: Parameters<typeof readLatestPlanOutcome>[0] = [
        {
            role: "toolResult",
            toolName: "plan_written",
            details: { planName: "first", outcome: "feedback" },
        },
        {
            role: "toolResult",
            toolName: "plan_written",
            content: [
                { type: "text", text: "approved" },
                { type: "image", data: "YXBwcm92ZWQ=", mimeType: "image/png" },
            ],
            details: {
                planName: "first",
                outcome: "approved_execute",
                triageMeta: { classification: "FEATURE" },
                feedback: "Keep the selected command.",
            },
        },
    ];
    assertEquals(readLatestPlanOutcome(messages), {
        outcome: "approved_execute",
        planName: "first",
        triageMeta: { classification: "FEATURE" },
        feedback: "Keep the selected command.",
        images: [{ base64: "YXBwcm92ZWQ=", mimeType: "image/png" }],
    });
});

test("extractAssistantOutput falls back to task_completed message details", () => {
    const messages: Parameters<typeof extractAssistantOutput>[0] = [
        {
            role: "assistant",
            content: [
                {
                    type: "tool_use",
                    name: "task_completed",
                    input: { message: "Implemented isolated worktree setup." },
                },
            ],
        },
        {
            role: "toolResult",
            toolName: "task_completed",
            details: {
                outcome: "task_completed",
                message: "Implemented isolated worktree setup.",
            },
        },
    ];

    assertEquals(extractAssistantOutput(messages), "Implemented isolated worktree setup.");
});

test("extractAssistantOutput handles legacy assistant text shapes", () => {
    assertEquals(
        extractAssistantOutput([{ role: "assistant", content: "Plain legacy summary." }]),
        "Plain legacy summary.",
    );
    assertEquals(
        extractAssistantOutput([{ role: "assistant", content: [{ contentText: "Content text summary." }] }]),
        "Content text summary.",
    );
});

test("finalizePlanImplementation checkpoints worktree changes before lifecycle completion", async () => {
    const projectRoot = await makeWorkflowProject([{ name: "feature-plan", status: "in_progress" }]);
    // A real worktree on a real branch. The checkpoint is RunWield's own policy — it
    // commits the Agent's work and refuses to return while the tree is still dirty —
    // so a stand-in returning a plausible SHA replaces the behaviour under test with
    // an assertion that the test itself wrote the answer.
    const worktree = await settleWorktreeAttempt(
        projectRoot,
        await createWorktreeGitArtifacts({ projectRoot, planName: "feature-plan", planId: PLAN_UNDER_TEST }),
    );
    await savePlan(worktree.path, "feature-plan", "# feature-plan", {
        planId: PLAN_UNDER_TEST,
        status: "in_progress",
    });
    const branchHeadBefore = await git(projectRoot, ["rev-parse", `${worktree.branch}^{commit}`]);
    await fsWriteFile(`${worktree.path}/implemented.txt`, "the Agent's work\n");

    const executionContext: ExecutionContext = {
        planName: "feature-plan",
        triageMeta: { classification: "FEATURE" },
        executionAgent: "engineer",
        executionMode: "worktree",
        projectRoot,
        executionCwd: worktree.path,
        baselineTree: "attempt-tree",
        worktreeId: worktree.id,
        worktreeBranch: worktree.branch,
    };

    const result = await finalizePlanImplementation({
        projectRoot,
        planName: "feature-plan",
        triageMeta: { classification: "FEATURE", summary: "Preserve completed implementation work." },
        executionContext,
        executionReport: "- Implemented.",
    });

    const branchHeadAfter = await git(projectRoot, ["rev-parse", `${worktree.branch}^{commit}`]);
    assertEquals(result, { implementationCommit: branchHeadAfter });
    assertEquals(branchHeadAfter === branchHeadBefore, false, "the Agent's work must be committed to the branch");
    // The checkpoint's own contract: nothing left behind in the worktree.
    assertEquals(await git(worktree.path, ["status", "--porcelain"]), "");
    const finalized = await loadPlan(worktree.path, "feature-plan");
    assertEquals(finalized?.attrs.status, "implemented");
    assertEquals(finalized?.attrs.executionReport, "- Implemented.");
    assertEquals(finalized?.attrs.worktreeId, worktree.id);
    assertEquals(
        finalized?.attrs.executionBaselineTree,
        worktree.baseTree,
        "registry baseline wins over stale caller data",
    );
    assertEquals((await findWorktreeRegistryEntryById(projectRoot, worktree.id))?.status, "completed");
});

test("finalizePlanImplementation restores missing execution_started before lifecycle completion", async () => {
    const projectRoot = await makeWorkflowProject([{ name: "feature-plan", status: "ready_for_work" }]);
    const worktree = await settleWorktreeAttempt(
        projectRoot,
        await createWorktreeGitArtifacts({ projectRoot, planName: "feature-plan", planId: PLAN_UNDER_TEST }),
    );
    await savePlan(worktree.path, "feature-plan", "# feature-plan", { status: "ready_for_work" });
    await fsWriteFile(`${worktree.path}/recovered.txt`, "work done before the marker was lost\n");

    const executionContext: ExecutionContext = {
        planName: "feature-plan",
        triageMeta: { classification: "FEATURE" },
        executionAgent: "engineer",
        executionMode: "worktree",
        projectRoot,
        executionCwd: worktree.path,
        baselineTree: "attempt-tree",
        worktreeId: worktree.id,
        worktreeBranch: worktree.branch,
    };

    await finalizePlanImplementation({
        projectRoot,
        planName: "feature-plan",
        triageMeta: { classification: "FEATURE", summary: "Recover lifecycle marker order." },
        executionContext,
        executionReport: "- Implemented after marker recovery.",
    });

    assertEquals(await git(worktree.path, ["status", "--porcelain"]), "");
    const finalized = await loadPlan(worktree.path, "feature-plan");
    assertEquals(
        finalized?.attrs.status,
        "implemented",
        "implemented is unreachable from ready_for_work unless execution_started was restored first",
    );
    assertEquals((await findWorktreeRegistryEntryById(projectRoot, worktree.id))?.status, "completed");
});

test("finalizePlanImplementation restores a Plan deleted and committed by the Engineer", async () => {
    const projectRoot = await makeWorkflowProject([{ name: "deleted-plan", status: "ready_for_work" }]);
    const hostedSession = makeHostedSession("deleted-execution-plan", projectRoot);
    const executionContext = await startActiveExecutionWorkflow({
        planName: "deleted-plan",
        triageMeta: {
            classification: "PLANNED_CHANGE",
            planId: PLAN_UNDER_TEST,
            summary: "Keep the execution Plan durable.",
        },
        currentStatus: "ready_for_work",
        hostedSession,
        ports: createExecutionStartPorts(),
    });
    const worktreePath = executionContext.executionCwd;
    assertExists(worktreePath);
    const planPath = `${worktreePath}/docs/plans/deleted-plan.md`;
    const preparationCommit = await git(worktreePath, ["rev-parse", "HEAD"]);
    assertStringIncludes(await git(worktreePath, ["ls-files"]), "docs/plans/deleted-plan.md");

    await fsWriteFile(`${worktreePath}/implemented.txt`, "implementation survives\n");
    await fsRm(planPath);
    await git(worktreePath, ["add", "-A"]);
    await git(worktreePath, ["commit", "-m", "Engineer accidentally deletes Plan"]);
    assertEquals(await loadPlan(worktreePath, "deleted-plan"), null);

    const result = await finalizePlanImplementation({
        projectRoot,
        planName: "deleted-plan",
        triageMeta: executionContext.triageMeta,
        executionContext,
        executionReport: "- Implemented without deleting lifecycle evidence.",
    });

    assertEquals(typeof result.implementationCommit, "string");
    assertEquals(await git(worktreePath, ["status", "--porcelain"]), "");
    const finalized = await loadPlan(worktreePath, "deleted-plan");
    assertEquals(finalized?.attrs.status, "implemented");
    assertEquals(finalized?.attrs.planId, PLAN_UNDER_TEST);
    assertEquals(finalized?.attrs.executionBaselineTree, executionContext.baselineTree);
    assertEquals(await git(worktreePath, ["merge-base", "--is-ancestor", preparationCommit, "HEAD"]), "");
});

test("finalizePlanImplementation fails closed without durable execution context", async () => {
    const projectRoot = await makeWorkflowProject([{ name: "feature-plan", status: "ready_for_work" }]);
    await assertRejects(
        () =>
            finalizePlanImplementation({
                projectRoot,
                planName: "feature-plan",
                triageMeta: { classification: "FEATURE" },
                executionContext: null,
            }),
        Error,
        "durable execution context is missing",
    );
    assertEquals((await loadPlan(projectRoot, "feature-plan"))?.attrs.status, "ready_for_work");
});

test("startActiveExecutionWorkflow records attempt timestamp only after execution starts", async () => {
    const projectRoot = await makeWorkflowProject([{ name: "clock-plan", status: "ready_for_work" }]);
    const hostedSession = makeHostedSession("attempt-clock-workflow", projectRoot);
    const result = await startActiveExecutionWorkflow({
        planName: "clock-plan",
        triageMeta: { planId: "plan-under-test", classification: "FEATURE" },
        currentStatus: "ready_for_work",
        hostedSession,
        ports: { ...createExecutionStartPorts(), now: () => 4242 },
    });

    assertEquals(result.executionStarted, true);
    assertEquals(result.executionAttemptStartedAtMs, 4242);
    assertEquals(hostedSession.getActiveExecutionWorkflow()?.executionAttemptStartedAtMs, 4242);
});

test("execution preparation ignores Plan body edits the user owns", async () => {
    const projectRoot = await makeWorkflowProject([
        { name: "body-plan", status: "ready_for_work", classification: "FEATURE" },
    ]);
    const stored = await loadPlan(projectRoot, "body-plan");
    assertExists(stored);
    const hostedSession = makeHostedSession("exec-body", projectRoot);
    hostedSession.setEventSink((event: RuntimeEventDraft) => {
        if (event.type === "system_status" && event.message === "Preparing the implementation target...") {
            fsWriteFileSync(stored.path, `${stored.markdown}\n\nEdited in another editor.\n`);
        }
    });

    const result = await startActiveExecutionWorkflow({
        planName: "body-plan",
        triageMeta: { planId: PLAN_UNDER_TEST, classification: "FEATURE" },
        currentStatus: "ready_for_work",
        hostedSession,
        ports: createExecutionStartPorts(),
    });

    assertEquals(result.planName, "body-plan");
    // The body edit reached the execution copy rather than being reverted or rejected.
    assertExists(result.executionCwd);
    const executionPlan = await loadPlan(result.executionCwd, "body-plan");
    assertStringIncludes(String(executionPlan?.markdown), "Edited in another editor.");
});

test("execution preparation still refuses when lifecycle front matter drifts", async () => {
    const projectRoot = await workflowRepo.checkout({ prefix: "runwield-exec-fm-" });
    try {
        await savePlan(projectRoot, "fm-plan", "# FM Plan\n", {
            planId: "plan-fm",
            classification: "FEATURE",
            status: "ready_for_work",
            summary: "s",
            affectedPaths: [],
        });
        const stored = await loadPlan(projectRoot, "fm-plan");
        assertExists(stored);
        const hostedSession = makeHostedSession("exec-fm", projectRoot);
        hostedSession.setEventSink((event: RuntimeEventDraft) => {
            if (event.type === "system_status" && event.message === "Preparing the implementation target...") {
                fsWriteFileSync(stored.path, stored.markdown.replace('status: "ready_for_work"', 'status: "on_hold"'));
            }
        });

        await assertRejects(
            () =>
                startActiveExecutionWorkflow({
                    planName: "fm-plan",
                    triageMeta: { planId: "plan-fm", classification: "FEATURE" },
                    currentStatus: "ready_for_work",
                    hostedSession,
                    ports: createExecutionStartPorts(),
                }),
            Error,
            "on_hold",
        );
        assertEquals((await loadPlan(projectRoot, "fm-plan"))?.attrs.status, "on_hold");
        assertEquals(hostedSession.getActiveExecutionWorkflow(), null);
    } finally {
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
    }
});

test("runPlanningAgent records a known Plan name before the planning turn starts", async () => {
    await withRuntimeCommandFixture("workflow-planning-plan-name-", async ({ setModelResponseFactory }) => {
        const projectRoot = await makeWorkflowProject([{ name: "resumed-plan", status: "draft" }]);
        const { hostedSession, sessionManager } = makeAgentHostedSession("workflow-planning-plan-name", projectRoot);
        let planNameDuringTurn: string | null = null;
        setModelResponseFactory(() => {
            planNameDuringTurn = hostedSession.getWorkflowContext()?.planName ?? null;
            return fauxAssistantMessage(fauxText("Acknowledged; nothing to finalize yet."));
        });

        try {
            const result = await runPlanningAgent({
                agentName: "planner",
                initialRequest: "Resume the draft Plan.",
                triageMeta: {},
                hostedSession,
                sessionManager,
                planName: "resumed-plan",
            });

            assertEquals(result.outcome, "no_call");
            // The pointer has to exist *before* the turn: compaction fires mid-turn, and
            // one recorded only on the way out is exactly the one that goes missing.
            assertEquals(planNameDuringTurn, "resumed-plan");
            assertEquals(hostedSession.getWorkflowContext()?.planName, "resumed-plan");
        } finally {
            hostedSession.dispose();
        }
    });
});

test("runPlanningAgent leaves workflow Plan context alone when no Plan name is known", async () => {
    await withRuntimeCommandFixture("workflow-planning-no-plan-name-", async ({ setModelResponseFactory }) => {
        const projectRoot = await makeWorkflowProject([{ name: "unrelated-plan", status: "draft" }]);
        const { hostedSession, sessionManager } = makeAgentHostedSession("workflow-planning-no-plan-name", projectRoot);
        setModelResponseFactory(() => fauxAssistantMessage(fauxText("Still gathering context.")));

        try {
            await runPlanningAgent({
                agentName: "planner",
                initialRequest: "Plan something new.",
                triageMeta: {},
                hostedSession,
                sessionManager,
            });

            assertEquals(hostedSession.getWorkflowContext()?.planName, undefined);
        } finally {
            hostedSession.dispose();
        }
    });
});
