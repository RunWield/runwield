import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { setCustomSetting } from "../settings.js";
import { loadPlan } from "../../plan-store.js";
import { defineGitFixture, git } from "../git-test-fixture.ts";
import { executeWorkflowTestTools, type WorkflowTestToolCall } from "../../testing/workflow-agent-tools.ts";
import type { IsolatedAgentSessionOptions, SemanticReviewPort } from "./validation-session-adapter.ts";
import type { LocalCIPort, LocalCIResult } from "./validation-local-ci.ts";
import { parseDiffFiles } from "./review-diff-tool.js";
import { makeRecordedSession, makeUi } from "./validation-test-helpers.js";
import { createWorkRecordMnemotecaFixture } from "../work-records/test-fixtures/mnemoteca-port.ts";
import { buildPlanEventUpdates } from "./plan-lifecycle.js";
import { readEpicDeliveryState, reconcileEpicDelivery, runEpicIntegrationGate } from "./epic-integration.ts";

type PlanFixtureAttribute = string | number | string[];
type PlanFixtureAttributes = Record<string, PlanFixtureAttribute>;

/** A review_complete decision the scripted integration reviewer reports. */
interface ScriptedReview {
    approved: boolean;
    findings?: Array<{ title: string; requirement: string; evidence: string; status: "new" }>;
}

/** What the scripted reviewer saw, for assertions. */
interface ReviewerCall {
    userRequest: string;
    cwd: string;
}

async function writePlan(cwd: string, name: string, attrs: PlanFixtureAttributes, body: string, extraYaml = "") {
    const path = join(cwd, "docs", "plans", `${name}.md`);
    await Deno.mkdir(dirname(path), { recursive: true });
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
    await Deno.writeTextFile(path, lines.join("\n"));
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
    await Deno.writeTextFile(join(repo, "README.md"), "# Fixture\n");
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
    await Deno.writeTextFile(join(repo, "first.js"), "export const first = true;\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "first child delivered"]);
    await git(repo, ["switch", "-c", "side", "main"]);
    await Deno.writeTextFile(join(repo, "second.js"), "export const second = true;\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "second child work"]);
    const secondCommit = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["switch", "main"]);
    await writePlan(repo, "epic", {
        planId: "plan-epic",
        classification: "PROJECT",
        complexity: "HIGH",
        status: "ready_for_work",
        targetBranch: "epic/epic",
        epicBaseCommit: base,
        affectedPaths: [],
        createdAt: "2026-01-01T00:00:00.000Z",
    }, "# Epic\n\n## Objective\n\nShip first and second together.\n");
    await writePlan(repo, "epic/02-second", childAttrs(2), "# Second\n", deliveryYaml(secondCommit));
    return { repo, base, secondCommit };
}

async function deliverSecondChild(repo: string) {
    await git(repo, ["switch", "epic/epic"]);
    await git(repo, ["merge", "--no-ff", "-m", "deliver second", "side"]);
    await git(repo, ["switch", "main"]);
}

function scriptedReviewer(review: ScriptedReview, calls: ReviewerCall[] = []): SemanticReviewPort {
    return {
        runIsolatedAgentSession: async (options: IsolatedAgentSessionOptions) => {
            calls.push({ userRequest: options.userRequest, cwd: options.cwd });
            const diffTool = (options.customTools || []).find((tool) => tool.name === "review_diff") as
                | { __runwieldReviewDiffs?: { full?: string } }
                | undefined;
            const full = diffTool?.__runwieldReviewDiffs?.full || "";
            const reads: WorkflowTestToolCall[] = parseDiffFiles(full).flatMap((
                file: { path: string; byteLength: number },
            ) => Array.from({ length: Math.max(1, Math.ceil(file.byteLength / 65536)) }, (_, index) => ({
                name: "review_diff",
                arguments: { command: "show", scope: "full", path: file.path, offsetBytes: index * 65536 },
            })));
            const decision = {
                outcome: review.approved ? "approved" : "feedback",
                approved: review.approved,
                feedback: "",
                findings: review.findings || [],
                advisories: [],
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

Deno.test("a validated child with pending publication does not complete the Epic", async () => {
    const { repo } = await epicWithPendingSecondChild();

    const state = await readEpicDeliveryState(repo, "epic");
    const reconciled = await reconcileEpicDelivery(repo, "epic");

    assertEquals(state?.children.map((child) => [child.name, child.settled]), [
        ["epic/01-first", true],
        ["epic/02-second", false],
    ]);
    assertEquals(reconciled.gateReady, false);
    assertEquals((await loadPlan(repo, "epic"))?.attrs.status, "ready_for_work");
});

Deno.test("delivering the last child to the Epic branch makes the Epic implemented", async () => {
    const { repo } = await epicWithPendingSecondChild();
    await deliverSecondChild(repo);

    const reconciled = await reconcileEpicDelivery(repo, "epic");

    assertEquals(reconciled.gateReady, true);
    const epic = await loadPlan(repo, "epic");
    assertEquals(epic?.attrs.status, "implemented");
    assert(epic?.attrs.implementedAt);
});

Deno.test("the integration gate validates the exact Epic branch head", async () => {
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

Deno.test("a new commit on the Epic branch makes a passed gate stale", async () => {
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
    await Deno.writeTextFile(join(repo, "late.js"), "export const late = true;\n");
    await git(repo, ["add", "late.js"]);
    await git(repo, ["commit", "-m", "late change"]);
    await git(repo, ["switch", "main"]);

    const reconciled = await reconcileEpicDelivery(repo, "epic");

    assertEquals(reconciled.status, "implemented");
    assertEquals(reconciled.gateReady, true);
    assertEquals((await loadPlan(repo, "epic"))?.attrs.validatedCommit, undefined);
});

Deno.test("integration findings produce a report and a draft repair child on the Epic branch", async () => {
    const { repo } = await epicWithPendingSecondChild();
    await deliverSecondChild(repo);
    const head = await git(repo, ["rev-parse", "epic/epic"]);
    const { hostedSession } = gateSession();

    const result = await runEpicIntegrationGate({
        hostedSession,
        projectRoot: repo,
        epicPlanName: "epic",
        semanticReviewPort: scriptedReviewer({
            approved: false,
            findings: [{
                title: "second.js never calls first.js",
                requirement: "Ship first and second together.",
                evidence: "second.js:1",
                status: "new",
            }],
        }),
        workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
        localCIPort: scriptedChecks({ kind: "completed", exitCode: 1, output: "1 test failed" }),
    });

    if (result.kind !== "findings") throw new Error(`Expected findings, got ${result.kind}`);
    assertEquals(result.commit, head);
    const epic = await loadPlan(repo, "epic");
    assertEquals(epic?.attrs.status, "implemented");
    assertEquals(epic?.attrs.epicIntegrationReport, "docs/plans/epic/integration-report.md");
    const report = await Deno.readTextFile(join(repo, "docs/plans/epic/integration-report.md"));
    assertStringIncludes(report, "second.js never calls first.js");
    assertStringIncludes(report, "1 test failed");
    // The repair child is an ordinary draft under the Epic, already on the Epic branch for Planner.
    const repairName = result.repairChild.childPlanName || "";
    assertEquals(result.repairChild.kind, "plan");
    const repair = await loadPlan(repo, repairName);
    assertEquals(repair?.attrs.status, "draft");
    assertEquals(repair?.attrs.parentPlan, "epic");
    assertEquals(repair?.attrs.targetBranch, "epic/epic");
    assertEquals(repair?.attrs.order, 3);
    assertStringIncludes(repair?.markdown || "", "second.js never calls first.js");
    const onBranch = await git(repo, ["ls-tree", "-r", "--name-only", "epic/epic", "docs/plans/epic"]);
    assertStringIncludes(onBranch, `${repairName}.md`.replace(/^/, "docs/plans/"));
    // With an undelivered repair child, the gate does not run again.
    assertEquals((await reconcileEpicDelivery(repo, "epic")).gateReady, false);
});

Deno.test("the gate does not run before every child is delivered", async () => {
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

Deno.test("Epic gate events apply only to Epics and a pass must name the checked commit", async () => {
    const epic = { classification: "PROJECT" as const, status: "implemented" as const };
    assertEquals(
        buildPlanEventUpdates("epic_integration_passed", "implemented", { triageMeta: epic, integrationCommit: "abc" })
            .validatedCommit,
        "abc",
    );
    await assertRejects(
        () =>
            Promise.resolve().then(() =>
                buildPlanEventUpdates("epic_integration_passed", "implemented", { triageMeta: epic })
            ),
        Error,
        "requires integrationCommit",
    );
    await assertRejects(
        () =>
            Promise.resolve().then(() =>
                buildPlanEventUpdates("epic_children_delivered", "ready_for_work", {
                    triageMeta: { classification: "PLANNED_CHANGE", status: "ready_for_work" },
                })
            ),
        Error,
        "can only apply to PROJECT Epic plans",
    );
});

Deno.test("review_complete carries an Epic child's Integration Notes without blocking approval", async () => {
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

Deno.test("a reviewed Epic becomes verified only after its checked work reaches the final target", async () => {
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
