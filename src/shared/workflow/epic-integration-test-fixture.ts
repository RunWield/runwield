import { mkdir as fsMkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { ok as assert } from "node:assert/strict";
import { dirname, join } from "node:path";
import { defineGitFixture, git } from "../git-test-fixture.ts";
import { executeWorkflowTestTools, type WorkflowTestToolCall } from "../../testing/workflow-agent-tools.ts";
import type { IsolatedAgentSessionOptions, SemanticReviewPort } from "./validation-session-adapter.ts";
import type { ReviewFinding, ReviewAdvisory } from "../../tools/review-complete.ts";
import type { LocalCIPort, LocalCIResult } from "./validation-local-ci.ts";
import { parseDiffFiles } from "./review-diff-tool.ts";
import { makeRecordedSession, makeUi } from "./validation-test-helpers.js";

type PlanFixtureAttribute = string | number | string[];
type PlanFixtureAttributes = Record<string, PlanFixtureAttribute>;

/** A review_complete decision the scripted integration reviewer reports. */
export interface ScriptedReview {
    approved: boolean;
    findings?: Array<Omit<ReviewFinding, "resolved">>;
    advisories?: ReviewAdvisory[];
}

/** What the scripted reviewer saw, for assertions. */
export interface ReviewerCall {
    userRequest: string;
    cwd: string;
    definition?: IsolatedAgentSessionOptions["subAgentDefinition"];
    repairDiff?: string;
}

export async function writePlan(cwd: string, name: string, attrs: PlanFixtureAttributes, body: string, extraYaml = "") {
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

export function childAttrs(order: number, extra: PlanFixtureAttributes = {}): PlanFixtureAttributes {
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

export const repoFixture = defineGitFixture(async (repo) => {
    await fsWriteFile(join(repo, "README.md"), "# Fixture\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "primary"]);
});

/**
 * An Epic on `epic/epic` whose first child is published to the branch. The
 * second child's work sits on a side branch until the test delivers it.
 */
export async function epicWithPendingSecondChild() {
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

export async function deliverSecondChild(repo: string) {
    await git(repo, ["switch", "epic/epic"]);
    await git(repo, ["merge", "--no-ff", "-m", "deliver second", "side"]);
    await git(repo, ["switch", "main"]);
}

export function scriptedReviewer(
    reviews: ScriptedReview | ScriptedReview[],
    calls: ReviewerCall[] = [],
): SemanticReviewPort {
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

export function scriptedChecks(result: LocalCIResult, cwds: string[] = []): LocalCIPort {
    return {
        run: ({ cwd }) => {
            cwds.push(cwd);
            return Promise.resolve(result);
        },
    };
}

export const PASSING_CHECKS: LocalCIResult = { kind: "completed", exitCode: 0, output: "all good" };

export function gateSession() {
    const recorder = makeUi();
    return { recorder, hostedSession: makeRecordedSession("epic-integration-test", recorder) };
}
