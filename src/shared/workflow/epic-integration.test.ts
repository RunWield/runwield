import { mkdir as fsMkdir, readFile as fsReadFile, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { dirname, join } from "node:path";
import { setCustomSetting } from "../settings.js";
import { findPlansByParent, loadPlan, updatePlanFrontMatter } from "../../plan-store.js";
import { defineGitFixture, git } from "../git-test-fixture.ts";
import { executeWorkflowTestTools, type WorkflowTestToolCall } from "../../testing/workflow-agent-tools.ts";
import type { IsolatedAgentSessionOptions, SemanticReviewPort } from "./validation-session-adapter.ts";
import type { ReviewFinding, ReviewAdvisory } from "../../tools/review-complete.ts";
import type { LocalCIPort, LocalCIResult } from "./validation-local-ci.ts";
import { parseDiffFiles } from "./review-diff-tool.ts";
import { makeRecordedSession, makeUi } from "./validation-test-helpers.js";
import { createWorkRecordMnemotecaFixture } from "../work-records/test-fixtures/mnemoteca-port.ts";
import { buildPlanEventUpdates, recordPlanEvent } from "./plan-lifecycle.js";
import { HostedSession } from "../session/hosted-session.js";
import { createPlanDeviationTool } from "../../tools/plan-deviation.ts";
import { checkpointExecutionWorktree } from "../worktree.js";
import { recordIntegrationNotes, syncEpicChildPlanDeviations } from "./epic-review-context.ts";
import { prepareSessionPlanningWorktree } from "./session-planning-worktree.ts";
import { resolveWorkflowPlanLocation } from "./plan-location.ts";
import { readEpicDeliveryState, reconcileEpicDelivery, runEpicIntegrationGate } from "./epic-integration.ts";

type PlanFixtureAttribute = string | number | string[];
type PlanFixtureAttributes = Record<string, PlanFixtureAttribute>;

/** A review_complete decision the scripted integration reviewer reports. */
interface ScriptedReview {
    approved: boolean;
    findings?: Array<Omit<ReviewFinding, "resolved">>;
    advisories?: ReviewAdvisory[];
}

type TaggedReviewDiffTool = NonNullable<IsolatedAgentSessionOptions["customTools"]>[number] & {
    __runwieldReviewDiffs: { full: string };
};

/** What the scripted reviewer saw, for assertions. */
interface ReviewerCall {
    userRequest: string;
    cwd: string;
    definition?: IsolatedAgentSessionOptions["subAgentDefinition"];
    repairDiff?: string;
}

async function writePlan(cwd: string, name: string, attrs: PlanFixtureAttributes, body: string, extraYaml = "") {
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
    if (extraYaml) lines.push(extraYaml.trimEnd());
    lines.push("---", "", body);
    await fsWriteFile(path, lines.join("\n"));
}

function childAttrs(order: number, extra: PlanFixtureAttributes = {}): PlanFixtureAttributes {
    return {
        planId: `plan-child-${order}`,
        classification: "PLANNED_CHANGE",
        complexity: "MEDIUM",
        status: "validated",
        parentPlan: "epic",
        order,
        targetBranch: "epic/epic",
        affectedPaths: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        ...extra,
    };
}

function deliveryYaml(executionCommit: string): string {
    return [
        "deliveryEvidence:",
        "  version: 1",
        "  mode: worktree_merge",
        `  executionCommit: ${JSON.stringify(executionCommit)}`,
        '  targetBranch: "epic/epic"',
        `  targetHeadBeforeMerge: ${JSON.stringify(executionCommit)}`,
        "executionMode: worktree",
    ].join("\n");
}

const repoFixture = defineGitFixture(async (repo) => {
    await fsWriteFile(join(repo, "README.md"), "# Fixture\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "primary"]);
});

/**
 * An Epic on `epic/epic` whose first child is published to the branch. The
 * second child's work sits on a side branch until the test delivers it.
 */
async function epicWithPendingSecondChild() {
    const repo = await repoFixture.checkout();
    const base = await git(repo, ["rev-parse", "main"]);
    await git(repo, ["switch", "-c", "epic/epic"]);
    await writePlan(repo, "epic/01-first", childAttrs(1), "# First\n");
    await fsWriteFile(join(repo, "first.js"), "export const first = true;\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "first child delivered"]);
    await git(repo, ["switch", "-c", "side", "main"]);
    await fsWriteFile(join(repo, "second.js"), "export const second = true;\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "second child work"]);
    const secondCommit = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["switch", "main"]);
    await writePlan(
        repo,
        "epic",
        {
            planId: "plan-epic",
            classification: "PROJECT",
            complexity: "HIGH",
            status: "ready_for_work",
            targetBranch: "epic/epic",
            epicBaseCommit: base,
            affectedPaths: [],
            createdAt: "2026-01-01T00:00:00.000Z",
        },
        "# Epic\n\n## Objective\n\nShip first and second together.\n",
    );
    const epicDocument = await fsReadFile(join(repo, "docs/plans/epic.md"), "utf8");
    await git(repo, ["switch", "epic/epic"]);
    await git(repo, ["add", "docs/plans/epic.md"]);
    await git(repo, ["commit", "-m", "Epic requirements"]);
    await git(repo, ["switch", "main"]);
    await fsMkdir(join(repo, "docs/plans"), { recursive: true });
    await fsWriteFile(join(repo, "docs/plans/epic.md"), epicDocument);
    await git(repo, ["add", "docs/plans/epic.md"]);
    await git(repo, ["commit", "-m", "primary Epic copy"]);
    await writePlan(repo, "epic/02-second", childAttrs(2), "# Second\n", deliveryYaml(secondCommit));
    return { repo, base, secondCommit };
}

async function deliverSecondChild(repo: string) {
    await git(repo, ["switch", "epic/epic"]);
    await git(repo, ["merge", "--no-ff", "-m", "deliver second", "side"]);
    await git(repo, ["switch", "main"]);
}

function scriptedReviewer(reviews: ScriptedReview | ScriptedReview[], calls: ReviewerCall[] = []): SemanticReviewPort {
    let index = 0;
    return {
        runIsolatedAgentSession: async (options: IsolatedAgentSessionOptions) => {
            const review = Array.isArray(reviews) ? reviews[index++] : reviews;
            assert(review, "Unexpected reviewer attempt");
            const diffTool = (options.customTools || []).find((tool) => tool.name === "review_diff") as
                { __runwieldReviewDiffs?: { full?: string; repair?: string } } | undefined;
            calls.push({
                userRequest: options.userRequest,
                cwd: options.cwd,
                definition: options.subAgentDefinition,
                repairDiff: diffTool?.__runwieldReviewDiffs?.repair,
            });
            const full = diffTool?.__runwieldReviewDiffs?.full || "";
            const reads: WorkflowTestToolCall[] = parseDiffFiles(full).flatMap(
                (file: { path: string; byteLength: number }) =>
                    Array.from({ length: Math.max(1, Math.ceil(file.byteLength / 65536)) }, (_, index) => ({
                        name: "review_diff",
                        arguments: { command: "show", scope: "full", path: file.path, offsetBytes: index * 65536 },
                    })),
            );
            const decision = {
                outcome: review.approved ? "approved" : "feedback",
                approved: review.approved,
                feedback: "",
                findings: review.findings || [],
                advisories: (review.advisories || []).map(({ title, detail }) => ({ title, detail })),
            };
            await executeWorkflowTestTools(options, [
                { name: "review_diff", arguments: { command: "list" } },
                ...reads,
                { name: "review_complete", arguments: decision },
            ]);
            return [];
        },
    };
}

function scriptedChecks(result: LocalCIResult, cwds: string[] = []): LocalCIPort {
    return {
        run: ({ cwd }) => {
            cwds.push(cwd);
            return Promise.resolve(result);
        },
    };
}

const PASSING_CHECKS: LocalCIResult = { kind: "completed", exitCode: 0, output: "all good" };

function gateSession() {
    const recorder = makeUi();
    return { recorder, hostedSession: makeRecordedSession("epic-integration-test", recorder) };
}

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

async function epicWithOpenRepairDraft() {
    const { repo } = await epicWithPendingSecondChild();
    await deliverSecondChild(repo);
    await reconcileEpicDelivery(repo, "epic");
    const repairName = "epic/03-repair-integration-findings";
    await writePlan(
        repo,
        repairName,
        childAttrs(3, { status: "draft" }),
        [
            "# Repair integration findings",
            "",
            "## Context",
            "",
            "The integration gate checked the Epic branch `epic/epic` at `old-commit` and found the problems below. Keep my inline note.",
            "Keep this context note.",
            "",
            "## Objective",
            "",
            "Keep my objective.",
            "",
            "## Findings",
            "",
            "Old findings.",
            "",
            "## Verification Plan",
            "",
            "Keep my checks.",
            "",
        ].join("\n"),
    );
    await setCustomSetting("codereview", "none", "project", repo);
    return { repo, repairName };
}

test("an implemented Epic can retry with a primary-only repair draft, but the automatic gate still waits", async () => {
    const { repo, repairName } = await epicWithOpenRepairDraft();
    const state = await readEpicDeliveryState(repo, "epic");
    assertEquals(state?.allSettled, false);
    assertEquals(state?.children.find((child) => child.name === repairName)?.openRepairDraft, true);
    const reconciled = await reconcileEpicDelivery(repo, "epic");
    assertEquals(reconciled.gateReady, false);
    assertEquals(reconciled.gateRetryReady, true);
});

for (const status of ["approved", "in_progress"]) {
    test(`a ${status} repair child blocks an Epic retry`, async () => {
        const { repo, repairName } = await epicWithOpenRepairDraft();
        await writePlan(repo, repairName, childAttrs(3, { status }), "# Started repair");
        const reconciled = await reconcileEpicDelivery(repo, "epic");
        assertEquals(reconciled.gateRetryReady, false);
        const result = await runEpicIntegrationGate({
            hostedSession: gateSession().hostedSession,
            projectRoot: repo,
            epicPlanName: "epic",
            semanticReviewPort: scriptedReviewer({ approved: true }),
            workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
            localCIPort: scriptedChecks(PASSING_CHECKS),
        });
        assertEquals(result.kind, "not_ready");
    });
}

test("an undelivered ordinary child blocks retry even with an open repair draft", async () => {
    const { repo } = await epicWithOpenRepairDraft();
    await writePlan(repo, "epic/04-extra-scope", childAttrs(4, { status: "draft" }), "# Extra scope");
    assertEquals((await reconcileEpicDelivery(repo, "epic")).gateRetryReady, false);
});

test("a passing retry closes all open repair drafts without changing their bodies or identities", async () => {
    const { repo, repairName } = await epicWithOpenRepairDraft();
    const older = await loadPlan(repo, repairName);
    const secondName = "epic/04-repair-integration-findings-2";
    await writePlan(repo, secondName, childAttrs(4, { status: "draft" }), "# Another repair\n");
    const second = await loadPlan(repo, secondName);
    const head = await git(repo, ["rev-parse", "epic/epic"]);
    const result = await runEpicIntegrationGate({
        hostedSession: gateSession().hostedSession,
        projectRoot: repo,
        epicPlanName: "epic",
        semanticReviewPort: scriptedReviewer({ approved: true }),
        workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
        localCIPort: scriptedChecks(PASSING_CHECKS),
    });
    assertEquals(result, { kind: "passed", commit: head });
    assertEquals((await loadPlan(repo, "epic"))?.attrs.status, "reviewed");
    for (const [name, before] of [
        [repairName, older],
        [secondName, second],
    ] as const) {
        const after = await loadPlan(repo, name);
        assertEquals(after?.attrs.status, "closed_without_verification");
        assertEquals(after?.attrs.planId, before?.attrs.planId);
        assertEquals(after?.attrs.order, before?.attrs.order);
        assertEquals(after?.body, before?.body);
        assertStringIncludes(after?.attrs.closedWithoutVerificationReason || "", head);
        assertStringIncludes(after?.attrs.closedWithoutVerificationReason || "", "epic/epic");
    }
});

for (const oldFindings of [
    "Old findings.",
    "### Failed checks\n\n```text\nOld output.\n## Summary\nOld summary.\n```\n\n### Old review finding\n\nOld findings.",
    "### Failed checks\n\n~~~~text\nOld output.\n~~~\n## Summary\nOld summary.\n~~~~\n\nOld findings.",
]) {
    test(`a findings retry replaces ${oldFindings.includes("## Summary") ? (oldFindings.includes("~~~~") ? "tilde-fenced" : "backtick-fenced") : "plain"} findings and preserves other sections`, async () => {
        const { repo, repairName } = await epicWithOpenRepairDraft();
        await writePlan(
            repo,
            "epic/04-repair-integration-findings-2",
            childAttrs(4, { status: "draft" }),
            (await loadPlan(repo, repairName))!.body.replace("Old findings.", oldFindings),
        );
        const newestName = "epic/04-repair-integration-findings-2";
        const before = await loadPlan(repo, newestName);
        const older = await loadPlan(repo, repairName);
        const head = await git(repo, ["rev-parse", "epic/epic"]);
        const { hostedSession } = gateSession();
        hostedSession.setInteractionAdapter({
            requestInteraction: async (request) => {
                assertEquals(request.type, "select");
                assertEquals((await loadPlan(repo, "epic"))?.attrs.epicIntegrationReview?.round, 3);
                return { outcome: "selected", value: "repair" };
            },
        });
        const result = await runEpicIntegrationGate({
            hostedSession,
            projectRoot: repo,
            epicPlanName: "epic",
            semanticReviewPort: scriptedReviewer({ approved: true }),
            workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
            localCIPort: scriptedChecks({ kind: "completed", exitCode: 1, output: "New check failure $& $` $'" }),
        });
        assertEquals(result.kind, "findings");
        if (result.kind !== "findings") throw new Error("Expected retry findings");
        assertEquals(result.repairChild.childPlanName, newestName);
        const location = await resolveWorkflowPlanLocation(repo, newestName, { readOnly: true });
        const after = location.plan;
        assertEquals(after?.markdown.split("---")[1], before?.markdown.split("---")[1]);
        assertStringIncludes(after?.body || "", head);
        assertStringIncludes(after?.body || "", "New check failure $& $` $'");
        for (const note of [
            "Keep this context note.",
            "Keep my objective.",
            "Keep my checks.",
            "Keep my inline note.",
        ]) {
            assertStringIncludes(after?.body || "", note);
        }
        for (const stale of ["Old findings.", "Old output.", "Old summary.", "### Old review finding"]) {
            assertEquals(after!.body.includes(stale), false);
        }
        const expectedBody = before!.body.replace("old-commit", head).replace(`## Findings\n\n${oldFindings}\n\n`, "");
        assertEquals(after!.body.replace(/## Findings\n[\s\S]*?(?=## Verification Plan)/, ""), expectedBody);
        assertEquals((await loadPlan(repo, repairName))?.markdown, older?.markdown);
        assertEquals((await findPlansByParent(repo, "epic")).length, 4);
    });
}

test("a passing retry can close a repair draft already published on the Epic branch", async () => {
    const { repo, repairName } = await epicWithOpenRepairDraft();
    const original = await loadPlan(repo, repairName);
    await git(repo, ["switch", "epic/epic"]);
    await git(repo, ["add", `docs/plans/${repairName}.md`]);
    await git(repo, ["commit", "-m", "Publish repair draft"]);
    await git(repo, ["switch", "main"]);
    await writePlan(repo, repairName, childAttrs(3, { status: "draft" }), `${original?.body}\nKeep my local note.\n`);
    const result = await runEpicIntegrationGate({
        hostedSession: gateSession().hostedSession,
        projectRoot: repo,
        epicPlanName: "epic",
        semanticReviewPort: scriptedReviewer({ approved: true }),
        workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
        localCIPort: scriptedChecks(PASSING_CHECKS),
    });
    assertEquals(result.kind, "passed");
    const closed = (await resolveWorkflowPlanLocation(repo, repairName, { readOnly: true })).plan;
    assertEquals(closed?.attrs.status, "closed_without_verification");
    assertEquals(closed?.body, `${original?.body}\nKeep my local note.\n`);
    assertEquals((await reconcileEpicDelivery(repo, "epic")).state?.allSettled, true);
});

test("a started repair in its registered document blocks retry despite a draft on the branch", async () => {
    const { repo, repairName } = await epicWithOpenRepairDraft();
    await git(repo, ["switch", "epic/epic"]);
    await git(repo, ["add", `docs/plans/${repairName}.md`]);
    await git(repo, ["commit", "-m", "Repair draft"]);
    await git(repo, ["switch", "main"]);
    await prepareSessionPlanningWorktree(repo, repairName);
    await recordPlanEvent({ cwd: repo, planName: repairName, event: "review_approved", currentStatus: "draft" });
    assertEquals((await reconcileEpicDelivery(repo, "epic")).gateRetryReady, false);
});

for (const branchStatus of ["approved", "verified"]) {
    test(`a stale primary draft does not hide a ${branchStatus} repair on the Epic branch`, async () => {
        const { repo, repairName } = await epicWithOpenRepairDraft();
        const primaryDraft = (await loadPlan(repo, repairName))!.markdown;
        await git(repo, ["switch", "epic/epic"]);
        await writePlan(repo, repairName, childAttrs(3, { status: branchStatus }), "# Branch repair");
        await git(repo, ["add", `docs/plans/${repairName}.md`]);
        await git(repo, ["commit", "-m", "Advance repair on branch"]);
        await git(repo, ["switch", "main"]);
        await fsWriteFile(join(repo, `docs/plans/${repairName}.md`), primaryDraft);
        const reconciled = await reconcileEpicDelivery(repo, "epic");
        assertEquals(reconciled.state?.children.find((child) => child.name === repairName)?.status, branchStatus);
        assertEquals(reconciled.gateRetryReady, false);
        assertEquals(reconciled.gateReady, branchStatus === "verified");
    });
}

test("a paused retry leaves the Epic and its repair draft unchanged", async () => {
    const { repo, repairName } = await epicWithOpenRepairDraft();
    const before = await loadPlan(repo, repairName);
    const result = await runEpicIntegrationGate({
        hostedSession: gateSession().hostedSession,
        projectRoot: repo,
        epicPlanName: "epic",
        semanticReviewPort: scriptedReviewer({ approved: true }),
        workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
        localCIPort: scriptedChecks({ kind: "canceled", output: "Canceled" }),
    });
    assertEquals(result.kind, "paused");
    assertEquals((await loadPlan(repo, "epic"))?.attrs.status, "implemented");
    assertEquals((await loadPlan(repo, repairName))?.markdown, before?.markdown);
});

test("a branch move during retry leaves the repair draft unchanged", async () => {
    const { repo, repairName } = await epicWithOpenRepairDraft();
    const before = await loadPlan(repo, repairName);
    const head = await git(repo, ["rev-parse", "epic/epic"]);
    const result = await runEpicIntegrationGate({
        hostedSession: gateSession().hostedSession,
        projectRoot: repo,
        epicPlanName: "epic",
        semanticReviewPort: scriptedReviewer({ approved: true }),
        workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
        localCIPort: {
            run: async () => {
                const moved = await git(repo, ["commit-tree", `${head}^{tree}`, "-p", head, "-m", "Branch moved"]);
                await git(repo, ["update-ref", "refs/heads/epic/epic", moved, head]);
                return PASSING_CHECKS;
            },
        },
    });
    assertEquals(result.kind, "not_ready");
    assertEquals((await loadPlan(repo, "epic"))?.attrs.status, "implemented");
    assertEquals((await loadPlan(repo, repairName))?.markdown, before?.markdown);
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

test("existing integration repair children count toward the automatic review limit", async () => {
    const { repo } = await epicWithPendingSecondChild();
    await deliverSecondChild(repo);
    await git(repo, ["switch", "epic/epic"]);
    for (const order of [3, 4]) {
        await writePlan(repo, `epic/0${order}-repair-integration-findings`, childAttrs(order), "# Delivered repair\n");
    }
    await git(repo, ["add", "docs/plans"]);
    await git(repo, ["commit", "-m", "earlier integration repairs"]);
    await git(repo, ["switch", "main"]);
    const { hostedSession } = gateSession();
    const result = await runEpicIntegrationGate({
        hostedSession,
        projectRoot: repo,
        epicPlanName: "epic",
        semanticReviewPort: scriptedReviewer({
            approved: false,
            findings: [
                { title: "Broken seam", requirement: "Ship together", evidence: "Not connected", status: "new" },
            ],
        }),
        workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
        localCIPort: scriptedChecks(PASSING_CHECKS),
    });
    assertEquals(result.kind, "paused");
    assertEquals((await loadPlan(repo, "epic"))?.attrs.epicIntegrationReview?.round, 3);
    assertEquals((await readEpicDeliveryState(repo, "epic"))?.children.length, 4);
});

const SEAM_FINDINGS: ScriptedReview = {
    approved: false,
    findings: [
        { title: "First seam", requirement: "Ship together", evidence: "First disconnected", status: "new" },
        { title: "Second seam", requirement: "Ship together", evidence: "Second disconnected", status: "new" },
    ],
};

async function readyGate() {
    const { repo } = await epicWithPendingSecondChild();
    await setCustomSetting("codereview", "none", "project", repo);
    await deliverSecondChild(repo);
    const { hostedSession, recorder } = gateSession();
    const options = {
        hostedSession,
        projectRoot: repo,
        epicPlanName: "epic",
        workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
        localCIPort: scriptedChecks(PASSING_CHECKS),
    };
    return { repo, hostedSession, recorder, options };
}

async function seedReviewRound(repo: string, round: number) {
    const plan = await loadPlan(repo, "epic");
    assert(plan);
    await updatePlanFrontMatter(
        repo,
        "epic",
        {
            epicIntegrationReview: {
                round,
                ledger: { items: [], sequence: 0 },
                checkedCommit: await git(repo, ["rev-parse", "epic/epic"]),
            },
        },
        {},
        { expectedRevision: plan.revision },
    );
}

async function deliverRepair(repo: string, childName: string) {
    const child = await loadPlan(repo, childName);
    assert(child);
    await git(repo, ["add", "docs/plans"]);
    await git(repo, ["commit", "-m", "save primary fixture documents"]);
    await git(repo, ["switch", "epic/epic"]);
    await writePlan(
        repo,
        childName,
        childAttrs(Number(child.attrs.order), { planId: child.attrs.planId! }),
        "# Delivered repair\n",
    );
    await fsWriteFile(join(repo, "repair.js"), "export const repaired = true;\n");
    await git(repo, ["add", "docs/plans", "repair.js"]);
    await git(repo, ["commit", "-m", "deliver integration repair"]);
    await git(repo, ["switch", "main"]);
}

test("integration findings retain their IDs across delivery and verify only the repair delta", async () => {
    const { repo, options } = await readyGate();
    const calls: ReviewerCall[] = [];
    const head = await git(repo, ["rev-parse", "epic/epic"]);
    const first = await runEpicIntegrationGate({
        ...options,
        semanticReviewPort: scriptedReviewer(SEAM_FINDINGS, calls),
    });
    assert(first.kind === "findings");
    assertEquals(calls[0].definition?.options?.reviewerMode, "discovery");
    const state = (await loadPlan(repo, "epic"))?.attrs.epicIntegrationReview;
    assertEquals(state?.round, 1);
    assertEquals(state?.checkedCommit, head);
    assertEquals(
        state?.ledger.items.map((item) => item.id),
        ["R1-1", "R1-2"],
    );
    const report = await fsReadFile(join(repo, first.reportPath), "utf8");
    const repair = await loadPlan(repo, first.repairChild.childPlanName!);
    for (const id of ["R1-1", "R1-2"]) {
        assertStringIncludes(report, `### ${id}.`);
        assertStringIncludes(repair!.markdown, `### ${id}.`);
    }
    const markdown = await fsReadFile(join(repo, "docs/plans/epic.md"), "utf8");
    assertEquals(markdown.includes("epicIntegrationReview:"), false);
    await deliverRepair(repo, first.repairChild.childPlanName!);
    // A new hosted Session reads the ledger from disk, not from the earlier gate's memory.
    const second = await runEpicIntegrationGate({
        ...options,
        hostedSession: gateSession().hostedSession,
        semanticReviewPort: scriptedReviewer(
            {
                approved: false,
                findings: [
                    { ...SEAM_FINDINGS.findings![0], id: "R1-1", status: "fix_confirmed", evidence: "Connected now" },
                    {
                        ...SEAM_FINDINGS.findings![1],
                        id: "R1-2",
                        status: "fix_rejected",
                        rejectionReason: "Still not wired",
                    },
                ],
            },
            calls,
        ),
    });
    assert(second.kind === "findings");
    assertEquals(calls[1].definition?.options?.reviewerMode, "verify");
    assertStringIncludes(calls[1].userRequest, "R1-1");
    assertStringIncludes(calls[1].userRequest, "R1-2");
    assertStringIncludes(calls[1].userRequest, "fix claimed");
    assertStringIncludes(calls[1].repairDiff || "", "repair.js");
    assertEquals(calls[1].repairDiff?.includes("diff --git a/first.js"), false);
    const nextRepair = await loadPlan(repo, second.repairChild.childPlanName!);
    assertStringIncludes(nextRepair!.markdown, "### R1-2.");
    assertStringIncludes(nextRepair!.markdown, "Still not wired");
    assertEquals(nextRepair!.markdown.includes("### R1-1."), false);
    assertEquals(
        (await loadPlan(repo, "epic"))?.attrs.epicIntegrationReview?.ledger.items.map((item) => item.status),
        ["fix_confirmed", "fix_rejected"],
    );
});

test("a verify verdict cannot omit an open integration finding", async () => {
    const { repo, options } = await readyGate();
    const first = await runEpicIntegrationGate({ ...options, semanticReviewPort: scriptedReviewer(SEAM_FINDINGS) });
    assert(first.kind === "findings");
    await deliverRepair(repo, first.repairChild.childPlanName!);
    const calls: ReviewerCall[] = [];
    const result = await runEpicIntegrationGate({
        ...options,
        semanticReviewPort: scriptedReviewer(
            [
                { approved: true },
                {
                    approved: true,
                    findings: SEAM_FINDINGS.findings!.map((item, i) => ({
                        ...item,
                        id: `R1-${i + 1}`,
                        status: "fix_confirmed",
                        evidence: "Connected",
                    })),
                },
            ],
            calls,
        ),
    });
    assertEquals(result.kind, "passed");
    assertEquals(calls.length, 2);
    assertEquals(
        (await loadPlan(repo, "epic"))?.attrs.epicIntegrationReview?.ledger.items.every(
            (item) => item.status === "fix_confirmed",
        ),
        true,
    );
});

for (const choice of ["stop", "repair", "unanswered"]) {
    test(`third integration review asks before creating a child: ${choice}`, async () => {
        const { repo, options, hostedSession } = await readyGate();
        await seedReviewRound(repo, 2);
        hostedSession.setInteractionAdapter({
            requestInteraction: async (request) => {
                assertEquals(request.type, "select");
                assertEquals((await readEpicDeliveryState(repo, "epic"))?.children.length, 2);
                assertEquals((await loadPlan(repo, "epic"))?.attrs.epicIntegrationReview?.round, 3);
                return choice === "unanswered" ? { outcome: "canceled" } : { outcome: "selected", value: choice };
            },
        });
        const result = await runEpicIntegrationGate({
            ...options,
            semanticReviewPort: scriptedReviewer(SEAM_FINDINGS),
        });
        assertEquals(result.kind, choice === "repair" ? "findings" : "paused");
        assertEquals((await readEpicDeliveryState(repo, "epic"))?.children.length, choice === "repair" ? 3 : 2);
        const report = await fsReadFile(join(repo, "docs/plans/epic/integration-report.md"), "utf8");
        assertStringIncludes(report, "R3-1");
        if (result.kind === "paused") assertStringIncludes(result.reason, "docs/plans/epic/integration-report.md");
    });
}

for (const checksPass of [true, false]) {
    test(`limit Code Review takeover requires passing project checks: ${checksPass}`, async () => {
        const { repo, options, hostedSession, recorder } = await readyGate();
        await seedReviewRound(repo, 2);
        let codeReviewOpened = false;
        hostedSession.setInteractionAdapter({
            requestInteraction: (request) => {
                if (request.type === "select") {
                    assertEquals(
                        request.options?.some((option) => option.value === "code_review"),
                        checksPass,
                    );
                    return Promise.resolve({ outcome: "selected", value: checksPass ? "code_review" : "stop" });
                }
                assertEquals(request.type, "code_review");
                codeReviewOpened = true;
                return Promise.resolve({ outcome: "accepted", _meta: { approved: true } });
            },
        });
        const result = await runEpicIntegrationGate({
            ...options,
            semanticReviewPort: scriptedReviewer(SEAM_FINDINGS),
            localCIPort: scriptedChecks(
                checksPass ? PASSING_CHECKS : { kind: "completed", exitCode: 1, output: "failed" },
            ),
        });
        assertEquals(result.kind, checksPass ? "passed" : "paused");
        assertEquals(codeReviewOpened, checksPass);
        const epic = await loadPlan(repo, "epic");
        if (checksPass) {
            assertEquals(epic?.attrs.status, "reviewed");
            assert(epic?.attrs.epicIntegrationReview?.userTakeoverAt);
            assertEquals(epic?.attrs.humanReviewMode, "always");
            assertEquals(epic?.attrs.humanReviewDecision, "approved");
            assertStringIncludes(recorder.messages.join("\n"), "integration review did not approve");
            assertEquals(epic?.attrs.epicIntegrationReview?.ledger.items.length, 2);
        }
    });
}

for (const takeover of [true, false]) {
    test(`Code Review changes create a repair child without a second limit decision: takeover=${takeover}`, async () => {
        const { repo, options, hostedSession } = await readyGate();
        await seedReviewRound(repo, 2);
        await setCustomSetting("codereview", "always", "project", repo);
        let limitPrompts = 0;
        hostedSession.setInteractionAdapter({
            requestInteraction: (request) => {
                if (request.type === "select") {
                    limitPrompts++;
                    return Promise.resolve({ outcome: "selected", value: "code_review" });
                }
                assertEquals(request.type, "code_review");
                return Promise.resolve({ outcome: "accepted", message: "Connect the seam" });
            },
        });
        const result = await runEpicIntegrationGate({
            ...options,
            semanticReviewPort: scriptedReviewer(takeover ? SEAM_FINDINGS : { approved: true }),
        });
        assertEquals(result.kind, "findings");
        assertEquals(limitPrompts, takeover ? 1 : 0);
        assertEquals((await readEpicDeliveryState(repo, "epic"))?.children.length, 3);
    });
}

for (const change of ["head", "controller"]) {
    test(`a changed ${change} prevents a completed review from overwriting saved gate evidence`, async () => {
        const { repo, options } = await readyGate();
        const reviewer = scriptedReviewer(SEAM_FINDINGS);
        const result = await runEpicIntegrationGate({
            ...options,
            semanticReviewPort: {
                runIsolatedAgentSession: async (request) => {
                    if (change === "head") {
                        await git(repo, ["switch", "epic/epic"]);
                        await fsWriteFile(join(repo, "new-head.js"), "export const changed = true;\n");
                        await git(repo, ["add", "new-head.js"]);
                        await git(repo, ["commit", "-m", "branch moved during review"]);
                        await git(repo, ["switch", "main"]);
                    } else {
                        await seedReviewRound(repo, 9);
                    }
                    return await reviewer.runIsolatedAgentSession(request);
                },
            },
        });
        assertEquals(result.kind, "not_ready");
        assertEquals(
            (await loadPlan(repo, "epic"))?.attrs.epicIntegrationReview?.round,
            change === "head" ? undefined : 9,
        );
        assertEquals((await readEpicDeliveryState(repo, "epic"))?.children.length, 2);
    });
}

test("a reviewer without a verdict pauses without consuming a round", async () => {
    const { repo, options } = await readyGate();
    await seedReviewRound(repo, 2);
    const result = await runEpicIntegrationGate({
        ...options,
        semanticReviewPort: {
            runIsolatedAgentSession: () => Promise.resolve([]),
        },
    });
    assertEquals(result.kind, "paused");
    assertEquals((await loadPlan(repo, "epic"))?.attrs.epicIntegrationReview?.round, 2);
    assertEquals((await readEpicDeliveryState(repo, "epic"))?.children.length, 2);
});

test("project-check failures alone reach the limit without becoming ledger findings", async () => {
    const { repo, options, hostedSession } = await readyGate();
    await seedReviewRound(repo, 2);
    hostedSession.setInteractionAdapter({
        requestInteraction: (request) => {
            assertEquals(request.type, "select");
            assertEquals(
                request.options?.map((option) => option.value),
                ["repair", "stop"],
            );
            return Promise.resolve({ outcome: "selected", value: "stop" });
        },
    });
    const result = await runEpicIntegrationGate({
        ...options,
        semanticReviewPort: scriptedReviewer({ approved: true }),
        localCIPort: scriptedChecks({ kind: "completed", exitCode: 1, output: "a deterministic failure" }),
    });
    assertEquals(result.kind, "paused");
    const saved = (await loadPlan(repo, "epic"))?.attrs.epicIntegrationReview;
    assertEquals(saved?.round, 3);
    assertEquals(saved?.ledger.items, []);
    assertEquals((await readEpicDeliveryState(repo, "epic"))?.children.length, 2);
});

test("repair names do not reuse a surviving repair after an earlier member is removed", async () => {
    const { repo } = await epicWithPendingSecondChild();
    await deliverSecondChild(repo);
    await git(repo, ["switch", "epic/epic"]);
    const oldName = "epic/99-repair-integration-findings-2";
    await writePlan(repo, oldName, childAttrs(40, { status: "user_verified" }), "# Keep delivered repair\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "surviving repair"]);
    const before = await git(repo, ["show", `epic/epic:docs/plans/${oldName}.md`]);
    await git(repo, ["switch", "main"]);
    const result = await runEpicIntegrationGate({
        hostedSession: gateSession().hostedSession,
        projectRoot: repo,
        epicPlanName: "epic",
        semanticReviewPort: scriptedReviewer({ approved: true }),
        workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
        localCIPort: scriptedChecks({ kind: "completed", exitCode: 1, output: "repair required" }),
    });
    if (result.kind !== "findings") throw new Error(`Expected findings, got ${result.kind}`);
    assertEquals(result.repairChild.childPlanName, "epic/repair-integration-findings-3");
    assertEquals((await loadPlan(repo, "epic/repair-integration-findings-3"))?.attrs.order, 41);
    assertEquals(await git(repo, ["show", `epic/epic:docs/plans/${oldName}.md`]), before);
});
