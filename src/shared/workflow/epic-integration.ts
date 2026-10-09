/**
 * @module shared/workflow/epic-integration
 * How an Epic with its own branch finishes.
 *
 * An Epic is `implemented` when every included child is delivered to the Epic
 * branch — its delivered commit is contained in the branch — not when every
 * child merely shows a finished status. The integration gate then checks the
 * exact Epic branch head as one change: the project's checks, an integration
 * review of the whole Epic diff, and Code Review per the `codereview` setting.
 * A pass marks the Epic `reviewed`; findings become a draft repair child that
 * Planner picks up like any other child. RunWield never merges the Epic branch
 * into the primary branch.
 */

import { join } from "@std/path";
import {
    compareChildPlansByOrder,
    findPlansByParent,
    loadPlan,
    saveChildFeaturePlans,
    withPlanCatalogLock,
} from "../../plan-store.js";
import type { PlanFrontMatter } from "../../plan-store.js";
import { AGENTS, isPlannedChangeClassification } from "../../constants.js";
import { isCommitPublishedToTarget } from "../isolated-publication.ts";
import { isGitRepository } from "../git.ts";
import { getCodeReviewMode } from "../settings.js";
import { resolvePrimaryCheckoutRoot } from "../primary-checkout.ts";
import { EPIC_INTEGRATION_REPORT_FILE_NAME, getEpicArtifactPath } from "../epic-artifacts.ts";
import type { HostedSession } from "../session/hosted-session.js";
import { recordPlanEvent } from "./plan-lifecycle.js";
import { resolveWorkflowPlanLocation } from "./plan-location.ts";
import { findTargetBranchPlansByParent } from "./planning-worktree.ts";
import { ensureEpicBranch } from "./epic-branch.ts";
import type { LocalCIPort, LocalCIResult } from "./validation-local-ci.ts";
import { createValidationSessionPort, type SemanticReviewPort } from "./validation-session-adapter.ts";
import { createReviewDiffTool } from "./review-diff-tool.js";
import { createLedger } from "./review-ledger.ts";
import { formatCodeReviewAnnotations, normalizeHumanReview } from "./validation-human-review.ts";
import {
    type OpaqueToolDefinition,
    ValidationInteractionTypes,
    type ValidationReviewOutcome,
    type ValidationSessionPort,
} from "./validation-ports.ts";
import type { EpicContinuationResolution } from "./epic-continuation.ts";

import type { WorkRecordMnemotecaPort } from "../work-records/mnemoteca-port.ts";

/** Child statuses that end a child's own workflow. */
const FINISHED_CHILD_STATUSES = new Set(["validated", "verified", "user_verified", "closed_without_verification"]);

/** Reviewer attempts before the gate pauses on a reviewer that never reports. */
const MAX_REVIEWER_ATTEMPTS = 3;

/** Characters of check output kept in the report; the end of the output carries the failure. */
const CHECK_OUTPUT_TAIL = 6000;

/** One child as the Epic sees it. */
export interface EpicChildDelivery {
    name: string;
    status: string;
    /** The child's work is in the Epic branch, or the user closed or accepted it. */
    settled: boolean;
    /** The commits this child delivered, when its delivery evidence records them. */
    delivery?: { from: string; to: string };
}

/** Where an Epic with a branch stands. */
export interface EpicDeliveryState {
    epicPlanName: string;
    branch: string;
    /** The ref that holds the Epic's published state. */
    ref: string;
    head: string | null;
    children: EpicChildDelivery[];
    /** Every included child is settled, and there is at least one. */
    allSettled: boolean;
}

/** What reconciliation found and changed. */
export interface EpicReconcileResult {
    state: EpicDeliveryState | null;
    /** The Epic status after reconciliation. */
    status?: string;
    /** The Epic is `implemented` with every child settled: the integration gate should run. */
    gateReady: boolean;
}

/** What one integration gate run decided. */
export type EpicIntegrationGateResult =
    | { kind: "not_ready"; reason: string }
    | { kind: "passed"; commit: string }
    | { kind: "findings"; commit: string; reportPath: string; repairChild: EpicContinuationResolution }
    | { kind: "paused"; reason: string };

/** What the integration gate needs for one run. */
export interface RunEpicIntegrationGateOptions {
    hostedSession: HostedSession;
    projectRoot: string;
    epicPlanName: string;
    /** Agent turns: the integration reviewer runs through this boundary. */
    semanticReviewPort: SemanticReviewPort;
    /** The project's checks, which run as a subprocess. */
    localCIPort: LocalCIPort;
    /** The Work Record store, which receives the Epic's record when the gate passes. */
    workRecordMnemotecaPort: WorkRecordMnemotecaPort;
}

interface GateFinding {
    source: "checks" | "integration_review" | "code_review";
    title: string;
    detail: string;
}

interface GitResult {
    success: boolean;
    stdout: string;
    stderr: string;
}

async function runGitResult(cwd: string, args: string[]): Promise<GitResult> {
    const output = await new Deno.Command("git", { cwd, args, stdout: "piped", stderr: "piped" }).output();
    return {
        success: output.success,
        stdout: new TextDecoder().decode(output.stdout),
        stderr: new TextDecoder().decode(output.stderr),
    };
}

async function runGit(cwd: string, args: string[]): Promise<string> {
    const result = await runGitResult(cwd, args);
    if (!result.success) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`.trim());
    return result.stdout;
}

async function refCommit(primaryRoot: string, ref: string): Promise<string | null> {
    const result = await runGitResult(primaryRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return result.success ? result.stdout.trim() : null;
}

function epicBranchOf(attrs: Partial<PlanFrontMatter> | undefined): string {
    return typeof attrs?.targetBranch === "string" ? attrs.targetBranch.trim().replace(/^origin\//, "") : "";
}

async function canonicalEpicRef(primaryRoot: string, branch: string): Promise<string> {
    return await refCommit(primaryRoot, `refs/remotes/origin/${branch}`)
        ? `refs/remotes/origin/${branch}`
        : `refs/heads/${branch}`;
}

async function isContained(primaryRoot: string, commit: string, ref: string): Promise<boolean> {
    return (await runGitResult(primaryRoot, ["merge-base", "--is-ancestor", commit, ref])).success;
}

/**
 * Whether a child's work is in the Epic branch. A child the user closed or
 * accepted directly is settled by that decision; a validated child counts only
 * once its delivered commit is contained in the branch, so pending publication
 * does not count.
 */
async function isChildSettled(
    primaryRoot: string,
    ref: string,
    head: string,
    child: { path: string; attrs: PlanFrontMatter },
): Promise<boolean> {
    const status = child.attrs.status;
    if (!FINISHED_CHILD_STATUSES.has(status)) return false;
    if (status === "user_verified" || status === "closed_without_verification") return true;
    const evidence = child.attrs.deliveryEvidence;
    if (evidence?.mode === "non_git_in_place") return true;
    if (evidence?.mode === "worktree_merge" && evidence.executionCommit) {
        return await isContained(primaryRoot, evidence.executionCommit, ref);
    }
    // A finished child document read from the Epic branch head itself was published there.
    return child.path.startsWith(`${head}:`);
}

/**
 * Read where an Epic with a branch stands: each child's delivery and the branch
 * head. Returns null for an Epic without a branch or outside Git.
 */
export async function readEpicDeliveryState(
    projectRoot: string,
    epicPlanName: string,
): Promise<EpicDeliveryState | null> {
    if (!await isGitRepository(projectRoot)) return null;
    const primaryRoot = resolvePrimaryCheckoutRoot(projectRoot);
    const location = await resolveWorkflowPlanLocation(primaryRoot, epicPlanName);
    const epic = location.plan;
    if (!epic || epic.attrs.classification !== "PROJECT" || epic.attrs.type === "sequence") return null;
    const branch = epicBranchOf(epic.attrs);
    if (!branch) return null;
    const ref = await canonicalEpicRef(primaryRoot, branch);
    const head = await refCommit(primaryRoot, ref);
    if (!head) {
        return { epicPlanName, branch, ref, head: null, children: [], allSettled: false };
    }

    const family = new Map<string, { name: string; path: string; attrs: PlanFrontMatter }>();
    for (const child of await findTargetBranchPlansByParent(primaryRoot, branch, epicPlanName)) {
        family.set(child.name, child as { name: string; path: string; attrs: PlanFrontMatter });
    }
    // Drafts not yet on the branch are still part of the Epic and are not delivered.
    for (const child of await findPlansByParent(location.documentRoot, epicPlanName)) {
        if (!family.has(child.name)) family.set(child.name, child);
    }
    const included = [...family.values()].filter((child) => isPlannedChangeClassification(child.attrs.classification))
        .sort(compareChildPlansByOrder);
    const children = await Promise.all(included.map(async (child) => {
        const evidence = child.attrs.deliveryEvidence;
        const delivery = evidence?.mode === "worktree_merge" && evidence.executionCommit &&
                evidence.targetHeadBeforeMerge
            ? { from: evidence.targetHeadBeforeMerge, to: evidence.executionCommit }
            : undefined;
        return {
            name: child.name,
            status: child.attrs.status,
            settled: await isChildSettled(primaryRoot, ref, head, child),
            ...(delivery ? { delivery } : {}),
        };
    }));
    return {
        epicPlanName,
        branch,
        ref,
        head,
        children,
        allSettled: children.length > 0 && children.every((child) => child.settled),
    };
}

/**
 * Bring an Epic's status in line with its branch:
 *
 * - `ready_for_work` with every child settled becomes `implemented`.
 * - `reviewed` by the gate whose branch has moved since becomes `implemented`
 *   again: the old pass proves an older commit.
 *
 * Safe to call after any child delivery and on every load.
 */
export async function reconcileEpicDelivery(projectRoot: string, epicPlanName: string): Promise<EpicReconcileResult> {
    const state = await readEpicDeliveryState(projectRoot, epicPlanName);
    if (!state) return { state: null, gateReady: false };
    const primaryRoot = resolvePrimaryCheckoutRoot(projectRoot);
    const epic = (await resolveWorkflowPlanLocation(primaryRoot, epicPlanName)).plan;
    if (!epic) return { state, gateReady: false };
    let status = epic.attrs.status;

    if (status === "ready_for_work" && state.allSettled) {
        const attrs = await recordPlanEvent({
            cwd: primaryRoot,
            planName: epicPlanName,
            event: "epic_children_delivered",
            currentStatus: "ready_for_work",
            details: { triageMeta: epic.attrs },
        });
        status = attrs.status;
    } else if (
        (status === "reviewed" || status === "validated") && epic.attrs.epicCompletionMode !== "done_enough" &&
        typeof epic.attrs.validatedCommit === "string" && state.head
    ) {
        const unchanged = state.head === epic.attrs.validatedCommit ||
            (await isContained(primaryRoot, epic.attrs.validatedCommit, state.ref) &&
                (await runGitResult(primaryRoot, [
                    "diff",
                    "--quiet",
                    epic.attrs.validatedCommit,
                    state.head,
                    "--",
                    ".",
                    `:(exclude)docs/plans/${epicPlanName}.md`,
                ])).success);
        const target = epic.attrs.epicDeliveryTargetBranch;
        if (
            unchanged && target && target !== state.branch &&
            await isCommitPublishedToTarget({
                projectRoot: primaryRoot,
                targetBranch: target,
                commit: epic.attrs.validatedCommit,
            })
        ) {
            const attrs = await recordPlanEvent({
                cwd: primaryRoot,
                planName: epicPlanName,
                event: "epic_publication_confirmed",
                currentStatus: "reviewed",
                details: { triageMeta: epic.attrs },
            });
            return { state, status: attrs.status, gateReady: false };
        }
        if (unchanged) return { state, status, gateReady: false };
        const attrs = await recordPlanEvent({
            cwd: primaryRoot,
            planName: epicPlanName,
            event: "epic_integration_stale",
            currentStatus: status,
            details: { triageMeta: epic.attrs },
        });
        status = attrs.status;
    }
    return { state, status, gateReady: status === "implemented" && state.allSettled };
}

async function epicDeliveryTarget(primaryRoot: string, epicBranch: string): Promise<string | undefined> {
    const remote = await runGitResult(primaryRoot, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
    const named = remote.success ? remote.stdout.trim().replace(/^refs\/remotes\/origin\//, "") : "";
    for (const branch of [...new Set([named, "main", "master"].filter(Boolean))]) {
        if (
            branch !== epicBranch &&
            (await refCommit(primaryRoot, `refs/heads/${branch}`) ||
                await refCommit(primaryRoot, `refs/remotes/origin/${branch}`))
        ) return branch;
    }
    return undefined;
}

/** The commit the Epic diff starts from: the recorded branch base, or where the branch left the primary branch. */
async function resolveEpicDiffBase(primaryRoot: string, epic: PlanFrontMatter, head: string): Promise<string> {
    if (typeof epic.epicBaseCommit === "string" && await refCommit(primaryRoot, epic.epicBaseCommit)) {
        return epic.epicBaseCommit;
    }
    const remoteHead = await runGitResult(primaryRoot, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
    const candidates = [remoteHead.success ? remoteHead.stdout.trim() : "", "refs/heads/main", "refs/heads/master"];
    for (const candidate of candidates.filter(Boolean)) {
        if (!await refCommit(primaryRoot, candidate)) continue;
        const base = await runGitResult(primaryRoot, ["merge-base", head, candidate]);
        if (base.success && base.stdout.trim()) return base.stdout.trim();
    }
    throw new Error("Cannot find where the Epic branch started. Record epicBaseCommit on the Epic and retry.");
}

function tail(text: string): string {
    return text.length > CHECK_OUTPUT_TAIL ? `…\n${text.slice(-CHECK_OUTPUT_TAIL)}` : text;
}

/** Run the project's checks on the exact Epic commit. */
async function runGateChecks(
    options: RunEpicIntegrationGateOptions,
    checkoutPath: string,
): Promise<{ result: LocalCIResult; finding: GateFinding | null }> {
    const result = await options.localCIPort.run({
        hostedSession: options.hostedSession,
        cwd: checkoutPath,
    });
    if (result.kind === "completed" && result.exitCode === 0 && !result.timedOut) return { result, finding: null };
    if (result.kind !== "completed") return { result, finding: null };
    return {
        result,
        finding: {
            source: "checks",
            title: result.timedOut
                ? "Project checks timed out on the Epic branch"
                : "Project checks fail on the Epic branch",
            detail: `Exit code ${result.exitCode}.\n\n\`\`\`text\n${tail(result.output.trim())}\n\`\`\``,
        },
    };
}

function childListing(state: EpicDeliveryState): string {
    return state.children.map((child) => `- ${child.name} (${child.status})`).join("\n");
}

/** Which files each delivered child changed, so the reviewer can find the seams between children. */
async function filesByChild(primaryRoot: string, state: EpicDeliveryState): Promise<string> {
    const sections: string[] = [];
    for (const child of state.children) {
        if (!child.delivery) {
            sections.push(`- ${child.name} (${child.status}): files not recorded`);
            continue;
        }
        const changed = await runGitResult(primaryRoot, [
            "diff",
            "--name-only",
            child.delivery.from,
            child.delivery.to,
        ]);
        const files = changed.success ? changed.stdout.split("\n").filter(Boolean) : [];
        sections.push(`- ${child.name} (${child.status}): ${files.length ? files.join(", ") : "no file changes"}`);
    }
    return sections.join("\n");
}

function buildIntegrationReviewRequest(
    epicPlanName: string,
    epicMarkdown: string,
    state: EpicDeliveryState,
    checksSummary: string,
    childFiles: string,
): string {
    return [
        `You are reviewing the assembled Epic ${epicPlanName} on its branch ${state.branch} at ${state.head}.`,
        "",
        "### Project Checks",
        "",
        checksSummary,
        "",
        "### Delivered Children and Their Files",
        "",
        childFiles || childListing(state),
        "",
        "### Epic",
        "",
        "The Objective and Verification Plan are the requirements. The `### Integration Notes` section, when present, lists",
        "places to look that the reviewers of individual children left for you.",
        "",
        epicMarkdown,
    ].join("\n");
}

/** Run the integration review over the whole Epic diff. */
async function runIntegrationReview(
    port: ValidationSessionPort,
    checkoutPath: string,
    diffText: string,
    request: string,
): Promise<{ kind: "completed"; outcome: ValidationReviewOutcome } | { kind: "paused"; reason: string }> {
    const sessionManager = port.createInMemorySessionManager(checkoutPath);
    let prompt = request;
    for (let attempt = 1; attempt <= MAX_REVIEWER_ATTEMPTS; attempt++) {
        // No full-read gate: each child was read line by line in its own review, and
        // this reviewer reads selectively from the Epic outcomes and Integration Notes.
        const customTools = [
            createReviewDiffTool({ full: diffText }, { ledger: createLedger() }) as unknown as OpaqueToolDefinition,
        ];
        const session = await port.runIsolatedAgentSession({
            kind: "reviewer",
            agentName: AGENTS.REVIEWER,
            userRequest: prompt,
            cwd: checkoutPath,
            reviewerMode: "integration",
            customTools,
            sessionManager,
        });
        if (session.outcome === "operational_failure") {
            return { kind: "paused", reason: session.failure.message };
        }
        if (session.reviewOutcome) return { kind: "completed", outcome: session.reviewOutcome };
        prompt =
            "You have not called review_complete yet. Finish this review now by calling review_complete with your decision. Do not restart the review — use what you have already inspected.";
    }
    return { kind: "paused", reason: "The integration reviewer finished without reporting a decision." };
}

/** Offer or require Code Review of the whole Epic, per the `codereview` setting. */
async function runGateCodeReview(
    port: ValidationSessionPort,
    primaryRoot: string,
    epicPlanName: string,
    epicMarkdown: string,
    epicAttrs: PlanFrontMatter,
    diffText: string,
    checkoutPath: string,
    branch: string,
): Promise<
    | { kind: "approved" | "not_required" | "skipped"; mode: "none" | "ask" | "always" }
    | { kind: "changes_requested"; mode: "ask" | "always"; finding: GateFinding }
    | { kind: "paused"; reason: string }
> {
    const mode = getCodeReviewMode(primaryRoot);
    if (mode === "none") return { kind: "not_required", mode };
    if (mode === "ask") {
        const offer = await port.requestInteraction({
            type: ValidationInteractionTypes.SELECT,
            prompt:
                `The integration gate passed for ${epicPlanName}. Review the whole Epic before it is marked reviewed?`,
            options: [
                { value: "open", label: "Open code review" },
                { value: "skip", label: "Skip code review" },
            ],
        });
        if (offer.outcome !== "selected") {
            return { kind: "paused", reason: "Code Review of the Epic is still waiting for your decision." };
        }
        if (offer.value === "skip") return { kind: "skipped", mode };
    }
    const response = await port.requestInteraction({
        type: ValidationInteractionTypes.CODE_REVIEW,
        prompt: `Review the assembled Epic ${epicPlanName}.`,
        _meta: {
            planName: epicPlanName,
            planTitle: epicMarkdown.split(/\r?\n/).find((line) => /^#\s+\S/.test(line))?.replace(/^#\s+/, "") ||
                epicPlanName,
            planContent: epicMarkdown,
            planAttrs: epicAttrs,
            diffText,
            targetBranch: branch,
            executionCwd: checkoutPath,
        },
    });
    const review = normalizeHumanReview(response);
    if (review.approved) return { kind: "approved", mode };
    const annotations = formatCodeReviewAnnotations(review.annotations);
    const feedback = [review.feedback.trim(), annotations ? `Annotations:\n${annotations}` : ""].filter(Boolean)
        .join("\n\n");
    if (!feedback) {
        return {
            kind: "paused",
            reason: "The Epic code review closed without an approval or notes. Load the Epic to review it again.",
        };
    }
    return {
        kind: "changes_requested",
        mode,
        finding: { source: "code_review", title: "Code Review requested changes", detail: feedback },
    };
}

function renderFindings(findings: GateFinding[]): string {
    const labels: Record<GateFinding["source"], string> = {
        checks: "Project checks",
        integration_review: "Integration review",
        code_review: "Code Review",
    };
    return findings.map((finding, index) =>
        [`### ${index + 1}. ${finding.title}`, "", `Source: ${labels[finding.source]}`, "", finding.detail].join("\n")
    ).join("\n\n");
}

function renderReport(epicPlanName: string, state: EpicDeliveryState, base: string, findings: GateFinding[]): string {
    return [
        `# Integration Gate Report: ${epicPlanName}`,
        "",
        `RunWield checked the Epic branch \`${state.branch}\` at \`${state.head}\`, diffed from \`${base}\`.`,
        "",
        "## Delivered Children",
        "",
        childListing(state),
        "",
        "## Findings",
        "",
        renderFindings(findings),
        "",
    ].join("\n");
}

function reviewFindings(outcome: ValidationReviewOutcome): GateFinding[] {
    if (outcome.approved) return [];
    const findings = outcome.findings.filter((finding) => finding.status !== "fix_confirmed" && !finding.resolved);
    if (findings.length === 0) {
        return [{
            source: "integration_review",
            title: "Integration review requested changes",
            detail: outcome.feedback || "The reviewer did not approve the Epic.",
        }];
    }
    return findings.map((finding) => ({
        source: "integration_review",
        title: finding.title,
        detail: [`Requirement: ${finding.requirement}`, "", `Evidence: ${finding.evidence}`].join("\n"),
    }));
}

/** Add a draft repair child that carries the gate's findings to Planner. */
async function addRepairChild(
    documentRoot: string,
    epicPlanName: string,
    state: EpicDeliveryState,
    reportRelativePath: string,
    findings: GateFinding[],
): Promise<EpicContinuationResolution> {
    const siblings = await findPlansByParent(documentRoot, epicPlanName);
    const highestOrder = Math.max(
        0,
        ...state.children.map((child) => Number(child.name.split("/").at(-1)?.slice(0, 2)) || 0),
        ...siblings.map((child) => typeof child.attrs.order === "number" ? child.attrs.order : 0),
    );
    const repairs = siblings.filter((child) => child.name.includes("repair-integration-findings")).length;
    const title = repairs === 0 ? "Repair integration findings" : `Repair integration findings ${repairs + 1}`;
    const content = [
        `# ${title}`,
        "",
        "## Context",
        "",
        `The integration gate checked the Epic branch \`${state.branch}\` at \`${state.head}\` and found the problems below.`,
        `The full report is \`${reportRelativePath}\`. This draft was created by RunWield; plan the repair from these`,
        "findings and the Epic. After this child is delivered, the integration gate runs again on the whole Epic.",
        "",
        "## Objective",
        "",
        "Resolve every finding below on the Epic branch.",
        "",
        "## Findings",
        "",
        renderFindings(findings),
        "",
    ].join("\n");
    const [written] = await withPlanCatalogLock(
        documentRoot,
        async () =>
            await saveChildFeaturePlans(documentRoot, epicPlanName, [{
                title,
                summary: `Repair ${findings.length} integration finding(s) on ${state.branch}.`,
                affectedPaths: [],
                dependencies: [],
                content,
                order: highestOrder + 1,
                targetBranch: state.branch,
                workKind: "BUG_FIX",
            }]),
    );
    const child = await loadPlan(documentRoot, written.name);
    if (!child) throw new Error(`Repair child was not saved: ${written.name}`);
    return {
        kind: "plan",
        completedPlanName: epicPlanName,
        parentPlanName: epicPlanName,
        childPlanName: written.name,
        childStatus: child.attrs.status,
        childSummary: child.attrs.summary || title,
        childAttrs: child.attrs,
    };
}

/** A temporary detached checkout of the exact Epic commit, owned and removed by the gate. */
async function withGateCheckout<T>(primaryRoot: string, commit: string, run: (path: string) => Promise<T>): Promise<T> {
    const parent = await Deno.makeTempDir({ prefix: "wld-epic-gate-" });
    const path = join(parent, "checkout");
    await runGit(primaryRoot, ["worktree", "add", "--detach", path, commit]);
    try {
        return await run(path);
    } finally {
        await runGitResult(primaryRoot, ["worktree", "remove", "--force", path]);
        await runGitResult(primaryRoot, ["worktree", "prune"]);
        await Deno.remove(parent, { recursive: true }).catch(() => {});
    }
}

/**
 * Run the integration gate on the exact Epic branch head.
 *
 * The gate runs only for an `implemented` Epic whose children are all settled.
 * Checks and the integration review both run so one report carries everything;
 * Code Review is offered only when both pass.
 */
export async function runEpicIntegrationGate(
    options: RunEpicIntegrationGateOptions,
): Promise<EpicIntegrationGateResult> {
    const { hostedSession, epicPlanName } = options;
    const primaryRoot = resolvePrimaryCheckoutRoot(options.projectRoot);
    const reconciled = await reconcileEpicDelivery(primaryRoot, epicPlanName);
    const state = reconciled.state;
    if (!state || !reconciled.gateReady || !state.head) {
        return { kind: "not_ready", reason: "Not every child of the Epic is delivered to the Epic branch yet." };
    }
    const location = await resolveWorkflowPlanLocation(primaryRoot, epicPlanName);
    const epic = location.plan;
    if (!epic) return { kind: "not_ready", reason: `Epic not found: ${epicPlanName}` };
    const head = state.head;
    const base = await resolveEpicDiffBase(primaryRoot, epic.attrs, head);
    const port = createValidationSessionPort(hostedSession, { semanticReviewPort: options.semanticReviewPort });
    port.emitStatus(
        `Running the integration gate for ${epicPlanName} on ${state.branch} at ${head.slice(0, 12)}.`,
        "info",
    );

    const run = await withGateCheckout(primaryRoot, head, async (checkoutPath) => {
        const diffText = await runGit(primaryRoot, ["diff", "--no-color", "--no-ext-diff", base, head]);
        const checks = await runGateChecks(options, checkoutPath);
        if (checks.result.kind === "canceled") {
            return { kind: "paused" as const, reason: "The project checks were canceled." };
        }
        if (checks.result.kind === "operational_failure") {
            return { kind: "paused" as const, reason: checks.result.failure.message };
        }
        const checksSummary = checks.finding
            ? `The project checks FAILED on this commit.\n\n${checks.finding.detail}`
            : "The project checks passed on this commit.";
        const review = await runIntegrationReview(
            port,
            checkoutPath,
            diffText,
            buildIntegrationReviewRequest(
                epicPlanName,
                epic.markdown,
                state,
                checksSummary,
                await filesByChild(primaryRoot, state),
            ),
        );
        if (review.kind === "paused") return review;
        const findings = [...(checks.finding ? [checks.finding] : []), ...reviewFindings(review.outcome)];
        if (findings.length > 0) return { kind: "findings" as const, findings };
        const codeReview = await runGateCodeReview(
            port,
            primaryRoot,
            epicPlanName,
            epic.markdown,
            epic.attrs,
            diffText,
            checkoutPath,
            state.branch,
        );
        if (codeReview.kind === "paused") return codeReview;
        if (codeReview.kind === "changes_requested") {
            return { kind: "findings" as const, findings: [codeReview.finding], codeReview };
        }
        return { kind: "passed" as const, codeReview };
    });

    if (run.kind === "paused") {
        port.emitStatus(`The integration gate for ${epicPlanName} paused: ${run.reason}`, "warning");
        return run;
    }

    const current = (await resolveWorkflowPlanLocation(primaryRoot, epicPlanName)).plan;
    if (!current || current.attrs.status !== "implemented") {
        return { kind: "not_ready", reason: `The Epic changed while the integration gate ran.` };
    }
    const after = await refCommit(primaryRoot, state.ref);
    if (after !== head) {
        return { kind: "not_ready", reason: "The Epic branch moved while the integration gate ran; run it again." };
    }

    if (run.kind === "passed") {
        const reviewedAt = run.codeReview.kind === "approved" ? new Date().toISOString() : null;
        await recordPlanEvent({
            cwd: primaryRoot,
            planName: epicPlanName,
            event: "epic_integration_passed",
            currentStatus: "implemented",
            details: {
                triageMeta: current.attrs,
                integrationCommit: head,
                epicDeliveryTargetBranch: current.attrs.epicDeliveryTargetBranch ||
                    await epicDeliveryTarget(primaryRoot, state.branch),
                humanReviewMode: run.codeReview.mode,
                humanReviewDecision: run.codeReview.kind,
                humanReviewedAt: reviewedAt,
            },
        });
        port.emitStatus(
            `${epicPlanName} is reviewed: the integration gate passed on ${state.branch} at ${head.slice(0, 12)}. ` +
                `Merge the Epic branch or open a pull request when you are ready.`,
            "success",
        );
        port.emitStatus(
            "The Epic remains reviewed until its checked work reaches the final target branch. Its Work Record is generated after that delivery.",
            "info",
        );
        return { kind: "passed", commit: head };
    }

    const reportPath = getEpicArtifactPath(location.documentRoot, epicPlanName, EPIC_INTEGRATION_REPORT_FILE_NAME);
    const reportRelativePath = `docs/plans/${epicPlanName}/${EPIC_INTEGRATION_REPORT_FILE_NAME}`;
    await Deno.mkdir(join(location.documentRoot, "docs", "plans", epicPlanName), { recursive: true });
    await Deno.writeTextFile(reportPath, renderReport(epicPlanName, state, base, run.findings));
    await recordPlanEvent({
        cwd: primaryRoot,
        planName: epicPlanName,
        event: "epic_integration_failed",
        currentStatus: "implemented",
        details: {
            triageMeta: current.attrs,
            failureReason: `The integration gate found ${run.findings.length} problem(s) on ${state.branch}.`,
            integrationReport: reportRelativePath,
        },
    });
    const repairChild = await addRepairChild(
        location.documentRoot,
        epicPlanName,
        state,
        reportRelativePath,
        run.findings,
    );
    await ensureEpicBranch(primaryRoot, epicPlanName);
    port.emitStatus(
        `The integration gate found ${run.findings.length} problem(s) in ${epicPlanName}. ` +
            `RunWield added the repair child ${repairChild.childPlanName}; Planner starts from the findings.`,
        "warning",
    );
    return { kind: "findings", commit: head, reportPath: reportRelativePath, repairChild };
}
