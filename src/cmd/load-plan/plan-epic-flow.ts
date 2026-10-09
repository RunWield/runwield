import { isSequencePlan, projectPlanType } from "../../shared/project-plan.ts";
/**
 * @module cmd/load-plan/plan-epic-flow
 * The Epic action menu: decomposition, child selection, and done-enough.
 *
 * An Epic is never executed itself — it is decomposed into child Planned
 * Changes, and closed either when every child verifies or when the user
 * explicitly declares it done enough.
 */

import { isPlannedChangeClassification } from "../../constants.js";
import {
    compareChildPlansByOrder,
    findPlansByParent,
    isTerminalArchivableStatus,
    loadPlan,
    resolvePlan,
} from "../../plan-store.js";
import { isInValidation, isProjectPlan, recordPlanEvent } from "../../shared/workflow/plan-lifecycle.js";
import { resolveWorkRecordSupersessionProposalsWithUi } from "../../shared/workflow/validation-helpers.ts";
import {
    autoGenerateWorkRecordForCompletedPlan,
    formatWorkRecordAutoGenerationResult,
} from "../../shared/work-records/auto-generation.js";
import { SYSTEM_WORK_RECORD_MNEMOTECA_PORT } from "../../shared/work-records/mnemoteca-port.ts";
import {
    findTargetBranchPlansByParent,
    preparePlanningWorktreeForPlan,
} from "../../shared/workflow/planning-worktree.ts";
import { isGitRepository } from "../../shared/git.ts";
import { ensureEpicBranch } from "../../shared/workflow/epic-branch.ts";
import { reconcileEpicDelivery } from "../../shared/workflow/epic-integration.ts";
import { archiveEpicWithChildren } from "./plan-epic-archive.ts";
import { buildPlanSummary } from "../../shared/plan-presentation.ts";
import { readControllerWorktree } from "../../shared/workflow/controller-registry.ts";
import {
    buildEpicDoneEnoughSummary,
    buildEpicPlanSummary,
    formatChildPlanDescription,
    formatChildPlanLabel,
    formatEpicProgressSummary,
    formatNextChildLabel,
    isActionableNextChild,
    isDecomposedEpicStatus,
    isDoneEnoughEpic,
} from "./plan-epic-children.ts";
import { isHoldableStatus, isUserVerifiableStatus, markPlanUserVerified, putPlanOnHold } from "./plan-hold.ts";
import { validatePlanExecutionPolicyForReadiness } from "./plan-execution.ts";
import type { PlanFrontMatter } from "../../plan-store.js";
import type { UiAPI } from "../../ui/tui/types.js";
import type { PlanSessionSurface } from "./plan-session-types.ts";

/** The Epic being acted on, loaded with its body for the detail view. */
export interface EpicPlanWithBody {
    planName: string;
    body: string;
    markdown: string;
    attrs: PlanFrontMatter;
}

/** Everything the Epic action menu needs to run. */
export interface HandleEpicPlanOptions {
    projectRoot: string;
    plan: EpicPlanWithBody;
    uiAPI: UiAPI;
    runSlicerAgent: PlanSessionSurface["runSlicerAgent"];
    loadChildPlan: (childPlanName: string) => Promise<void>;
    session: PlanSessionSurface;
}

/**
 * @param {Object} opts
 * @param {string} opts.projectRoot
 * @param {{ planName: string, body: string, markdown: string, attrs: import('../../plan-store.js').PlanFrontMatter }} opts.plan
 * @param {import('../../ui/tui/types.js').UiAPI} opts.uiAPI
 * @param {PlanSessionSurface["runSlicerAgent"]} opts.runSlicerAgent
 * @param {(childPlanName: string) => Promise<void>} opts.loadChildPlan
 * @param {PlanSessionSurface} opts.session
 * @returns {Promise<"handled" | "continue" | "review" | "direct_review">}
 */
export async function handleEpicPlan({
    projectRoot,
    plan,
    uiAPI,
    runSlicerAgent,
    loadChildPlan,
    session,
}: HandleEpicPlanOptions): Promise<"handled" | "continue" | "review" | "direct_review"> {
    if (!isProjectPlan(plan.attrs)) return "continue";
    projectPlanType(plan.attrs);
    const sequence = isSequencePlan(plan.attrs);

    let epicGateReady = false;
    if (await isGitRepository(projectRoot)) {
        try {
            const branch = await ensureEpicBranch(projectRoot, plan.planName);
            if (branch.kind === "ready" && branch.created) {
                uiAPI.appendSystemMessage(
                    `Created the Epic branch ${branch.branch} from the latest primary branch.`,
                    false,
                    "RunWield",
                );
            } else if (branch.reason === "branch_unavailable") {
                uiAPI.appendSystemMessage(
                    `This Epic has no Epic branch yet, so its children deliver to their own targets. ${
                        branch.error || ""
                    }`.trim(),
                    false,
                    "RunWield",
                );
            }
            const reconciled = await reconcileEpicDelivery(projectRoot, plan.planName);
            epicGateReady = reconciled.gateReady;
            if (reconciled.status === "verified" && plan.attrs.status !== "verified") {
                const record = await autoGenerateWorkRecordForCompletedPlan({
                    cwd: projectRoot,
                    planName: plan.planName,
                    mnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
                });
                if (record.status === "failed") uiAPI.appendSystemMessage(record.message, true, "RunWield");
            }
        } catch (error) {
            // The Epic stays readable; child work retries branch preparation when it starts.
            const message = error instanceof Error ? error.message : String(error);
            uiAPI.appendSystemMessage(`The Epic branch is not ready: ${message}`, true, "RunWield");
        }
        const refreshed = await loadPlan(projectRoot, plan.planName);
        if (refreshed) plan.attrs = { ...plan.attrs, ...refreshed.attrs };
    }
    const targetBranch = typeof plan.attrs.targetBranch === "string" ? plan.attrs.targetBranch.trim() : "";
    const familyChildren = targetBranch && await isGitRepository(projectRoot)
        ? await findTargetBranchPlansByParent(projectRoot, targetBranch, plan.planName)
        : await findPlansByParent(projectRoot, plan.planName);
    const children = familyChildren.filter((child) => isPlannedChangeClassification(child.attrs.classification)).sort(
        compareChildPlansByOrder,
    );
    const hasChildren = children.length > 0;
    const pendingPublication = (await Promise.all(children.map(async (child) => {
        if (child.attrs.status !== "reviewed" && child.attrs.status !== "validated") return null;
        const attempt = await readControllerWorktree(projectRoot, {
            planName: child.name,
            planId: child.attrs.planId,
        });
        return attempt ? child : null;
    }))).filter((child) => child !== null);
    const isApprovedEpic = plan.attrs.status === "approved";
    const hasLegacyExecutableEpicStatus = ["in_progress", "failed"].includes(plan.attrs.status) ||
        isInValidation(plan.attrs.status);
    const canPickChild = hasChildren &&
        (sequence
            ? plan.attrs.status === "ready_for_work"
            : isDecomposedEpicStatus(plan.attrs) || isApprovedEpic || hasLegacyExecutableEpicStatus);
    let epicReadinessRecorded = false;

    async function ensureEpicReadinessPassed() {
        if (plan.attrs.status !== "approved" || epicReadinessRecorded) return true;
        if (!validatePlanExecutionPolicyForReadiness(plan, uiAPI)) return false;
        const updatedAttrs = await recordPlanEvent({
            cwd: projectRoot,
            planName: plan.planName,
            event: "epic_readiness_passed",
            currentStatus: "approved",
            details: { triageMeta: plan.attrs },
        });
        plan.attrs = { ...plan.attrs, ...updatedAttrs };
        epicReadinessRecorded = true;
        uiAPI.appendSystemMessage(
            `PROJECT Epic ready for decomposition or child plan selection: ${plan.planName}`,
            false,
            "RunWield",
        );
        return true;
    }

    if (hasChildren) {
        uiAPI.appendSystemMessage(formatEpicProgressSummary(children), false, "RunWield");
    }
    if (pendingPublication.length > 0) {
        for (const child of pendingPublication) {
            uiAPI.appendSystemMessage(
                `Publication is still pending for ${child.name}. Its checks passed, but delivery has not finished. Choose Resume publication to continue.`,
                false,
                "RunWield",
            );
        }
    } else if (isDoneEnoughEpic(plan)) {
        const summary = plan.attrs.epicDoneEnoughSummary ? ` ${plan.attrs.epicDoneEnoughSummary}` : "";
        uiAPI.appendSystemMessage(
            `This Epic is marked done enough for now.${summary} Remaining child plans stay visible and loadable.`,
            false,
            "RunWield",
        );
    }

    const canReviewWithArchitect = plan.attrs.status === "draft" || plan.attrs.status === "feedback" ||
        plan.attrs.status === "approved" || (sequence && plan.attrs.status === "ready_for_work" &&
            children.every((child) =>
                ["draft", "feedback", "approved", "ready_for_work"].includes(child.attrs.status)
            ));
    const canDirectReview = !sequence && (plan.attrs.status === "draft" || plan.attrs.status === "feedback" ||
        plan.attrs.status === "approved" || plan.attrs.status === "ready_for_work");
    const canOpenSlicer = !sequence && (isApprovedEpic || hasLegacyExecutableEpicStatus ||
        plan.attrs.status === "ready_for_decomposition" || plan.attrs.status === "ready_for_work");

    if (canReviewWithArchitect) {
        const action = sequence
            ? "Review the Sequence and all children with Planner."
            : canOpenSlicer
            ? "Review it with Architect or resume Slicer decomposition to create child plans."
            : "Review it with Architect to continue planning.";
        uiAPI.appendSystemMessage(
            `This PROJECT ${sequence ? "Sequence" : "Epic"} contains child Plans. ${action}`,
            false,
            "RunWield",
        );
    } else if (!hasChildren) {
        uiAPI.appendSystemMessage("This PROJECT Epic has no child plans yet.", false, "RunWield");
    }

    while (true) {
        /** @type {Array<{ value: string, label: string }>} */
        const epicOptions = [
            ...pendingPublication.map((child) => ({
                value: `publish:${child.name}`,
                label: `Resume publication: ${child.name}`,
            })),
            ...(canPickChild ? [{ value: "pick_child", label: "Pick a child Planned Change plan" }] : []),
            ...(canDirectReview ? [{ value: "direct_review", label: "Review plan" }] : []),
            ...(canReviewWithArchitect
                ? [{ value: "review", label: sequence ? "Review Sequence with Planner" : "Review with Architect" }]
                : []),
            ...(canOpenSlicer ? [{ value: "slicer", label: "Open or resume Slicer decomposition" }] : []),
            ...(epicGateReady && session.runEpicIntegrationGate
                ? [{ value: "integration_gate", label: "Run the integration gate on the Epic branch" }]
                : []),
            ...(hasChildren && (plan.attrs.status === "ready_for_work" || plan.attrs.status === "implemented")
                ? [{ value: "done_enough", label: `Mark ${sequence ? "Sequence" : "Epic"} done enough for now` }]
                : []),
            ...(isUserVerifiableStatus(plan.attrs.status)
                ? [{
                    value: "user_verify",
                    label: "Mark Epic as User Verified (user attestation; no Workflow Validation claim)",
                }]
                : []),
            ...(isHoldableStatus(plan.attrs.status) ? [{ value: "hold", label: "Put Epic on hold" }] : []),
            ...(isTerminalArchivableStatus(plan.attrs.status) && pendingPublication.length === 0
                ? [{ value: "archive_epic", label: "Archive Epic" }]
                : []),
            { value: "view", label: "View Epic details" },
            { value: "cancel", label: "Cancel" },
        ];

        const answer = await uiAPI.promptSelect("What would you like to do with this Epic?", epicOptions);
        if (!answer || answer === "cancel") return "handled";

        const publicationChild = pendingPublication.find((child) => answer === `publish:${child.name}`);
        if (publicationChild) {
            await loadChildPlan(publicationChild.name);
            return "handled";
        }

        if (answer === "view") {
            uiAPI.appendSystemMessage(buildEpicPlanSummary(plan, children), false, "Plan");
            continue;
        }

        if (answer === "integration_gate" && session.runEpicIntegrationGate) {
            await session.activateForPlan(plan.planName);
            const gate = await session.runEpicIntegrationGate(plan.planName);
            if (gate.kind === "findings" && gate.repairChild.childPlanName) {
                await loadChildPlan(gate.repairChild.childPlanName);
            } else if (gate.kind === "not_ready" || gate.kind === "paused") {
                uiAPI.appendSystemMessage(gate.reason, false, "RunWield");
            }
            return "handled";
        }

        if (answer === "hold") {
            await putPlanOnHold({ projectRoot, plan, uiAPI });
            return "handled";
        }

        if (answer === "user_verify") {
            await markPlanUserVerified({
                projectRoot,
                plan,
                uiAPI,
                session,
            });
            return "handled";
        }

        if (answer === "archive_epic") {
            const archived = await archiveEpicWithChildren({ projectRoot, plan, uiAPI });
            if (archived) return "handled";
            continue;
        }

        if (answer === "direct_review") {
            return "direct_review";
        }

        if (answer === "review") {
            return "review";
        }

        if (answer === "slicer") {
            if (!(await ensureEpicReadinessPassed())) return "handled";
            await session.activateForPlan(plan.planName);
            await runSlicerAgent({
                planName: plan.planName,
                triageMeta: plan.attrs,
            });
            return "handled";
        }

        if (answer === "done_enough") {
            const summary = buildEpicDoneEnoughSummary(children);
            uiAPI.appendSystemMessage(
                [
                    formatEpicProgressSummary(children),
                    "Marking this Epic done enough closes it without claiming verification.",
                    "Unverified child plans remain visible and loadable.",
                ].join("\n"),
                false,
                "RunWield",
            );
            const confirm = await uiAPI.promptSelect("Mark this Epic done enough for now?", [
                { value: "confirm", label: "Yes, mark done enough for now" },
                { value: "cancel", label: "Cancel" },
            ]);
            if (confirm !== "confirm") {
                uiAPI.appendSystemMessage("Epic done-enough update canceled.", false, "RunWield");
                continue;
            }
            const updatedAttrs = await recordPlanEvent({
                cwd: projectRoot,
                planName: plan.planName,
                event: "epic_done_enough",
                currentStatus: plan.attrs.status,
                details: {
                    triageMeta: plan.attrs,
                    epicDoneEnoughSummary: summary,
                },
            });
            plan.attrs = { ...plan.attrs, ...updatedAttrs };
            uiAPI.appendSystemMessage(
                `Epic marked done enough for now. ${plan.attrs.epicDoneEnoughSummary || summary}`,
                false,
                "RunWield",
            );
            let workRecordResult;
            try {
                workRecordResult = await autoGenerateWorkRecordForCompletedPlan({
                    cwd: projectRoot,
                    planName: plan.planName,
                    mnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
                });
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                workRecordResult = {
                    status: /** @type {const} */ ("failed"),
                    planName: plan.planName,
                    error: reason,
                    message: formatWorkRecordAutoGenerationResult({
                        status: "failed",
                        planName: plan.planName,
                        error: reason,
                        message: "",
                    }),
                };
            }
            if (workRecordResult.status !== "skipped" || workRecordResult.reason !== "parent_not_terminal") {
                uiAPI.appendSystemMessage(workRecordResult.message, workRecordResult.status === "failed", "RunWield");
            }
            if (
                (workRecordResult.status === "generated" || workRecordResult.status === "linked") &&
                workRecordResult.recordId && workRecordResult.supersessionProposals?.length
            ) {
                await resolveWorkRecordSupersessionProposalsWithUi({
                    projectRoot,
                    successorRecordId: workRecordResult.recordId,
                    proposals: workRecordResult.supersessionProposals,
                    mnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
                    uiAPI,
                });
            }
            continue;
        }

        if (answer === "pick_child") {
            if (!(await ensureEpicReadinessPassed())) return "handled";
            while (true) {
                const nextChild = children.find(isActionableNextChild);
                const childOptions = [
                    ...(nextChild
                        ? [{
                            value: "__next_child__",
                            label: formatNextChildLabel(nextChild),
                            description: formatChildPlanDescription(nextChild),
                        }]
                        : []),
                    ...children.map((child) => ({
                        value: child.name,
                        label: formatChildPlanLabel(child),
                        description: formatChildPlanDescription(child),
                    })),
                ];
                const childPlanName = await uiAPI.promptSelect("Load child Plan:", childOptions);
                if (!childPlanName) break;
                if (childPlanName === "__next_child__") {
                    if (!nextChild) break;
                    if (
                        typeof nextChild.attrs.targetBranch === "string" && nextChild.attrs.planId &&
                        await isGitRepository(projectRoot)
                    ) {
                        await preparePlanningWorktreeForPlan(projectRoot, nextChild.name, nextChild.attrs);
                    }
                    await loadChildPlan(nextChild.name);
                    return "handled";
                }

                while (true) {
                    const childAction = await uiAPI.promptSelect(
                        "What would you like to do with this Planned Change?",
                        [
                            { value: "load", label: "Load this Planned Change" },
                            { value: "view", label: "View Planned Change details" },
                            { value: "back", label: "Back to child list" },
                        ],
                    );
                    if (!childAction || childAction === "back") break;

                    if (childAction === "load") {
                        const selectedChild = children.find((child) => child.name === String(childPlanName));
                        if (
                            selectedChild && typeof selectedChild.attrs.targetBranch === "string" &&
                            selectedChild.attrs.planId && await isGitRepository(projectRoot)
                        ) {
                            await preparePlanningWorktreeForPlan(projectRoot, selectedChild.name, selectedChild.attrs);
                        }
                        await loadChildPlan(String(childPlanName));
                        return "handled";
                    }

                    if (childAction === "view") {
                        try {
                            const childPlan = await resolvePlan(projectRoot, String(childPlanName));
                            uiAPI.appendSystemMessage(
                                `Planned Change: ${childPlan.planName}\n\n${buildPlanSummary(childPlan)}`,
                                false,
                                "Plan",
                            );
                        } catch (err) {
                            const message = err instanceof Error ? err.message : String(err);
                            uiAPI.appendSystemMessage(
                                `Could not load Planned Change details for ${String(childPlanName)}: ${message}`,
                                false,
                                "RunWield",
                            );
                            break;
                        }
                    }
                }
            }
        }
    }
}
