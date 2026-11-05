import { readFile as fsReadFile, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { setCustomSetting } from "../settings.js";
import { loadPlan } from "../../plan-store.js";
import { git } from "../git-test-fixture.ts";
import type { IsolatedAgentSessionOptions, SemanticReviewPort } from "./validation-session-adapter.ts";
import { parseDiffFiles } from "./review-diff-tool.ts";
import { createWorkRecordMnemotecaFixture } from "../work-records/test-fixtures/mnemoteca-port.ts";
import { buildPlanEventUpdates } from "./plan-lifecycle.js";
import { HostedSession } from "../session/hosted-session.js";
import { createPlanDeviationTool } from "../../tools/plan-deviation.ts";
import { checkpointExecutionWorktree } from "../worktree.js";
import { recordIntegrationNotes, syncEpicChildPlanDeviations } from "./epic-review-context.ts";
import { readEpicDeliveryState, reconcileEpicDelivery, runEpicIntegrationGate } from "./epic-integration.ts";
import {
    type ReviewerCall,
    writePlan,
    childAttrs,
    repoFixture,
    epicWithPendingSecondChild,
    deliverSecondChild,
    scriptedReviewer,
    scriptedChecks,
    PASSING_CHECKS,
    gateSession,
} from "./epic-integration-test-fixture.ts";

type TaggedReviewDiffTool = NonNullable<IsolatedAgentSessionOptions["customTools"]>[number] & {
    __runwieldReviewDiffs: { full: string };
};

test("a validated child with pending publication does not complete the Epic", async () => {
    const { repo } = await epicWithPendingSecondChild();

    const state = await readEpicDeliveryState(repo, "epic");
    const reconciled = await reconcileEpicDelivery(repo, "epic");

    assertEquals(
        state?.children.map((child) => [child.name, child.settled]),
        [
            ["epic/01-first", true],
            ["epic/02-second", false],
        ],
    );
    assertEquals(reconciled.gateReady, false);
    assertEquals((await loadPlan(repo, "epic"))?.attrs.status, "ready_for_work");
});

test("delivering the last child to the Epic branch makes the Epic implemented", async () => {
    const { repo } = await epicWithPendingSecondChild();
    await deliverSecondChild(repo);

    const reconciled = await reconcileEpicDelivery(repo, "epic");

    assertEquals(reconciled.gateReady, true);
    const epic = await loadPlan(repo, "epic");
    assertEquals(epic?.attrs.status, "implemented");
    assert(epic?.attrs.implementedAt);
});

test("the integration gate validates the exact Epic branch head", async () => {
    const { repo } = await epicWithPendingSecondChild();
    await setCustomSetting("codereview", "none", "project", repo);
    await deliverSecondChild(repo);
    const head = await git(repo, ["rev-parse", "epic/epic"]);
    const { hostedSession } = gateSession();
    const reviewerCalls: ReviewerCall[] = [];
    const checkCwds: string[] = [];

    const result = await runEpicIntegrationGate({
        hostedSession,
        projectRoot: repo,
        epicPlanName: "epic",
        semanticReviewPort: scriptedReviewer({ approved: true }, reviewerCalls),
        workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
        localCIPort: scriptedChecks(PASSING_CHECKS, checkCwds),
    });

    assertEquals(result, { kind: "passed", commit: head });
    const epic = await loadPlan(repo, "epic");
    assertEquals(epic?.attrs.status, "reviewed");
    assertEquals(epic?.attrs.validatedCommit, head);
    // Checks and review ran in the gate's own checkout of that commit, which is gone afterwards.
    assertEquals(checkCwds.length, 1);
    assertEquals(reviewerCalls[0].cwd, checkCwds[0]);
    assertStringIncludes(reviewerCalls[0].userRequest, "Ship first and second together.");
    assertStringIncludes(reviewerCalls[0].userRequest, "epic/02-second");
    assertEquals((await git(repo, ["worktree", "list"])).split("\n").length, 1);
    // RunWield does not merge the Epic into the primary branch.
    assertEquals(
        await git(repo, ["merge-base", "--is-ancestor", head, "main"]).catch(() => "not merged"),
        "not merged",
    );
});

test("an integration review nudge keeps one controller request identity and a new gate gets another", async () => {
    const { repo } = await epicWithPendingSecondChild();
    await setCustomSetting("codereview", "none", "project", repo);
    await deliverSecondChild(repo);
    const { hostedSession } = gateSession();
    const controllerRequestIds: Array<string | undefined> = [];
    const accepted = scriptedReviewer({ approved: true });
    let calls = 0;
    const port: SemanticReviewPort = {
        runIsolatedAgentSession: async (options: IsolatedAgentSessionOptions) => {
            calls += 1;
            controllerRequestIds.push(options.controllerRequestId);
            // The first attempt returns without review_complete, so the gate regenerates its nudge.
            if (calls === 1) return [];
            return await accepted.runIsolatedAgentSession(options);
        },
    };

    const first = await runEpicIntegrationGate({
        hostedSession,
        projectRoot: repo,
        epicPlanName: "epic",
        semanticReviewPort: port,
        workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
        localCIPort: scriptedChecks(PASSING_CHECKS),
    });
    assertEquals(first.kind, "passed");
    assertEquals(calls, 2);
    assertEquals(typeof controllerRequestIds[0], "string");
    assertEquals((controllerRequestIds[0] || "").length > 0, true);
    assertEquals(controllerRequestIds[1], controllerRequestIds[0]);

    // A later commit makes the gate stale, and the next review is a different review.
    await git(repo, ["switch", "epic/epic"]);
    await fsWriteFile(join(repo, "late.js"), "export const late = true;\n");
    await git(repo, ["add", "late.js"]);
    await git(repo, ["commit", "-m", "late change"]);
    await git(repo, ["switch", "main"]);
    await reconcileEpicDelivery(repo, "epic");
    const second = await runEpicIntegrationGate({
        hostedSession,
        projectRoot: repo,
        epicPlanName: "epic",
        semanticReviewPort: port,
        workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
        localCIPort: scriptedChecks(PASSING_CHECKS),
    });
    assertEquals(second.kind, "passed");
    assertEquals(controllerRequestIds.length, 3);
    assertEquals(controllerRequestIds[2] === controllerRequestIds[0], false);
});

test("a new commit on the Epic branch makes a passed gate stale", async () => {
    const { repo } = await epicWithPendingSecondChild();
    await deliverSecondChild(repo);
    const { hostedSession } = gateSession();
    await runEpicIntegrationGate({
        hostedSession,
        projectRoot: repo,
        epicPlanName: "epic",
        semanticReviewPort: scriptedReviewer({ approved: true }),
        workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
        localCIPort: scriptedChecks(PASSING_CHECKS),
    });
    await git(repo, ["switch", "epic/epic"]);
    await fsWriteFile(join(repo, "late.js"), "export const late = true;\n");
    await git(repo, ["add", "late.js"]);
    await git(repo, ["commit", "-m", "late change"]);
    await git(repo, ["switch", "main"]);

    const reconciled = await reconcileEpicDelivery(repo, "epic");

    assertEquals(reconciled.status, "implemented");
    assertEquals(reconciled.gateReady, true);
    assertEquals((await loadPlan(repo, "epic"))?.attrs.validatedCommit, undefined);
});

test("integration findings produce a report and a draft repair child on the Epic branch", async () => {
    const { repo } = await epicWithPendingSecondChild();
    await deliverSecondChild(repo);
    // This child exists only on the target branch. Its filename must not allocate order 100.
    await git(repo, ["switch", "epic/epic"]);
    await writePlan(repo, "epic/99-target-only", childAttrs(40, { status: "user_verified" }), "# Target only");
    await git(repo, ["add", "docs/plans/epic/99-target-only.md"]);
    await git(repo, ["commit", "-m", "target-only child"]);
    await git(repo, ["switch", "main"]);
    assertEquals(
        (await readEpicDeliveryState(repo, "epic"))?.children.find((child) => child.name === "epic/99-target-only")
            ?.order,
        40,
    );
    const head = await git(repo, ["rev-parse", "epic/epic"]);
    const { hostedSession } = gateSession();

    const result = await runEpicIntegrationGate({
        hostedSession,
        projectRoot: repo,
        epicPlanName: "epic",
        semanticReviewPort: scriptedReviewer({
            approved: false,
            findings: [
                {
                    title: "second.js never calls first.js",
                    requirement: "Ship first and second together.",
                    evidence: "second.js:1",
                    status: "new",
                },
            ],
        }),
        workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
        localCIPort: scriptedChecks({ kind: "completed", exitCode: 1, output: "1 test failed" }),
    });

    if (result.kind !== "findings") throw new Error(`Expected findings, got ${result.kind}`);
    assertEquals(result.commit, head);
    const epic = await loadPlan(repo, "epic");
    assertEquals(epic?.attrs.status, "implemented");
    assertEquals(epic?.attrs.epicIntegrationReport, "docs/plans/epic/integration-report.md");
    const report = await fsReadFile(join(repo, "docs/plans/epic/integration-report.md"), "utf8");
    assertStringIncludes(report, "second.js never calls first.js");
    assertStringIncludes(report, "1 test failed");
    // The repair child is an ordinary draft under the Epic, already on the Epic branch for Planner.
    const repairName = result.repairChild.childPlanName || "";
    assertEquals(result.repairChild.kind, "plan");
    const repair = await loadPlan(repo, repairName);
    assertEquals(repair?.attrs.status, "draft");
    assertEquals(repair?.attrs.parentPlan, "epic");
    assertEquals(repair?.attrs.targetBranch, "epic/epic");
    assertEquals(repair?.attrs.order, 41);
    assertEquals(repairName, "epic/repair-integration-findings");
    assertStringIncludes(repair?.markdown || "", "second.js never calls first.js");
    const onBranch = await git(repo, ["ls-tree", "-r", "--name-only", "epic/epic", "docs/plans/epic"]);
    assertStringIncludes(onBranch, `${repairName}.md`.replace(/^/, "docs/plans/"));
    // The automatic gate still waits for delivery of the repair child.
    assertEquals((await reconcileEpicDelivery(repo, "epic")).gateReady, false);
});

test("the gate does not run before every child is delivered", async () => {
    const { repo } = await epicWithPendingSecondChild();
    const { hostedSession } = gateSession();

    const result = await runEpicIntegrationGate({
        hostedSession,
        projectRoot: repo,
        epicPlanName: "epic",
        semanticReviewPort: scriptedReviewer({ approved: true }),
        workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
        localCIPort: scriptedChecks(PASSING_CHECKS),
    });

    assertEquals(result.kind, "not_ready");
    assertEquals((await loadPlan(repo, "epic"))?.attrs.status, "ready_for_work");
});

test("Epic gate events apply only to Epics and a pass must name the checked commit", async () => {
    const epic = { classification: "PROJECT" as const, status: "implemented" as const };
    assertEquals(
        buildPlanEventUpdates("epic_integration_passed", "implemented", { triageMeta: epic, integrationCommit: "abc" })
            .validatedCommit,
        "abc",
    );
    await assertRejects(
        () =>
            Promise.resolve().then(() =>
                buildPlanEventUpdates("epic_integration_passed", "implemented", { triageMeta: epic }),
            ),
        Error,
        "requires integrationCommit",
    );
    await assertRejects(
        () =>
            Promise.resolve().then(() =>
                buildPlanEventUpdates("epic_children_delivered", "ready_for_work", {
                    triageMeta: { classification: "PLANNED_CHANGE", status: "ready_for_work" },
                }),
            ),
        Error,
        "can only apply to PROJECT Epic plans",
    );
});

test("review_complete carries an Epic child's Integration Notes without blocking approval", async () => {
    const { createReviewCompletedTool } = await import("../../tools/review-complete.ts");
    const { hostedSession } = gateSession();
    const tool = createReviewCompletedTool({ hostedSession });
    type Details = { outcome?: string; integrationNotes?: Array<{ check: string; where: string }> };
    const execute = tool.execute as unknown as (
        id: string,
        params: Record<string, unknown>,
    ) => Promise<{ details: Details }>;

    const { details } = await execute("review-1", {
        approved: true,
        integrationNotes: [{ check: "  Child 3 must read the new index  ", where: "index.ts" }, { check: "   " }],
    });

    assertEquals(details.outcome, "approved");
    assertEquals(details.integrationNotes, [{ check: "Child 3 must read the new index", where: "index.ts" }]);
});

test("a reviewed Epic becomes verified only after its checked work reaches the final target", async () => {
    const { repo } = await epicWithPendingSecondChild();
    await setCustomSetting("codereview", "none", "project", repo);
    await deliverSecondChild(repo);
    const { hostedSession } = gateSession();
    await runEpicIntegrationGate({
        hostedSession,
        projectRoot: repo,
        epicPlanName: "epic",
        semanticReviewPort: scriptedReviewer({ approved: true }),
        workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
        localCIPort: scriptedChecks(PASSING_CHECKS),
    });
    assertEquals((await reconcileEpicDelivery(repo, "epic")).status, "reviewed");
    // The user's external merge is the boundary; the integration gate never merges it.
    await git(repo, ["merge", "--no-ff", "epic/epic", "-m", "Deliver Epic"]);
    assertEquals((await reconcileEpicDelivery(repo, "epic")).status, "verified");
    assertEquals((await loadPlan(repo, "epic"))?.attrs.status, "verified");
});

test("the gate installs fresh-checkout dependencies before checks and review", async () => {
    const { repo } = await epicWithPendingSecondChild();
    await setCustomSetting("codereview", "none", "project", repo);
    // Project setup can be configured after the Epic branch was created.
    await setCustomSetting("worktree_setup_command", "printf installed > dependency.txt", "project", repo);
    await deliverSecondChild(repo);
    const { hostedSession } = gateSession();
    const accepted = scriptedReviewer({ approved: true });
    const result = await runEpicIntegrationGate({
        hostedSession,
        projectRoot: repo,
        epicPlanName: "epic",
        semanticReviewPort: {
            runIsolatedAgentSession: async (options) => {
                assertEquals(await fsReadFile(join(options.cwd, "dependency.txt"), "utf8"), "installed");
                return accepted.runIsolatedAgentSession(options);
            },
        },
        workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
        localCIPort: {
            run: async ({ cwd }) => {
                assertEquals(await fsReadFile(join(cwd, "dependency.txt"), "utf8"), "installed");
                return PASSING_CHECKS;
            },
        },
    });
    assertEquals(result.kind, "passed");
    assertEquals((await git(repo, ["worktree", "list"])).split("\n").length, 1);
});

test("the gate initializes submodules before running project setup", async () => {
    await withProcessGlobalTestLock(async () => {
        const previous = process.env.GIT_ALLOW_PROTOCOL;
        process.env.GIT_ALLOW_PROTOCOL = "file";
        try {
            const { repo } = await epicWithPendingSecondChild();
            const vendor = await repoFixture.checkout();
            await git(repo, ["switch", "epic/epic"]);
            await git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", vendor, "third_party/vendor"]);
            await git(repo, ["add", ".gitmodules", "third_party/vendor"]);
            await git(repo, ["commit", "-m", "vendor dependency"]);
            await git(repo, ["switch", "main"]);
            await setCustomSetting("codereview", "none", "project", repo);
            await setCustomSetting(
                "worktree_setup_command",
                "cat third_party/vendor/README.md > dependency.txt",
                "project",
                repo,
            );
            await deliverSecondChild(repo);
            const { hostedSession } = gateSession();
            const result = await runEpicIntegrationGate({
                hostedSession,
                projectRoot: repo,
                epicPlanName: "epic",
                semanticReviewPort: scriptedReviewer({ approved: true }),
                workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
                localCIPort: {
                    run: async ({ cwd }) => {
                        assertEquals(await fsReadFile(join(cwd, "dependency.txt"), "utf8"), "# Fixture\n");
                        return PASSING_CHECKS;
                    },
                },
            });
            assertEquals(result.kind, "passed");
            assertEquals((await git(repo, ["worktree", "list"])).split("\n").length, 1);
        } finally {
            if (previous === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
            else process.env.GIT_ALLOW_PROTOCOL = previous;
        }
    });
});

test("failed gate setup pauses without checks, review, or a repair child", async () => {
    const { repo } = await epicWithPendingSecondChild();
    await setCustomSetting("worktree_setup_command", "echo setup-failed >&2; exit 7", "project", repo);
    await deliverSecondChild(repo);
    const { hostedSession } = gateSession();
    const reviewerCalls: ReviewerCall[] = [];
    const checkCwds: string[] = [];
    const result = await runEpicIntegrationGate({
        hostedSession,
        projectRoot: repo,
        epicPlanName: "epic",
        semanticReviewPort: scriptedReviewer({ approved: true }, reviewerCalls),
        workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
        localCIPort: scriptedChecks(PASSING_CHECKS, checkCwds),
    });
    assertEquals(result.kind, "paused");
    if (result.kind === "paused") assertStringIncludes(result.reason, "setup-failed");
    assertEquals(checkCwds, []);
    assertEquals(reviewerCalls, []);
    assertEquals((await loadPlan(repo, "epic"))?.attrs.status, "implemented");
    assertEquals(await loadPlan(repo, "epic/03-repair-integration-findings"), null);
    assertEquals((await git(repo, ["worktree", "list"])).split("\n").length, 1);
});

test("integration review uses Epic requirements from the checked branch, not primary", async () => {
    const { repo } = await epicWithPendingSecondChild();
    await setCustomSetting("codereview", "none", "project", repo);
    const epicPath = join(repo, "docs/plans/epic.md");
    await fsWriteFile(
        epicPath,
        (await fsReadFile(epicPath, "utf8")).replace("Ship first and second together.", "Stale primary requirements."),
    );
    await git(repo, ["add", "docs/plans/epic.md"]);
    await git(repo, ["commit", "-m", "stale primary requirements"]);
    await deliverSecondChild(repo);
    const { hostedSession } = gateSession();
    const calls: ReviewerCall[] = [];
    const result = await runEpicIntegrationGate({
        hostedSession,
        projectRoot: repo,
        epicPlanName: "epic",
        semanticReviewPort: scriptedReviewer({ approved: true }, calls),
        workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
        localCIPort: scriptedChecks(PASSING_CHECKS),
    });
    assertEquals(result.kind, "passed");
    assertStringIncludes(calls[0].userRequest, "Ship first and second together.");
    assertEquals(calls[0].userRequest.includes("Stale primary requirements."), false);
});

test("a missing branch Epic pauses rather than reviewing the primary document", async () => {
    const { repo } = await epicWithPendingSecondChild();
    await git(repo, ["switch", "epic/epic"]);
    await git(repo, ["rm", "docs/plans/epic.md"]);
    await git(repo, ["commit", "-m", "remove branch Epic"]);
    await git(repo, ["switch", "main"]);
    await deliverSecondChild(repo);
    const { hostedSession } = gateSession();
    const calls: ReviewerCall[] = [];
    const cwds: string[] = [];
    const result = await runEpicIntegrationGate({
        hostedSession,
        projectRoot: repo,
        epicPlanName: "epic",
        semanticReviewPort: scriptedReviewer({ approved: true }, calls),
        workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
        localCIPort: scriptedChecks(PASSING_CHECKS, cwds),
    });
    assertEquals(result.kind, "paused");
    if (result.kind === "paused") assertStringIncludes(result.reason, "Epic document is missing");
    assertEquals(calls, []);
    assertEquals(cwds, []);
    assertEquals((await git(repo, ["worktree", "list"])).split("\n").length, 1);
});

test("child deviations and Integration Notes travel through delivery to the branch-head integration review", async () => {
    const { repo } = await epicWithPendingSecondChild();
    await setCustomSetting("codereview", "none", "project", repo);
    await deliverSecondChild(repo);
    const primaryBefore = (await loadPlan(repo, "epic"))!.markdown;
    const executionRoot = `${repo}-child`;
    await git(repo, ["worktree", "add", "-b", "worktree/deviation", executionRoot, "epic/epic"]);
    const session = new HostedSession({
        id: "epic-child-deviation",
        cwd: repo,
        interactionAdapter: {
            supportsInteraction: () => true,
            requestInteraction: () => ({ outcome: "accepted", value: true }),
        },
    });
    session.setActiveExecutionWorkflow({
        planName: "epic/01-first",
        triageMeta: { classification: "PLANNED_CHANGE" },
        executionAgent: "engineer",
        executionStarted: true,
        projectRoot: repo,
        executionCwd: executionRoot,
        executionMode: "worktree",
        worktreeBranch: "worktree/deviation",
        worktreeId: "child-deviation-attempt",
    });
    try {
        const tool = createPlanDeviationTool({ hostedSession: session });
        type DeviationContext = Parameters<typeof tool.execute>[4];
        const result = await tool.execute(
            "child-scope-change",
            {
                supersededRequirement: "Ship first and second together.",
                replacementRequirement: "Ship first only; omit the second outcome.",
                reason: "The user removed the second outcome.",
            },
            undefined,
            undefined,
            {} as DeviationContext,
        );
        assertEquals(result.details?.decision, "recorded");
        await fsRm(join(executionRoot, "second.js"));
        await recordIntegrationNotes(executionRoot, "epic", "epic/01-first", [
            { check: "First is usable without second", where: "first.js" },
        ]);
        assertEquals((await loadPlan(repo, "epic"))?.markdown, primaryBefore);
        // A lost projection is rebuilt before checkpointing, just as publication does.
        const epic = (await loadPlan(executionRoot, "epic"))!;
        await fsWriteFile(epic.path, primaryBefore);
        assertEquals(await syncEpicChildPlanDeviations(executionRoot, "epic/01-first"), "docs/plans/epic.md");
        await recordIntegrationNotes(executionRoot, "epic", "epic/01-first", [
            { check: "First is usable without second", where: "first.js" },
        ]);
        await checkpointExecutionWorktree({
            worktreePath: executionRoot,
            branch: "worktree/deviation",
            planName: "epic/01-first",
        });
        await git(repo, ["switch", "epic/epic"]);
        await git(repo, ["merge", "--no-ff", "-m", "deliver deviation and notes", "worktree/deviation"]);
        await git(repo, ["switch", "main"]);
        assertEquals(await git(repo, ["ls-tree", "--name-only", "epic/epic", "--", "second.js"]), "");
        const branchDoc = await git(repo, ["show", "epic/epic:docs/plans/epic.md"]);
        assertStringIncludes(branchDoc, "Replacement requirement: Ship first only; omit the second outcome.");
        assertStringIncludes(branchDoc, "First is usable without second");
        assertEquals((await loadPlan(repo, "epic"))?.markdown, primaryBefore);

        const calls: ReviewerCall[] = [];
        const { hostedSession } = gateSession();
        const gate = await runEpicIntegrationGate({
            hostedSession,
            projectRoot: repo,
            epicPlanName: "epic",
            semanticReviewPort: scriptedReviewer(
                {
                    approved: true,
                    advisories: [
                        {
                            title: "Second outcome removed by epic/01-first",
                            detail: "Ship first and second together is replaced by the user-confirmed child deviation.",
                        },
                    ],
                },
                calls,
            ),
            workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
            localCIPort: scriptedChecks(PASSING_CHECKS),
        });
        assertEquals(gate.kind, "passed");
        assertStringIncludes(calls[0].userRequest, "### Child Plan Deviations");
        assertStringIncludes(calls[0].userRequest, "lists user-confirmed replacements");
        assertStringIncludes(
            calls[0].userRequest,
            "Replacement requirement: Ship first only; omit the second outcome.",
        );
        assertStringIncludes(calls[0].userRequest, "First is usable without second");
    } finally {
        session.dispose();
        await git(repo, ["worktree", "remove", "--force", executionRoot]);
    }
});

test("integration review keeps readable file headers with user prefix settings", async () => {
    const { repo } = await epicWithPendingSecondChild();
    await deliverSecondChild(repo);
    await setCustomSetting("codereview", "none", "project", repo);
    await git(repo, ["config", "diff.noprefix", "true"]);
    await git(repo, ["config", "color.diff", "always"]);
    const { hostedSession } = gateSession();
    const reviewer = scriptedReviewer({ approved: true });
    try {
        const result = await runEpicIntegrationGate({
            hostedSession,
            projectRoot: repo,
            epicPlanName: "epic",
            workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
            localCIPort: scriptedChecks(PASSING_CHECKS),
            semanticReviewPort: {
                runIsolatedAgentSession: async (options) => {
                    const diffTool = options.customTools?.find((tool) => tool.name === "review_diff");
                    const full = (diffTool as TaggedReviewDiffTool).__runwieldReviewDiffs.full;
                    const paths = parseDiffFiles(full).map((file) => file.path);
                    assertEquals(paths.includes("first.js"), true);
                    assertEquals(paths.includes("second.js"), true);
                    return await reviewer.runIsolatedAgentSession(options);
                },
            },
        });
        assertEquals(result.kind, "passed");
    } finally {
        hostedSession.dispose();
        await fsRm(repo, { recursive: true });
    }
});
