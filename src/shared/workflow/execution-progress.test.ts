import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { loadPlan, type PlanFrontMatter, savePlan, updatePlanFrontMatter } from "../../plan-store.js";
import { HostedSession } from "../session/hosted-session.js";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";
import {
    checkpointExecutionPreparation,
    createWorktreeGitArtifacts,
    hasExecutionChangesSince,
    removeWorktreeGitArtifacts,
    settleWorktreeAttempt,
} from "../worktree.js";
import { updateEntry as updateWorktreeRegistryEntry } from "../worktree-registry.js";
import { executePlan, startActiveExecutionWorkflow } from "./workflow.js";
import { createExecutionStartPorts } from "./execution-start.ts";
import { captureWorktreeTree } from "./git-snapshot.ts";
import { getTransitionJournalDir } from "./state-transition.ts";
import { runInitCommand } from "../../cmd/init/index.ts";
import { createSessionRuntime } from "../session/session-runtime.ts";
import { recordTutorialContext } from "../session/tutorial-context-session.ts";
import { createInitialTutorialContext } from "../../ui/tui/onboarding-content.ts";
import { publishExecutionWorktreeIsolated } from "../isolated-publication.ts";
import { RUNWIELD_GITIGNORE_BLOCK } from "../runwield-owned-paths.ts";

interface RuntimeStatusEvent {
    type?: string;
    message?: string;
}

interface TestPlanDescriptor {
    name: string;
    status?: PlanFrontMatter["status"];
    attrs?: Partial<PlanFrontMatter>;
}

const workflowRepo = defineCommittedGitFixture();
const PLAN_ID = "execution-progress-plan";

function messagesFrom(events: RuntimeStatusEvent[]): string[] {
    return events
        .map((event) => typeof event.message === "string" ? event.message : "")
        .filter((message) => message.length > 0);
}

function assertMessageOrder(messages: string[], expected: string[]): void {
    let cursor = -1;
    for (const expectedMessage of expected) {
        const nextIndex = messages.findIndex((message, index) => index > cursor && message.includes(expectedMessage));
        assert(
            nextIndex > cursor,
            `Expected message after index ${cursor}: ${expectedMessage}\n${messages.join("\n")}`,
        );
        cursor = nextIndex;
    }
}

async function makeWorkflowProject(plans: TestPlanDescriptor[]): Promise<string> {
    const cwd = await workflowRepo.checkout({ prefix: "runwield-execution-progress-" });
    for (const [index, plan] of plans.entries()) {
        await savePlan(cwd, plan.name, `# ${plan.name}`, {
            classification: "PLANNED_CHANGE",
            status: plan.status || "ready_for_work",
            summary: plan.name,
            affectedPaths: [],
            planId: index === 0 ? PLAN_ID : `${PLAN_ID}-${index}`,
            ...plan.attrs,
        });
    }
    return cwd;
}

function makeHostedSession(id: string, cwd: string, events: RuntimeStatusEvent[]): HostedSession {
    const hostedSession = new HostedSession({
        id,
        cwd,
        eventSink: (event: RuntimeStatusEvent) => {
            events.push(event);
        },
    });
    const sessionManager = SessionManager.inMemory(cwd);
    hostedSession.setRootSessionManager(sessionManager);
    return hostedSession;
}

Deno.test("execution preparation progress reports fresh worktree setup before launching Engineer", async () => {
    await withRuntimeCommandFixture("execution-progress-fresh-", async ({ setModelMessages }) => {
        setModelMessages([fauxAssistantMessage(fauxText("Execution remains paused in the fixture."))]);
        const projectRoot = await makeWorkflowProject([{
            name: "fresh-progress",
        }]);
        await Deno.writeTextFile(join(projectRoot, ".gitignore"), ".wld/\n");
        const events: RuntimeStatusEvent[] = [];
        const hostedSession = makeHostedSession("fresh-progress", projectRoot, events);
        const originalWarn = console.warn;
        console.warn = () => {};
        let executionCwd = "";
        try {
            await executePlan({
                planName: "fresh-progress",
                triageMeta: { planId: PLAN_ID, classification: "PLANNED_CHANGE" },
                hostedSession,
            });

            const workflow = hostedSession.getActiveExecutionWorkflow();
            assert(workflow);
            assert(typeof workflow.executionCwd === "string");
            assert(typeof workflow.worktreeBranch === "string");
            executionCwd = workflow.executionCwd;
            const messages = messagesFrom(events);
            assertMessageOrder(messages, [
                "=== Executing Plan: fresh-progress ===",
                "Preparing the implementation target...",
                "Creating the worktree from base branch",
                `Created worktree ${workflow.worktreeBranch} from base branch`,
                "Copying the Plan into the worktree...",
                "Marking the Plan as in progress...",
                "Starting Plan Engineer...",
            ]);
            assert(
                messages.some((message) => message.includes(".wld/settings.json") && message.includes(".wld/agents/")),
                `Expected execution preparation to report broad .wld/ ignore rule.\n${messages.join("\n")}`,
            );
            // An `engineer`-owned Plan runs under the workflow-only Plan Engineer.
            assertEquals(hostedSession.getRootAgentName(), "plan-engineer");
            const executionPlan = await loadPlan(executionCwd, "fresh-progress");
            assertEquals(executionPlan?.attrs.status, "in_progress");
        } finally {
            console.warn = originalWarn;
            hostedSession.dispose();
            if (executionCwd) {
                await removeWorktreeGitArtifacts({ projectRoot, path: executionCwd, force: true }).catch(() =>
                    undefined
                );
            }
            await Deno.remove(projectRoot, { recursive: true }).catch(() => undefined);
        }
    });
});

Deno.test("execution preparation progress reports reused worktree without claiming creation", async () => {
    const projectRoot = await makeWorkflowProject([{
        name: "reuse-progress",
    }]);
    const events: RuntimeStatusEvent[] = [];
    const hostedSession = makeHostedSession("reuse-progress", projectRoot, events);
    let executionCwd = "";
    try {
        const firstWorkflow = await startActiveExecutionWorkflow({
            planName: "reuse-progress",
            triageMeta: { planId: PLAN_ID, classification: "PLANNED_CHANGE" },
            currentStatus: "ready_for_work",
            hostedSession,
            ports: createExecutionStartPorts(),
        });
        executionCwd = firstWorkflow.executionCwd || "";
        const inProgressPlan = await loadPlan(projectRoot, "reuse-progress");
        assert(inProgressPlan);
        await updatePlanFrontMatter(
            projectRoot,
            "reuse-progress",
            {
                status: "ready_for_work",
            },
            {},
            {
                expectedRevision: inProgressPlan.revision,
            },
        );
        events.length = 0;

        await startActiveExecutionWorkflow({
            planName: "reuse-progress",
            triageMeta: { planId: PLAN_ID, classification: "PLANNED_CHANGE" },
            currentStatus: "ready_for_work",
            hostedSession,
            ports: createExecutionStartPorts(),
        });

        const messages = messagesFrom(events);
        assertStringIncludes(messages.join("\n"), `Reusing worktree ${firstWorkflow.worktreeBranch}`);
        assertEquals(messages.some((message) => message.includes("Creating the worktree")), false);
    } finally {
        if (executionCwd) {
            await removeWorktreeGitArtifacts({ projectRoot, path: executionCwd, force: true }).catch(() => undefined);
        }
        await Deno.remove(projectRoot, { recursive: true }).catch(() => undefined);
    }
});

Deno.test("restart resumes a dirty ready-for-work worktree without repeating preparation", async () => {
    const projectRoot = await makeWorkflowProject([{ name: "restart-progress" }]);
    const events: RuntimeStatusEvent[] = [];
    const hostedSession = makeHostedSession("restart-progress", projectRoot, events);
    let resumedSession: HostedSession | undefined;
    let executionCwd = "";
    try {
        const worktree = await settleWorktreeAttempt(
            projectRoot,
            await createWorktreeGitArtifacts({
                projectRoot,
                planName: "restart-progress",
                planId: PLAN_ID,
            }),
        );
        executionCwd = worktree.path;
        await savePlan(worktree.path, "restart-progress", "# restart-progress", {
            classification: "PLANNED_CHANGE",
            status: "ready_for_work",
            summary: "restart-progress",
            affectedPaths: ["implemented.txt"],
            planId: PLAN_ID,
        });
        await Deno.writeTextFile(`${worktree.path}/implemented.txt`, "Agent work survived the restart.\n");
        const poisonedBaseline = await captureWorktreeTree(worktree.path);
        await updateWorktreeRegistryEntry(projectRoot, worktree.id, {
            status: "active",
            executionBaselineTree: poisonedBaseline,
        });
        const headBefore = await git(worktree.path, ["rev-parse", "HEAD"]);

        const workflow = await startActiveExecutionWorkflow({
            planName: "restart-progress",
            triageMeta: {
                planId: PLAN_ID,
                classification: "PLANNED_CHANGE",
                worktreeId: worktree.id,
                worktreePath: worktree.path,
                worktreeBranch: worktree.branch,
                worktreeBaseBranch: worktree.baseBranch,
                worktreeStatus: "active",
            },
            currentStatus: "ready_for_work",
            hostedSession,
            ports: createExecutionStartPorts(),
        });

        const executionPlan = await loadPlan(worktree.path, "restart-progress");
        assertEquals(executionPlan?.attrs.status, "in_progress");
        assertEquals(await Deno.readTextFile(`${worktree.path}/implemented.txt`), "Agent work survived the restart.\n");
        assertEquals(
            workflow.baselineTree,
            worktree.baseTree,
            "the dirty recovery snapshot cannot become the baseline",
        );
        const headAfter = await git(worktree.path, ["rev-parse", "HEAD"]);
        assertEquals(headAfter, headBefore, "resume must not checkpoint unreviewed Agent files as setup");
        const messages = messagesFrom(events);
        assertStringIncludes(messages.join("\n"), `Reusing worktree ${worktree.branch}`);

        // Mirror the durable residue left by the old failure: the Plan Event landed,
        // the registry contains a tree captured after the Agent edits, and the
        // execution-worktree journal still says recovery is needed.
        await updateWorktreeRegistryEntry(projectRoot, worktree.id, {
            status: "active",
            executionBaselineTree: poisonedBaseline,
        });
        const recoveryDirectory = getTransitionJournalDir(worktree.path);
        const recoveryPath = `${recoveryDirectory}/interrupted-restart.json`;
        await Deno.mkdir(recoveryDirectory, { recursive: true });
        await Deno.writeTextFile(
            recoveryPath,
            JSON.stringify({
                version: 1,
                transitionId: "interrupted-restart",
                operation: "execution_preparation",
                planName: "restart-progress",
                state: "needs_recovery",
                resources: [
                    { kind: "plan", id: "restart-progress" },
                    { kind: "attempt", id: worktree.id },
                ],
                completedEffects: [
                    {
                        effect: "git_worktree_reused",
                        proof: { worktreeId: worktree.id, path: worktree.path, branch: worktree.branch },
                    },
                    {
                        effect: "worktree_registry_updated",
                        proof: { worktreeId: worktree.id, status: "active" },
                    },
                    { effect: "plan_event_recorded", proof: { planName: "restart-progress" } },
                ],
            }),
        );
        resumedSession = makeHostedSession("restart-progress-after-failure", projectRoot, []);
        const resumedWorkflow = await startActiveExecutionWorkflow({
            planName: "restart-progress",
            triageMeta: {
                planId: PLAN_ID,
                classification: "PLANNED_CHANGE",
                worktreeId: worktree.id,
                worktreePath: worktree.path,
                worktreeBranch: worktree.branch,
                worktreeBaseBranch: worktree.baseBranch,
                worktreeStatus: "active",
            },
            currentStatus: "in_progress",
            hostedSession: resumedSession,
            ports: createExecutionStartPorts(),
        });
        assertEquals(resumedWorkflow.baselineTree, worktree.baseTree);
        assertEquals(await Deno.stat(recoveryPath).then(() => true).catch(() => false), false);
    } finally {
        resumedSession?.dispose();
        hostedSession.dispose();
        if (executionCwd) {
            await removeWorktreeGitArtifacts({ projectRoot, path: executionCwd, force: true }).catch(() => undefined);
        }
        await Deno.remove(projectRoot, { recursive: true }).catch(() => undefined);
    }
});

Deno.test("restart accepts an existing Plan-only preparation commit", async () => {
    const projectRoot = await makeWorkflowProject([{ name: "prepared-restart" }]);
    const hostedSession = makeHostedSession("prepared-restart", projectRoot, []);
    let executionCwd = "";
    try {
        const worktree = await settleWorktreeAttempt(
            projectRoot,
            await createWorktreeGitArtifacts({
                projectRoot,
                planName: "prepared-restart",
                planId: PLAN_ID,
            }),
        );
        executionCwd = worktree.path;
        await savePlan(worktree.path, "prepared-restart", "# prepared-restart", {
            classification: "PLANNED_CHANGE",
            status: "ready_for_work",
            summary: "prepared-restart",
            affectedPaths: ["implemented.txt"],
            planId: PLAN_ID,
        });
        const firstPreparation = await checkpointExecutionPreparation({
            worktreePath: worktree.path,
            branch: worktree.branch,
            baseCommit: worktree.baseCommit,
            planName: "prepared-restart",
            planRelativePath: "docs/plans/prepared-restart.md",
        });
        await updateWorktreeRegistryEntry(projectRoot, worktree.id, {
            status: "active",
            executionBaselineTree: worktree.baseTree,
        });

        const workflow = await startActiveExecutionWorkflow({
            planName: "prepared-restart",
            triageMeta: {
                planId: PLAN_ID,
                classification: "PLANNED_CHANGE",
                worktreeId: worktree.id,
                worktreePath: worktree.path,
                worktreeBranch: worktree.branch,
                worktreeBaseBranch: worktree.baseBranch,
                worktreeStatus: "active",
            },
            currentStatus: "ready_for_work",
            hostedSession,
            ports: createExecutionStartPorts(),
        });

        assertEquals((await loadPlan(worktree.path, "prepared-restart"))?.attrs.status, "in_progress");
        assertEquals(workflow.baselineTree, worktree.baseTree);
        assertEquals(
            await git(worktree.path, [
                "merge-base",
                "--is-ancestor",
                firstPreparation.preparationCommit,
                "HEAD",
            ]),
            "",
        );
        assertEquals(
            await git(worktree.path, ["diff", "--name-only", `${worktree.baseCommit}..HEAD`]),
            ".gitignore\ndocs/plans/prepared-restart.md",
        );
        assertEquals(await git(worktree.path, ["status", "--porcelain"]), "");
    } finally {
        hostedSession.dispose();
        if (executionCwd) {
            await removeWorktreeGitArtifacts({ projectRoot, path: executionCwd, force: true }).catch(() => undefined);
        }
        await Deno.remove(projectRoot, { recursive: true }).catch(() => undefined);
    }
});

for (const checkpointed of [false, true]) {
    Deno.test(`child preparation preserves parent edits in a reused ${checkpointed ? "prepared" : "planning"} worktree`, async () => {
        const parentName = "usage";
        const planName = "usage/01-recording";
        const parentPath = "docs/plans/usage.md";
        const childPath = `docs/plans/${planName}.md`;
        const projectRoot = await makeWorkflowProject([
            { name: planName, attrs: { parentPlan: parentName } },
            { name: parentName, attrs: { classification: "PROJECT" } },
        ]);
        const hostedSession = makeHostedSession(`parent-edit-${checkpointed}`, projectRoot, []);
        let executionCwd = "";
        try {
            await git(projectRoot, ["add", "docs/plans"]);
            await git(projectRoot, ["commit", "-m", "Approved Plan family"]);
            const worktree = await settleWorktreeAttempt(
                projectRoot,
                await createWorktreeGitArtifacts({ projectRoot, planName, planId: PLAN_ID }),
            );
            executionCwd = worktree.path;
            const parent = await loadPlan(worktree.path, parentName);
            assert(parent);
            const revisedParent = `${parent.markdown}\nRecording remains opt-in, as requested by the owner.\n`;
            await Deno.writeTextFile(parent.path, revisedParent);
            if (checkpointed) {
                await checkpointExecutionPreparation({
                    worktreePath: worktree.path,
                    branch: worktree.branch,
                    baseCommit: worktree.baseCommit,
                    planName,
                    planRelativePath: childPath,
                    relatedPlanPaths: [parentPath],
                });
                // A subsequent planning edit must survive restarting preparation too.
                await Deno.writeTextFile(parent.path, `${revisedParent}\nMetrics must never block delivery.\n`);
            }
            const expectedParent = await Deno.readTextFile(parent.path);
            await updateWorktreeRegistryEntry(projectRoot, worktree.id, {
                status: checkpointed ? "active" : "planning",
            });

            const workflow = await startActiveExecutionWorkflow({
                planName,
                triageMeta: { planId: PLAN_ID, classification: "PLANNED_CHANGE", parentPlan: parentName },
                currentStatus: "ready_for_work",
                hostedSession,
                ports: createExecutionStartPorts(),
            });

            assertEquals(workflow.executionCwd, worktree.path);
            assertEquals(workflow.executionStarted, true);
            assertEquals((await loadPlan(worktree.path, planName))?.attrs.status, "in_progress");
            assertEquals(await Deno.readTextFile(parent.path), expectedParent);
            assertEquals(await git(worktree.path, ["show", `HEAD:${parentPath}`]), expectedParent.trim());
            assertEquals(await git(worktree.path, ["status", "--porcelain"]), "");
            assertEquals((await loadPlan(projectRoot, parentName))?.markdown, parent.markdown);
        } finally {
            hostedSession.dispose();
            if (executionCwd) {
                await removeWorktreeGitArtifacts({ projectRoot, path: executionCwd, force: true }).catch(() =>
                    undefined
                );
            }
            await Deno.remove(projectRoot, { recursive: true }).catch(() => undefined);
        }
    });
}

Deno.test("reused child preparation does not require a local copy of its parent", async () => {
    const planName = "epic/01-child";
    const projectRoot = await makeWorkflowProject([{ name: planName, attrs: { parentPlan: "epic" } }]);
    const hostedSession = makeHostedSession("child-only-planning", projectRoot, []);
    let executionCwd = "";
    try {
        await git(projectRoot, ["add", "docs/plans"]);
        await git(projectRoot, ["commit", "-m", "Child Plan"]);
        const worktree = await settleWorktreeAttempt(
            projectRoot,
            await createWorktreeGitArtifacts({ projectRoot, planName, planId: PLAN_ID }),
        );
        executionCwd = worktree.path;
        await updateWorktreeRegistryEntry(projectRoot, worktree.id, { status: "planning" });

        const workflow = await startActiveExecutionWorkflow({
            planName,
            triageMeta: { planId: PLAN_ID, classification: "PLANNED_CHANGE", parentPlan: "epic" },
            currentStatus: "ready_for_work",
            hostedSession,
            ports: createExecutionStartPorts(),
        });

        assertEquals(workflow.executionStarted, true);
        assertEquals(workflow.executionCwd, worktree.path);
        assertEquals(await git(worktree.path, ["status", "--porcelain"]), "");
        assertEquals(await loadPlan(worktree.path, "epic"), null);
    } finally {
        hostedSession.dispose();
        if (executionCwd) {
            await removeWorktreeGitArtifacts({ projectRoot, path: executionCwd, force: true }).catch(() => undefined);
        }
        await Deno.remove(projectRoot, { recursive: true }).catch(() => undefined);
    }
});

Deno.test("execution starts with registered sibling scope moves and leftover planning documents", async () => {
    const planName = "remote/03-writer";
    const siblingName = "remote/04-history";
    const projectRoot = await makeWorkflowProject([
        { name: planName, attrs: { parentPlan: "remote" } },
        { name: siblingName, status: "draft", attrs: { parentPlan: "remote" } },
        { name: "legacy-plan" },
    ]);
    const hostedSession = makeHostedSession("planning-document-recovery", projectRoot, []);
    const worktrees: string[] = [];
    try {
        await git(projectRoot, ["add", "docs/plans"]);
        await git(projectRoot, ["commit", "-m", "Planning baseline"]);
        const siblingWorktree = await settleWorktreeAttempt(
            projectRoot,
            await createWorktreeGitArtifacts({
                projectRoot,
                planName: siblingName,
                planId: `${PLAN_ID}-1`,
            }),
        );
        worktrees.push(siblingWorktree.path);
        await updateWorktreeRegistryEntry(projectRoot, siblingWorktree.id, { status: "planning" });
        const worktree = await settleWorktreeAttempt(
            projectRoot,
            await createWorktreeGitArtifacts({
                projectRoot,
                planName,
                planId: PLAN_ID,
            }),
        );
        worktrees.push(worktree.path);
        await updateWorktreeRegistryEntry(projectRoot, worktree.id, { status: "planning" });
        const sibling = await loadPlan(worktree.path, siblingName);
        assert(sibling);
        await Deno.writeTextFile(
            sibling.path,
            `${sibling.markdown}\nUse the laptop-owned save bridge from child 03.\n`,
        );
        const legacy = await loadPlan(worktree.path, "legacy-plan");
        assert(legacy);
        await updatePlanFrontMatter(worktree.path, "legacy-plan", { status: "feedback" }, {}, {
            expectedRevision: legacy.revision,
        });
        await savePlan(worktree.path, "save-proof", "# Earlier planning proof\n", {
            status: "ready_for_work",
            planId: "earlier-proof",
        });
        // The reported attempt included both staged and unstaged Plan edits.
        await git(worktree.path, ["add", `docs/plans/${siblingName}.md`]);

        const workflow = await startActiveExecutionWorkflow({
            planName,
            triageMeta: { planId: PLAN_ID, classification: "PLANNED_CHANGE", parentPlan: "remote" },
            currentStatus: "ready_for_work",
            hostedSession,
            ports: createExecutionStartPorts(),
        });

        assertEquals(workflow.executionStarted, true);
        assertEquals(workflow.executionCwd, worktree.path);
        assertEquals((await loadPlan(worktree.path, planName))?.attrs.status, "in_progress");
        assertStringIncludes((await loadPlan(siblingWorktree.path, siblingName))!.body, "laptop-owned save bridge");
        assertEquals((await loadPlan(siblingWorktree.path, siblingName))?.attrs.status, "draft");
        assertEquals((await loadPlan(worktree.path, "legacy-plan"))?.attrs.status, "feedback");
        assertStringIncludes(
            await git(worktree.path, ["show", "HEAD:docs/plans/save-proof.md"]),
            "Earlier planning proof",
        );
        assertEquals(await git(worktree.path, ["status", "--porcelain"]), "");
        assertEquals((await loadPlan(projectRoot, "legacy-plan"))?.attrs.status, "ready_for_work");
    } finally {
        hostedSession.dispose();
        for (const path of worktrees) {
            await removeWorktreeGitArtifacts({ projectRoot, path, force: true }).catch(() => undefined);
        }
        await Deno.remove(projectRoot, { recursive: true }).catch(() => undefined);
    }
});

Deno.test("execution preparation progress reports non-Git in-place preparation without worktree creation", async () => {
    const projectRoot = await Deno.makeTempDir({ prefix: "runwield-non-git-progress-" });
    const events: RuntimeStatusEvent[] = [];
    const hostedSession = makeHostedSession("non-git-progress", projectRoot, events);
    try {
        await Deno.mkdir(join(projectRoot, "docs", "plans"), { recursive: true });
        await savePlan(projectRoot, "non-git-progress", "# non-git-progress", {
            classification: "PLANNED_CHANGE",
            status: "ready_for_work",
            summary: "non-git-progress",
            affectedPaths: [],
            planId: PLAN_ID,
        });

        await startActiveExecutionWorkflow({
            planName: "non-git-progress",
            triageMeta: { planId: PLAN_ID, classification: "PLANNED_CHANGE" },
            currentStatus: "ready_for_work",
            hostedSession,
            ports: {
                ...createExecutionStartPorts(),
                hasNonGitExecutionConsent: () => true,
            },
        });

        const messages = messagesFrom(events);
        assertMessageOrder(messages, [
            "Preparing the implementation target...",
            "Preparing in-place work because Git is unavailable...",
            "Marking the Plan as in progress...",
        ]);
        assertEquals(messages.some((message) => message.includes("worktree")), false);
    } finally {
        await Deno.remove(projectRoot, { recursive: true }).catch(() => undefined);
    }
});

for (const tutorial of [false, true]) {
    Deno.test(`${tutorial ? "Tutorial" : "Plan"} execution carries uncommitted Init files and preserves them on resume`, async () => {
        await withRuntimeCommandFixture("init-context-execution-", async ({ setModelMessages }) => {
            const projectRoot = await makeWorkflowProject([{ name: "init-context" }]);
            Deno.chdir(projectRoot);
            const initialHead = await git(projectRoot, ["rev-parse", "HEAD"]);
            const glossary = "# Domain Language\n\n## Fixture\n\nCurrent fixture terminology.\n";
            setModelMessages([
                fauxAssistantMessage(
                    fauxToolCall("init_save_verification_command", { command: "printf init-verified" }),
                ),
                fauxAssistantMessage(fauxToolCall("write", { path: "docs/domain-language.md", content: glossary })),
                fauxAssistantMessage(fauxText("Init complete.")),
                fauxAssistantMessage(fauxText("Execution remains paused in the fixture.")),
            ]);
            const runtime = createSessionRuntime();
            const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            runtime.setInteractionAdapter(created.sessionId, {
                supportsInteraction: () => true,
                requestInteraction: () => ({ outcome: "selected", value: "yes" }),
            });
            const events: RuntimeStatusEvent[] = [];
            const hostedSession = makeHostedSession("init-context", projectRoot, events);
            if (tutorial) {
                const manager = SessionManager.inMemory(projectRoot);
                recordTutorialContext(manager, createInitialTutorialContext());
                hostedSession.setRootSessionManager(manager);
                assertEquals(hostedSession.getTutorialContext()?.guidanceEnabled, true);
            }
            let executionCwd = "";
            try {
                await runInitCommand([], {
                    projectRoot,
                    sessionRuntime: runtime,
                    sessionId: created.sessionId,
                    sessionPort: { startInteractiveSession: () => Promise.reject(new Error("Unexpected model setup")) },
                    uiAPI: { appendSystemMessage: (_message, error) => assert(!error) },
                });
                await Deno.writeTextFile(join(projectRoot, "unrelated.txt"), "Keep in the original checkout.\n");
                const status = await git(projectRoot, ["status", "--porcelain"]);
                const settings = await Deno.readTextFile(join(projectRoot, ".wld/settings.json"));
                await executePlan({
                    planName: "init-context",
                    triageMeta: { planId: PLAN_ID, classification: "PLANNED_CHANGE" },
                    hostedSession,
                });
                const workflow = hostedSession.getActiveExecutionWorkflow();
                assert(workflow?.executionCwd, messagesFrom(events).join("\n"));
                executionCwd = workflow.executionCwd;
                assertEquals(await Deno.readTextFile(join(executionCwd, "docs/domain-language.md")), glossary);
                assertEquals(await Deno.readTextFile(join(executionCwd, ".wld/settings.json")), settings);
                assertStringIncludes(
                    await Deno.readTextFile(join(executionCwd, ".gitignore")),
                    RUNWIELD_GITIGNORE_BLOCK,
                );
                const preparationFiles = await git(executionCwd, ["diff", "--name-only", `${initialHead}..HEAD`]);
                for (const path of [".wld/settings.json", "docs/domain-language.md", ".gitignore"]) {
                    assertStringIncludes(preparationFiles, path);
                }
                assertEquals(await git(projectRoot, ["rev-parse", "HEAD"]), initialHead);
                assertEquals(await git(projectRoot, ["status", "--porcelain"]), status);
                assertEquals(await Deno.stat(join(executionCwd, "unrelated.txt")).catch(() => null), null);
                await Deno.writeTextFile(join(executionCwd, "docs/domain-language.md"), "Repaired glossary\n");
                await Deno.writeTextFile(
                    join(executionCwd, ".wld/settings.json"),
                    '{"verification_command":"printf repaired"}\n',
                );
                assertEquals(
                    await hasExecutionChangesSince({
                        worktreePath: executionCwd,
                        baseRef: initialHead,
                        includeWorkingTree: true,
                    }),
                    true,
                );
                const plan = await loadPlan(executionCwd, "init-context");
                assert(plan);
                await startActiveExecutionWorkflow({
                    planName: "init-context",
                    triageMeta: plan.attrs,
                    currentStatus: "in_progress",
                    hostedSession,
                    ports: createExecutionStartPorts(),
                });
                assertEquals(
                    await Deno.readTextFile(join(executionCwd, "docs/domain-language.md")),
                    "Repaired glossary\n",
                );
                assertStringIncludes(
                    await Deno.readTextFile(join(executionCwd, ".wld/settings.json")),
                    "printf repaired",
                );
                assertEquals(await Deno.readTextFile(join(projectRoot, ".wld/settings.json")), settings);
                const resumed = await loadPlan(executionCwd, "init-context");
                assert(resumed);
                await updatePlanFrontMatter(executionCwd, "init-context", { status: "reviewed" }, {}, {
                    expectedRevision: resumed.revision,
                });
                await git(executionCwd, ["add", "."]);
                await git(executionCwd, ["commit", "-m", "Reviewed context update"]);
                await publishExecutionWorktreeIsolated({
                    projectRoot,
                    executionCwd,
                    executionBranch: workflow.worktreeBranch!,
                    targetBranch: "main",
                    planName: "init-context",
                    sealedExecutionCommit: await git(executionCwd, ["rev-parse", "HEAD"]),
                    allowedPlanPaths: ["docs/plans/init-context.md"],
                });
                assertEquals(
                    await Deno.readTextFile(join(projectRoot, "docs/domain-language.md")),
                    "Repaired glossary\n",
                );
                assertStringIncludes(
                    await Deno.readTextFile(join(projectRoot, ".wld/settings.json")),
                    "printf repaired",
                );
                assertEquals(
                    await Deno.readTextFile(join(projectRoot, "unrelated.txt")),
                    "Keep in the original checkout.\n",
                );
            } finally {
                await runtime.closeAllSessionsWhenIdle();
                hostedSession.dispose();
                if (executionCwd) await removeWorktreeGitArtifacts({ projectRoot, path: executionCwd, force: true });
                Deno.chdir(projectRoot + "/..");
                await Deno.remove(projectRoot, { recursive: true });
            }
        });
    });
}
