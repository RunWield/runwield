import { isEpicPlan, projectPlanType } from "../../shared/project-plan.ts";
/**
 * @module cmd/load-plan
 * Load-plan command implementation. Loads a saved Plan from disk and continues
 * work on it (review/edit/execute), distinct from /resume which restores a
 * previous chat session.
 */

import { parseArgs } from "@std/cli/parse-args";
import { AGENTS, CLI_BIN, getCwd } from "../../constants.js";
import {
    archivePlan,
    canonicalPlanStatus,
    ensurePlanIdentity,
    isRecoverableWorktreeStatus,
    listPlanDocuments,
    loadPlan,
    onboardExternalPlan,
    resolvePlan,
    resolveSiblingChildPlanDependencies,
} from "../../plan-store.js";
import { formatArchiveRetentionNudge } from "../../shared/plan-archive-retention.ts";
import { decidePostPlanning } from "../../shared/workflow/decisions.ts";
import { buildPlannerReReviewRequest, buildResumeRequest } from "./plan-presentation.ts";
import { buildPlanSummary } from "../../shared/plan-presentation.ts";
import { handlePlanRecovery, SYSTEM_RECOVERY_FLOW_PORTS } from "./plan-recovery-flow.ts";
import {
    buildManagedUnsupportedLoadPlanMessage,
    createPlanSessionSurface,
    isManagedUnsupportedError,
    restorePreviousAgentFlow,
    selectPlanFlowRestoreAgent,
} from "./plan-session-surface.ts";
import { handleEpicPlan } from "./plan-epic-flow.ts";
import {
    executePostPlanningDecision,
    executeReadyPlanWithRepair,
    prepareApprovedPlanForWork,
    shouldKeepPlanningAgentActive,
} from "./plan-execution.ts";
import { getDirectPlanReviewEligibility, reviewLoadedPlanDirectly } from "./plan-review-flow.ts";
import {
    handleOnHoldPlan,
    isHoldableStatus,
    isUserVerifiableStatus,
    markPlanUserVerified,
    putPlanOnHold,
} from "./plan-hold.ts";
import { completeUserVerification } from "./user-verification-completion.ts";
import { resolvePrimaryCheckoutRoot } from "../../shared/primary-checkout.ts";
import { confirmChildFeatureDependencies, formatTopLevelPlanOption } from "./plan-epic-children.ts";
import { reopenPlanForReview, resolveRecoveryWorktree } from "./plan-recovery-worktree.ts";
import { healSettledTransitionRecords } from "../../shared/workflow/transition-recovery.ts";
import { isExecutablePlanStatus, isInValidation } from "../../shared/workflow/plan-lifecycle.js";
import { getPlanContentStatus } from "../../shared/workflow/validation-engine.ts";
import { loadPlanActionEvidence } from "../../shared/workflow/plan-actions.ts";
import { printCommandHelp } from "../help/index.js";
import { startInteractiveSession } from "../../ui/tui/chat-session.ts";
import { SYSTEM_BROWSER_PORT } from "../../shared/browser-port.ts";
import { resolvePlanWithPrimaryRecovery, resumePlanPublicationCleanup } from "./primary-plan-recovery.ts";
import { resolveWorkflowPlanLocation } from "../../shared/workflow/plan-location.ts";
import type { CommandContext } from "../registry.js";
import type { UiAPI } from "../../ui/tui/types.js";
import {
    buildPlanRecoveryUserMessage,
    buildValidationRecoveryNotice,
} from "../../shared/workflow/validation-user-messages.ts";
import { isGitRepository } from "../../shared/git.ts";
import { openFileSessionStore } from "../../shared/session/file-session-store.ts";
import { findPlanAssociatedSessions, verifyPlanAssociatedSession } from "../../shared/session/plan-session-lookup.ts";
import { preparePlanningWorktreeForPlan } from "../../shared/workflow/planning-worktree.ts";
import { ensureEpicBranch } from "../../shared/workflow/epic-branch.ts";
import { isPublicationCleanupPending } from "../../shared/workflow/publication-attempt.ts";

export { getLoadPlanCompletions } from "./getArgumentCompletions.ts";

type TransitionRecoveryRecord = Awaited<ReturnType<typeof healSettledTransitionRecords>>["remaining"][number];

async function finishSavedPublicationCleanup(projectRoot: string, uiAPI: UiAPI, planArg: string): Promise<boolean> {
    const notices = await resumePlanPublicationCleanup(projectRoot, planArg);
    for (const notice of notices) {
        uiAPI.appendSystemMessage(
            buildPlanRecoveryUserMessage({ kind: "publication_cleanup_resumed", ...notice }),
            !notice.complete,
            "RunWield",
        );
    }
    return notices.every((notice) => notice.complete);
}

/**
 * Handle `load-plan` command.
 *
 * @param {string[]} argv
 * @param {import('../registry.js').CommandContext} [options]
 */
export async function runLoadPlanCommand(argv: string[], options: CommandContext = {}): Promise<void> {
    let sessionRuntime = options.sessionRuntime;
    let runtimeSessionId = options.sessionId;

    const parsedArgs = parseArgs(argv, {
        boolean: ["help"],
        alias: { h: "help" },
        stopEarly: true,
    });

    if (parsedArgs.help) {
        printCommandHelp("load-plan");
        return;
    }

    let [planArg] = parsedArgs._.map(String);
    if (!planArg) {
        if (options.uiAPI) {
            const clearEditor = () => {
                if (!options.editor) return;
                options.editor.setText("");
                options.editor.disableSubmit = false;
            };
            if (!sessionRuntime || !runtimeSessionId) {
                throw new Error("runLoadPlanCommand requires an active runtime session for plan selection");
            }
            const activeSnapshot = sessionRuntime.getSessionSnapshot(runtimeSessionId);
            if (!activeSnapshot) throw new Error("runLoadPlanCommand runtime session is missing");
            const plans = await listPlanDocuments(activeSnapshot.cwd);
            if (plans.length === 0) {
                options.uiAPI.appendSystemMessage(
                    "No plans available, start one by entering a new request",
                );
                clearEditor();
                return;
            }

            const topLevelPlans = plans.filter((plan) => !plan.attrs.parentPlan);
            if (topLevelPlans.length === 0) {
                options.uiAPI.appendSystemMessage(
                    "No top-level plans available. Load the parent Epic directly or create a plan.",
                );
                clearEditor();
                return;
            }

            const planOptions = topLevelPlans.map(formatTopLevelPlanOption);

            const chosen = await options.uiAPI.promptSelect("Load plan:", planOptions, {
                layout: { maxPrimaryColumnWidth: 96 },
            });
            if (!chosen) {
                clearEditor();
                return;
            }

            planArg = chosen;
        } else {
            console.error(`Usage: ${CLI_BIN} load-plan <plan-name-or-path>`);
            Deno.exit(1);
        }
    }

    let uiAPI = options.uiAPI;
    let cliResumeSessionId = "";

    if (!uiAPI) {
        const startupProjectRoot = getCwd();
        const startupResolved = await resolvePlanWithPrimaryRecovery(startupProjectRoot, planArg);
        let startupPlan = startupResolved.plan;
        if (!startupPlan.attrs.planId) {
            const location = await resolveWorkflowPlanLocation(startupProjectRoot, startupPlan.planName, {
                migrateRegistry: false,
            });
            const identified = await ensurePlanIdentity(location.documentRoot, startupPlan.planName);
            startupPlan = { ...startupPlan, attrs: identified.attrs };
        }
        const startupPlanId = typeof startupPlan.attrs.planId === "string" ? startupPlan.attrs.planId : "";
        if (startupPlanId) {
            const lookupStore = openFileSessionStore();
            try {
                const associations = await findPlanAssociatedSessions(lookupStore, {
                    cwd: startupProjectRoot,
                    planId: startupPlanId,
                });
                const safeAssociations = associations.filter((candidate) => candidate.safePlanningResume);
                if (safeAssociations.length === 1) {
                    const verified = await verifyPlanAssociatedSession(lookupStore, safeAssociations[0]);
                    if (verified.ok) cliResumeSessionId = safeAssociations[0].runwieldSessionId;
                }
            } finally {
                lookupStore.close();
            }
        }
        uiAPI = await startInteractiveSession(
            null,
            {
                browser: SYSTEM_BROWSER_PORT,
                ...(cliResumeSessionId
                    ? { sessionStartMode: "continue" as const, resumeSessionId: cliResumeSessionId }
                    : {}),
                onSessionReady: (nextSessionId, nextRuntime) => {
                    runtimeSessionId = nextSessionId;
                    sessionRuntime = nextRuntime;
                },
            },
        );
    }

    if (!uiAPI) return;
    if (!sessionRuntime || !runtimeSessionId) throw new Error("runLoadPlanCommand requires a runtime session");
    const runtime = sessionRuntime;
    let activeSessionId = runtimeSessionId;
    let projectRoot = "";
    const makeSessionSurface = () =>
        createPlanSessionSurface(runtime, activeSessionId, {
            executePlan: async (options) => {
                const planId = typeof options.triageMeta?.planId === "string" ? options.triageMeta.planId : "";
                const evidence = planId ? await loadPlanActionEvidence(projectRoot, planId) : null;
                if (evidence?.kind !== "success") {
                    console.error(
                        "[RunWield] plan_execution_evidence_unavailable",
                        evidence?.kind || "missing_plan_id",
                    );
                }
                return await runtime.executePlan(activeSessionId, {
                    ...options,
                    ...(evidence?.kind === "success" ? { approvalEvidence: evidence.evidence } : {}),
                });
            },
            runPlanningAgent: (options) => runtime.runPlanningAgent(activeSessionId, options),
            runValidation: (options) => runtime.runValidation(activeSessionId, options),
            runSlicerAgent: (options) => runtime.runSlicerAgent(activeSessionId, options),
        });
    let session = makeSessionSurface();
    projectRoot = session.cwd;
    let executePlan = session.executePlan;
    let runPlanningAgent = session.runPlanningAgent;
    let continueWorkflowValidation = session.runValidation;
    let runSlicerAgent = session.runSlicerAgent;
    let switchPlanAgent = session.switchAgent;
    const refreshSessionSurface = () => {
        session = makeSessionSurface();
        projectRoot = session.cwd;
        executePlan = session.executePlan;
        runPlanningAgent = session.runPlanningAgent;
        continueWorkflowValidation = session.runValidation;
        runSlicerAgent = session.runSlicerAgent;
        switchPlanAgent = session.switchAgent;
    };

    let skipRouterRestore = false;
    const initialAgentName = session.getEffectiveAgentName() || AGENTS.ROUTER;
    let restoreAgentName = initialAgentName;

    let loadedPlanName = null;
    let unresolvedLifecycleRecords: TransitionRecoveryRecord[] = [];

    try {
        const resolved = await resolvePlanWithPrimaryRecovery(projectRoot, planArg);
        const plan = resolved.plan;
        if (resolved.recoveredWorktree?.recovered) {
            uiAPI.appendSystemMessage(
                buildValidationRecoveryNotice({
                    kind: "worktree_restored",
                    planName: plan.planName,
                    branch: resolved.recoveredWorktree.branch || plan.attrs.worktreeBranch || "recovered source",
                }),
                false,
                "RunWield",
            );
        }
        if (resolved.recoveredStatus) {
            uiAPI.appendSystemMessage(
                buildValidationRecoveryNotice({
                    kind: "plan_status_restored",
                    planName: plan.planName,
                    from: resolved.recoveredStatus.from,
                    to: resolved.recoveredStatus.to,
                }),
                false,
                "RunWield",
            );
        }
        loadedPlanName = plan.planName;
        const rawStatus = getPlanContentStatus(plan.markdown);
        if (rawStatus !== undefined && !canonicalPlanStatus(rawStatus)) {
            uiAPI.appendSystemMessage(
                `Plan has unknown status: ${rawStatus}. RunWield cannot safely continue until the Plan status is corrected.`,
                true,
                "RunWield",
            );
            return;
        }
        // Clear our own leftovers before doing anything with the Plan. An interrupted
        // lifecycle operation blocks every later one, and the record is RunWield's
        // bookkeeping, not the user's problem — so anything the repository proves is
        // finished gets closed here and the load simply continues. Only what genuinely
        // needs a decision is surfaced, and then with the command that resolves it.
        try {
            const healed = await healSettledTransitionRecords(projectRoot, { planName: plan.planName });
            unresolvedLifecycleRecords = healed.remaining;
            if (healed.closed.length > 0) {
                uiAPI.appendSystemMessage(
                    `Cleared ${healed.closed.length} unfinished lifecycle record${
                        healed.closed.length === 1 ? "" : "s"
                    } for ${plan.planName} that the repository proves are already settled. Continuing.`,
                    false,
                    "RunWield",
                );
            }
            for (const remaining of healed.remaining) {
                uiAPI.appendSystemMessage(
                    `${plan.planName} has an unfinished ${
                        remaining.operation || "lifecycle operation"
                    } that RunWield cannot confirm on its own: ${remaining.reason}. ` +
                        `Lifecycle changes to this Plan stay blocked until it is resolved. ` +
                        `Plan Recovery opens below with "Close the unfinished lifecycle record" as the first option; ` +
                        `run \`${CLI_BIN} plans doctor\` first if you want to see the exact evidence that is missing.`,
                    true,
                    "RunWield",
                );
            }
        } catch (healError) {
            // Never let bookkeeping cleanup stop a Plan from loading.
            uiAPI.appendSystemMessage(
                `Could not check for unfinished lifecycle records: ${
                    healError instanceof Error ? healError.message : String(healError)
                }`,
                true,
                "RunWield",
            );
        }
        const recordedAttempt = await resolveRecoveryWorktree(projectRoot, plan, { migrateRegistry: false });
        let cleanupPending = isPublicationCleanupPending(recordedAttempt?.publication);
        if (recordedAttempt?.path && !cleanupPending) {
            const executionPlan = await loadPlan(recordedAttempt.path, plan.planName).catch(() => null);
            if (executionPlan) {
                plan.path = executionPlan.path;
                plan.attrs = executionPlan.attrs;
                plan.markdown = executionPlan.markdown;
                plan.body = executionPlan.body;
                plan.revision = executionPlan.revision;
                plan.hasFrontMatter = true;
            }
        }
        // Loading is the deliberate action that adopts a plain markdown file the user
        // wrote into docs/plans/. Reads elsewhere tolerate the missing Front Matter and
        // leave the file alone; here it stops being an anonymous file and becomes a
        // Plan with a durable identity, so the rest of this flow has something to
        // record lifecycle state on.
        if (plan.hasFrontMatter === false) {
            const location = await resolveWorkflowPlanLocation(projectRoot, plan.planName, { migrateRegistry: false });
            const adopted = await onboardExternalPlan(location.documentRoot, plan.planName);
            if (adopted.onboarded) {
                plan.attrs = adopted.resource.attrs;
                plan.markdown = adopted.resource.markdown;
                plan.body = adopted.resource.body;
                plan.revision = adopted.resource.revision;
                uiAPI.appendSystemMessage(
                    `Adopted ${plan.planName} as a RunWield Plan: added front matter (status draft, external origin) ` +
                        "and left your text untouched.",
                    false,
                    "RunWield",
                );
            }
        }
        if (!plan.attrs.planId) {
            const location = await resolveWorkflowPlanLocation(projectRoot, plan.planName, { migrateRegistry: false });
            const identified = await ensurePlanIdentity(location.documentRoot, plan.planName);
            plan.attrs = identified.attrs;
            plan.markdown = identified.markdown;
            plan.body = identified.body;
            plan.revision = identified.revision;
        }
        let planDocumentRoot = projectRoot;
        const planId = typeof plan.attrs.planId === "string" ? plan.attrs.planId : "";
        if (
            plan.attrs.parentPlan && planId && typeof plan.attrs.targetBranch === "string" &&
            ["draft", "feedback", "approved", "ready_for_work"].includes(plan.attrs.status) &&
            plan.attrs.worktreeStatus !== "active" && await isGitRepository(projectRoot)
        ) {
            await ensureEpicBranch(projectRoot, String(plan.attrs.parentPlan));
            const planning = await preparePlanningWorktreeForPlan(projectRoot, plan.planName, plan.attrs);
            await switchPlanAgent(session.getEffectiveAgentName() || AGENTS.ROUTER, {
                cwd: planning.entry.path,
                forceRebuild: true,
            });
            refreshSessionSurface();
            planDocumentRoot = planning.entry.path;
            plan.path = planning.plan.path;
            plan.attrs = planning.plan.attrs;
            plan.markdown = planning.plan.markdown;
            plan.body = planning.plan.body;
            plan.revision = planning.plan.revision;
            plan.hasFrontMatter = true;
        }
        const associations = planId ? await runtime.listPlanAssociatedSessions(projectRoot, planId) : [];
        const safeAssociations = associations.filter((candidate) =>
            candidate.safePlanningResume && candidate.displayName?.trim()
        );
        const activeElsewhere = associations.find((candidate) => candidate.reason === "active_elsewhere");
        let candidateToAdopt: (typeof safeAssociations)[number] | null = null;
        const activeSnapshot = runtime.getSessionSnapshot(activeSessionId);
        if (safeAssociations.length === 1 && activeSnapshot?.managed === null) {
            candidateToAdopt = safeAssociations[0];
        } else if (
            safeAssociations.length === 1 &&
            activeSnapshot?.managed?.runwieldSessionId !== safeAssociations[0].runwieldSessionId
        ) {
            const answer = await uiAPI.promptSelect(`Continue ${plan.planName} in its planning Session?`, [
                { value: "switch", label: `Continue in "${safeAssociations[0].displayName || plan.planName}"` },
                { value: "stay", label: "Stay here" },
            ]);
            if (answer === "switch") candidateToAdopt = safeAssociations[0];
        } else if (safeAssociations.length > 1) {
            const answer = await uiAPI.promptSelect(
                `Choose a planning Session for ${plan.planName}:`,
                safeAssociations.map((candidate) => ({
                    value: candidate.runwieldSessionId,
                    label: candidate.displayName || "",
                })),
            );
            candidateToAdopt = safeAssociations.find((candidate) => candidate.runwieldSessionId === answer) || null;
        } else if (activeElsewhere) {
            uiAPI.appendSystemMessage(
                `The associated planning Session is active in another ${
                    activeElsewhere.activeSurface || "RunWield"
                } surface. Staying in this Session.`,
                true,
                "RunWield",
            );
        }
        if (candidateToAdopt) {
            const verified = await runtime.verifyPlanAssociatedSession(candidateToAdopt);
            if (!verified.ok) {
                uiAPI.appendSystemMessage(
                    `The associated planning Session is damaged. Staying in this Session.`,
                    true,
                    "RunWield",
                );
            } else {
                const loaded = await runtime.loadSession({
                    cwd: projectRoot,
                    sessionId: candidateToAdopt.piSessionId,
                    sessionPath: candidateToAdopt.transcriptPath,
                });
                activeSessionId = loaded.sessionId;
                runtimeSessionId = loaded.sessionId;
                options.replaceRuntimeSession?.(loaded.sessionId);
                uiAPI.clearMessages?.();
                await runtime.replaySession(loaded.sessionId);
                refreshSessionSurface();
            }
        }
        uiAPI.appendSystemMessage(`Plan loaded: ${plan.planName}`, false, "RunWield");
        uiAPI.appendSystemMessage(
            `Classification: ${plan.attrs.classification}, Status: ${plan.attrs.status}`,
            false,
            "RunWield",
        );

        // The Session keeps its current name until the user actually chooses to
        // continue work on this Plan. Selecting, viewing, or canceling must not
        // hydrate and rename a persisted Session; continuation actions call
        // `session.activateForPlan` right before their workflow work begins.

        const triageMeta = plan.attrs;
        projectPlanType(triageMeta);
        const agentName = isEpicPlan(triageMeta) ? AGENTS.ARCHITECT : AGENTS.PLANNER;
        const planFlowRestoreAgent = selectPlanFlowRestoreAgent(initialAgentName, agentName);
        /** @param {string} targetPlanName */
        const loadAnotherPlan = async (targetPlanName: string) => {
            skipRouterRestore = true;
            await runLoadPlanCommand([targetPlanName], {
                ...options,
            });
        };

        if (plan.attrs.parentPlan) {
            try {
                const parentPlan = await resolvePlan(projectRoot, plan.attrs.parentPlan);
                if (parentPlan.attrs.status === "on_hold") {
                    uiAPI.appendSystemMessage(
                        `Parent Epic "${parentPlan.planName}" is on hold. Resume the parent before working on child Planned Change "${plan.planName}".`,
                        true,
                        "RunWield",
                    );
                    while (true) {
                        const answer = await uiAPI.promptSelect("Parent Epic is on hold. What would you like to do?", [
                            { value: "resume_parent", label: "Resume from hold" },
                            { value: "view", label: "View plan details" },
                            { value: "cancel", label: "Cancel / Keep on hold" },
                        ]);
                        if (!answer || answer === "cancel") return;
                        if (answer === "view") {
                            uiAPI.appendSystemMessage(buildPlanSummary(parentPlan), false, "Plan");
                            continue;
                        }
                        if (answer === "resume_parent") {
                            await loadAnotherPlan(parentPlan.planName);
                            return;
                        }
                    }
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                uiAPI.appendSystemMessage(`Could not inspect parent Epic hold status: ${message}`, true, "RunWield");
            }
        }

        if (plan.attrs.status === "on_hold") {
            const result = await handleOnHoldPlan({
                projectRoot,
                plan,
                uiAPI,
                session,
            });
            if (result === "handled") return;
        }

        const epicResult = await handleEpicPlan({
            projectRoot,
            plan,
            uiAPI,
            runSlicerAgent,
            loadChildPlan: loadAnotherPlan,
            session,
        });
        if (epicResult === "direct_review") {
            restoreAgentName = planFlowRestoreAgent;
            await session.activateForPlan(plan.planName);
            const reviewResult = await reviewLoadedPlanDirectly({
                projectRoot,
                plan,
                agentName,
                uiAPI,
                executePlan,
                continueWorkflowValidation,
                runPlanningAgent,
                runSlicerAgent,
                session,
            });
            if (reviewResult.keepPlanAgentActive) {
                skipRouterRestore = true;
            }
            return;
        }
        if (epicResult === "handled") {
            skipRouterRestore = true;
            return;
        }
        const forceReview = epicResult === "review";

        // An unprovable record blocks every lifecycle change, so it has to be reachable
        // from Plan Recovery whatever the Plan's status is. Otherwise a draft or
        // verified Plan is told it is blocked and offered nothing.
        if (
            (!cleanupPending && !["verified", "user_verified"].includes(plan.attrs.status) &&
                (["in_progress", "failed"].includes(plan.attrs.status) ||
                    isInValidation(plan.attrs.status) ||
                    isRecoverableWorktreeStatus(plan.attrs.worktreeStatus) ||
                    Boolean(recordedAttempt?.publication))) ||
            unresolvedLifecycleRecords.length > 0
        ) {
            restoreAgentName = planFlowRestoreAgent;
            const result = await handlePlanRecovery({
                projectRoot,
                plan,
                agentName,
                uiAPI,
                unresolvedRecords: unresolvedLifecycleRecords,
                session,
                recordedAttempt,
                ports: SYSTEM_RECOVERY_FLOW_PORTS,
            });
            if (result === "verified") {
                skipRouterRestore = true;
                return;
            }
            if (result === "handled") return;
        }

        const dependenciesConfirmed = await confirmChildFeatureDependencies(
            projectRoot,
            plan,
            uiAPI,
            resolveSiblingChildPlanDependencies,
        );
        if (!dependenciesConfirmed) return;

        const directReviewEligibility = getDirectPlanReviewEligibility(plan);

        if (
            plan.attrs.status === "validated" || plan.attrs.status === "verified" ||
            plan.attrs.status === "user_verified" || cleanupPending
        ) {
            uiAPI.appendSystemMessage(
                cleanupPending || plan.attrs.status === "validated" || plan.attrs.status === "verified"
                    ? "This plan is already verified."
                    : "This plan is User Verified by user attestation.",
                false,
                "RunWield",
            );
            while (true) {
                const answer = await uiAPI.promptSelect("What would you like to do?", [
                    ...(cleanupPending
                        ? [
                            { value: "view", label: "View plan details" },
                            { value: "cleanup", label: "Remove published worktree and branch" },
                        ]
                        : [
                            { value: "archive", label: "Archive plan" },
                            { value: "review", label: "Re-open for review (planner/architect)" },
                            { value: "view", label: "View plan details" },
                        ]),
                    { value: "cancel", label: "Cancel" },
                ]);
                if (!answer || answer === "cancel") {
                    return;
                }
                if (answer === "cleanup") {
                    if (await finishSavedPublicationCleanup(projectRoot, uiAPI, plan.planName)) cleanupPending = false;
                    continue;
                }
                if (answer === "view") {
                    uiAPI.appendSystemMessage(buildPlanSummary(plan), false, "Plan");
                    continue;
                }
                if (answer === "archive") {
                    if (plan.attrs.status === "user_verified") {
                        const primaryRoot = resolvePrimaryCheckoutRoot(projectRoot);
                        if (!await completeUserVerification({ projectRoot, plan, uiAPI, session })) continue;
                        projectRoot = primaryRoot;
                    }
                    const archived = await archivePlan(projectRoot, plan.planName, {
                        abandonedWorktree: plan.attrs.worktreeStatus === "abandoned",
                    });
                    uiAPI.appendSystemMessage(
                        `Archived ${plan.planName} to ${archived.relativePath}`,
                        false,
                        "RunWield",
                    );
                    const nudge = await formatArchiveRetentionNudge(projectRoot);
                    if (nudge) uiAPI.appendSystemMessage(nudge, false, "RunWield");
                    return;
                }
                await session.activateForPlan(plan.planName);
                await reopenPlanForReview({
                    projectRoot,
                    plan,
                    currentStatus: plan.attrs.status,
                    session,
                });
                break;
            }
        }

        if (plan.attrs.status === "approved" || isExecutablePlanStatus(plan.attrs.status)) {
            let reviewForced = forceReview;
            while (true) {
                const answer = reviewForced ? "review" : await uiAPI.promptSelect("What would you like to do?", [
                    { value: "proceed", label: "Proceed with execution" },
                    ...(plan.attrs.status === "ready_for_work"
                        ? [{ value: "planner_re_review", label: "Send back to Planner for re-review" }]
                        : []),
                    ...(directReviewEligibility.eligible
                        ? [{
                            value: "review",
                            label: plan.attrs.status === "ready_for_work"
                                ? "Review plan"
                                : "Re-open for review (edit/annotate)",
                        }]
                        : []),
                    {
                        value: "user_verify",
                        label: "Mark as User Verified (user attestation; no Workflow Validation claim)",
                    },
                    { value: "hold", label: "Put on hold" },
                    { value: "view", label: "View plan details" },
                    { value: "cancel", label: "Cancel" },
                ]);
                reviewForced = false;

                if (!answer || answer === "cancel") return;

                if (answer === "hold") {
                    await putPlanOnHold({ projectRoot, plan, uiAPI });
                    return;
                }

                if (answer === "user_verify") {
                    await markPlanUserVerified({
                        projectRoot,
                        plan,
                        uiAPI,
                        session,
                    });
                    return;
                }

                if (answer === "proceed") {
                    restoreAgentName = planFlowRestoreAgent;
                    if (plan.attrs.status === "approved") {
                        const ready = await prepareApprovedPlanForWork(
                            projectRoot,
                            plan,
                            uiAPI,
                        );
                        if (!ready) {
                            skipRouterRestore = true;
                            return;
                        }
                    }

                    const executionResult = await executeReadyPlanWithRepair({
                        projectRoot,
                        plan,
                        agentName,
                        uiAPI,
                        executePlan,
                        continueWorkflowValidation,
                        session,
                    });
                    if (executionResult && typeof executionResult === "object" && executionResult.kind === "verified") {
                        skipRouterRestore = true;
                    }
                    return;
                }

                if (answer === "planner_re_review") {
                    restoreAgentName = planFlowRestoreAgent;
                    const preReviewStatus = plan.attrs.status;

                    await session.activateForPlan(plan.planName);
                    await reopenPlanForReview({
                        projectRoot,
                        plan,
                        currentStatus: preReviewStatus,
                        session,
                    });
                    await switchPlanAgent(agentName, { cwd: planDocumentRoot, forceRebuild: true });

                    const outcome = await runPlanningAgent({
                        agentName,
                        initialRequest: buildPlannerReReviewRequest(plan.planName),
                        triageMeta: plan.attrs,
                        planName: plan.planName,
                        cwd: planDocumentRoot,
                    });

                    const planningDecision = decidePostPlanning(outcome, {
                        planningAgentName: agentName,
                        fallbackTriageMeta: plan.attrs,
                    });
                    const postPlanningResult = await executePostPlanningDecision({
                        decision: planningDecision,
                        fallbackPlanContent: plan.markdown || plan.body || "",
                        uiAPI,
                        executePlan,
                        continueWorkflowValidation,
                        runSlicerAgent,
                        session,
                    });
                    if (postPlanningResult === "verified" || shouldKeepPlanningAgentActive(planningDecision)) {
                        skipRouterRestore = true;
                    }
                    return;
                }

                if (answer === "review") {
                    restoreAgentName = planFlowRestoreAgent;
                    await session.activateForPlan(plan.planName);
                    const reviewResult = await reviewLoadedPlanDirectly({
                        projectRoot,
                        plan,
                        agentName,
                        uiAPI,
                        executePlan,
                        continueWorkflowValidation,
                        runPlanningAgent,
                        runSlicerAgent,
                        session,
                    });
                    if (reviewResult.keepPlanAgentActive) {
                        skipRouterRestore = true;
                    }
                    return;
                }

                if (answer === "view") {
                    uiAPI.appendSystemMessage(buildPlanSummary(plan), false, "Plan");
                }
            }
        }

        // Not approved — show a first-action menu before kicking off the planning agent.
        if (!forceReview) {
            while (true) {
                const answer = await uiAPI.promptSelect("What would you like to do?", [
                    { value: "resume", label: "Resume planning" },
                    ...(directReviewEligibility.eligible ? [{ value: "review", label: "Review plan" }] : []),
                    ...(isUserVerifiableStatus(plan.attrs.status)
                        ? [{
                            value: "user_verify",
                            label: "Mark as User Verified (user attestation; no Workflow Validation claim)",
                        }]
                        : []),
                    ...(isHoldableStatus(plan.attrs.status) ? [{ value: "hold", label: "Put on hold" }] : []),
                    { value: "view", label: "View plan details" },
                    { value: "cancel", label: "Cancel" },
                ]);
                if (!answer || answer === "cancel") return;
                if (answer === "view") {
                    uiAPI.appendSystemMessage(buildPlanSummary(plan), false, "Plan");
                    continue;
                }
                if (answer === "hold") {
                    await putPlanOnHold({ projectRoot, plan, uiAPI });
                    return;
                }
                if (answer === "user_verify") {
                    await markPlanUserVerified({
                        projectRoot,
                        plan,
                        uiAPI,
                        session,
                    });
                    return;
                }
                if (answer === "review") {
                    restoreAgentName = planFlowRestoreAgent;
                    await session.activateForPlan(plan.planName);
                    const reviewResult = await reviewLoadedPlanDirectly({
                        projectRoot,
                        plan,
                        agentName,
                        uiAPI,
                        executePlan,
                        continueWorkflowValidation,
                        runPlanningAgent,
                        runSlicerAgent,
                        session,
                    });
                    if (reviewResult.keepPlanAgentActive) {
                        skipRouterRestore = true;
                    }
                    return;
                }
                if (answer === "resume") break;
            }
        }

        uiAPI.appendSystemMessage(buildPlanSummary(plan), false, "Plan");
        restoreAgentName = planFlowRestoreAgent;
        await session.activateForPlan(plan.planName);
        await switchPlanAgent(agentName, { cwd: planDocumentRoot, forceRebuild: true });

        const outcome = await runPlanningAgent({
            agentName,
            initialRequest: buildResumeRequest(plan.planName, plan.attrs),
            triageMeta: plan.attrs,
            planName: plan.planName,
            cwd: planDocumentRoot,
        });

        const planningDecision = decidePostPlanning(outcome, {
            planningAgentName: agentName,
            fallbackTriageMeta: plan.attrs,
        });
        const postPlanningResult = await executePostPlanningDecision({
            decision: planningDecision,
            fallbackPlanContent: plan.markdown || plan.body || "",
            uiAPI,
            executePlan,
            continueWorkflowValidation,
            runSlicerAgent,
            session,
        });
        if (postPlanningResult === "verified" || shouldKeepPlanningAgentActive(planningDecision)) {
            skipRouterRestore = true;
        }
    } catch (error) {
        if (!isManagedUnsupportedError(error)) throw error;
        uiAPI.appendSystemMessage(buildManagedUnsupportedLoadPlanMessage(loadedPlanName), true, "RunWield");
    } finally {
        if (!skipRouterRestore && sessionRuntime.getSessionSnapshot(session.id)) {
            await restorePreviousAgentFlow(uiAPI, restoreAgentName, session);
        }
    }
}
