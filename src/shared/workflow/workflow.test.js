// @ts-nocheck: public workflow facade now forwards to TypeScript extraction modules; behavioral coverage remains unchanged.
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { createWorktreeGitArtifacts, settleWorktreeAttempt } from "../worktree.js";
import {
    buildSlicerRequest,
    extractAssistantOutput,
    finalizePlanImplementation,
    readLatestPlanOutcome,
    runPlanningAgent,
    startActiveExecutionWorkflow,
} from "./workflow.js";
import { HostedSession } from "../session/hosted-session.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { loadPlan, savePlan } from "../../plan-store.js";
import { getTransitionJournalDir } from "./state-transition.ts";
import { loadCanonicalExecutionPlanSource } from "./execution-plan-file.js";
import { createExecutionStartPorts } from "./execution-start.ts";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { getCwd } from "../../constants.js";
import {
    findById as findWorktreeRegistryEntryById,
    listEntries as listWorktreeRegistryEntries,
} from "../worktree-registry.js";

/**
 * @param {string} [id]
 * @param {string} [cwd]
 */
function makeHostedSession(id = "workflow-test", cwd = getCwd()) {
    return new HostedSession({ id, cwd, sessionManager: null });
}

/**
 * @param {string} id @param {string} cwd
 * @param {string} cwd
 */
function makeAgentHostedSession(id, cwd) {
    const sessionManager = SessionManager.inMemory(cwd);
    const hostedSession = new HostedSession({ id, cwd });
    hostedSession.setRootSessionManager(sessionManager);
    return hostedSession;
}

/** @type {string[]} */
const projectsToRemove = [];
let projectCleanupRegistered = false;

function registerProjectCleanup() {
    if (projectCleanupRegistered) return;
    projectCleanupRegistered = true;
    globalThis.addEventListener("unload", () => {
        for (const path of projectsToRemove) {
            try {
                Deno.removeSync(path, { recursive: true });
            } catch {
                // Best effort; a leftover temp directory must not fail a passing run.
            }
        }
    });
}

const workflowRepo = defineCommittedGitFixture();

/** The durable Plan identity shared by the fixture Plan and the `triageMeta` naming it. */
const PLAN_UNDER_TEST = "plan-under-test";

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
 *
 * @param {Array<string | { name: string, status?: string, classification?: string, attrs?: Record<string, unknown> }>} plans
 * @returns {Promise<string>} the project root
 */
async function makeWorkflowProject(plans) {
    const cwd = await workflowRepo.checkout({ prefix: "runwield-workflow-" });
    projectsToRemove.push(cwd);
    registerProjectCleanup();
    for (const [index, entry] of plans.entries()) {
        const plan = typeof entry === "string" ? { name: entry } : entry;
        await savePlan(
            cwd,
            plan.name,
            `# ${plan.name}`,
            /** @type {any} */ ({
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
            }),
        );
    }
    return cwd;
}

Deno.test("HostedSession scopes active execution workflow independently", () => {
    const sessionA = new HostedSession({ id: "workflow-a", cwd: "/project-a" });
    const sessionB = new HostedSession({ id: "workflow-b", cwd: "/project-b" });
    const workflowA = /** @type {const} */ ({
        planName: "a",
        triageMeta: {},
        executionAgent: "engineer",
        executionCwd: "/work/a",
    });
    const workflowB = /** @type {const} */ ({
        planName: "b",
        triageMeta: {},
        executionAgent: "engineer",
        executionCwd: "/work/b",
    });

    sessionA.setActiveExecutionWorkflow(workflowA);
    sessionB.setActiveExecutionWorkflow(workflowB);
    sessionA.clearActiveExecutionWorkflow();

    assertEquals(sessionA.getActiveExecutionWorkflow(), null);
    assertEquals(sessionA.getActiveExecutionCwd(), "/project-a");
    assertEquals(sessionB.getActiveExecutionWorkflow(), workflowB);
    assertEquals(sessionB.getActiveExecutionCwd(), "/work/b");
});

Deno.test("startActiveExecutionWorkflow continues an existing in-progress worktree", async () => {
    const projectRoot = await makeWorkflowProject([{
        name: "continued-plan",
        status: "in_progress",
        attrs: {},
    }]);
    const hostedSession = makeHostedSession("continued-workflow", projectRoot);
    const recorded = await settleWorktreeAttempt(
        projectRoot,
        await createWorktreeGitArtifacts({ projectRoot, planName: "continued-plan", planId: PLAN_UNDER_TEST }),
    );
    await savePlan(recorded.path, "continued-plan", "# continued-plan", {
        planId: PLAN_UNDER_TEST,
        status: "in_progress",
    });
    await Deno.writeTextFile(`${recorded.path}/continued-implementation.ts`, "export const continued = true;\n");
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

Deno.test("startActiveExecutionWorkflow indexes a newly created execution worktree", async () => {
    await withProcessGlobalTestLock(async () => {
        const projectRoot = await makeWorkflowProject([{ name: "indexed-plan", status: "ready_for_work" }]);
        const hostedSession = makeHostedSession("indexed-workflow", projectRoot);
        const events = [];
        hostedSession.setEventSink((event) => events.push(event));
        const binDir = await Deno.makeTempDir({ prefix: "runwield-fake-cymbal-bin-" });
        const markerPath = `${binDir}/cymbal-marker.txt`;
        const cymbalPath = `${binDir}/cymbal`;
        const previousPath = Deno.env.get("PATH") || "";
        const previousMarker = Deno.env.get("RUNWIELD_CYMBAL_MARKER");
        await Deno.writeTextFile(
            cymbalPath,
            '#!/bin/sh\nprintf "%s\\n" "$PWD" > "$RUNWIELD_CYMBAL_MARKER"\nprintf "%s\\n" "$*" >> "$RUNWIELD_CYMBAL_MARKER"\n',
        );
        await Deno.chmod(cymbalPath, 0o755);
        Deno.env.set("PATH", `${binDir}:${previousPath}`);
        Deno.env.set("RUNWIELD_CYMBAL_MARKER", markerPath);
        try {
            const result = await startActiveExecutionWorkflow({
                planName: "indexed-plan",
                triageMeta: { planId: PLAN_UNDER_TEST, classification: "FEATURE" },
                currentStatus: "ready_for_work",
                hostedSession,
                ports: createExecutionStartPorts(),
            });

            const marker = (await Deno.readTextFile(markerPath)).trim().split("\n");
            assertEquals(marker, [await Deno.realPath(result.executionCwd), "index ."]);
            assertEquals(
                events.some((event) => event.message === "Indexing the worktree for code search..."),
                true,
            );
        } finally {
            Deno.env.set("PATH", previousPath);
            if (previousMarker === undefined) {
                Deno.env.delete("RUNWIELD_CYMBAL_MARKER");
            } else {
                Deno.env.set("RUNWIELD_CYMBAL_MARKER", previousMarker);
            }
            await Deno.remove(binDir, { recursive: true }).catch(() => {});
        }
    });
});

Deno.test("startActiveExecutionWorkflow bases the execution worktree on the requested target branch", async () => {
    const projectRoot = await makeWorkflowProject([{
        name: "targeted-plan",
        status: "ready_for_work",
        attrs: { targetBranch: " feature-base " },
    }]);
    const hostedSession = makeHostedSession("targeted-workflow", projectRoot);
    await Deno.writeTextFile(`${projectRoot}/current-only-marker`, "present only in the current checkout\n");

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
    const entry = await findWorktreeRegistryEntryById(projectRoot, /** @type {string} */ (result.worktreeId));
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
    assertEquals(await git(/** @type {string} */ (result.executionCwd), ["status", "--porcelain"]), "");
    const plan = await loadPlan(/** @type {string} */ (result.executionCwd), "targeted-plan");
    assertEquals(plan?.attrs.status, "in_progress");
});

Deno.test("startActiveExecutionWorkflow uses the latest uncommitted Plan revision instead of the target branch copy", async () => {
    const projectRoot = await makeWorkflowProject([{
        name: "revised-before-execution",
        status: "ready_for_work",
        attrs: {},
    }]);
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
        const executionPlan = await loadPlan(result.executionCwd, "revised-before-execution");
        assertEquals(executionPlan?.body.trim(), "# Latest approved Plan\n\n## Context\n\nlatest approved Plan");
        assertEquals(executionPlan?.attrs.summary, "latest approved Plan");
    } finally {
        hostedSession.dispose();
        if (executionCwd) {
            await git(projectRoot, ["worktree", "remove", "--force", executionCwd]).catch(() => "");
        }
    }
});

Deno.test("startActiveExecutionWorkflow captures baseline after first Plan materialization and records metric", async () => {
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
    /** @type {string[]} */
    const order = [];
    /** @type {any[]} */
    const metrics = [];

    const result = await startActiveExecutionWorkflow({
        planName: "p",
        triageMeta: { planId: PLAN_UNDER_TEST },
        currentStatus: "ready_for_work",
        hostedSession,
        ports: {
            ...createExecutionStartPorts(),
            loadCanonicalExecutionPlanSource: (root, name) => {
                // Observe the ordering, then read the real Plan: a synthetic source
                // disagrees with the file on disk and trips the front-matter guard.
                order.push("load-source");
                return loadCanonicalExecutionPlanSource(root, name);
            },
            recordWorkflowMetric: (metric) => {
                metrics.push(metric);
                return Promise.resolve(null);
            },
        },
    });

    assertEquals(order, ["load-source", "load-source"]);
    assertEquals(metrics.at(-1)?.details.planFileMaterialized, true);
    // The ordering used to be asserted by spying on the Plan restore and the baseline
    // capture. It did not need to be: a baseline that contains the restored Plan can
    // only have been captured after the restore, and a stale baseline recorded on the
    // session proves it was recomputed. The evidence below says both, without making
    // either step replaceable.
    assertEquals(result.baselineTree !== "stale-tree-without-plan", true);
    const baselineFiles = await git(/** @type {string} */ (result.executionCwd), [
        "ls-tree",
        "-r",
        "--name-only",
        /** @type {string} */ (result.baselineTree),
    ]);
    assertStringIncludes(baselineFiles, "docs/plans/p.md");
});

Deno.test("startActiveExecutionWorkflow rejects an unsafe canonical source before worktree selection or creation", async () => {
    const projectRoot = await makeWorkflowProject([{ name: "p", status: "ready_for_work" }]);
    const hostedSession = makeHostedSession("canonical-source-before-worktree", projectRoot);
    let reuseLookups = 0;
    let ensureCalls = 0;

    await assertRejects(
        () =>
            startActiveExecutionWorkflow({
                planName: "p",
                triageMeta: { planId: PLAN_UNDER_TEST, worktreeId: "wt-recorded" },
                currentStatus: "ready_for_work",
                hostedSession,
                ports: {
                    ...createExecutionStartPorts(),
                    probeGitRepository: () => Promise.resolve({ ok: true, state: "work_tree", cwd: "" }),
                    loadCanonicalExecutionPlanSource: () =>
                        Promise.resolve({
                            kind: "symlink",
                            relativePath: "docs/plans/p.md",
                            reason: "Canonical Plan source parent is a symlink at plans.",
                        }),
                    findReusableWorktree: () => {
                        reuseLookups++;
                        return Promise.resolve(null);
                    },
                    ensureExecutionPlanFile: () => {
                        ensureCalls++;
                        return Promise.resolve({ kind: "present", relativePath: "docs/plans/p.md" });
                    },
                },
            }),
        Error,
        "docs/plans/p.md",
    );

    assertEquals(reuseLookups, 1);
    assertEquals(ensureCalls, 0);
    // "Before creation" is a claim about the repository and the registry, so ask them
    // rather than a fake that was told to refuse.
    assertEquals(await listWorktreeRegistryEntries(projectRoot), []);
    assertStringIncludes(await git(projectRoot, ["worktree", "list", "--porcelain"]), projectRoot);
    assertEquals((await git(projectRoot, ["worktree", "list", "--porcelain"])).includes("refs/heads/worktree/"), false);
});

Deno.test("startActiveExecutionWorkflow preserves a malformed derived Plan and blocks", async () => {
    const projectRoot = await makeWorkflowProject([{ name: "p", status: "ready_for_work" }]);
    const hostedSession = makeHostedSession("reused-plan-block", projectRoot);
    const reused = await settleWorktreeAttempt(
        projectRoot,
        await createWorktreeGitArtifacts({ projectRoot, planName: "p", planId: PLAN_UNDER_TEST }),
    );
    // Really malformed, rather than a stand-in reporting that it would have been:
    // preparation has to parse this file and refuse on what it finds. The worktree
    // carries no Plan of its own — restoring one is the step being blocked here.
    await Deno.mkdir(`${reused.path}/docs/plans`, { recursive: true });
    await Deno.writeTextFile(`${reused.path}/docs/plans/p.md`, "---\nnot: [valid\n---\n\n# broken\n");

    try {
        await assertRejects(
            () =>
                startActiveExecutionWorkflow({
                    planName: "p",
                    triageMeta: { planId: PLAN_UNDER_TEST, worktreeId: reused.id },
                    currentStatus: "ready_for_work",
                    hostedSession,
                    ports: {
                        ...createExecutionStartPorts(),
                        probeGitRepository: () => Promise.resolve({ ok: true, state: "work_tree", cwd: "" }),
                        findReusableWorktree: () => Promise.resolve(reused),
                        resolveCurrentCheckoutBranch: () => Promise.resolve("main"),
                    },
                }),
            Error,
            "could not be parsed",
        );

        assertEquals((await Deno.stat(reused.path)).isDirectory, true);
        assertEquals((await findWorktreeRegistryEntryById(projectRoot, reused.id))?.status, "active");
        assertEquals((await loadPlan(projectRoot, "p"))?.attrs.status, "ready_for_work");
        assertStringIncludes(await Deno.readTextFile(`${reused.path}/docs/plans/p.md`), "not: [valid");
    } finally {
        await Deno.remove(getTransitionJournalDir(hostedSession.cwd), { recursive: true }).catch(() => {});
    }
});

Deno.test("startActiveExecutionWorkflow rolls back a worktree that fails before execution begins", async () => {
    const projectRoot = await makeWorkflowProject([{
        name: "p",
        status: "ready_for_work",
        attrs: { targetBranch: "docs-as-file" },
    }]);
    const hostedSession = makeHostedSession("fresh-cleanup-failure", projectRoot);
    // A branch whose tree has `docs` as a *file*, built with plumbing so the working
    // tree is untouched. A worktree checked out from it cannot hold docs/plans/p.md, so the
    // real Plan restore fails on the real filesystem — after the worktree exists, which
    // is what gives the rollback below something to preserve. Faking the restore's
    // return value would have skipped both the checkout and the failure.
    const branchRoot = await Deno.makeTempDir({ prefix: "runwield-docs-as-file-" });
    await git(projectRoot, ["worktree", "add", "--detach", branchRoot]);
    await Deno.writeTextFile(`${branchRoot}/docs`, "not a directory\n");
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
                    ports: {
                        ...createExecutionStartPorts(),
                        probeGitRepository: () => Promise.resolve({ ok: true, state: "work_tree", cwd: "" }),
                        findReusableWorktree: () => Promise.resolve(null),
                    },
                }),
            Error,
            "no Agent work began",
        );

        const entries = await listWorktreeRegistryEntries(projectRoot);
        assertEquals(entries.length, 0);
    } finally {
        await Deno.remove(getTransitionJournalDir(hostedSession.cwd), { recursive: true }).catch(() => {});
    }
});

Deno.test("startActiveExecutionWorkflow bases untargeted plans on the current target branch", async () => {
    const projectRoot = await makeWorkflowProject([{ name: "untargeted-plan", status: "ready_for_work" }]);
    const hostedSession = makeHostedSession("untargeted-workflow", projectRoot);
    let prepareCalls = 0;
    let reuseLookups = 0;
    const result = await startActiveExecutionWorkflow({
        planName: "untargeted-plan",
        triageMeta: { planId: PLAN_UNDER_TEST, worktreeStatus: "completed" },
        currentStatus: "ready_for_work",
        hostedSession,
        ports: {
            ...createExecutionStartPorts(),
            probeGitRepository: () => Promise.resolve({ ok: true, state: "work_tree", cwd: "" }),
            findReusableWorktree: () => {
                reuseLookups++;
                return Promise.resolve(null);
            },
            prepareTargetBranchRef: () => {
                prepareCalls++;
                return Promise.reject(new Error("an untargeted Plan must not prepare a target branch"));
            },
        },
    });

    assertEquals(prepareCalls, 0);
    assertEquals(reuseLookups, 1);
    const entry = await findWorktreeRegistryEntryById(projectRoot, /** @type {string} */ (result.worktreeId));
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

Deno.test("startActiveExecutionWorkflow resolves implicit current branch before reusing a recorded worktree", async () => {
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
    /** @type {unknown[]} */
    const reuseCalls = [];
    const result = await startActiveExecutionWorkflow({
        planName: "untargeted-plan",
        triageMeta: { planId: PLAN_UNDER_TEST, worktreeId: recorded.id },
        currentStatus: "ready_for_work",
        hostedSession,
        ports: {
            ...createExecutionStartPorts(),
            probeGitRepository: () => Promise.resolve({ ok: true, state: "work_tree", cwd: "" }),
            findReusableWorktree: (opts) => {
                reuseCalls.push(opts);
                return Promise.resolve(recorded);
            },
        },
    });

    assertEquals(reuseCalls, [{
        projectRoot,
        planName: "untargeted-plan",
        planId: PLAN_UNDER_TEST,
        worktreeId: recorded.id,
    }]);
    // Reused, not recreated: same attempt, and the Plan never targeted a branch, so the
    // recorded target is the checkout's own branch resolved at reuse time.
    assertEquals(result.worktreeId, recorded.id);
    assertEquals(result.executionCwd, recorded.path);
    assertEquals(result.worktreeBaseBranch, "main");
    const entry = await findWorktreeRegistryEntryById(projectRoot, recorded.id);
    assertEquals(entry?.status, "active");
    assertEquals(entry?.executionBaselineTree, result.baselineTree);
});

Deno.test("startActiveExecutionWorkflow rejects reusable worktree target mismatches", async () => {
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

Deno.test("startActiveExecutionWorkflow matches explicit remote target to recorded local reusable target", async () => {
    const projectRoot = await makeWorkflowProject([{ name: "targeted-plan", status: "ready_for_work" }]);
    const hostedSession = makeHostedSession("remote-reusable-workflow", projectRoot);
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
    let prepareCalls = 0;
    const result = await startActiveExecutionWorkflow({
        planName: "targeted-plan",
        triageMeta: { planId: PLAN_UNDER_TEST, worktreeId: recorded.id, targetBranch: "origin/feature-base" },
        currentStatus: "ready_for_work",
        hostedSession,
        ports: {
            ...createExecutionStartPorts(),
            probeGitRepository: () => Promise.resolve({ ok: true, state: "work_tree", cwd: "" }),
            findReusableWorktree: () => Promise.resolve(recorded),
            resolveTargetBranchName: () => Promise.resolve("feature-base"),
            prepareTargetBranchRef: () => {
                prepareCalls++;
                return Promise.reject(new Error("a matching reusable target must not be re-prepared"));
            },
        },
    });

    // `origin/feature-base` and the recorded local `feature-base` are the same target, so
    // the existing worktree is reused rather than rejected as a mismatch.
    assertEquals(prepareCalls, 0);
    assertEquals(result.worktreeId, recorded.id);
    assertEquals(result.worktreeBaseBranch, "feature-base");
});

Deno.test("startActiveExecutionWorkflow ignores an unregistered cached attempt and uses the saved target", async () => {
    const projectRoot = await makeWorkflowProject([{
        name: "targeted-plan",
        status: "ready_for_work",
        attrs: { targetBranch: "feature-base" },
    }]);
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
    assertEquals((await findWorktreeRegistryEntryById(projectRoot, started.worktreeId))?.baseBranch, "feature-base");
});

Deno.test("startActiveExecutionWorkflow prompts once and uses CWD for non-Git in-place execution", async () => {
    const projectRoot = await makeWorkflowProject([{ name: "non-git-plan", status: "ready_for_work" }]);
    const hostedSession = makeHostedSession("non-git-feature-workflow", projectRoot);
    /** @type {string[]} */
    const prompts = [];
    const result = await startActiveExecutionWorkflow({
        planName: "non-git-plan",
        triageMeta: { planId: "plan-under-test", classification: "FEATURE" },
        currentStatus: "ready_for_work",
        hostedSession,
        ports: {
            ...createExecutionStartPorts(),
            probeGitRepository: () => Promise.resolve({ ok: false, state: "not_git", cwd: projectRoot }),
            hasNonGitExecutionConsent: () => false,
            confirmNonGitFeaturePlanExecution: (_session, projectRoot) => {
                const prompt = `non git prompt:${projectRoot}`;
                prompts.push(prompt);
                return Promise.resolve(true);
            },
            findReusableWorktree: () => Promise.reject(new Error("should not inspect worktrees")),
            captureWorktreeTree: () => Promise.reject(new Error("should not capture git tree")),
        },
    });

    assertEquals(prompts, [`non git prompt:${projectRoot}`]);
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

Deno.test("startActiveExecutionWorkflow cancels non-Git execution without consent", async () => {
    const projectRoot = await makeWorkflowProject([{ name: "non-git-plan", status: "ready_for_work" }]);
    const hostedSession = makeHostedSession("non-git-feature-cancel-workflow", projectRoot);
    await assertRejects(
        () =>
            startActiveExecutionWorkflow({
                planName: "non-git-plan",
                triageMeta: { planId: PLAN_UNDER_TEST, classification: "FEATURE" },
                currentStatus: "ready_for_work",
                hostedSession,
                ports: {
                    ...createExecutionStartPorts(),
                    probeGitRepository: () => Promise.resolve({ ok: false, state: "not_git", cwd: projectRoot }),
                    hasNonGitExecutionConsent: () => false,
                    confirmNonGitFeaturePlanExecution: () => Promise.resolve(false),
                },
            }),
        Error,
        "in-place execution was not approved",
    );
    assertEquals(hostedSession.getActiveExecutionWorkflow(), null);
    // Refusing consent leaves the Plan exactly where it was.
    assertEquals((await loadPlan(projectRoot, "non-git-plan"))?.attrs.status, "ready_for_work");
});

Deno.test("startActiveExecutionWorkflow does not activate Frontend Engineer before non-Git consent commits", async () => {
    const projectRoot = await makeWorkflowProject([{ name: "visual-plan", status: "ready_for_work" }]);
    const hostedSession = makeHostedSession("frontend-non-git-cancel-workflow", projectRoot);
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
                ports: {
                    ...createExecutionStartPorts(),
                    probeGitRepository: () => Promise.resolve({ ok: false, state: "not_git", cwd: projectRoot }),
                    hasNonGitExecutionConsent: () => false,
                    confirmNonGitFeaturePlanExecution: () => Promise.resolve(false),
                },
            }),
        Error,
        "in-place execution was not approved",
    );

    assertEquals(hostedSession.getActiveExecutionWorkflow(), null);
    assertEquals((await loadPlan(projectRoot, "visual-plan"))?.attrs.status, "ready_for_work");
});

Deno.test("readLatestPlanOutcome returns the latest plan_written outcome", () => {
    const messages = [
        /** @type {any} */ ({
            role: "toolResult",
            toolName: "plan_written",
            details: { planName: "first", outcome: "feedback" },
        }),
        /** @type {any} */ ({
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
        }),
    ];
    assertEquals(readLatestPlanOutcome(messages), {
        outcome: "approved_execute",
        planName: "first",
        triageMeta: { classification: "FEATURE" },
        feedback: "Keep the selected command.",
        images: [{ base64: "YXBwcm92ZWQ=", mimeType: "image/png" }],
    });
});

Deno.test("readLatestPlanOutcome returns null when no plan_written tool result is present", () => {
    assertEquals(readLatestPlanOutcome([]), null);
});

Deno.test("extractAssistantOutput falls back to task_completed message details", () => {
    const messages = [
        /** @type {any} */ ({
            role: "assistant",
            content: [{
                type: "tool_use",
                name: "task_completed",
                input: { message: "Implemented isolated worktree setup." },
            }],
        }),
        /** @type {any} */ ({
            role: "toolResult",
            toolName: "task_completed",
            details: {
                outcome: "task_completed",
                message: "Implemented isolated worktree setup.",
            },
        }),
    ];

    assertEquals(extractAssistantOutput(messages), "Implemented isolated worktree setup.");
});

Deno.test("extractAssistantOutput handles legacy assistant text shapes", () => {
    assertEquals(
        extractAssistantOutput([
            /** @type {any} */ ({ role: "assistant", content: "Plain legacy summary." }),
        ]),
        "Plain legacy summary.",
    );
    assertEquals(
        extractAssistantOutput([
            /** @type {any} */ ({ role: "assistant", content: [{ contentText: "Content text summary." }] }),
        ]),
        "Content text summary.",
    );
});

Deno.test("finalizePlanImplementation checkpoints worktree changes before lifecycle completion", async () => {
    const projectRoot = await makeWorkflowProject([{ name: "feature-plan", status: "in_progress" }]);
    // A real worktree on a real branch. The checkpoint is RunWield's own policy — it
    // commits the Agent's work and refuses to return while the tree is still dirty —
    // so a stand-in returning a plausible SHA replaces the behaviour under test with
    // an assertion that the test itself wrote the answer.
    const worktree = await settleWorktreeAttempt(
        projectRoot,
        await createWorktreeGitArtifacts({ projectRoot, planName: "feature-plan", planId: PLAN_UNDER_TEST }),
    );
    await savePlan(worktree.path, "feature-plan", "# feature-plan", { status: "in_progress" });
    const branchHeadBefore = await git(projectRoot, ["rev-parse", `${worktree.branch}^{commit}`]);
    await Deno.writeTextFile(`${worktree.path}/implemented.txt`, "the Agent's work\n");

    const executionContext = /** @type {const} */ ({
        planName: "feature-plan",
        triageMeta: { classification: "FEATURE" },
        executionAgent: "engineer",
        executionMode: "worktree",
        projectRoot,
        executionCwd: worktree.path,
        baselineTree: "attempt-tree",
        worktreeId: worktree.id,
        worktreeBranch: worktree.branch,
    });

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

Deno.test("finalizePlanImplementation restores missing execution_started before lifecycle completion", async () => {
    const projectRoot = await makeWorkflowProject([{ name: "feature-plan", status: "ready_for_work" }]);
    const worktree = await settleWorktreeAttempt(
        projectRoot,
        await createWorktreeGitArtifacts({ projectRoot, planName: "feature-plan", planId: PLAN_UNDER_TEST }),
    );
    await savePlan(worktree.path, "feature-plan", "# feature-plan", { status: "ready_for_work" });
    await Deno.writeTextFile(`${worktree.path}/recovered.txt`, "work done before the marker was lost\n");

    const executionContext = /** @type {const} */ ({
        planName: "feature-plan",
        triageMeta: { classification: "FEATURE" },
        executionAgent: "engineer",
        executionMode: "worktree",
        projectRoot,
        executionCwd: worktree.path,
        baselineTree: "attempt-tree",
        worktreeId: worktree.id,
        worktreeBranch: worktree.branch,
    });

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

Deno.test("finalizePlanImplementation restores a Plan deleted and committed by the Engineer", async () => {
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
    const worktreePath = /** @type {string} */ (executionContext.executionCwd);
    const planPath = `${worktreePath}/docs/plans/deleted-plan.md`;
    const preparationCommit = await git(worktreePath, ["rev-parse", "HEAD"]);
    assertStringIncludes(await git(worktreePath, ["ls-files"]), "docs/plans/deleted-plan.md");

    await Deno.writeTextFile(`${worktreePath}/implemented.txt`, "implementation survives\n");
    await Deno.remove(planPath);
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

Deno.test("finalizePlanImplementation fails closed without durable execution context", async () => {
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

Deno.test("buildSlicerRequest includes plan name and base instructions", () => {
    const text = buildSlicerRequest("my-plan", undefined);
    assertStringIncludes(text, "Slice Plan: my-plan");
    assertStringIncludes(text, "docs/plans/my-plan.md");
    assertStringIncludes(text, "system prompt");
    // Without triage meta, the report block must not appear.
    assertEquals(text.includes("Triage Report"), false);
});

Deno.test("buildSlicerRequest includes triage report fields when present", () => {
    const text = buildSlicerRequest("my-plan", {
        classification: "PROJECT",
        workKind: "DOCUMENTATION",
        complexity: "HIGH",
        summary: "Initialize RunWield",
        affectedPaths: ["src/foo.js", "src/bar.js"],
    });
    assertStringIncludes(text, "Triage Report");
    assertStringIncludes(text, "Classification: PROJECT");
    assertStringIncludes(text, "Work Kind: DOCUMENTATION");
    assertStringIncludes(text, "Complexity: HIGH");
    assertStringIncludes(text, "Summary: Initialize RunWield");
    assertStringIncludes(text, "src/foo.js, src/bar.js");
});

Deno.test("buildSlicerRequest omits empty affectedPaths", () => {
    const text = buildSlicerRequest("p", {
        classification: "PROJECT",
        complexity: "LOW",
        summary: "x",
        affectedPaths: [],
    });
    assertEquals(text.includes("Affected paths"), false);
});

Deno.test("startActiveExecutionWorkflow records attempt timestamp only after execution starts", async () => {
    const projectRoot = await makeWorkflowProject([{ name: "clock-plan", status: "ready_for_work" }]);
    const hostedSession = makeHostedSession("attempt-clock-workflow", projectRoot);
    const result = await startActiveExecutionWorkflow({
        planName: "clock-plan",
        triageMeta: { planId: "plan-under-test", classification: "FEATURE" },
        currentStatus: "ready_for_work",
        hostedSession,
        ports: {
            ...createExecutionStartPorts(),
            now: () => 4242,
            probeGitRepository: () => Promise.resolve({ ok: false, state: "not_git", cwd: projectRoot }),
            hasNonGitExecutionConsent: () => true,
            recordWorkflowMetric: () => Promise.resolve(null),
        },
    });

    assertEquals(result.executionStarted, true);
    assertEquals(result.executionAttemptStartedAtMs, 4242);
    assertEquals(hostedSession.getActiveExecutionWorkflow()?.executionAttemptStartedAtMs, 4242);
});

Deno.test("execution preparation ignores Plan body edits the user owns", async () => {
    const projectRoot = await makeWorkflowProject([
        { name: "body-plan", status: "ready_for_work", classification: "FEATURE" },
    ]);
    const stored = await loadPlan(projectRoot, "body-plan");
    const hostedSession = makeHostedSession("exec-body", projectRoot);

    const result = await startActiveExecutionWorkflow({
        planName: "body-plan",
        triageMeta: { planId: PLAN_UNDER_TEST, classification: "FEATURE" },
        currentStatus: "ready_for_work",
        hostedSession,
        ports: {
            ...createExecutionStartPorts(),
            probeGitRepository: () => Promise.resolve({ ok: true, state: "work_tree", cwd: "" }),
            resolveCurrentCheckoutBranch: () => Promise.resolve("main"),
            findReusableWorktree: () => Promise.resolve(null),
            // Same lifecycle front matter, different body: the user edited their
            // Plan outside RunWield, which must not abort execution.
            loadCanonicalExecutionPlanSource: () =>
                Promise.resolve(
                    /** @type {any} */ ({
                        kind: "loaded",
                        path: stored?.path,
                        relativePath: "docs/plans/body-plan.md",
                        markdown: `${stored?.markdown}\n\nEdited in another editor.\n`,
                        attrs: { ...stored?.attrs },
                    }),
                ),
        },
    });

    assertEquals(result.planName, "body-plan");
    // The body edit reached the execution copy rather than being reverted or rejected.
    const executionPlan = await loadPlan(/** @type {string} */ (result.executionCwd), "body-plan");
    assertStringIncludes(String(executionPlan?.markdown), "Edited in another editor.");
});

Deno.test("execution preparation still refuses when lifecycle front matter drifts", async () => {
    const projectRoot = await Deno.makeTempDir({ prefix: "runwield-exec-fm-" });
    try {
        await savePlan(projectRoot, "fm-plan", "# FM Plan\n", {
            planId: "plan-fm",
            classification: "FEATURE",
            status: "ready_for_work",
            summary: "s",
            affectedPaths: [],
        });
        const stored = await loadPlan(projectRoot, "fm-plan");
        const hostedSession = makeHostedSession("exec-fm", projectRoot);

        await assertRejects(
            () =>
                startActiveExecutionWorkflow({
                    planName: "fm-plan",
                    triageMeta: { planId: "plan-fm", classification: "FEATURE" },
                    currentStatus: "ready_for_work",
                    hostedSession,
                    ports: {
                        ...createExecutionStartPorts(),
                        probeGitRepository: () => Promise.resolve({ ok: true, state: "work_tree", cwd: "" }),
                        resolveCurrentCheckoutBranch: () => Promise.resolve("main"),
                        findReusableWorktree: () => Promise.resolve(null),
                        // Front matter drifted on disk between the locked read and the
                        // read that materializes the Plan. Drift it in the markdown, the
                        // way a real edit would: attrs are derived from those bytes, so a
                        // fixture that changes attrs alone cannot happen in practice.
                        loadCanonicalExecutionPlanSource: () =>
                            Promise.resolve(
                                /** @type {any} */ ({
                                    kind: "loaded",
                                    path: stored?.path,
                                    relativePath: "docs/plans/fm-plan.md",
                                    markdown: String(stored?.markdown).replace(
                                        'status: "ready_for_work"',
                                        'status: "on_hold"',
                                    ),
                                    attrs: { ...stored?.attrs, status: "on_hold" },
                                }),
                            ),
                    },
                }),
            Error,
            "front matter change",
        );
    } finally {
        await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
    }
});

Deno.test("runPlanningAgent records a known Plan name before the planning turn starts", async () => {
    await withRuntimeCommandFixture("workflow-planning-plan-name-", async ({ setModelResponseFactory }) => {
        const projectRoot = await makeWorkflowProject([{ name: "resumed-plan", status: "draft" }]);
        const hostedSession = makeAgentHostedSession("workflow-planning-plan-name", projectRoot);
        let planNameDuringTurn = null;
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
                sessionManager: hostedSession.getRootSessionManager(),
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

Deno.test("runPlanningAgent leaves workflow Plan context alone when no Plan name is known", async () => {
    await withRuntimeCommandFixture("workflow-planning-no-plan-name-", async ({ setModelResponseFactory }) => {
        const projectRoot = await makeWorkflowProject([{ name: "unrelated-plan", status: "draft" }]);
        const hostedSession = makeAgentHostedSession("workflow-planning-no-plan-name", projectRoot);
        setModelResponseFactory(() => fauxAssistantMessage(fauxText("Still gathering context.")));

        try {
            await runPlanningAgent({
                agentName: "planner",
                initialRequest: "Plan something new.",
                triageMeta: {},
                hostedSession,
                sessionManager: hostedSession.getRootSessionManager(),
            });

            assertEquals(hostedSession.getWorkflowContext()?.planName, undefined);
        } finally {
            hostedSession.dispose();
        }
    });
});
