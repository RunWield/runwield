import { assertEquals } from "../../testing/assertions.ts";
import { rmdir as fsRmdir } from "node:fs/promises";
import { captureForegroundProcess } from "../../shared/captured-process.ts";
import { test as registerTest } from "node:test";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { createPlanSessionSurface } from "./plan-session-surface.ts";
import { recordWorkflowMetric } from "../../shared/workflow/metrics.ts";

import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { resetHeldPlanToDraft } from "./plan-hold.ts";
import { resetRecoveryPlan } from "./plan-recovery-reset.ts";
import { resolveRecoveryWorktree, persistRecoveredWorktreeMetadata } from "./plan-recovery-worktree.ts";
import { dirname } from "node:path";
import { handlePlanRecovery, SYSTEM_RECOVERY_FLOW_PORTS } from "./plan-recovery-flow.ts";
import { abandonRecoveryPlan, continueRecoveryPlan } from "./plan-recovery-actions.ts";
import { getStoredPlanPath, listPlans, loadPlan, savePlan, updatePlanFrontMatter } from "../../plan-store.js";
import { getTransitionJournalDir } from "../../shared/workflow/state-transition.ts";
import { readControllerRecord, writeControllerState } from "../../shared/workflow/controller-registry.ts";
import { resolvePlanWithPrimaryRecovery } from "./primary-plan-recovery.ts";
import {
    addEntry as addWorktreeRegistryEntry,
    findById as findWorktreeRegistryEntryById,
    getWorktreeRegistryPath,
} from "../../shared/worktree-registry.ts";
import { enterProjectRuntime } from "../../shared/project-runtime-layout.ts";

import type { PlanFrontMatter } from "../../plan-store.js";
import type { UiAPI } from "../../ui/tui/api.ts";
import type { PlanSessionSurface } from "./plan-session-types.ts";
import type { HandlePlanRecoveryOptions, RecoveryFlowPlan } from "./plan-recovery-flow.ts";
import type { RecoveryActionContext } from "./plan-recovery-actions.ts";

const sessionRuntimes = new Map<string, ReturnType<typeof createSessionRuntime>>();

function test(name: string, run: () => Promise<void>): void {
    registerTest(name, () =>
        withRuntimeCommandFixture("recovery-runtime-", async () => {
            try {
                await run();
            } finally {
                for (const runtime of sessionRuntimes.values()) runtime.closeAllSessions();
                sessionRuntimes.clear();
            }
        }),
    );
}

interface PromptOption {
    value: string;
    label: string;
}

interface TestUi extends UiAPI {
    prompts: string[];
    messages: string[];
    optionLabels: string[][];
}

interface RunRecoveryResult {
    result: "handled" | "review" | "settled" | "verified";
    plan: RecoveryFlowPlan;
    ui: TestUi;
}

interface RealRecoveryProject {
    projectRoot: string;
    plan: RecoveryFlowPlan;
    baselineTree: string;
}

interface RecoveryProjectOptions {
    legacyUnregisteredRecovery?: boolean;
}

function makeUi(answers: (string | null)[], textAnswers: (string | null)[] = []): TestUi {
    const prompts: string[] = [];
    const messages: string[] = [];
    const optionLabels: string[][] = [];
    const ui: Partial<TestUi> = {
        prompts,
        messages,
        optionLabels,
        promptSelect: (prompt: string, options: PromptOption[]) => {
            prompts.push(`${prompt}:${options.map((option) => option.value).join(",")}`);
            optionLabels.push(options.map((option) => option.label));
            return Promise.resolve(answers.shift() ?? null);
        },
        promptText: (prompt: string) => {
            prompts.push(`${prompt}:text`);
            return Promise.resolve(textAnswers.shift() ?? null);
        },
        appendSystemMessage: (message: string) => {
            messages.push(message);
        },
    };
    return ui as TestUi;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
    const output = await captureForegroundProcess("git", { cwd, args });
    if (!output.success) {
        throw new Error(new TextDecoder().decode(output.stderr));
    }
    return new TextDecoder().decode(output.stdout).trim();
}

async function makeRealRecoveryProject(
    attrs: Partial<PlanFrontMatter> = {},
    options: RecoveryProjectOptions = {},
): Promise<RealRecoveryProject> {
    const projectRoot = await fsMkdtemp(join(tmpdir(), "runwield-recovery-real-"));
    await runGit(projectRoot, ["init", "-b", "main"]);
    await runGit(projectRoot, ["config", "core.autocrlf", "false"]);
    await runGit(projectRoot, ["config", "user.email", "runwield@example.test"]);
    await runGit(projectRoot, ["config", "user.name", "RunWield Test"]);
    await savePlan(projectRoot, "recovery-contract", "# Plan\n\nrecovery fixture\n", {
        classification: "FEATURE",
        status: "failed",
        summary: "test plan",
        affectedPaths: [],
        executionMode: "non_git_in_place",
        planId: "plan-1",
        ...attrs,
    });
    await runGit(projectRoot, ["add", "."]);
    await runGit(projectRoot, ["commit", "-m", "initial fixture"]);
    const baselineTree = await runGit(projectRoot, ["rev-parse", "HEAD^{tree}"]);
    if (attrs.worktreeId && options.legacyUnregisteredRecovery) {
        await writeControllerState(
            projectRoot,
            { planName: "recovery-contract", planId: attrs.planId || "plan-1" },
            {},
            {
                recovery: {
                    worktreeId: attrs.worktreeId,
                    worktreePath: attrs.worktreePath,
                    worktreeBranch: attrs.worktreeBranch,
                    worktreeBaseBranch: attrs.worktreeBaseBranch,
                    worktreeStatus: attrs.worktreeStatus || "active",
                    executionBaselineTree: baselineTree,
                },
            },
        );
    } else if (attrs.worktreeId) {
        await addWorktreeRegistryEntry(projectRoot, {
            id: attrs.worktreeId,
            planId: attrs.planId || "plan-1",
            planName: "recovery-contract",
            path: attrs.worktreePath || `${projectRoot}/gone`,
            branch: attrs.worktreeBranch || "rw/gone",
            baseBranch: attrs.targetBranch || attrs.worktreeBaseBranch || "main",
            baseRef: "main",
            baseCommit: await runGit(projectRoot, ["rev-parse", "HEAD"]),
            baseTree: baselineTree,
            executionBaselineTree: baselineTree,
            status: "active",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        });
    }
    const loadedPlan = await loadPlan(projectRoot, "recovery-contract");
    if (!loadedPlan) throw new Error("fixture plan was not saved");
    const plan: RecoveryFlowPlan = { ...loadedPlan, planName: "recovery-contract" };
    return { projectRoot, plan, baselineTree };
}

async function makeOptions(
    plan: RecoveryFlowPlan,
    uiAPI: UiAPI,
    projectRoot: string,
): Promise<HandlePlanRecoveryOptions> {
    return {
        projectRoot,
        plan,
        agentName: "engineer",
        uiAPI,
        session: await makeSession(projectRoot),
        ports: SYSTEM_RECOVERY_FLOW_PORTS,
    };
}

async function fileExists(path: string): Promise<boolean> {
    return await fsStat(path)
        .then(() => true)
        .catch(() => false);
}

async function writeTransitionRecord(
    projectRoot: string,
    transitionId: string,
    planName: string,
    state: string,
): Promise<void> {
    const journalDir = getTransitionJournalDir(projectRoot);
    await fsMkdir(journalDir, { recursive: true });
    await fsWriteFile(
        `${journalDir}/${transitionId}.json`,
        `${JSON.stringify({ transitionId, planName, operation: "recovery_reset", state }, null, 2)}\n`,
    );
}

async function writeUnresolvedTransitionRecord(
    projectRoot: string,
    transitionId: string,
    planName: string,
): Promise<void> {
    const journalDir = getTransitionJournalDir(projectRoot);
    await fsMkdir(journalDir, { recursive: true });
    await fsWriteFile(
        `${journalDir}/${transitionId}.json`,
        `${JSON.stringify(
            {
                transitionId,
                planName,
                operation: "recovery_reset",
                state: "interrupted",
                beforeFacts: { plan: { revision: "stale-frontmatter-revision" } },
            },
            null,
            2,
        )}\n`,
    );
}

async function makeSession(projectRoot: string): Promise<PlanSessionSurface> {
    const runtime = createSessionRuntime();
    const sessionId = await runtime.createPromptReadySession({ cwd: projectRoot, agentName: "guide" });
    sessionRuntimes.set(sessionId, runtime);
    return createPlanSessionSurface(runtime, sessionId, {
        executePlan: (options) => runtime.executePlan(sessionId, options),
        runPlanningAgent: (options) => runtime.runPlanningAgent(sessionId, options),
        runValidation: (options) => runtime.runValidation(sessionId, options),
        runSlicerAgent: (options) => runtime.runSlicerAgent(sessionId, options),
    });
}

async function makeActionContext(
    projectRoot: string,
    plan: RecoveryFlowPlan,
    uiAPI: UiAPI,
): Promise<RecoveryActionContext> {
    const context: RecoveryActionContext = {
        projectRoot,
        plan,
        agentName: "engineer",
        uiAPI,
        session: await makeSession(projectRoot),
        loadedWorktreeId: plan.attrs.worktreeId,
        worktreeContext: await resolveRecoveryWorktree(projectRoot, plan),
        unresolvedRecords: [],
        refreshRecoveryWorktree: async () => {
            const resolved = await resolveRecoveryWorktree(projectRoot, plan);
            plan.attrs = await persistRecoveredWorktreeMetadata(resolved?.path || projectRoot, plan, resolved);
            context.worktreeContext = resolved;
            return resolved;
        },
        recordRecoveryResult: async (action, result, details = {}) => {
            await recordWorkflowMetric(
                {
                    category: "recovery",
                    event: "recovery_action_result",
                    planName: plan.planName,
                    details: { action, result, ...details },
                },
                projectRoot,
            );
        },
    };
    return context;
}

async function runRealRecovery(
    selections: Array<string | null>,
    attrs: Partial<PlanFrontMatter> = {},
    configure: (options: HandlePlanRecoveryOptions, project: RealRecoveryProject) => Promise<void> | void = () => {},
): Promise<RunRecoveryResult> {
    const project = await makeRealRecoveryProject(attrs);
    const ui = makeUi(selections);
    const options = await makeOptions(project.plan, ui, project.projectRoot);
    await configure(options, project);
    const result = await handlePlanRecovery(options);
    return { result, plan: project.plan, ui };
}

test("continuing an in-progress worktree repairs its authoritative Plan before execution handoff", async () => {
    const project = await makeRealRecoveryProject({ status: "ready_for_work", executionMode: "worktree" });
    const worktreePath = await fsMkdtemp(join(tmpdir(), "runwield-recovery-authority-worktree-"));
    await fsRmdir(worktreePath);
    try {
        await runGit(project.projectRoot, ["worktree", "add", "-b", "rw/authority", worktreePath, "HEAD"]);
        const primaryPlan = await loadPlan(project.projectRoot, project.plan.planName);
        const executionPlan = await loadPlan(worktreePath, project.plan.planName);
        if (!primaryPlan || !executionPlan) throw new Error("authority fixture Plan disappeared");
        const attempt = {
            executionMode: "worktree" as const,
            executionBaselineTree: project.baselineTree,
            worktreeId: "authority-worktree-1",
            worktreePath,
            worktreeBranch: "rw/authority",
            worktreeBaseBranch: "main",
            worktreeStatus: "active" as const,
        };
        const primaryAttrs = await updatePlanFrontMatter(
            project.projectRoot,
            project.plan.planName,
            { status: "ready_for_work" },
            primaryPlan.attrs,
            { expectedRevision: primaryPlan.revision },
        );
        const executionAttrs = await updatePlanFrontMatter(
            worktreePath,
            project.plan.planName,
            { ...attempt, status: "in_progress" },
            executionPlan.attrs,
            { expectedRevision: executionPlan.revision },
        );
        const now = new Date().toISOString();
        await addWorktreeRegistryEntry(project.projectRoot, {
            id: attempt.worktreeId,
            planName: project.plan.planName,
            planId: "plan-1",
            path: worktreePath,
            branch: attempt.worktreeBranch,
            baseBranch: attempt.worktreeBaseBranch,
            baseRef: attempt.worktreeBaseBranch,
            baseCommit: await runGit(project.projectRoot, ["rev-parse", "HEAD"]),
            baseTree: project.baselineTree,
            executionBaselineTree: project.baselineTree,
            status: "active",
            createdAt: now,
            updatedAt: now,
        });
        const recoveryDirectory = getTransitionJournalDir(worktreePath);
        const recoveryPath = `${recoveryDirectory}/interrupted-execution-setup.json`;
        await fsMkdir(recoveryDirectory, { recursive: true });
        await fsWriteFile(
            recoveryPath,
            `${JSON.stringify(
                {
                    version: 1,
                    transitionId: "interrupted-execution-setup",
                    operation: "execution_preparation",
                    planName: project.plan.planName,
                    state: "needs_recovery",
                    resources: [
                        { kind: "plan", id: project.plan.planName },
                        { kind: "attempt", id: attempt.worktreeId },
                    ],
                    completedEffects: [
                        {
                            effect: "git_worktree_reused",
                            proof: {
                                worktreeId: attempt.worktreeId,
                                path: worktreePath,
                                branch: attempt.worktreeBranch,
                            },
                        },
                        {
                            effect: "worktree_registry_updated",
                            proof: { worktreeId: attempt.worktreeId, status: "active" },
                        },
                        { effect: "plan_event_recorded", proof: { planName: project.plan.planName } },
                    ],
                },
                null,
                2,
            )}\n`,
        );
        project.plan.attrs = primaryAttrs;
        const ui = makeUi(["continue"]);
        const options = await makeOptions(project.plan, ui, project.projectRoot);

        assertEquals(await handlePlanRecovery(options), "handled");
        assertEquals(
            await fsStat(recoveryPath)
                .then(() => true)
                .catch(() => false),
            false,
        );
        assertEquals((await loadPlan(project.projectRoot, project.plan.planName))?.attrs.status, "ready_for_work");
        assertEquals((await loadPlan(worktreePath, project.plan.planName))?.attrs.status, "ready_for_work");
        assertEquals((await findWorktreeRegistryEntryById(project.projectRoot, attempt.worktreeId))?.status, "active");
        assertEquals(
            ui.messages.some((message) => message.includes("old status data")),
            false,
        );
        assertEquals(executionAttrs.status, "in_progress");
    } finally {
        await runGit(project.projectRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => "");
        await fsRm(project.projectRoot, { recursive: true }).catch(() => {});
        await fsRm(worktreePath, { recursive: true }).catch(() => {});
    }
});

test("registered worktree recovery keeps uncertain journals at that worktree until attestation", async () => {
    const project = await makeRealRecoveryProject({ status: "failed", executionMode: "worktree" });
    const worktreePath = await fsMkdtemp(join(tmpdir(), "runwield-recovery-uncertain-worktree-"));
    await fsRmdir(worktreePath);
    try {
        await runGit(project.projectRoot, ["worktree", "add", "-b", "rw/uncertain", worktreePath, "HEAD"]);
        await addWorktreeRegistryEntry(project.projectRoot, {
            id: "uncertain-worktree-1",
            planName: project.plan.planName,
            planId: "plan-1",
            path: worktreePath,
            branch: "rw/uncertain",
            baseBranch: "main",
            baseRef: "main",
            baseCommit: await runGit(project.projectRoot, ["rev-parse", "HEAD"]),
            baseTree: project.baselineTree,
            executionBaselineTree: project.baselineTree,
            status: "active",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        });
        await enterProjectRuntime(worktreePath);
        await writeUnresolvedTransitionRecord(worktreePath, "registered-uncertain", project.plan.planName);
        const activePath = `${getTransitionJournalDir(worktreePath)}/registered-uncertain.json`;
        const primaryActivePath = `${getTransitionJournalDir(project.projectRoot)}/registered-uncertain.json`;
        const archivePath = `${getTransitionJournalDir(worktreePath)}/attested/registered-uncertain.json`;
        const primaryArchivePath = `${getTransitionJournalDir(project.projectRoot)}/attested/registered-uncertain.json`;

        const declinedUi = makeUi(["settle_records", "no", "cancel"]);
        const declined = await makeOptions(project.plan, declinedUi, project.projectRoot);
        assertEquals(await handlePlanRecovery(declined), "handled");
        assertEquals(await fileExists(activePath), true);
        assertEquals(await fileExists(primaryActivePath), false);
        assertEquals(await fileExists(archivePath), false);
        assertEquals(
            declinedUi.optionLabels[0]?.some((label) => label.includes("unfinished Plan update")),
            true,
        );

        const attestedUi = makeUi(["settle_records", "yes", "cancel"]);
        const attested = await makeOptions(project.plan, attestedUi, project.projectRoot);
        assertEquals(await handlePlanRecovery(attested), "handled");
        assertEquals(await fileExists(activePath), false);
        assertEquals(await fileExists(primaryActivePath), false);
        assertEquals(await fileExists(primaryArchivePath), false);
        const archived = JSON.parse(await fsReadFile(archivePath, "utf8"));
        assertEquals(archived.state, "closed_by_user_attestation");
        assertEquals(archived.attestationNote, `Closed from Plan Recovery for ${project.plan.planName}.`);
    } finally {
        await runGit(project.projectRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => "");
        await fsRm(project.projectRoot, { recursive: true }).catch(() => {});
        await fsRm(worktreePath, { recursive: true }).catch(() => {});
    }
});

test("validated work already contained in its target branch is complete without a worktree record", async () => {
    const project = await makeRealRecoveryProject({ status: "validated", executionMode: "worktree" });
    const executionCommit = await runGit(project.projectRoot, ["rev-parse", "HEAD"]);
    const currentPlan = await loadPlan(project.projectRoot, project.plan.planName);
    if (!currentPlan) throw new Error("published fixture Plan disappeared");
    await updatePlanFrontMatter(
        project.projectRoot,
        project.plan.planName,
        {
            status: "validated",
            executionMode: "worktree",
            deliveryEvidence: {
                version: 1,
                mode: "worktree_merge",
                executionCommit,
                targetBranch: "main",
                targetHeadBeforeMerge: executionCommit,
            },
        },
        currentPlan.attrs,
        { expectedRevision: currentPlan.revision },
    );
    assertEquals(
        await runGit(project.projectRoot, ["status", "--porcelain"]),
        "",
        "delivery bookkeeping creates no Plan commit",
    );
    const publishedPlan = await loadPlan(project.projectRoot, project.plan.planName);
    if (!publishedPlan) throw new Error("published fixture Plan was not saved");
    project.plan = { ...publishedPlan, planName: project.plan.planName };
    const ui = makeUi([]);
    const options = await makeOptions(project.plan, ui, project.projectRoot);

    assertEquals(await handlePlanRecovery(options), "settled");
    assertEquals(ui.prompts.length, 0);
    assertEquals(ui.messages.includes(`${project.plan.planName} is on main.`), true);
});

test("Plan Recovery actions preserve live context", async () => {
    let abandonedProjectRoot = "";
    let primaryBeforeAbandon = "";
    const abandonSuccess = await runRealRecovery(["abandon", "confirm", null], {}, async (_options, project) => {
        abandonedProjectRoot = project.projectRoot;
        primaryBeforeAbandon = await fsReadFile(project.plan.path, "utf8");
        const worktreePath = await fsMkdtemp(join(tmpdir(), "runwield-recovery-abandon-worktree-"));
        await fsRmdir(worktreePath);
        await runGit(project.projectRoot, ["worktree", "add", "-b", "rw/test", worktreePath, "HEAD"]);
        await addWorktreeRegistryEntry(project.projectRoot, {
            id: "worktree-1",
            planName: project.plan.planName,
            planId: "plan-1",
            path: worktreePath,
            branch: "rw/test",
            baseBranch: "main",
            baseRef: "main",
            baseCommit: await runGit(project.projectRoot, ["rev-parse", "HEAD"]),
            baseTree: project.baselineTree,
            status: "active",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        });
        const attrs = await updatePlanFrontMatter(
            project.projectRoot,
            project.plan.planName,
            {
                documentWorktreeId: "worktree-1",
                executionMode: "worktree",
                worktreeId: "worktree-1",
                worktreePath,
                worktreeBranch: "rw/test",
            },
            project.plan.attrs,
            { expectedRevision: project.plan.revision },
        );
        project.plan.attrs = attrs;
        const reloaded = await loadPlan(project.projectRoot, project.plan.planName);
        if (!reloaded) throw new Error("abandon fixture plan disappeared");
        project.plan.revision = reloaded.revision;
    });
    assertEquals(abandonSuccess.result, "handled");
    assertEquals(Boolean(abandonSuccess.plan.attrs.worktreeId), false);
    assertEquals(abandonSuccess.ui.prompts.filter((prompt) => prompt.startsWith("Plan recovery")).length, 2);
    const abandonedController = await readControllerRecord(abandonedProjectRoot, {
        planName: abandonSuccess.plan.planName,
        planId: abandonSuccess.plan.attrs.planId,
    });
    assertEquals(abandonedController?.state.documentWorktreeId, undefined);
    const primaryPath = getStoredPlanPath(abandonedProjectRoot, abandonSuccess.plan.planName);
    assertEquals(
        (await listPlans(abandonedProjectRoot)).map((plan) => plan.path),
        [primaryPath],
    );
    assertEquals(
        (await resolvePlanWithPrimaryRecovery(abandonedProjectRoot, abandonSuccess.plan.planName)).plan.path,
        primaryPath,
    );
    assertEquals(await fsReadFile(primaryPath, "utf8"), primaryBeforeAbandon);

    const abandonMissingRegistry = await runRealRecovery(
        ["abandon", "confirm", null],
        {},
        async (_options, project) => {
            const worktreePath = await fsMkdtemp(join(tmpdir(), "runwield-recovery-missing-registry-"));
            await fsRmdir(worktreePath);
            await writeControllerState(
                project.projectRoot,
                { planName: project.plan.planName, planId: project.plan.attrs.planId },
                {},
                {
                    recovery: { worktreeId: "missing-worktree-1", worktreePath, worktreeBranch: "rw/missing-registry" },
                },
            );
            const attrs = await updatePlanFrontMatter(
                project.projectRoot,
                project.plan.planName,
                { worktreeId: "missing-worktree-1", worktreePath, worktreeBranch: "rw/missing-registry" },
                project.plan.attrs,
                { expectedRevision: project.plan.revision },
            );
            project.plan.attrs = attrs;
            const reloaded = await loadPlan(project.projectRoot, project.plan.planName);
            if (!reloaded) throw new Error("missing-registry abandon fixture plan disappeared");
            project.plan.revision = reloaded.revision;
        },
    );
    assertEquals(abandonMissingRegistry.result, "handled");
    assertEquals(Boolean(abandonMissingRegistry.plan.attrs.worktreeId), false);
    assertEquals(
        abandonMissingRegistry.ui.messages.some((message) => message.includes("recorded worktree and branch are gone")),
        true,
    );
});

test("discarded execution refreshes the surviving Plan before reopening review", async () => {
    const project = await makeRealRecoveryProject({ status: "ready_for_work" });
    const primary = await loadPlan(project.projectRoot, project.plan.planName);
    if (!primary) throw new Error("primary Plan fixture disappeared");
    const worktreePath = `${project.projectRoot}-discard`;
    await runGit(project.projectRoot, ["worktree", "add", "-b", "rw/discard-review", worktreePath, "HEAD"]);
    try {
        await addWorktreeRegistryEntry(project.projectRoot, {
            id: "discard-review",
            planId: "plan-1",
            planName: project.plan.planName,
            path: worktreePath,
            branch: "rw/discard-review",
            baseBranch: "main",
            baseRef: "main",
            baseCommit: await runGit(project.projectRoot, ["rev-parse", "HEAD"]),
            baseTree: project.baselineTree,
            status: "execution_failed",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        });
        const execution = await loadPlan(worktreePath, project.plan.planName);
        if (!execution) throw new Error("execution Plan fixture disappeared");
        await updatePlanFrontMatter(
            worktreePath,
            project.plan.planName,
            {
                status: "failed",
                documentWorktreeId: "discard-review",
            },
            {},
            { expectedRevision: execution.revision },
        );
        await fsWriteFile(execution.path, `${await fsReadFile(execution.path, "utf8")}\nExecution-only edits.\n`);
        const ui = makeUi(["abandon", "confirm", "review"]);
        const select = ui.promptSelect;
        ui.promptSelect = async (...args) => {
            if (ui.prompts.length === 2) {
                assertEquals(
                    await fsReadFile(primary.path, "utf8"),
                    primary.markdown,
                    "discard preserves primary bytes",
                );
                assertEquals(project.plan.path, primary.path);
                assertEquals(project.plan.body, primary.body);
                assertEquals(project.plan.revision, primary.revision);
                assertEquals(project.plan.attrs.status, "ready_for_work");
                assertEquals(project.plan.attrs.documentWorktreeId, undefined);
                assertEquals(options.session.getActiveExecutionWorkflow(), null);
            }
            return await select(...args);
        };
        const options = await makeOptions(project.plan, ui, project.projectRoot);
        await options.session.setActiveExecutionWorkflow({
            planName: project.plan.planName,
            triageMeta: { classification: "PLANNED_CHANGE" },
            executionAgent: "engineer",
            executionCwd: worktreePath,
            worktreeId: "discard-review",
            projectRoot: project.projectRoot,
        });
        assertEquals(await handlePlanRecovery(options), "review");
        assertEquals(options.session.getActiveExecutionWorkflow(), null);
        assertEquals((await loadPlan(project.projectRoot, project.plan.planName))?.attrs.status, "draft");
        assertEquals((await loadPlan(project.projectRoot, project.plan.planName))?.body, primary.body);
        assertEquals((await findWorktreeRegistryEntryById(project.projectRoot, "discard-review"))?.status, "abandoned");
    } finally {
        await runGit(project.projectRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => {});
        await fsRm(project.projectRoot, { recursive: true });
    }
});

test("unregistered legacy recovery offers User Verification for implemented plans with lost worktrees", async () => {
    const project = await makeRealRecoveryProject(
        {
            status: "implemented",
            executionMode: "worktree",
            worktreeId: "lost-worktree",
            worktreePath: `${await fsMkdtemp(join(tmpdir(), "runwield-fixture-"))}/gone`,
            worktreeBranch: "rw/gone",
            worktreeBaseBranch: "main",
        },
        { legacyUnregisteredRecovery: true },
    );
    assertEquals(await findWorktreeRegistryEntryById(project.projectRoot, "lost-worktree"), null);
    const ui = makeUi(["user_verify"], ["Accepted from staging check."]);
    const options = await makeOptions(project.plan, ui, project.projectRoot);

    assertEquals(await handlePlanRecovery(options), "handled");
    assertEquals(
        ui.prompts[0],
        "The worktree and branch are gone. The Plan says they should be here. What do you want to do?:reset,abandon,user_verify,review,stop_lost",
    );
    assertEquals(ui.prompts[1], "Required user verification note (blank cancels)::text");
    const loadedPlan = await loadPlan(project.projectRoot, project.plan.planName);
    assertEquals(loadedPlan?.attrs.status, "user_verified");
    assertEquals(loadedPlan?.attrs.userVerificationNote, "Accepted from staging check.");
    assertEquals(Boolean(loadedPlan?.attrs.userVerifiedAt), true);
    assertEquals(loadedPlan?.attrs.verifiedAt, undefined);
});

test("unregistered legacy recovery omits User Verification for failed plans with lost worktrees", async () => {
    const project = await makeRealRecoveryProject(
        {
            executionMode: "worktree",
            worktreeId: "lost-worktree",
            worktreePath: `${await fsMkdtemp(join(tmpdir(), "runwield-fixture-"))}/gone`,
            worktreeBranch: "rw/gone",
            worktreeBaseBranch: "main",
        },
        { legacyUnregisteredRecovery: true },
    );
    assertEquals(await findWorktreeRegistryEntryById(project.projectRoot, "lost-worktree"), null);
    const ui = makeUi(["stop_lost"]);
    const options = await makeOptions(project.plan, ui, project.projectRoot);

    assertEquals(await handlePlanRecovery(options), "handled");
    assertEquals(
        ui.prompts[0],
        "The worktree and branch are gone. The Plan says they should be here. What do you want to do?:reset,abandon,review,stop_lost",
    );
    assertEquals((await loadPlan(project.projectRoot, project.plan.planName))?.attrs.status, "ready_for_work");
});

test("continue recovery cancellation leaves the Session name and workflow untouched", async () => {
    const project = await makeRealRecoveryProject({
        affectedPaths: ["tracked.txt"],
        createdAt: "2000-01-01T00:00:00.000Z",
        updatedAt: "2000-01-01T00:00:00.000Z",
    });
    await fsWriteFile(`${project.projectRoot}/tracked.txt`, "changed after Plan update\n");
    await runGit(project.projectRoot, ["add", "tracked.txt"]);
    await runGit(project.projectRoot, ["commit", "-m", "touch affected path"]);

    const ui = makeUi(["cancel"]);
    const context = await makeActionContext(project.projectRoot, project.plan, ui);
    const runtime = sessionRuntimes.get(context.session.id);
    if (!runtime) throw new Error("Recovery Session missing");
    const sessionBefore = runtime.getSessionSnapshot(context.session.id);
    const outcome = await continueRecoveryPlan(context);

    assertEquals(outcome, { kind: "handled" });
    assertEquals(runtime.getSessionSnapshot(context.session.id), sessionBefore);
    assertEquals(ui.messages.includes("Execution canceled."), true);
});

test("recovery cancel at the first menu leaves unrelated repairable state untouched", async () => {
    const project = await makeRealRecoveryProject();
    const ui = makeUi([null]);
    const options = await makeOptions(project.plan, ui, project.projectRoot);
    // Unrelated repairable state: another Plan's document, worktree registry
    // entry, and settled journal. A repository-wide `plans doctor --repair`
    // would retire the journal and touch the rest; the selected-Plan recovery
    // preflight must leave all of it alone.
    await writeTransitionRecord(project.projectRoot, "unrelated-record", "unrelated-plan", "committed");
    const journalPath = `${getTransitionJournalDir(project.projectRoot)}/unrelated-record.json`;
    const journalBefore = await fsReadFile(journalPath);
    await savePlan(project.projectRoot, "unrelated-plan", "# Unrelated Plan\n", {
        classification: "FEATURE",
        status: "draft",
        summary: "unrelated fixture plan",
        affectedPaths: [],
        planId: "unrelated-plan-1",
    });
    const unrelatedPlanPath = getStoredPlanPath(project.projectRoot, "unrelated-plan");
    const unrelatedPlanBefore = await fsReadFile(unrelatedPlanPath);
    const registryPath = getWorktreeRegistryPath(project.projectRoot);
    await fsMkdir(dirname(registryPath), { recursive: true });
    await fsWriteFile(
        registryPath,
        `${JSON.stringify(
            {
                version: 2,
                entries: [
                    {
                        id: "unrelated-worktree",
                        planName: "unrelated-plan",
                        path: `${project.projectRoot}/unrelated-worktree`,
                        branch: "rw/unrelated-plan",
                        baseBranch: "main",
                        baseRef: "main",
                        baseCommit: await runGit(project.projectRoot, ["rev-parse", "HEAD"]),
                        baseTree: project.baselineTree,
                        status: "active",
                        createdAt: "2026-01-01T00:00:00.000Z",
                        updatedAt: "2026-01-01T00:00:00.000Z",
                    },
                ],
            },
            null,
            2,
        )}\n`,
    );
    const registryBefore = await fsReadFile(registryPath);

    // Capture every Git command the preflight spawns.
    const tracePath = `${project.projectRoot}${process.platform === "win32" ? "\\" : "/"}git-trace2.log`;
    const previousTrace = process.env["GIT_TRACE2"];
    process.env["GIT_TRACE2"] = tracePath;
    let result: string;
    try {
        result = await handlePlanRecovery(options);
    } finally {
        if (previousTrace === undefined) delete process.env["GIT_TRACE2"];
        else process.env["GIT_TRACE2"] = previousTrace;
    }

    // The flow stopped at the first recovery menu without running any action.
    assertEquals(result, "handled");
    assertEquals(ui.prompts.length, 1);
    // The unrelated state survived byte-for-byte: no repository-wide repair ran.
    assertEquals(await fsReadFile(journalPath), journalBefore);
    assertEquals(await fsReadFile(unrelatedPlanPath), unrelatedPlanBefore);
    assertEquals(await fsReadFile(registryPath), registryBefore);
    // No repository-wide Doctor Git work and no publication ancestry work
    // occurred before the menu. The selected-Plan snapshot is allowed its own
    // `git worktree list` discovery and nothing else.
    let trace = "";
    try {
        trace = await fsReadFile(tracePath, "utf8");
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    for (const forbidden of ["for-each-ref", "clone", "fetch", "merge-base", "rev-list", "--contains", "show-ref"]) {
        assertEquals(
            trace.includes(forbidden),
            false,
            `unexpected repository-wide Git work before the menu: ${forbidden}`,
        );
    }
});

test("recovery abandon: deletes unchanged branch from Plan base commit when registry is missing", async () => {
    const project = await makeRealRecoveryProject({ status: "failed" });
    const root = project.projectRoot;
    const parent = await fsMkdtemp(join(tmpdir(), "rw-discard-missing-registry-"));
    const branch = "worktree/missing-registry";
    const path = `${parent}/missing`;
    try {
        await runGit(root, ["switch", "-c", "target"]);
        await fsWriteFile(`${root}/target.txt`, "target\n");
        await runGit(root, ["add", "target.txt"]);
        await runGit(root, ["commit", "-m", "target base"]);
        const baseCommit = await runGit(root, ["rev-parse", "HEAD"]);
        await runGit(root, ["switch", "main"]);
        await fsWriteFile(`${root}/main.txt`, "main\n");
        await runGit(root, ["add", "main.txt"]);
        await runGit(root, ["commit", "-m", "main diverged"]);
        await runGit(root, ["branch", branch, baseCommit]);
        const beforeUpdate = await loadPlan(root, project.plan.planName);
        if (!beforeUpdate) throw new Error("fixture Plan missing");
        await updatePlanFrontMatter(root, project.plan.planName, { status: "failed" }, beforeUpdate.attrs, {
            expectedRevision: beforeUpdate.revision,
        });
        await writeControllerState(
            root,
            { planName: project.plan.planName, planId: "plan-1" },
            { executionMode: "worktree", documentWorktreeId: "missing-registry-attempt" },
            {
                recovery: {
                    worktreeId: "missing-registry-attempt",
                    worktreePath: path,
                    worktreeBranch: branch,
                    worktreeBaseBranch: "target",
                    worktreeBaseCommit: baseCommit,
                    worktreeStatus: "active",
                },
            },
        );
        const plan = await loadPlan(root, project.plan.planName);
        if (!plan) throw new Error("fixture Plan missing");
        const ui = makeUi(["confirm"]);
        const context = await makeActionContext(root, { ...plan, planName: project.plan.planName }, ui);
        context.worktreeContext = await resolveRecoveryWorktree(root, context.plan);
        await abandonRecoveryPlan(context);
        assertEquals(await runGit(root, ["branch", "--list", branch]), "");
        assertEquals(await findWorktreeRegistryEntryById(root, "missing-registry-attempt"), null);
    } finally {
        await fsRm(root, { recursive: true });
        await fsRm(parent, { recursive: true });
    }
});

test("held reset keep: restores abandoned rescue record when registry is missing", async () => {
    const project = await makeRealRecoveryProject({ status: "on_hold" });
    const root = project.projectRoot;
    const parent = await fsMkdtemp(join(tmpdir(), "rw-held-keep-missing-registry-"));
    const branch = "worktree/held-keep";
    const path = `${parent}/held`;
    try {
        const baseCommit = await runGit(root, ["rev-parse", "HEAD"]);
        await runGit(root, ["worktree", "add", "-b", branch, path, baseCommit]);
        const beforeUpdate = await loadPlan(root, project.plan.planName);
        if (!beforeUpdate) throw new Error("fixture Plan missing");
        await updatePlanFrontMatter(root, project.plan.planName, { status: "on_hold" }, beforeUpdate.attrs, {
            expectedRevision: beforeUpdate.revision,
        });
        await writeControllerState(
            root,
            { planName: project.plan.planName, planId: "plan-1" },
            { executionMode: "worktree", documentWorktreeId: "held-keep-attempt" },
            {
                recovery: {
                    worktreeId: "held-keep-attempt",
                    worktreePath: path,
                    worktreeBranch: branch,
                    worktreeBaseBranch: "main",
                    worktreeBaseCommit: baseCommit,
                    worktreeStatus: "active",
                },
            },
        );
        const plan = await loadPlan(root, project.plan.planName);
        if (!plan) throw new Error("fixture Plan missing");
        const ui = makeUi(["reset_keep"]);
        await resetHeldPlanToDraft({
            projectRoot: root,
            plan: { ...plan, planName: project.plan.planName },
            uiAPI: ui,
        });
        const record = await findWorktreeRegistryEntryById(root, "held-keep-attempt");
        assertEquals(record?.status, "abandoned");
        assertEquals(record?.path, path);
        assertEquals(
            await fsStat(path)
                .then(() => true)
                .catch(() => false),
            true,
        );
    } finally {
        await runGit(root, ["worktree", "remove", "--force", path]).catch(() => Promise.resolve());
        await fsRm(root, { recursive: true });
        await fsRm(parent, { recursive: true });
    }
});

for (const action of ["abandon", "held_reset", "recreate"]) {
    for (const scenario of [
        "primary_path",
        "primary_branch",
        "wrong_checkout",
        "unchanged",
        "branch_only",
        "unique_commit",
        "missing_plan_id",
        "invalid_base",
    ]) {
        if (action !== "recreate" && ["missing_plan_id", "invalid_base"].includes(scenario)) continue;
        if (action === "recreate" && ["unchanged", "branch_only", "unique_commit"].includes(scenario)) continue;
        test(`recovery ${action}: ${scenario} preserves the developer checkout and reports actual cleanup`, async () => {
            const project = await makeRealRecoveryProject({ status: action === "held_reset" ? "on_hold" : "failed" });
            const root = project.projectRoot;
            const parent = await fsMkdtemp(join(tmpdir(), "rw-discard-"));
            const branch = "worktree/attempt";
            let path = `${parent}/attempt`;
            try {
                await fsWriteFile(`${root}/tracked.txt`, "base\n");
                await runGit(root, ["add", "tracked.txt"]);
                await runGit(root, ["commit", "-m", "tracked developer file"]);
                await runGit(root, ["switch", "-c", "target"]);
                await fsWriteFile(`${root}/target.txt`, "target\n");
                await runGit(root, ["add", "target.txt"]);
                await runGit(root, ["commit", "-m", "diverge target"]);
                const baseCommit = await runGit(root, ["rev-parse", "HEAD"]);
                await runGit(root, ["switch", "main"]);
                await fsWriteFile(`${root}/main.txt`, "main\n");
                await runGit(root, ["add", "main.txt"]);
                await runGit(root, ["commit", "-m", "diverge main"]);
                if (scenario === "primary_path") path = root;
                else if (scenario === "primary_branch") await runGit(root, ["switch", "-c", branch]);
                else if (scenario === "branch_only") await runGit(root, ["branch", branch, baseCommit]);
                else {
                    await runGit(root, [
                        "worktree",
                        "add",
                        "-b",
                        scenario === "wrong_checkout" ? "worktree/other" : branch,
                        path,
                        baseCommit,
                    ]);
                    if (scenario === "wrong_checkout") {
                        await fsWriteFile(`${path}/untracked-other.txt`, "other work\n");
                    }
                    if (scenario === "unique_commit") {
                        await fsWriteFile(`${path}/unique.txt`, "rescue this commit\n");
                        await runGit(path, ["add", "unique.txt"]);
                        await runGit(path, ["commit", "-m", "unique work"]);
                    }
                }
                await addWorktreeRegistryEntry(root, {
                    id: "discard-attempt",
                    planId: "plan-1",
                    planName: project.plan.planName,
                    path,
                    branch,
                    baseBranch: "target",
                    baseRef: "target",
                    baseCommit,
                    status: "active",
                    createdAt: "2026-09-08T00:00:00Z",
                    updatedAt: "2026-09-08T00:00:00Z",
                });
                await writeControllerState(
                    root,
                    { planName: project.plan.planName, planId: "plan-1" },
                    {
                        executionMode: "worktree",
                        documentWorktreeId: "discard-attempt",
                    },
                );
                const plan = await loadPlan(root, project.plan.planName);
                if (!plan) throw new Error("fixture Plan missing");
                const ui = makeUi(action === "held_reset" ? ["reset_delete", "confirm"] : ["confirm"]);
                const context = await makeActionContext(root, { ...plan, planName: project.plan.planName }, ui);
                context.worktreeContext = await resolveRecoveryWorktree(root, context.plan);
                if (!context.worktreeContext) throw new Error("fixture attempt missing");
                if (scenario === "missing_plan_id") context.plan.attrs.planId = undefined;
                if (scenario === "invalid_base") context.worktreeContext.baseCommit = "not-a-commit";
                await fsWriteFile(`${root}/tracked.txt`, "previous stash\n");
                await runGit(root, ["stash", "push", "-m", "developer stash", "--", "tracked.txt"]);
                await fsWriteFile(`${root}/tracked.txt`, "current developer edits\n");
                await fsWriteFile(`${root}/untracked.txt`, "current untracked edits\n");
                const beforeHead = await runGit(root, ["rev-parse", "HEAD"]);
                const beforeBranch = await runGit(root, ["branch", "--show-current"]);
                const beforeStash = await runGit(root, ["rev-parse", "refs/stash"]);
                const beforeRecord = await findWorktreeRegistryEntryById(root, "discard-attempt");
                const beforeController = await readControllerRecord(root, {
                    planName: project.plan.planName,
                    planId: "plan-1",
                });
                const beforePlan = await fsReadFile(plan.path, "utf8");
                if (action === "held_reset") {
                    await resetHeldPlanToDraft({ projectRoot: root, plan: context.plan, uiAPI: ui });
                } else if (action === "recreate") await resetRecoveryPlan(context, false, "available");
                else await abandonRecoveryPlan(context);
                assertEquals(await runGit(root, ["rev-parse", "HEAD"]), beforeHead);
                assertEquals(await runGit(root, ["branch", "--show-current"]), beforeBranch);
                assertEquals(await runGit(root, ["rev-parse", "refs/stash"]), beforeStash);
                assertEquals(await fsReadFile(`${root}/tracked.txt`, "utf8"), "current developer edits\n");
                assertEquals(await fsReadFile(`${root}/untracked.txt`, "utf8"), "current untracked edits\n");
                const succeeded = ["unchanged", "branch_only", "unique_commit"].includes(scenario);
                const afterRecord = await findWorktreeRegistryEntryById(root, "discard-attempt");
                const afterController = await readControllerRecord(root, {
                    planName: project.plan.planName,
                    planId: "plan-1",
                });
                if (succeeded) {
                    assertEquals(afterRecord?.status, "abandoned");
                    assertEquals(afterController?.state.documentWorktreeId, undefined);
                    assertEquals(
                        await fsStat(path)
                            .then(() => true)
                            .catch(() => false),
                        false,
                    );
                    if (scenario === "unique_commit") {
                        assertEquals(await runGit(root, ["show", `${branch}:unique.txt`]), "rescue this commit");
                        assertEquals(
                            ui.messages.some((message) => message.includes(branch) && message.includes("rescue")),
                            true,
                        );
                        assertEquals(
                            ui.messages.some((message) => message.includes("branch were deleted")),
                            false,
                        );
                    } else assertEquals(await runGit(root, ["branch", "--list", branch]), "");
                } else {
                    assertEquals(afterRecord, beforeRecord);
                    assertEquals(afterController, beforeController);
                    assertEquals(await fsReadFile(plan.path, "utf8"), beforePlan);
                    if (scenario === "wrong_checkout") {
                        assertEquals(await fsReadFile(`${path}/untracked-other.txt`, "utf8"), "other work\n");
                    }
                }
            } finally {
                await fsRm(root, { recursive: true });
                await fsRm(parent, { recursive: true });
            }
        });
    }
}

test("recovery preserves a surviving attached HEAD when the checkout and branch are gone", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-attached-head-"));
    const worktreePath = join(root, "checkout");
    const branch = "rw/surviving-head";
    const project = await makeRealRecoveryProject({
        executionMode: "worktree",
        worktreeId: "surviving-head",
        worktreePath,
        worktreeBranch: branch,
        worktreeBaseBranch: "main",
    });
    try {
        await runGit(project.projectRoot, ["worktree", "add", "--detach", worktreePath, "HEAD"]);
        await fsRm(worktreePath, { recursive: true });
        // Git retains the attached checkout's detached HEAD, although the directory
        // and the Plan's recorded branch are both absent. Windows porcelain uses
        // forward slashes while worktreePath has native backslashes.
        const ui = makeUi(["cancel"]);
        assertEquals(await handlePlanRecovery(await makeOptions(project.plan, ui, project.projectRoot)), "handled");
        assertEquals(ui.prompts[0].includes("inspect"), true);
        assertEquals(ui.prompts[0].includes("stop_lost"), false);
    } finally {
        await fsRm(project.projectRoot, { recursive: true });
        await fsRm(root, { recursive: true });
    }
});

for (const status of ["failed", "implemented"] as const) {
    test(`recovery restores ${status} work from a unique rescue branch only after selection`, async () => {
        const container = await fsMkdtemp(join(tmpdir(), "runwield-rescue-menu-"));
        const worktreePath = join(container, "execution");
        const branch = "worktree/rescued-attempt";
        const project = await makeRealRecoveryProject({
            status: "ready_for_work",
            executionMode: "worktree",
            worktreeId: "rescued-attempt",
            worktreePath,
            worktreeBranch: branch,
            worktreeBaseBranch: "main",
        });
        try {
            await enterProjectRuntime(project.projectRoot);
            await runGit(project.projectRoot, ["switch", "-c", "rescue/saved-work"]);
            await updatePlanFrontMatter(
                project.projectRoot,
                project.plan.planName,
                { status, documentWorktreeId: "rescued-attempt" },
                project.plan.attrs,
                {
                    expectedRevision: project.plan.revision,
                },
            );
            await fsWriteFile(join(project.projectRoot, "saved-work.ts"), "// saved implementation\n");
            await runGit(project.projectRoot, ["add", "docs", "saved-work.ts"]);
            await runGit(project.projectRoot, ["commit", "-m", "save rescued execution"]);
            const rescuedCommit = await runGit(project.projectRoot, ["rev-parse", "HEAD"]);
            await runGit(project.projectRoot, ["switch", "main"]);
            const primaryBytes = await fsReadFile(project.plan.path, "utf8");
            const refs = await runGit(project.projectRoot, ["show-ref"]);
            const worktrees = await runGit(project.projectRoot, ["worktree", "list", "--porcelain"]);
            const selected = await resolvePlanWithPrimaryRecovery(project.projectRoot, project.plan.planName);
            const action = status === "failed" ? "continue" : "validate";
            const cancelled = makeUi(["cancel"]);
            assertEquals(
                await handlePlanRecovery(await makeOptions(selected.plan, cancelled, project.projectRoot)),
                "handled",
            );
            assertEquals(cancelled.prompts[0].includes(action), true);
            assertEquals(cancelled.prompts[0].includes("stop_lost"), false);
            assertEquals(await fileExists(worktreePath), false);
            assertEquals(await runGit(project.projectRoot, ["show-ref"]), refs);
            assertEquals(await runGit(project.projectRoot, ["worktree", "list", "--porcelain"]), worktrees);

            const ui = makeUi([action]);
            const options = await makeOptions(selected.plan, ui, project.projectRoot);
            assertEquals(await handlePlanRecovery(options), "handled");
            assertEquals(await fsReadFile(join(worktreePath, "saved-work.ts"), "utf8"), "// saved implementation\n");
            assertEquals(await runGit(worktreePath, ["rev-parse", "HEAD"]), rescuedCommit);
            assertEquals(
                (await findWorktreeRegistryEntryById(project.projectRoot, "rescued-attempt"))?.path,
                worktreePath,
            );
            assertEquals(await fsReadFile(project.plan.path, "utf8"), primaryBytes);
        } finally {
            await fsRm(project.projectRoot, { recursive: true });
            await fsRm(container, { recursive: true });
        }
    });
}
