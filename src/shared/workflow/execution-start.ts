// @ts-nocheck: extracted from checked JSDoc workflow.js; tightening types is out of scope for this structural split.
import { prepareEditedSiblingPlans } from "./epic-sibling-drafts.ts";
import { CLI_BIN } from "../../constants.js";
import {
    ensurePlanIdentity,
    findPlansByParent,
    getPlanFrontMatterRevisionForText,
    loadPlan,
    updatePlanFrontMatter,
} from "../../plan-store.js";
import {
    defaultPlanBranchName,
    effectiveDeliveryBranch,
    ensurePlanBranch,
    isStandalonePlannedChange,
    shouldAdoptPlanBranch,
} from "./plan-branch.ts";
import { probeGitRepository } from "../git.ts";
import { hasNonGitExecutionConsent, rememberNonGitExecutionConsent } from "../non-git-execution-consent.ts";
import { requestHostedSessionInteraction, RuntimeInteractionTypes } from "../session/session-runtime-interactions.js";
import {
    checkpointExecutionPreparation,
    createWorktreeGitArtifacts,
    deleteMergedWorktreeBranch,
    findReusableWorktree,
    hasExecutionChangesSince,
    hasOnlyExecutionPreparationChangesSince,
    prepareTargetBranchRef,
    removeWorktreeGitArtifacts,
    resolveCurrentCheckoutBranch,
    resolveRepositoryDefaultBranch,
    resolveTargetBranchName,
    settleWorktreeAttempt,
} from "../worktree.js";
import {
    findById as findWorktreeRegistryEntryById,
    listEntries as listWorktreeRegistryEntries,
    pruneEntry as pruneWorktreeRegistryEntry,
    updateEntry as updateWorktreeRegistryEntry,
} from "../worktree-registry.js";
import { captureWorktreeTree } from "./git-snapshot.ts";
import { ensureExecutionPlanFile, loadCanonicalExecutionPlanSource } from "./execution-plan-file.js";
import {
    emitCreatedExecutionWorktree,
    emitCreatingExecutionWorktree,
    emitExecutionWorktreeIndexWarning,
    emitIndexingExecutionWorktree,
    emitMaterializingPlanInExecutionWorktree,
    emitPreparingExecutionTarget,
    emitPreparingInPlaceExecution,
    emitReconciledPlanInExecutionWorktree,
    emitRestoredPlanInExecutionWorktree,
    emitReusingExecutionWorktree,
    emitUpdatingPlanStatusToInProgress,
} from "./execution-preparation-progress.ts";
import { recordPlanEvent } from "./plan-lifecycle.js";
import { recordWorkflowMetric } from "./metrics.js";
import { listTransitionRecoveryRecords, runExecutionPreparationTransition } from "./state-transition.ts";
import { healSettledTransitionRecords } from "./transition-recovery.ts";
import { CollaborationStyles, resolveExecutionOwner } from "./execution-collaboration.ts";
import { ensureRunWieldOwnedGitignoreBlock } from "../runwield-owned-paths.ts";
import { emitSystemStatus } from "../session/session-runtime-events.js";
import { resolveWorkflowPlanLocation } from "./plan-location.ts";
import { resolvePrimaryCheckoutRoot } from "../primary-checkout.ts";

export function normalizeExecutionTargetBranch(value) {
    if (typeof value !== "string") return undefined;
    const target = value.trim();
    return target && target !== "HEAD" ? target : undefined;
}

async function addRunWieldOwnedGitignoreBlock(projectRoot, hostedSession) {
    const reconciliation = await ensureRunWieldOwnedGitignoreBlock(projectRoot);
    for (const warning of reconciliation.warnings) {
        emitSystemStatus(hostedSession, warning.message, { header: "RunWield", level: "warning" });
    }
}

async function runCymbalIndexForExecutionWorktree(hostedSession, worktreePath) {
    emitIndexingExecutionWorktree(hostedSession);
    let output;
    try {
        output = await new Deno.Command("cymbal", {
            args: ["index", "."],
            cwd: worktreePath,
            stdout: "piped",
            stderr: "piped",
        }).output();
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
            emitExecutionWorktreeIndexWarning(hostedSession, "the cymbal executable was not found.");
            return;
        }
        throw error;
    }
    if (output.code === 0) return;
    const decoder = new TextDecoder();
    const stderr = decoder.decode(output.stderr).trim();
    const stdout = decoder.decode(output.stdout).trim();
    emitExecutionWorktreeIndexWarning(hostedSession, stderr || stdout || `cymbal exited with code ${output.code}.`);
}

/**
 * @param {import('../session/hosted-session.js').HostedSession} hostedSession
 * @param {string} projectRoot
 * @returns {Promise<boolean>}
 */
export async function confirmNonGitFeaturePlanExecution(hostedSession, projectRoot) {
    const response = await requestHostedSessionInteraction(
        hostedSession,
        {
            type: RuntimeInteractionTypes.SELECT,
            prompt:
                "Git is not available for this project. RunWield recommends using Git so Plan execution can run in an isolated Worktree with diff-based review and merge-back. Proceeding will modify the current files directly and skip Git-only isolation/recovery.",
            options: [
                { value: "proceed", label: "Proceed in current files and remember for planned Plan work" },
                { value: "cancel", label: "Cancel execution" },
            ],
        },
        undefined,
        hostedSession?.getManagedOperationCapability?.() || null,
    );
    if (response.outcome !== "selected" || response.value !== "proceed") return false;
    await rememberNonGitExecutionConsent("featurePlan", projectRoot);
    return true;
}

/**
 * @param {string | undefined} reusableBaseBranch
 * @param {string | undefined} targetBranch
 */
export function assertReusableWorktreeTargetMatches(reusableBaseBranch, targetBranch) {
    const reusableTarget = normalizeExecutionTargetBranch(reusableBaseBranch);
    const planTarget = normalizeExecutionTargetBranch(targetBranch);
    if (reusableTarget !== planTarget) {
        throw new Error(
            `Existing execution worktree targets ${reusableTarget || "HEAD/current checkout"}, but plan targets ${
                planTarget || "HEAD/current checkout"
            }. Aborting before Engineer starts.`,
        );
    }
}

/**
 * The environment `startActiveExecutionWorkflow` reaches for.
 *
 * Required, every one. The previous shape was `ports?.name || name`, which let a
 * caller replace one collaborator while production silently fell back to the
 * import for the rest — an override bag with a different noun on it. Required
 * members mean the substitution is made at the call site, where it is visible,
 * and this module never chooses.
 */
export interface ExecutionStartPorts {
    findReusableWorktree: typeof findReusableWorktree;
    resolveCurrentCheckoutBranch: typeof resolveCurrentCheckoutBranch;
    resolveTargetBranchName: typeof resolveTargetBranchName;
    loadCanonicalExecutionPlanSource: typeof loadCanonicalExecutionPlanSource;
    recordWorkflowMetric: typeof recordWorkflowMetric;
    probeGitRepository: typeof probeGitRepository;
    hasNonGitExecutionConsent: typeof hasNonGitExecutionConsent;
    confirmNonGitFeaturePlanExecution: typeof confirmNonGitFeaturePlanExecution;
    now: () => number;
}

/** The real environment. Construct once at the edge and pass it down. */
export function createExecutionStartPorts(): ExecutionStartPorts {
    return {
        findReusableWorktree,
        resolveCurrentCheckoutBranch,
        resolveTargetBranchName,
        loadCanonicalExecutionPlanSource,
        recordWorkflowMetric,
        probeGitRepository,
        hasNonGitExecutionConsent,
        confirmNonGitFeaturePlanExecution,
        now: () => Date.now(),
    };
}

async function materializeEpicPlanFamily(projectRoot, executionCwd, planName, planAttrs, existingOnly = false) {
    const parentPlan = typeof planAttrs.parentPlan === "string" ? planAttrs.parentPlan.trim() : "";
    if (!parentPlan) return [];
    const materializedPaths = [];
    const relatedPlanNames = [
        parentPlan,
        ...(await findPlansByParent(projectRoot, parentPlan)).map((plan) => plan.name),
    ];
    for (const relatedPlanName of new Set(relatedPlanNames)) {
        if (relatedPlanName === planName) continue;
        const source = await loadCanonicalExecutionPlanSource(projectRoot, relatedPlanName);
        // Reused child worktrees need only carry the family documents they
        // already contain. The parent may still live in its own planning worktree.
        if (existingOnly && source.kind === "absent") continue;
        if (source.kind !== "loaded") {
            throw new Error(
                `Cannot prepare related Plan ${source.relativePath}: ${source.reason || source.kind}`,
            );
        }
        const result = await ensureExecutionPlanFile({
            executionCwd,
            planName: relatedPlanName,
            canonicalSource: source,
            // The fetched target is authoritative for already-published relatives.
            // Primary-checkout copies can be stale because publication deliberately
            // never moves or rewrites that checkout. Only restore family Plans that
            // are absent from the target; never reconcile an existing parent or
            // sibling backwards from the primary checkout.
            reconcileFromCanonical: false,
        });
        if (result.kind !== "present" && result.kind !== "restored" && result.kind !== "reconciled") {
            throw new Error(
                `Cannot prepare related Plan ${result.relativePath}: ${result.reason || result.kind}`,
            );
        }
        materializedPaths.push(result.relativePath);
    }
    return materializedPaths;
}

interface ExecutionPreparationLocationOptions {
    migrateRegistry?: boolean;
    readOnly?: boolean;
}

/** Reconcile the source authority before the registry can select an incomplete worktree. */
export async function reconcileExecutionPreparationLocation(
    projectRoot: string,
    planName: string,
    options: ExecutionPreparationLocationOptions = {},
) {
    const records = await listTransitionRecoveryRecords(projectRoot);
    const source = await loadPlan(projectRoot, planName).catch(() => null);
    const entries = await listWorktreeRegistryEntries(projectRoot, { migrate: false });
    // Only an interrupted first preparation can use the approved source when its
    // selected worktree has no document yet. A worker's later deletion cannot.
    const unmaterialized = source?.attrs.status === "ready_for_work" && records.some((record) => {
        if (record.operation !== "execution_preparation" || record.planName !== planName) return false;
        const before = record.beforeFacts?.plan;
        if (before?.revision !== source.revision || before?.status !== "ready_for_work") return false;
        const effects = record.completedEffects || [];
        if (
            !effects.length ||
            effects.some((effect) => !["git_worktree_created", "worktree_registry_settled"].includes(effect.effect))
        ) return false;
        return effects.some((effect) =>
            entries.some((entry) =>
                entry.planId === source.attrs.planId && entry.status === "active" && !entry.executionBaselineTree &&
                entry.id === effect.proof?.worktreeId && entry.path === effect.proof?.path
            )
        );
    });
    const healed = await healSettledTransitionRecords(projectRoot, {
        planName,
        evidenceProjectRoot: projectRoot,
        apply: !unmaterialized,
    });
    if (healed.remaining.some((entry) => !entry.resolvable)) {
        throw new Error(
            `RunWield still cannot confirm an interrupted execution setup for ${planName}. The execution files are safe.`,
        );
    }
    if (unmaterialized) {
        const selected = entries.find((entry) => entry.planId === source.attrs.planId && entry.status === "active");
        if (selected && !await loadPlan(selected.path, planName)) {
            return {
                registryRoot: projectRoot,
                documentRoot: projectRoot,
                plan: source,
                resumeInterruptedPreparation: true,
            };
        }
    }
    return await resolveWorkflowPlanLocation(projectRoot, planName, options);
}

interface ExecutionStartOptions {
    planName: string;
    triageMeta: Partial<import("../../plan-store.js").PlanFrontMatter>;
    currentStatus: import("./plan-lifecycle.js").PlanStatus;
    cwd?: string;
    existingExecution?: import("../session/hosted-session.js").ActiveExecutionWorkflow | null;
    hostedSession?: import("../session/hosted-session.js").HostedSession;
    collaborationStyle?: "autonomous" | "pair";
    collaborationRecommendation?: "autonomous" | "pair";
    ports: ExecutionStartPorts;
}

/** Prepare execution through the shared policy with either a Session or durable carrier inputs.
 * @param {ExecutionStartOptions} opts
 * @returns {Promise<import('../session/hosted-session.js').ActiveExecutionWorkflow>}
 */
export async function startActiveExecutionWorkflow(
    {
        planName,
        triageMeta,
        currentStatus,
        hostedSession,
        cwd = hostedSession?.cwd,
        existingExecution = hostedSession?.getActiveExecutionWorkflow?.(),
        collaborationStyle = CollaborationStyles.AUTONOMOUS,
        collaborationRecommendation = CollaborationStyles.AUTONOMOUS,
        ports,
    }: ExecutionStartOptions,
): Promise<import("../session/hosted-session.js").ActiveExecutionWorkflow> {
    if (!cwd) throw new Error("startActiveExecutionWorkflow: cwd is required");
    const projectRoot = resolvePrimaryCheckoutRoot(cwd);
    const sourceLocation = await reconcileExecutionPreparationLocation(projectRoot, planName);
    if (sourceLocation.archived) {
        throw new Error(`This Plan is archived. Run wld plans archive restore ${planName} before executing it.`);
    }
    if (sourceLocation.plan) {
        triageMeta = sourceLocation.plan.attrs;
        currentStatus = sourceLocation.plan.attrs.status;
    }
    const findReusable = ports.findReusableWorktree;
    // Worktree policy and the Plan restore are RunWield's own: they stay imported so a
    // test cannot stand in for them. Producing their failure modes takes a real
    // repository — a branch whose tree has `docs` as a file blocks the restore.
    const prepareTarget = prepareTargetBranchRef;
    const resolveCurrentBranch = ports.resolveCurrentCheckoutBranch;
    const resolveTarget = ports.resolveTargetBranchName;
    const captureTree = captureWorktreeTree;
    const loadCanonicalPlanSource = ports.loadCanonicalExecutionPlanSource;
    const ensurePlanFile = ensureExecutionPlanFile;
    const recordWorkflowMetricFn = ports.recordWorkflowMetric;
    const probeGit = ports.probeGitRepository;
    const hasConsent = ports.hasNonGitExecutionConsent;
    const confirmNonGit = ports.confirmNonGitFeaturePlanExecution;
    const now = ports.now;
    // Plan identity is durable state, so it is never sourced from an injected seam.
    // This used to fall back to a synthetic `test-plan:<name>` id whenever `ports`
    // was non-empty, which any production caller passing a single real dep tripped:
    // the Plan got `test-plan:<name>` as its durable id, ensurePlanIdentity() never
    // ran, and the backfill the Plan still needed happened later inside the
    // execution transaction — rewriting Front Matter the transaction had already
    // snapshotted, then aborting the run. Tests that need a fixed id pass
    // `triageMeta.planId`; everything else gets the real one.
    const planIdentity = typeof triageMeta.planId === "string" && triageMeta.planId
        ? { id: triageMeta.planId }
        : await ensurePlanIdentity(sourceLocation.documentRoot, planName);
    const stablePlanId = "planId" in planIdentity ? planIdentity.planId : planIdentity.id;
    const effectiveTriageMeta = { ...triageMeta, planId: stablePlanId };
    hostedSession?.setWorkflowExecutionContext?.({ planName, triageMeta: effectiveTriageMeta });
    if (hostedSession?.getManagedOperationCapability?.()) {
        hostedSession?.recordPlanAssociation?.({ planId: stablePlanId, planName, purpose: "execution" });
    }
    let executionAgent = resolveExecutionOwner(effectiveTriageMeta);
    const collaborationState = {
        collaborationStyle,
        collaborationRecommendation,
        pairCheckpointCount: 0,
    };
    emitPreparingExecutionTarget(hostedSession);
    const gitProbe = await probeGit(projectRoot);
    if (!gitProbe.ok) {
        if (!hasConsent("featurePlan", projectRoot) && !(await confirmNonGit(hostedSession, projectRoot))) {
            throw new Error(
                "Plan execution canceled because Git is not available and in-place execution was not approved.",
            );
        }
        emitPreparingInPlaceExecution(hostedSession);
        const attemptId = triageMeta.worktreeId || `non-git-${crypto.randomUUID().slice(0, 8)}`;
        const canonicalPlan = await loadPlan(projectRoot, planName);
        if (!canonicalPlan) throw new Error(`Plan not found: ${planName}`);
        await healSettledTransitionRecords(projectRoot, { planName, evidenceProjectRoot: projectRoot });
        const needsExecutionStartedEvent = canonicalPlan.attrs.status !== "in_progress";
        const transition = await runExecutionPreparationTransition({
            projectRoot,
            planName,
            planId: stablePlanId,
            worktreeId: attemptId,
            expectedRevision: canonicalPlan?.revision,
            expectedPlanEvent: needsExecutionStartedEvent,
            prepare: async ({ markEffect }) => {
                const workflow = {
                    planName,
                    triageMeta: effectiveTriageMeta,
                    executionAgent,
                    executionStarted: false,
                    ...collaborationState,
                    projectRoot,
                    executionCwd: projectRoot,
                    executionMode: /** @type {const} */ ("non_git_in_place"),
                    nonGitInPlace: true,
                };
                if (needsExecutionStartedEvent) {
                    emitUpdatingPlanStatusToInProgress(hostedSession);
                    await recordPlanEvent({
                        cwd: projectRoot,
                        planName,
                        event: "execution_started",
                        currentStatus,
                        details: {
                            triageMeta: effectiveTriageMeta,
                            nonGitInPlace: true,
                            executionMode: "non_git_in_place",
                        },
                    });
                    await markEffect("plan_event_recorded", { planName, event: "execution_started" });
                }
                const activeWorkflow = { ...workflow, executionStarted: true, executionAttemptStartedAtMs: now() };
                await recordWorkflowMetricFn({
                    category: "execution",
                    event: "non_git_in_place_execution_started",
                    planName,
                    details: { gitState: gitProbe.state },
                }, projectRoot);
                return activeWorkflow;
            },
            verifyPreparation: (workflow) => {
                if (!workflow || typeof workflow !== "object") {
                    throw new Error(`Non-Git execution preparation for ${planName} did not return workflow evidence.`);
                }
                if (workflow.planName !== planName || workflow.executionMode !== "non_git_in_place") {
                    throw new Error(
                        `Non-Git execution preparation returned incompatible workflow evidence for ${planName}.`,
                    );
                }
                if (workflow.executionCwd !== projectRoot || workflow.projectRoot !== projectRoot) {
                    throw new Error(
                        `Non-Git execution preparation returned an unexpected execution context for ${planName}.`,
                    );
                }
                return { planName, executionMode: "non_git_in_place", projectRoot };
            },
        });
        if (transition.status !== "committed") {
            throw new Error(transition.message || `Non-Git execution preparation did not commit for ${planName}.`);
        }
        const activeWorkflow =
            /** @type {import('../session/hosted-session.js').ActiveExecutionWorkflow} */ (transition.value);
        hostedSession?.setActiveExecutionWorkflow(activeWorkflow);
        return activeWorkflow;
    }
    let targetBranch = normalizeExecutionTargetBranch(triageMeta.targetBranch);
    let deliveryBranch = effectiveDeliveryBranch(triageMeta);
    const hasRecordedWorktree = Boolean(
        triageMeta.worktreeId || triageMeta.worktreePath || triageMeta.worktreeBranch ||
            triageMeta.executionBaselineTree,
    );
    const startsFresh = triageMeta.worktreeStatus === "abandoned" && !hasRecordedWorktree;
    const cachedWorkflow = existingExecution;
    const existing = !startsFresh && cachedWorkflow?.planName === planName &&
            cachedWorkflow.worktreeId === triageMeta.worktreeId
        ? cachedWorkflow
        : null;
    // The registry owns attempt identity. Review status or missing projected
    // metadata must not turn existing implementation into a fresh worktree.
    // Explicitly abandoned attempts are excluded by the registry lookup.
    const activeReusable = await findReusable({
        projectRoot,
        planName,
        planId: stablePlanId,
        worktreeId: triageMeta.worktreeId || undefined,
    });
    const planningReusable = !activeReusable
        ? (await listWorktreeRegistryEntries(projectRoot)).find((entry) =>
            entry.planId === stablePlanId && entry.planName === planName && entry.status === "planning"
        ) || null
        : null;
    const reusable = activeReusable || planningReusable;
    if (reusable) {
        const requestedTarget = deliveryBranch
            ? await resolveTarget(projectRoot, deliveryBranch)
            : await resolveCurrentBranch(projectRoot);
        assertReusableWorktreeTargetMatches(reusable.baseBranch, requestedTarget);
    }
    const reusablePlanSource = reusable ? await loadCanonicalPlanSource(reusable.path, planName) : null;
    const planAuthorityRoot = reusable && reusablePlanSource?.kind === "loaded"
        ? reusable.path
        : sourceLocation.documentRoot;
    if (reusable && planAuthorityRoot === reusable.path) {
        const healed = await healSettledTransitionRecords(planAuthorityRoot, {
            planName,
            evidenceProjectRoot: projectRoot,
        });
        if (healed.remaining.length > 0) {
            throw new Error(
                `RunWield still cannot confirm an interrupted execution setup for ${planName}. ` +
                    "The execution files are safe. Load this Plan again to review the remaining recovery evidence.",
            );
        }
    }
    const preflightCanonicalPlanSource = planAuthorityRoot === reusable?.path
        ? reusablePlanSource
        : await loadCanonicalPlanSource(planAuthorityRoot, planName);
    const canonicalPlanForRevision = await loadPlan(planAuthorityRoot, planName).catch(() => null);
    if (preflightCanonicalPlanSource.kind !== "loaded") {
        throw new Error(
            `Cannot load execution Plan ${preflightCanonicalPlanSource.relativePath}: ${
                preflightCanonicalPlanSource.reason || preflightCanonicalPlanSource.kind
            }`,
        );
    }
    if (reusable) {
        Object.assign(effectiveTriageMeta, preflightCanonicalPlanSource.attrs, { planId: stablePlanId });
        executionAgent = resolveExecutionOwner(effectiveTriageMeta);
        hostedSession?.setWorkflowExecutionContext?.({ planName, triageMeta: effectiveTriageMeta });
        if (hostedSession?.getManagedOperationCapability?.()) {
            hostedSession?.recordPlanAssociation?.({ planId: stablePlanId, planName, purpose: "execution" });
        }
    }
    targetBranch = normalizeExecutionTargetBranch(preflightCanonicalPlanSource.attrs.targetBranch);
    const standalone = isStandalonePlannedChange(preflightCanonicalPlanSource.attrs);
    if (!reusable && standalone && !targetBranch) {
        targetBranch = await resolveRepositoryDefaultBranch(projectRoot);
    }
    deliveryBranch = effectiveDeliveryBranch(preflightCanonicalPlanSource.attrs) || targetBranch;
    // Existing attempts retain their recorded landing across setting changes.
    const adoptPlanBranch = !reusable && shouldAdoptPlanBranch(projectRoot, preflightCanonicalPlanSource.attrs);
    const resolvedTargetBranch = reusable
        ? normalizeExecutionTargetBranch(reusable.baseBranch) || await resolveCurrentBranch(projectRoot)
        : adoptPlanBranch
        ? defaultPlanBranchName(planName)
        : deliveryBranch;
    const attemptId = reusable?.id || triageMeta.worktreeId || crypto.randomUUID().slice(0, 8);
    const authorityStatus = canonicalPlanForRevision?.attrs.status || currentStatus;
    const reusableBaseRef = reusable && (reusable.baseCommit || reusable.baseTree);
    const reusableHasExecutionChanges = Boolean(reusable && reusableBaseRef) && await hasExecutionChangesSince({
        worktreePath: reusable.path,
        baseRef: reusableBaseRef,
        includeWorkingTree: true,
    });
    const reusableHasPreparationCheckpoint = Boolean(reusable && reusableBaseRef) &&
        await hasOnlyExecutionPreparationChangesSince({
            worktreePath: reusable.path,
            baseRef: reusableBaseRef,
        });
    const continuingReusableWorktree = Boolean(reusable) &&
        (authorityStatus === "in_progress" || reusableHasExecutionChanges || reusableHasPreparationCheckpoint);
    const needsPreparationCheckpoint = !continuingReusableWorktree ||
        (reusableHasPreparationCheckpoint && !reusableHasExecutionChanges);
    const needsExecutionStartedEvent = authorityStatus !== "in_progress";
    /** @type {Extract<Awaited<ReturnType<typeof loadCanonicalExecutionPlanSource>>, {kind:"loaded"}> | undefined} */
    let lockedCanonicalPlanSource;
    // Reconcile cross-worktree planning edits before acquiring the active Plan's
    // transition lock, so simultaneous sibling starts cannot lock each other out.
    const editedSiblingPaths = reusable && needsPreparationCheckpoint
        ? await prepareEditedSiblingPlans(reusable.path, planName, preflightCanonicalPlanSource.relativePath)
        : [];
    const transition = await runExecutionPreparationTransition({
        // Lock the approved source document. A fresh execution directory does
        // not exist yet; a reopened Plan can still live in its retired directory.
        projectRoot: planAuthorityRoot,
        planName,
        planId: stablePlanId,
        worktreeId: attemptId,
        targetRef: resolvedTargetBranch || targetBranch || undefined,
        expectedRevision: canonicalPlanForRevision?.revision,
        expectedPlanEvent: needsExecutionStartedEvent,
        resumeInterrupted: sourceLocation.resumeInterruptedPreparation === true,
        prepare: async ({ beforePlan, markEffect, registerRollback }) => {
            let canonicalPlanSource = await loadCanonicalPlanSource(planAuthorityRoot, planName);
            if (canonicalPlanSource.kind !== "loaded") {
                throw new Error(
                    `Cannot load canonical Project Plan ${canonicalPlanSource.relativePath}: ${
                        canonicalPlanSource.reason || canonicalPlanSource.kind
                    }`,
                );
            }
            // The Plan is read twice under the same lock: once as the transition's
            // locked snapshot, once here as the source that will be materialized into
            // the worktree. Those must agree, or execution runs against metadata the
            // lifecycle checks never saw.
            //
            // Compare Front Matter, not whole-file bytes: RunWield owns Front Matter
            // and the user owns the body, so a body edit between the two reads is
            // legitimate and must not abort a valid run. This is the same
            // ownership-scoped comparison the transition layer uses for its
            // preconditions — one primitive, not a second list of fields to keep in
            // sync with the first.
            const canonicalFrontMatterRevision = await getPlanFrontMatterRevisionForText(
                canonicalPlanSource.markdown,
            );
            if (
                beforePlan && beforePlan.frontMatterRevision &&
                beforePlan.frontMatterRevision !== canonicalFrontMatterRevision
            ) {
                throw new Error(
                    `Plan ${planName} had its front matter change while preparing execution; reload the Plan and start execution again.`,
                );
            }
            if (!reusable && standalone) {
                if (adoptPlanBranch) {
                    deliveryBranch =
                        (await ensurePlanBranch({ projectRoot, planName, sourceBranch: targetBranch })).branch;
                }
                await updatePlanFrontMatter(
                    planAuthorityRoot,
                    planName,
                    { targetBranch, deliveryBranch },
                    canonicalPlanSource.attrs,
                    { expectedRevision: beforePlan.revision },
                );
                Object.assign(effectiveTriageMeta, { targetBranch, deliveryBranch });
                canonicalPlanSource = await loadCanonicalPlanSource(planAuthorityRoot, planName);
                if (canonicalPlanSource.kind !== "loaded") {
                    throw new Error(`Cannot reload recorded delivery branch for ${planName}.`);
                }
            }
            lockedCanonicalPlanSource = canonicalPlanSource;
            const reusedWorktree = Boolean(reusable);
            let preparationCommit;
            /** @type {any} */
            let worktree;
            if (reusable) {
                worktree = reusable;
                emitReusingExecutionWorktree(hostedSession, {
                    worktreeBranch: worktree.branch,
                    baseBranch: worktree.baseBranch,
                });
                await markEffect("git_worktree_reused", {
                    worktreeId: worktree.id,
                    path: worktree.path,
                    branch: worktree.branch,
                });
            } else {
                const implicitTargetBranch = deliveryBranch || await resolveCurrentBranch(projectRoot);
                const targetPreparation = implicitTargetBranch
                    ? await prepareTarget(projectRoot, implicitTargetBranch)
                    : { baseRef: "HEAD", baseBranch: "HEAD" };
                emitCreatingExecutionWorktree(
                    hostedSession,
                    targetPreparation.baseBranch || targetPreparation.baseRef,
                );
                const worktreeOptions = {
                    projectRoot,
                    planName,
                    planId: stablePlanId,
                    attemptId,
                    ...targetPreparation,
                };
                await addRunWieldOwnedGitignoreBlock(projectRoot, hostedSession);
                const worktreeArtifacts = await createWorktreeGitArtifacts(worktreeOptions);
                await addRunWieldOwnedGitignoreBlock(worktreeArtifacts.path, hostedSession);
                emitCreatedExecutionWorktree(hostedSession, {
                    worktreeBranch: worktreeArtifacts.branch,
                    baseBranch: worktreeArtifacts.baseBranch || worktreeArtifacts.baseRef,
                });
                await runCymbalIndexForExecutionWorktree(hostedSession, worktreeArtifacts.path);
                await markEffect("git_worktree_created", {
                    worktreeId: worktreeArtifacts.id,
                    path: worktreeArtifacts.path,
                    branch: worktreeArtifacts.branch,
                    baseRef: worktreeArtifacts.baseRef,
                    baseCommit: worktreeArtifacts.baseCommit,
                });
                registerRollback("remove_clean_created_worktree_and_registry_entry", async () => {
                    await removeWorktreeGitArtifacts({
                        projectRoot,
                        path: worktreeArtifacts.path,
                        // No Agent turn has started yet. If preparation fails, this
                        // checkout contains only RunWield's own materialized Plan
                        // and baseline evidence, so it is safe to remove as a unit.
                        force: true,
                    });
                    // Deleting the branch is irreversible, so it is its own proven step.
                    if (worktreeArtifacts.branch) {
                        await deleteMergedWorktreeBranch({
                            projectRoot,
                            branch: worktreeArtifacts.branch,
                            baseCommit: worktreeArtifacts.baseCommit,
                            ownedPreparationCommit: preparationCommit,
                        });
                    }
                    await pruneWorktreeRegistryEntry(projectRoot, worktreeArtifacts.id);
                });
                worktree = await settleWorktreeAttempt(projectRoot, {
                    ...worktreeArtifacts,
                    planName: worktreeArtifacts.planName || planName,
                    planId: worktreeArtifacts.planId || stablePlanId,
                });
                await markEffect("worktree_registry_settled", {
                    worktreeId: worktree.id,
                    path: worktree.path,
                    branch: worktree.branch,
                    status: worktree.status,
                });
            }
            if (reusable) await addRunWieldOwnedGitignoreBlock(worktree.path, hostedSession);
            const worktreeBaseBranch = worktree.baseBranch === "HEAD" ? undefined : worktree.baseBranch;
            emitMaterializingPlanInExecutionWorktree(hostedSession);
            const planFile = await ensurePlanFile({
                executionCwd: worktree.path,
                planName,
                canonicalSource: canonicalPlanSource,
                reconcileFromCanonical: !continuingReusableWorktree,
                // Before the first Engineer turn, the locked primary Plan is the
                // complete authority. A new worktree starts from the target branch,
                // whose committed Plan may be older than a just-approved revision.
                // Once execution begins, the execution copy becomes authoritative and
                // this replacement is deliberately disabled.
                replaceFromCanonical: !continuingReusableWorktree,
            });
            if (planFile.kind === "restored") emitRestoredPlanInExecutionWorktree(hostedSession);
            if (planFile.kind === "reconciled") emitReconciledPlanInExecutionWorktree(hostedSession);
            if (planFile.kind !== "present" && planFile.kind !== "restored" && planFile.kind !== "reconciled") {
                const preparationError = new Error(
                    `Cannot prepare execution worktree Plan file ${planFile.relativePath}: ${
                        planFile.reason || planFile.kind
                    }`,
                );
                if (!reusedWorktree && worktree.id) {
                    await updateWorktreeRegistryEntry(projectRoot, worktree.id, {
                        status: "execution_failed",
                    }).catch(() => null);
                }
                throw new Error(
                    reusedWorktree
                        ? `${preparationError.message}; the existing execution worktree was left at ${worktree.path}.`
                        : `${preparationError.message}; no Agent work began.`,
                );
            }
            let relatedPlanPaths = [];
            if (needsPreparationCheckpoint) {
                // A reused planning worktree can contain parent and sibling edits
                // too. Include the same family on initial preparation and retry;
                // materialization preserves every already-present Plan verbatim.
                relatedPlanPaths = await materializeEpicPlanFamily(
                    planAuthorityRoot,
                    worktree.path,
                    planName,
                    canonicalPlanSource.attrs,
                    reusedWorktree,
                );
            }
            const executionPlan = await loadPlan(worktree.path, planName);
            if (!executionPlan) throw new Error(`Plan not found in its execution worktree: ${planName}`);
            // Re-entering an in-progress attempt must keep the tree from before the
            // implementation began. Capturing the current tree here makes completed
            // code disappear from the later review diff, especially after RunWield
            // reconciles the Plan copy while resuming the worktree.
            const recordedBaselineTree = continuingReusableWorktree
                ? existing?.planName === planName && existing.executionCwd === worktree.path &&
                        existing.baselineTree
                    ? existing.baselineTree
                    : "executionBaselineTree" in worktree && typeof worktree.executionBaselineTree === "string"
                    ? worktree.executionBaselineTree
                    : "baseTree" in worktree && typeof worktree.baseTree === "string"
                    ? worktree.baseTree
                    : undefined
                : undefined;
            const recordedBaselineContainsExecution = Boolean(
                recordedBaselineTree && "baseTree" in worktree && typeof worktree.baseTree === "string" &&
                    await hasExecutionChangesSince({
                        worktreePath: worktree.path,
                        baseRef: worktree.baseTree,
                        targetRef: recordedBaselineTree,
                    }),
            );
            const safeRecordedBaselineTree = recordedBaselineContainsExecution ? undefined : recordedBaselineTree;
            const baselineTree = safeRecordedBaselineTree ||
                (continuingReusableWorktree && "baseTree" in worktree && typeof worktree.baseTree === "string"
                    ? worktree.baseTree
                    : await captureTree(worktree.path));
            const workflow = {
                planName,
                triageMeta: effectiveTriageMeta,
                executionAgent,
                executionStarted: false,
                ...collaborationState,
                executionMode: /** @type {const} */ ("worktree"),
                baselineTree,
                projectRoot,
                executionCwd: worktree.path,
                worktreeId: worktree.id,
                worktreeBranch: worktree.branch,
                worktreeBaseBranch,
                worktreeBaseRef: "baseRef" in worktree && typeof worktree.baseRef === "string"
                    ? worktree.baseRef
                    : undefined,
                worktreeBaseCommit: "baseCommit" in worktree && typeof worktree.baseCommit === "string"
                    ? worktree.baseCommit
                    : undefined,
            };
            if (worktree.id) {
                if (reusable?.status === "planning") {
                    registerRollback("restore_planning_registry_entry", async () => {
                        await updateWorktreeRegistryEntry(projectRoot, worktree.id, {
                            status: "planning",
                            executionBaselineTree: undefined,
                        });
                    });
                }
                await updateWorktreeRegistryEntry(projectRoot, worktree.id, {
                    status: "active",
                    executionBaselineTree: baselineTree,
                });
                await markEffect("worktree_registry_updated", {
                    worktreeId: worktree.id,
                    status: "active",
                    executionBaselineTree: baselineTree,
                });
            }
            if (needsExecutionStartedEvent) {
                emitUpdatingPlanStatusToInProgress(hostedSession);
                await recordPlanEvent({
                    cwd: worktree.path,
                    planName,
                    event: "execution_started",
                    currentStatus: authorityStatus,
                    details: {
                        triageMeta: effectiveTriageMeta,
                        executionBaselineTree: baselineTree,
                        worktreeId: worktree.id,
                        worktreePath: worktree.path,
                        worktreeBranch: worktree.branch,
                        worktreeBaseBranch,
                        worktreeStatus: "active",
                    },
                });
                await markEffect("plan_event_recorded", {
                    planName,
                    event: "execution_started",
                    worktreeId: worktree.id,
                });
            }
            if (needsPreparationCheckpoint) {
                // Sibling drafts Planner reshaped while planning this child travel with it.
                relatedPlanPaths = [
                    ...relatedPlanPaths,
                    ...(reusedWorktree
                        ? editedSiblingPaths
                        : await prepareEditedSiblingPlans(worktree.path, planName, planFile.relativePath)),
                ];
                const preparation = await checkpointExecutionPreparation({
                    worktreePath: worktree.path,
                    branch: worktree.branch,
                    baseCommit: worktree.baseCommit,
                    planName,
                    planRelativePath: planFile.relativePath,
                    relatedPlanPaths,
                });
                preparationCommit = preparation.preparationCommit;
                await markEffect("execution_preparation_checkpoint_settled", {
                    preparationCommit,
                    worktreeId: worktree.id,
                    worktreeBranch: worktree.branch,
                });
            }
            const activeWorkflow = { ...workflow, executionStarted: true, executionAttemptStartedAtMs: now() };
            await recordWorkflowMetricFn({
                category: "execution",
                event: "worktree_prepared",
                planName,
                details: {
                    reusedWorktree,
                    worktreeStatus: "active",
                    hasBranch: Boolean(worktree.branch),
                    hasBaseBranch: Boolean(worktreeBaseBranch),
                    hasBaselineTree: Boolean(baselineTree),
                    planFileMaterialized: planFile.kind === "restored",
                    planFileReconciled: planFile.kind === "reconciled",
                },
            }, projectRoot);
            return activeWorkflow;
        },
        verifyPreparation: async (workflow) => {
            if (!workflow || typeof workflow !== "object") {
                throw new Error(`Execution preparation for ${planName} did not return workflow evidence.`);
            }
            if (workflow.planName !== planName || workflow.executionMode !== "worktree") {
                throw new Error(`Execution preparation returned incompatible workflow evidence for ${planName}.`);
            }
            if (workflow.worktreeId !== attemptId) {
                throw new Error(
                    `Execution preparation attempt mismatch for ${planName}: expected ${attemptId}, found ${workflow.worktreeId}.`,
                );
            }
            if (!workflow.executionCwd || !workflow.worktreeBranch || !workflow.baselineTree) {
                throw new Error(
                    `Execution preparation for ${planName} is missing worktree, branch, or baseline proof.`,
                );
            }
            {
                const worktreeStat = await Deno.stat(workflow.executionCwd).catch(() => null);
                if (!worktreeStat?.isDirectory) {
                    throw new Error(
                        `Execution preparation worktree is not attached for ${planName}: ${workflow.executionCwd}`,
                    );
                }
            }
            {
                const registryEntry = await findWorktreeRegistryEntryById(projectRoot, workflow.worktreeId);
                if (!registryEntry) {
                    throw new Error(
                        `Execution preparation registry entry is missing for attempt ${workflow.worktreeId}.`,
                    );
                }
                if (
                    registryEntry.planName !== planName || registryEntry.path !== workflow.executionCwd ||
                    registryEntry.branch !== workflow.worktreeBranch || registryEntry.status !== "active" ||
                    registryEntry.executionBaselineTree !== workflow.baselineTree
                ) {
                    throw new Error(
                        `Execution preparation registry entry does not match prepared workflow ${workflow.worktreeId}.`,
                    );
                }
            }
            {
                const worktreePlan = await loadPlan(workflow.executionCwd, planName);
                if (!worktreePlan) {
                    throw new Error(`Execution preparation did not materialize Plan file for ${planName}.`);
                }
                if (worktreePlan.attrs.planId && worktreePlan.attrs.planId !== stablePlanId) {
                    throw new Error(`Execution preparation Plan ID mismatch for ${planName}.`);
                }
                if (!lockedCanonicalPlanSource) {
                    throw new Error(
                        `Execution preparation did not retain locked canonical Plan evidence for ${planName}.`,
                    );
                }
                const expectedWorktreeStatus = needsExecutionStartedEvent
                    ? "in_progress"
                    : lockedCanonicalPlanSource.attrs.status;
                if (
                    worktreePlan.attrs.classification !== lockedCanonicalPlanSource.attrs.classification ||
                    worktreePlan.attrs.status !== expectedWorktreeStatus
                ) {
                    throw new Error(
                        `RunWield could not synchronize the execution copy of Plan "${planName}". ` +
                            `Your Plan and worktree were preserved. Retry with \`${CLI_BIN} load-plan ${planName}\`; ` +
                            `if it still cannot start, run \`${CLI_BIN} plans doctor --repair\` and retry.`,
                    );
                }
            }
            return {
                planName,
                worktreeId: workflow.worktreeId,
                worktreeBranch: workflow.worktreeBranch,
                worktreeBaseBranch: workflow.worktreeBaseBranch,
                baselineTree: workflow.baselineTree,
                planRevision: (await loadPlan(workflow.executionCwd, planName))?.revision,
            };
        },
    });
    if (transition.status !== "committed") {
        throw new Error(transition.message || `Execution preparation did not commit for ${planName}.`);
    }
    const activeWorkflow =
        /** @type {import('../session/hosted-session.js').ActiveExecutionWorkflow} */ (transition.value);
    hostedSession?.setActiveExecutionWorkflow(activeWorkflow);
    return activeWorkflow;
}
