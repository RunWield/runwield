import { mkdir as fsMkdir, readdir as fsReaddir, readFile as fsReadFile, rm as fsRm } from "node:fs/promises";
/**
 * @module shared/workflow/state-transition
 * Transaction boundary helpers for Plan Lifecycle mutations.
 */

import { dirname, join, resolve } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { CLI_BIN } from "../../constants.js";
import { pickControllerState, type WorkflowControllerState, WORKTREE_CONTEXT_FIELDS } from "./controller-state.ts";
import { enterProjectRuntime, resolveProjectRuntimeLayout } from "../project-runtime-layout.ts";
import {
    controllerStatesEqual,
    restoreOwnControllerWrite,
    withControllerWriteTracking,
    writeControllerState,
} from "./controller-registry.ts";
import {
    atomicWriteTextFile,
    getKnownFrontMatterRevision,
    getPlanDocumentRoot,
    getRecordedPlanWriteFrontMatterRevision,
    getRecordedPlanWriteRevision,
    inspectPlanStrict,
    loadArchivedPlan,
    loadPlan,
    loadPlanStrict,
    parsePlanFrontMatter,
    splitPlanMarkdownBody,
    updatePlanFrontMatter,
    withPlanCatalogLock,
    withPlanLock,
    writePlanMarkdownWithRevision,
} from "../../plan-store.js";
import { SharedPlanLockError } from "../collaboration/lock.ts";
import { findById as findWorktreeRegistryEntryById } from "../worktree-registry.js";
import { recordWorkflowMetric } from "./metrics.js";
import { resolveWorkflowPlanLocation } from "./plan-location.ts";

export interface TransitionRecoveryAction {
    label: string;
    description: string;
    command?: string;
}

export interface TransitionResult {
    status: "committed" | "rolled_back" | "needs_recovery" | "blocked";
    transitionId: string;
    operation: string;
    value?: unknown;
    message?: string;
    recoveryActions?: TransitionRecoveryAction[];
    /**
     * The error that ended the transition, unchanged.
     *
     * Turning a failure into a result must not flatten it to a string. Callers
     * classify typed failures — a merge conflict carries the worktree to repair in
     * and the kind of conflict it was — and reducing that to `message` silently
     * downgrades their recovery to a generic one. Present only on `rolled_back` and
     * `needs_recovery`, where something actually threw.
     */
    cause?: unknown;
}

export interface TransitionResource {
    kind: "catalog" | "plan" | "attempt" | "target_ref";
    id?: string;
    /** The directory that owns this lock, when documents span worktrees. */
    root?: string;
}

/**
 * A resource as it appears when read back from a journal file, where nothing is
 * yet proven to match {@link TransitionResource}.
 */
interface JournaledResource {
    kind?: unknown;
    id?: unknown;
}

/** Canonical Plan snapshot handed to transition callbacks. */
type PlanSnapshot = Awaited<ReturnType<typeof loadPlan>>;
type RecoveryRecord = Awaited<ReturnType<typeof listTransitionRecoveryRecords>>[number];

/** Record a durably-completed external effect in the transition journal. */
type MarkEffect = (effect: string, proof?: Record<string, unknown>) => Promise<void>;

/** Register a compensating action run only if the transition rolls back. */
type RegisterRollback = (label: string, run: () => Promise<void>) => void;

/** Context for callbacks that only read canonical Plan state. */
interface BaseTransitionContext {
    transitionId: string;
    beforePlan: PlanSnapshot;
}

/** Context for callbacks that perform journaled external effects. */
interface EffectTransitionContext extends BaseTransitionContext {
    markEffect: MarkEffect;
}

/** Context for callbacks that may also register compensating rollbacks. */
interface RollbackTransitionContext extends EffectTransitionContext {
    registerRollback: RegisterRollback;
}

/** Fields every semantic transition entry point accepts. */
interface TransitionOptionsBase {
    projectRoot: string;
    planName: string;
    planId?: string;
    worktreeId?: string;
    targetRef?: string;
    expectedRevision?: string;
}

const activeSemanticTransitions = new AsyncLocalStorage<Set<string>>();

function compactError(value: unknown): string {
    return value instanceof Error ? value.message : String(value);
}

function transitionResourceKey(resource: TransitionResource): string {
    return `${resource.kind}:${resource.id || ""}`;
}

/**
 * Whether a resource key identifies something a stalled transition can still own.
 *
 * The catalog is a lock-ordering device, not a claim: almost every composite
 * operation takes it, so treating it as ownership makes one unresolved journal
 * block validation, publication, and archive for every Plan in the project — a
 * project-wide outage caused by a single stranded Plan. Ownership is the Plan
 * itself, the exact attempt, and the target ref, which are the resources whose
 * state a half-finished transition can actually have left uncertain.
 */
function isOwnershipResourceKey(key: string): boolean {
    return !key.startsWith("catalog:");
}

function ownershipResourceKeys(resources: TransitionResource[]): Set<string> {
    return new Set(resources.map(transitionResourceKey).filter(isOwnershipResourceKey));
}

/**
 * Acquire transition resources in deterministic order. Non-Plan resources are
 * represented by lock files in the Plan lock namespace until they get dedicated
 * lock stores; this prevents same-attempt/target-ref races without introducing
 * one global lifecycle lock.
 */
export async function withOrderedTransitionResources<T>(
    projectRoot: string,
    resources: TransitionResource[],
    fn: () => Promise<T>,
): Promise<T> {
    const lockKey = (resource: TransitionResource) =>
        `${transitionResourceKey(resource)}:${resolve(resource.root || projectRoot)}`;
    const ordered = [...new Map(resources.map((resource) => [lockKey(resource), resource])).values()].sort((a, b) =>
        lockKey(a).localeCompare(lockKey(b)),
    );
    const acquireAt = async (index: number): Promise<T> => {
        if (index >= ordered.length) return await fn();
        const resource = ordered[index];
        const root = resource.root || projectRoot;
        if (resource.kind === "catalog") return await withPlanCatalogLock(root, () => acquireAt(index + 1));
        const lockName =
            resource.kind === "plan" ? resource.id || "unknown" : `__${resource.kind}:${resource.id || "unknown"}`;
        return await withPlanLock(root, lockName, () => acquireAt(index + 1));
    };
    return await withControllerWriteTracking(() => acquireAt(0));
}

function withTrackedPlanLock<T>(projectRoot: string, planName: string, run: () => Promise<T>): Promise<T> {
    return withControllerWriteTracking(() => withPlanLock(projectRoot, planName, run));
}

export function getTransitionJournalDir(projectRoot: string): string {
    return resolveProjectRuntimeLayout(projectRoot).selected.transitionJournalsDir;
}

export function getTransitionJournalPath(projectRoot: string, transitionId: string): string {
    return join(getTransitionJournalDir(projectRoot), `${transitionId}.json`);
}

async function enteredTransitionJournalDir(projectRoot: string): Promise<string> {
    return (await enterProjectRuntime(projectRoot)).selected.transitionJournalsDir;
}

async function enteredTransitionJournalPath(projectRoot: string, transitionId: string): Promise<string> {
    return join(await enteredTransitionJournalDir(projectRoot), `${transitionId}.json`);
}

async function writeJournal(projectRoot: string, transitionId: string, record: Record<string, unknown>) {
    const path = await enteredTransitionJournalPath(projectRoot, transitionId);
    await fsMkdir(dirname(path), { recursive: true });
    await atomicWriteTextFile(path, `${JSON.stringify(record, null, 2)}\n`);
}

async function removeJournal(projectRoot: string, transitionId: string) {
    await fsRm(await enteredTransitionJournalPath(projectRoot, transitionId)).catch((error) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
}

/**
 * Undo this transaction's own Plan write, but only when it can prove the write
 * was its own.
 *
 * The Plan lock keeps other RunWield writers out, but it cannot stop an editor,
 * a shell command, or a `git checkout` from touching the same file. So a changed
 * revision alone is not evidence of authorship, and blindly restoring would
 * silently destroy an outside edit.
 *
 * `getRecordedPlanWriteRevision` closes that gap: every RunWield Plan write goes
 * through one revision-checked writer that records what it wrote. If the file
 * still holds exactly those bytes, this transaction is the last writer and the
 * restore is safe. If it holds anything else, someone outside the lock wrote
 * last and we fail closed with a journal.
 *
 * The body is handled separately because RunWield does not own it. When the file
 * holds RunWield's Front Matter but a body someone else edited, the safe undo is
 * a Front-Matter-only revert: put back the metadata this transaction changed and
 * leave the user's prose exactly as they wrote it. That case is expected, not
 * exceptional — bodies are edited outside RunWield by design.
 *
 * @returns the restored revision, or null when restoring is not provably safe.
 */
async function restoreOwnPlanWrite({
    projectRoot,
    planName,
    beforePlan,
    currentRevision,
}: {
    projectRoot: string;
    planName: string;
    beforePlan: LockedPlan;
    currentRevision?: string;
}): Promise<string | null> {
    if (!currentRevision) return null;
    if (
        !(await restoreOwnControllerWrite(projectRoot, { planName, planId: beforePlan.attrs.planId }, beforePlan.attrs))
    )
        return null;
    if (currentRevision === beforePlan.revision) return currentRevision;
    const ownsWholeFile = currentRevision === getRecordedPlanWriteRevision(beforePlan.path);
    const current = ownsWholeFile ? null : await loadPlan(projectRoot, planName).catch(() => null);
    // A controller-only write leaves no authored document revision. After undoing
    // that write, a user's body-only edit needs no compensating document write.
    if (current && planEffectsAreSettled(beforePlan, current)) return current.revision;
    let restoredMarkdown = beforePlan.markdown;
    if (!ownsWholeFile) {
        // Not our bytes as a whole. The only remaining provably-safe undo is the
        // Front Matter, and only if RunWield is still its author.
        if (
            !current ||
            current.revision !== currentRevision ||
            !current.frontMatterRevision ||
            current.frontMatterRevision !== getRecordedPlanWriteFrontMatterRevision(beforePlan.path)
        )
            return null;
        try {
            restoredMarkdown = `${splitPlanMarkdownBody(beforePlan.markdown).frontMatterBlock}${
                splitPlanMarkdownBody(current.markdown).body
            }`;
        } catch {
            return null;
        }
    }
    try {
        // Compare-and-set against the bytes we just proved carry our metadata, so a
        // writer that slips in between the check and the write loses the race
        // instead of being overwritten.
        await writePlanMarkdownWithRevision(beforePlan.path, restoredMarkdown, currentRevision);
    } catch {
        return null;
    }
    const restored = await loadPlan(projectRoot, planName).catch(() => null);
    if (!restored?.revision) return null;
    if (ownsWholeFile) return restored.revision === beforePlan.revision ? restored.revision : null;
    // A Front-Matter-only revert cannot reproduce the original whole-file revision,
    // so the proof is that the metadata matches and the user's body survived.
    return restored.frontMatterRevision &&
        restored.frontMatterRevision === beforePlan.frontMatterRevision &&
        restored.body === current?.body
        ? restored.revision
        : null;
}

/** A Plan snapshot read under the transition's own lock. */
type LockedPlan = NonNullable<PlanSnapshot>;

/**
 * Decide whether an expected Plan revision is still a usable precondition.
 *
 * RunWield owns Plan Front Matter; the user owns the body and may edit it with any
 * tool, at any time, without telling RunWield. A whole-file revision token goes
 * stale for both reasons at once, and only one of them is a conflict: another
 * writer changed the metadata this operation is about to change. Rejecting a
 * lifecycle action because someone rewrote a paragraph of prose would make the
 * body RunWield's property, which it is not.
 *
 * Body-only drift is proven, never assumed: the expected token's Front Matter
 * block must be known to this process and byte-identical to what is on disk now.
 * An unknown token (a different process, a restart) falls back to strict
 * whole-file comparison.
 */
function classifyPlanPrecondition(
    expectedRevision: string,
    beforePlan: PlanSnapshot,
): {
    stale: boolean;
    bodyOnlyDrift: boolean;
} {
    if (!beforePlan) return { stale: true, bodyOnlyDrift: false };
    if (beforePlan.revision === expectedRevision) return { stale: false, bodyOnlyDrift: false };
    const expectedFrontMatterRevision = getKnownFrontMatterRevision(expectedRevision);
    const bodyOnlyDrift = Boolean(
        expectedFrontMatterRevision &&
        beforePlan.frontMatterRevision &&
        expectedFrontMatterRevision === beforePlan.frontMatterRevision,
    );
    return { stale: !bodyOnlyDrift, bodyOnlyDrift };
}

/**
 * Decide whether the Plan file holds nothing this transaction left behind.
 *
 * Byte-identical is the easy proof. The other accepted proof is that the Front
 * Matter — the only part a lifecycle transition writes — is unchanged while the
 * body differs from bytes RunWield authored: that difference belongs to the user,
 * who owns the body, so there is nothing here for RunWield to undo. Body drift
 * that RunWield itself wrote is still outstanding work.
 */
function planEffectsAreSettled(beforePlan: PlanSnapshot, current: PlanSnapshot): boolean {
    if (!beforePlan) return true;
    if (!current) return false;
    if (!controllerStatesEqual(beforePlan.attrs, current.attrs)) return false;
    if (current.revision === beforePlan.revision) return true;
    if (
        !current.frontMatterRevision ||
        !beforePlan.frontMatterRevision ||
        current.frontMatterRevision !== beforePlan.frontMatterRevision
    )
        return false;
    return current.revision !== getRecordedPlanWriteRevision(beforePlan.path);
}

/** One compensating action's outcome, as recorded during failure handling. */
interface RollbackResult {
    label: string;
    status: "rolled_back" | "failed";
    error?: string;
}

/** A durable effect the transition marked as completed before it failed. */
interface CompletedEffect {
    effect: string;
    proof?: Record<string, unknown>;
    completedAt: string;
}

/**
 * Decide whether a failed transition provably left nothing behind.
 *
 * The journal is a blocking record: while one exists, every later transition on
 * the same resources refuses to run. That is the right behavior for a genuinely
 * uncertain repository, and the wrong behavior for a failure that never got far
 * enough to change anything — a disallowed Plan Event, a stale review decision,
 * a failed precondition. Those must stay retryable.
 *
 * "Provably clean" therefore requires positive evidence, never an assumption:
 * the Plan file is byte-identical to what was read under the lock, no
 * irreversible effect was marked, and every marked effect was undone by a
 * compensation that itself succeeded.
 */
function classifyTransitionFailure({
    planSettled,
    completedEffects,
    rollbackResults,
    irreversibleEffects,
}: {
    planSettled: boolean;
    completedEffects: CompletedEffect[];
    rollbackResults: RollbackResult[];
    irreversibleEffects: string[];
}): { provablyClean: boolean; reason?: string } {
    const completedEffectNames = new Set(completedEffects.map((effect) => effect.effect));
    const irreversible = irreversibleEffects.filter((effect) => completedEffectNames.has(effect));
    if (irreversible.length > 0) {
        return { provablyClean: false, reason: `irreversible_effect:${irreversible.join(",")}` };
    }
    const failedRollback = rollbackResults.find((result) => result.status === "failed");
    if (failedRollback) {
        return { provablyClean: false, reason: `rollback_failed:${failedRollback.label}` };
    }
    // Effects were marked but nothing was registered to undo them, so their
    // external state (Git refs, worktrees, registry rows) is unaccounted for.
    if (completedEffects.length > 0 && rollbackResults.length === 0) {
        return { provablyClean: false, reason: "effects_without_compensation" };
    }
    // Checked last because, unlike the conditions above, this one is repairable:
    // the caller can undo a Plan write it can prove it made and ask again.
    if (!planSettled) return { provablyClean: false, reason: "plan_bytes_changed" };
    return { provablyClean: true };
}

/**
 * Actions for a Plan file RunWield cannot parse. The user owns the body and may
 * have edited the file by hand, so the fix is theirs to make — which means the
 * message has to name the file and the exact command that re-checks it.
 */
function planFileActions(planName: string, path: string): TransitionRecoveryAction[] {
    return [
        {
            label: `Repair the Front Matter in ${planName}`,
            description: `Open ${path} and fix the YAML between the leading --- markers. RunWield owns that block; your body text below it is untouched and does not need to be valid YAML.`,
        },
        {
            label: "Re-check the Plan file",
            description: "Confirms RunWield can read the Plan again and reports anything else it finds.",
            command: `${CLI_BIN} plans doctor`,
        },
        {
            label: "Compare against the last committed version",
            description: "Shows what changed in the Front Matter if the file was working before.",
            command: `git diff -- ${path}`,
        },
    ];
}

/**
 * Explain a block caused by an unresolved journal in the user's terms.
 *
 * The record is RunWield's own bookkeeping, so a bare internal id and an
 * operation label is not an explanation — it reads as RunWield failing at its own
 * paperwork and handing the bill to the user. Say what is being protected, and
 * point at the command that resolves it.
 */
/**
 * Plain-language names for what RunWield was doing. The internal operation id is
 * meaningful to this module and to nobody else: a user in an unrelated project
 * reading "direct_delivery_publication" learns only that something inside RunWield
 * has a name.
 */
const OPERATION_DESCRIPTIONS: Record<string, string> = {
    direct_delivery_publication: "merging this Plan's finished work into the target branch",
    implementation_checkpoint: "saving a checkpoint of the implementation work",
    execution_preparation: "setting up the execution worktree",
    epic_decomposition_finalize: "writing this Epic's child Plans",
    plan_review_write: "saving the Plan review decision",
    review_reopened: "reopening this Plan for review",
    validation_merge_repair_worktree: "saving the merge repair worktree for publication retry",
};

function describeOperation(operation: unknown): string {
    if (typeof operation !== "string") return "an operation on this Plan";
    return OPERATION_DESCRIPTIONS[operation] || "an operation on this Plan";
}

function unresolvedTransitionMessage(record: Record<string, unknown>, _operation: string, planName: string): string {
    const completed = Array.isArray(record.completedEffects) ? record.completedEffects : [];
    const cause = typeof record.error === "string" && record.error.trim() ? record.error.trim() : "";

    const lines = [
        `RunWield stopped part-way through ${describeOperation(record.operation)} for ${planName}, ` +
            `and cannot tell by itself whether that finished.`,
    ];
    if (completed.length === 0) {
        lines.push("Nothing was changed: no work was merged and no files were moved.");
    } else {
        lines.push(
            `Some of it did complete, so the repository may already be partly updated. ` +
                `Do not repeat the step by hand until this is settled.`,
        );
    }
    // The reason lives in the record and is usually the whole answer — an overlapping
    // uncommitted file, a moved branch. Printing RunWield's caution while withholding
    // the cause leaves the user with a problem statement and no problem.
    if (cause) lines.push(`Why it stopped: ${cause}`);
    lines.push(
        `Until this is settled, RunWield will not make further changes to ${planName}, ` +
            `because a second change on top of an uncertain one is how work gets lost.`,
    );
    return lines.join("\n");
}

function unresolvedTransitionActions(planName: string): TransitionRecoveryAction[] {
    return [
        {
            label: "Let RunWield close what it can prove",
            description:
                "Checks the repository and clears the record if the interrupted work is provably finished or provably never happened.",
            command: `${CLI_BIN} plans doctor --repair`,
        },
        {
            label: "See exactly what is unresolved",
            description: "Reports the record, the effects it names, and what evidence is still missing.",
            command: `${CLI_BIN} plans doctor`,
        },
        {
            label: "Resolve it through Plan Recovery",
            description:
                "Recovery supersedes the record: pick continue, retry, merge, or abandon and RunWield clears it on success.",
            command: `${CLI_BIN} load-plan ${planName}`,
        },
    ];
}

function planAction(planName: string) {
    return [
        {
            label: "Reload the Plan and retry",
            description: `Re-read docs/plans/${planName}.md, then repeat the action so RunWield uses current Plan metadata.`,
        },
        {
            label: "Inspect with load-plan",
            description: "Open the Plan recovery flow for details and safe next actions.",
            command: `wld load-plan ${planName}`,
        },
    ];
}

/**
 * Run a semantic lifecycle transition across ordered resources with a durable
 * recovery journal. This is the boundary for operations that include Plan,
 * registry, Git/worktree, and target-ref effects.
 */
async function runSemanticTransition<T>({
    projectRoot,
    planName,
    operation,
    resources,
    apply,
    expectedRevision,
    recoveryActions,
    postconditions = {},
    expectedEffects = [],
    verify,
    irreversibleEffects = [],
    supersedesUnresolved = false,
    supersedesOperations = [],
}: TransitionOptionsBase & {
    operation: string;
    resources: TransitionResource[];
    apply: (ctx: RollbackTransitionContext & { expectedRevision?: string }) => Promise<T>;
    recoveryActions?: TransitionRecoveryAction[];
    postconditions?: Record<string, unknown>;
    /**
     * Effects the transition refuses to commit without.
     *
     * Only ever effects the caller marks. Listing an effect this wrapper marks
     * itself asserts that the wrapper called its own function, which is not a
     * postcondition — it reads like proof while guaranteeing nothing.
     */
    expectedEffects?: string[];
    verify?: (value: T) => Promise<Record<string, unknown> | void>;
    /**
     * Effects that cannot be compensated once marked (a moved target ref).
     * Marking one forces `needs_recovery` even if every rollback succeeded.
     */
    irreversibleEffects?: string[];
    /**
     * Set by operations whose purpose is to resolve an uncertain repository
     * (Plan Recovery). They must run despite an unresolved journal on their
     * own resources, otherwise the only recovery path is blocked by the very
     * record it exists to clear, and the Plan is stranded for good.
     */
    supersedesUnresolved?: boolean;
    /** Resume only named operations; unrelated uncertainty still blocks. */
    supersedesOperations?: string[];
}): Promise<TransitionResult> {
    const transitionId = crypto.randomUUID();
    const completedEffects: Array<{ effect: string; proof?: Record<string, unknown>; completedAt: string }> = [];
    const rollbackActions: Array<{ label: string; run: () => Promise<void> }> = [];
    // Before-facts are recorded once, at prepare, and every later state carries them.
    // Each write replaces the whole record, so a state change used to erase them — and a
    // record with no before-revision can never be proven settled, which permanently
    // strands its Plan. That is exactly what a cancelled execution start produced: state
    // "applying", no effects, nothing to compare, no way back.
    let journaledBeforeFacts: Record<string, unknown> | undefined;
    const writeState = async (state: string, extra: Record<string, unknown> = {}) => {
        if (extra.beforeFacts && typeof extra.beforeFacts === "object") {
            journaledBeforeFacts = extra.beforeFacts as Record<string, unknown>;
        }
        await writeJournal(projectRoot, transitionId, {
            version: 1,
            transitionId,
            operation,
            planName,
            resources,
            state,
            intendedPostconditions: postconditions,
            completedEffects,
            ...(journaledBeforeFacts ? { beforeFacts: journaledBeforeFacts } : {}),
            updatedAt: new Date().toISOString(),
            ...extra,
        });
    };
    const markEffect: MarkEffect = async (effect, proof) => {
        completedEffects.push({ effect, ...(proof ? { proof } : {}), completedAt: new Date().toISOString() });
        await writeState("applying");
    };
    const registerRollback: RegisterRollback = (label, run) => {
        rollbackActions.push({ label, run });
    };
    const actions = recoveryActions || planAction(planName);
    const parentActiveTransitions = activeSemanticTransitions.getStore();
    const activeTransitionIds = new Set(parentActiveTransitions || []);
    activeTransitionIds.add(transitionId);
    return await activeSemanticTransitions.run(
        activeTransitionIds,
        async () =>
            await withOrderedTransitionResources(projectRoot, resources, async () => {
                const strictBefore = await loadPlanStrict(projectRoot, planName);
                // A Plan file RunWield cannot read is a blocked precondition, not a
                // partial transition: nothing has been applied yet, so there is
                // nothing to recover. Journaling it would leave a record no evidence
                // can ever close — the journal carries no before-revision to compare
                // — and that record would block every later operation on this Plan
                // even after the file is fixed. `wld plans doctor` reports the file
                // itself, which is the actual problem to solve.
                if (strictBefore.kind !== "loaded" && strictBefore.kind !== "not_found") {
                    const message =
                        strictBefore.kind === "malformed"
                            ? strictBefore.error.message
                            : "message" in strictBefore
                              ? strictBefore.message
                              : "error" in strictBefore
                                ? strictBefore.error.message
                                : `Plan not found: ${planName}`;
                    return {
                        status: "blocked",
                        transitionId,
                        operation,
                        message,
                        recoveryActions: planFileActions(planName, strictBefore.path),
                    };
                }
                const beforePlan =
                    strictBefore.kind === "loaded"
                        ? {
                              path: strictBefore.path,
                              markdown: strictBefore.markdown,
                              attrs: strictBefore.attrs,
                              controllerRevision: strictBefore.controllerRevision,
                              body: strictBefore.body,
                              revision: strictBefore.revision,
                              frontMatterRevision: strictBefore.frontMatterRevision,
                          }
                        : null;
                const existingRecoveryRecords = await listTransitionRecoveryRecords(projectRoot);
                const resourceKeys = ownershipResourceKeys(resources);
                const conflictsWithThisTransition = (record: Record<string, unknown>) => {
                    if (
                        record.transitionId === transitionId ||
                        activeTransitionIds.has(String(record.transitionId || ""))
                    )
                        return false;
                    if (record.planName === planName) return true;
                    if (!Array.isArray(record.resources)) return false;
                    return record.resources.some((resource: unknown) => {
                        if (!resource || typeof resource !== "object") return false;
                        const { kind, id } = resource as JournaledResource;
                        if (typeof kind !== "string") return false;
                        const key = `${kind}:${typeof id === "string" ? id : ""}`;
                        return isOwnershipResourceKey(key) && resourceKeys.has(key);
                    });
                };
                const canSupersede = (record: RecoveryRecord) =>
                    supersedesUnresolved ||
                    (record.planName === planName &&
                        typeof record.operation === "string" &&
                        supersedesOperations.includes(record.operation));
                const conflictingRecoveryRecord = existingRecoveryRecords.find(
                    (record) => conflictsWithThisTransition(record) && !canSupersede(record),
                );
                if (conflictingRecoveryRecord) {
                    return {
                        status: "blocked",
                        transitionId,
                        operation,
                        message: unresolvedTransitionMessage(conflictingRecoveryRecord, operation, planName),
                        recoveryActions: unresolvedTransitionActions(planName),
                    };
                }
                const supersededRecords = existingRecoveryRecords.filter(
                    (record) => conflictsWithThisTransition(record) && canSupersede(record),
                );
                if (expectedRevision !== undefined) {
                    const precondition = classifyPlanPrecondition(expectedRevision, beforePlan);
                    if (precondition.stale) {
                        const message = beforePlan
                            ? `${planName} changed after this operation read it, so RunWield stopped instead of overwriting the newer Plan metadata.`
                            : `${planName} is missing, so this operation has nothing to update.`;
                        // Stale/precondition mismatches are typed caller outcomes, not partial lifecycle effects.
                        // Do not durably journal them: recovery scans treat any remaining journal as unresolved work.
                        return { status: "blocked", transitionId, operation, message, recoveryActions: actions };
                    }
                }
                const attemptBeforeFacts = await Promise.all(
                    resources
                        .filter((resource) => resource.kind === "attempt")
                        .map(async (resource) => {
                            if (!resource.id) return { id: "", entry: null };
                            // Non-migrating: this read only records before-facts, and
                            // the migrating variant backfills missing planIds into
                            // Plan Front Matter — including the Plan snapshotted in
                            // `beforePlan` moments ago, whose Front Matter revision
                            // later preconditions compare against.
                            const entry = await findWorktreeRegistryEntryById(projectRoot, resource.id, {
                                migrate: false,
                            }).catch(() => null);
                            return {
                                id: resource.id,
                                entry: entry
                                    ? {
                                          planName: entry.planName,
                                          planId: entry.planId,
                                          path: entry.path,
                                          branch: entry.branch,
                                          status: entry.status,
                                          executionBaselineTree: entry.executionBaselineTree,
                                          updatedAt: entry.updatedAt,
                                      }
                                    : null,
                            };
                        }),
                );
                await writeState("prepared", {
                    preparedAt: new Date().toISOString(),
                    beforeFacts: {
                        plan: beforePlan
                            ? {
                                  path: beforePlan.path,
                                  revision: beforePlan.revision,
                                  status: beforePlan.attrs.status,
                                  controllerState: pickControllerState(beforePlan.attrs),
                              }
                            : { missing: true },
                        ...(attemptBeforeFacts.length > 0 ? { worktreeRegistry: attemptBeforeFacts } : {}),
                    },
                });
                try {
                    await writeState("applying");
                    const value = await apply({
                        transitionId,
                        beforePlan,
                        expectedRevision: beforePlan?.revision,
                        markEffect,
                        registerRollback,
                    });
                    await writeState("verifying", { proof: value });
                    for (const expectedEffect of expectedEffects) {
                        if (!completedEffects.some((effect) => effect.effect === expectedEffect)) {
                            throw new Error(
                                `Transition ${operation} did not prove expected effect: ${expectedEffect}.`,
                            );
                        }
                    }
                    const afterPlan = await loadPlan(projectRoot, planName);
                    const verificationProof = verify ? await verify(value) : undefined;
                    await writeState("committed", {
                        committedAt: new Date().toISOString(),
                        proof: value,
                        afterFacts: afterPlan
                            ? {
                                  plan: {
                                      path: afterPlan.path,
                                      revision: afterPlan.revision,
                                      status: afterPlan.attrs.status,
                                  },
                              }
                            : { plan: { missing: true } },
                        ...(verificationProof ? { verificationProof } : {}),
                    });
                    await removeJournal(projectRoot, transitionId);
                    // The recovery just settled the uncertainty these records
                    // described, so retiring them here is what actually returns
                    // the Plan to normal operation.
                    for (const superseded of supersededRecords) {
                        const supersededId = String(superseded.transitionId || "");
                        if (supersededId) await removeJournal(projectRoot, supersededId);
                    }
                    await recordWorkflowMetric(
                        {
                            category: "recovery",
                            event: "semantic_transition_committed",
                            planName,
                            details: { operation, resources: resources.map(transitionResourceKey) },
                        },
                        projectRoot,
                    ).catch(() => {});
                    return { status: "committed", transitionId, operation, value };
                } catch (error) {
                    if (error instanceof SharedPlanLockError) throw error;
                    const message = compactError(error);
                    // Fail closed instead of restoring Plan bytes here. A logical RunWield
                    // lock does not prove that the current file revision belongs to this
                    // transition; an editor, Git checkout, or recovery operator may have
                    // changed the same bytes outside the lock. The journal keeps the
                    // before facts and completed effect proofs so doctor/recovery can make
                    // an explicit, evidence-based repair without overwriting uncertain work.
                    const rollbackResults: RollbackResult[] = [];
                    for (const rollback of rollbackActions.toReversed()) {
                        try {
                            await rollback.run();
                            rollbackResults.push({ label: rollback.label, status: "rolled_back" });
                        } catch (rollbackError) {
                            rollbackResults.push({
                                label: rollback.label,
                                status: "failed",
                                error: compactError(rollbackError),
                            });
                        }
                    }
                    const currentPlan = await loadPlan(projectRoot, planName).catch(() => null);
                    const currentPlanRevision = currentPlan?.revision;
                    const classify = (planSettled: boolean) =>
                        classifyTransitionFailure({
                            planSettled,
                            completedEffects,
                            rollbackResults,
                            irreversibleEffects,
                        });
                    let outcome = classify(planEffectsAreSettled(beforePlan, currentPlan));
                    // Registered compensations already ran above; the Plan write is
                    // the one effect they cannot cover, so undo it here when this
                    // transaction can prove it was the writer. Only worth trying when
                    // nothing else is outstanding — otherwise the journal stays either
                    // way and restoring would just move bytes for no gain.
                    if (!outcome.provablyClean && outcome.reason === "plan_bytes_changed" && beforePlan) {
                        const restoredRevision = await restoreOwnPlanWrite({
                            projectRoot,
                            planName,
                            beforePlan,
                            currentRevision: currentPlanRevision,
                        });
                        if (restoredRevision) outcome = classify(true);
                    }
                    // A journal blocks every later transition on these resources until
                    // something proves the repository safe, so only write one when this
                    // failure could actually have left durable state behind. A rejected
                    // precondition that never touched a byte must not strand the Plan.
                    if (outcome.provablyClean) {
                        await removeJournal(projectRoot, transitionId);
                        return {
                            status: "rolled_back",
                            transitionId,
                            operation,
                            message,
                            recoveryActions: actions,
                            cause: error,
                        };
                    }
                    await writeState("needs_recovery", {
                        error: message,
                        currentPlanRevision,
                        uncertainty: outcome.reason,
                        ...(rollbackResults.length > 0 ? { rollbackResults } : {}),
                        recoveryActions: actions,
                    });
                    return {
                        status: "needs_recovery",
                        transitionId,
                        operation,
                        message,
                        recoveryActions: actions,
                        cause: error,
                    };
                }
            }),
    );
}

/**
 * Prepare FEATURE execution as one semantic transition: worktree selection or
 * creation, Plan materialization, baseline capture, registry settlement, and
 * execution_started Plan Event recording must all happen while holding the Plan,
 * exact attempt, and target-ref resources.
 */
export async function runExecutionPreparationTransition<T>({
    projectRoot,
    planName,
    planId: _planId,
    worktreeId,
    targetRef,
    expectedRevision,
    expectedPlanEvent = true,
    resumeInterrupted = false,
    prepare,
    verifyPreparation,
}: TransitionOptionsBase & {
    expectedPlanEvent?: boolean;
    /** Original source authority proved this first preparation is safe to resume. */
    resumeInterrupted?: boolean;
    prepare: (ctx: RollbackTransitionContext) => Promise<T>;
    verifyPreparation?: (value: T, ctx: BaseTransitionContext) => Promise<unknown> | unknown;
}): Promise<TransitionResult> {
    const resources: TransitionResource[] = [{ kind: "plan", id: planName }];
    if (worktreeId) resources.push({ kind: "attempt", id: worktreeId });
    if (targetRef) resources.push({ kind: "target_ref", id: targetRef });
    return await runSemanticTransition({
        projectRoot,
        planName,
        operation: "execution_preparation",
        supersedesOperations: resumeInterrupted ? ["execution_preparation"] : [],
        resources,
        expectedRevision,
        expectedEffects: expectedPlanEvent ? ["plan_event_recorded"] : [],
        apply: async (ctx) => {
            const value = await prepare(ctx);
            const preparationProof = verifyPreparation ? await verifyPreparation(value, ctx) : { planName };
            await ctx.markEffect("execution_prepared", (preparationProof || { planName }) as Record<string, unknown>);
            return value;
        },
        recoveryActions: [
            ...planAction(planName),
            {
                label: "Inspect execution worktree evidence",
                description:
                    "If worktree creation or registry settlement was interrupted, inspect the recorded worktree path/branch before deleting or recreating it.",
            },
        ],
    });
}

/**
 * Run one same-Plan transaction with a durable journal and conservative rollback.
 * The apply callback must perform only effects protected by the acquired Plan lock
 * unless it records its own external proof before mutating Git or registry state.
 */
async function runPlanTransition<T>({
    projectRoot,
    planName,
    operation,
    apply,
    expectedRevision,
}: TransitionOptionsBase & {
    operation: string;
    apply: (ctx: BaseTransitionContext) => Promise<T>;
}): Promise<TransitionResult> {
    const transitionId = crypto.randomUUID();
    return await withTrackedPlanLock(projectRoot, planName, async () => {
        const strictBefore = await loadPlanStrict(projectRoot, planName);
        // Unreadable Plan bytes are a blocked precondition, not partial work. See
        // the matching branch in runSemanticTransition: journaling this would
        // create a record nothing can ever close.
        if (strictBefore.kind !== "loaded" && strictBefore.kind !== "not_found") {
            const message =
                strictBefore.kind === "malformed"
                    ? strictBefore.error.message
                    : "message" in strictBefore
                      ? strictBefore.message
                      : "error" in strictBefore
                        ? strictBefore.error.message
                        : `Plan not found: ${planName}`;
            return {
                status: "blocked",
                transitionId,
                operation,
                message,
                recoveryActions: planFileActions(planName, strictBefore.path),
            };
        }
        const beforePlan =
            strictBefore.kind === "loaded"
                ? {
                      path: strictBefore.path,
                      markdown: strictBefore.markdown,
                      attrs: strictBefore.attrs,
                      controllerRevision: strictBefore.controllerRevision,
                      body: strictBefore.body,
                      revision: strictBefore.revision,
                      frontMatterRevision: strictBefore.frontMatterRevision,
                  }
                : null;
        const activeTransitionIds = activeSemanticTransitions.getStore() || new Set();
        const existingRecoveryRecords = await listTransitionRecoveryRecords(projectRoot);
        const conflictingRecoveryRecord = existingRecoveryRecords.find((record) => {
            if (record.transitionId === transitionId || activeTransitionIds.has(String(record.transitionId || ""))) {
                return false;
            }
            if (record.planName === planName) return true;
            if (!Array.isArray(record.resources)) return false;
            return record.resources.some((resource: unknown) => {
                if (!resource || typeof resource !== "object") return false;
                const { kind, id } = resource as JournaledResource;
                return kind === "plan" && id === planName;
            });
        });
        if (conflictingRecoveryRecord) {
            const message = unresolvedTransitionMessage(conflictingRecoveryRecord, operation, planName);
            return {
                status: "blocked",
                transitionId,
                operation,
                message,
                recoveryActions: unresolvedTransitionActions(planName),
            };
        }
        if (expectedRevision !== undefined) {
            const precondition = classifyPlanPrecondition(expectedRevision, beforePlan);
            if (precondition.stale) {
                const message = beforePlan
                    ? `${planName} changed after this operation read it, so RunWield stopped instead of overwriting the newer Plan metadata.`
                    : `${planName} is missing, so this operation has nothing to update.`;
                // Stale/precondition mismatches are typed caller outcomes, not partial lifecycle effects.
                // Do not durably journal them: recovery scans treat any remaining journal as unresolved work.
                return {
                    status: "blocked",
                    transitionId,
                    operation,
                    message,
                    recoveryActions: planAction(planName),
                };
            }
        }
        await writeJournal(projectRoot, transitionId, {
            version: 1,
            transitionId,
            operation,
            planName,
            state: "prepared",
            preparedAt: new Date().toISOString(),
            before: beforePlan
                ? {
                      path: beforePlan.path,
                      revision: beforePlan.revision,
                      status: beforePlan.attrs.status,
                      controllerState: pickControllerState(beforePlan.attrs),
                  }
                : { missing: true },
        });
        try {
            await writeJournal(projectRoot, transitionId, {
                version: 1,
                transitionId,
                operation,
                planName,
                state: "applying",
                before: beforePlan
                    ? { revision: beforePlan.revision, controllerState: pickControllerState(beforePlan.attrs) }
                    : { missing: true },
                updatedAt: new Date().toISOString(),
            });
            const value = await apply({ transitionId, beforePlan });
            await writeJournal(projectRoot, transitionId, {
                version: 1,
                transitionId,
                operation,
                planName,
                state: "committed",
                committedAt: new Date().toISOString(),
            });
            await removeJournal(projectRoot, transitionId);
            await recordWorkflowMetric(
                {
                    category: "recovery",
                    event: "plan_transition_committed",
                    planName,
                    details: { operation },
                },
                projectRoot,
            ).catch(() => {});
            return { status: "committed", transitionId, operation, value };
        } catch (error) {
            if (error instanceof SharedPlanLockError) throw error;
            const message = compactError(error);
            // Do not restore beforePlan bytes over the current file here. At this
            // layer we cannot prove whether a revision change is this transition's
            // partial write or an unmanaged external edit, so fail closed and keep
            // the journal for explicit recovery instead of overwriting another
            // writer's bytes.
            //
            // When the bytes are unchanged there is nothing to fail closed over:
            // this layer's only durable effect is the Plan write itself, so an
            // identical revision proves the write never landed. Rejections that
            // belong to normal operation reach here — a stale review decision is
            // the designed outcome of reviewing an edited Plan — and must leave
            // the Plan retryable rather than blocked.
            const currentPlan = await loadPlan(projectRoot, planName).catch(() => null);
            const currentPlanRevision = currentPlan?.revision;
            // Undoing a partial write is the whole compensation at this layer: the
            // Plan file is the only durable thing `apply` may touch here. When
            // nothing RunWield owns changed, or when it changed and we can prove we
            // were the writer, the repository is provably back to its starting state
            // and the Plan must stay usable rather than be blocked by a journal.
            const settled = planEffectsAreSettled(beforePlan, currentPlan);
            const restoredRevision =
                beforePlan && !settled
                    ? await restoreOwnPlanWrite({
                          projectRoot,
                          planName,
                          beforePlan,
                          currentRevision: currentPlanRevision,
                      })
                    : null;
            if (!beforePlan || settled || restoredRevision) {
                await removeJournal(projectRoot, transitionId);
                return {
                    status: "rolled_back",
                    transitionId,
                    operation,
                    message,
                    recoveryActions: planAction(planName),
                    cause: error,
                };
            }
            await writeJournal(projectRoot, transitionId, {
                version: 1,
                transitionId,
                operation,
                planName,
                state: "needs_recovery",
                error: message,
                uncertainty: "plan_bytes_changed",
                beforeFacts: {
                    plan: { revision: beforePlan.revision, controllerState: pickControllerState(beforePlan.attrs) },
                },
                currentPlanRevision,
                recoveryActions: planAction(planName),
                updatedAt: new Date().toISOString(),
            });
            return {
                status: "needs_recovery",
                transitionId,
                operation,
                message,
                recoveryActions: planAction(planName),
                cause: error,
            };
        }
    });
}

/**
 * Semantic boundary for lifecycle Plan Events owned by plan-lifecycle.js.
 */
export async function runPlanLifecycleEventTransition<T>(
    opts: TransitionOptionsBase & {
        event: string;
        resources?: TransitionResource[];
        record: (ctx: BaseTransitionContext) => Promise<T>;
    },
): Promise<TransitionResult> {
    if (opts.resources && opts.resources.length > 0) {
        return await runSemanticTransition({
            projectRoot: opts.projectRoot,
            planName: opts.planName,
            operation: `plan_event:${opts.event}`,
            resources: opts.resources,
            expectedRevision: opts.expectedRevision,
            apply: async (ctx) => {
                const value = await opts.record(ctx);
                await ctx.markEffect("plan_event_recorded", { planName: opts.planName, event: opts.event });
                return value;
            },
        });
    }
    return await runPlanTransition({
        projectRoot: opts.projectRoot,
        planName: opts.planName,
        operation: `plan_event:${opts.event}`,
        expectedRevision: opts.expectedRevision,
        apply: opts.record,
    });
}

/**
 * Semantic boundary for applying a Plan review approval/feedback decision.
 *
 * Reapproval preserves the execution attempt while replacing review evidence.
 * Pass `worktreeId` to lock the same attempt during the Plan decision; review
 * never retires the registry entry.
 */
export async function runPlanReviewDecisionTransition<T>(
    opts: TransitionOptionsBase & {
        approved: boolean;
        decide: (ctx: RollbackTransitionContext) => Promise<T>;
    },
): Promise<TransitionResult> {
    const operation = opts.approved ? "plan_review_approved" : "plan_review_feedback";
    if (!opts.worktreeId) {
        return await runPlanTransition({
            projectRoot: opts.projectRoot,
            planName: opts.planName,
            operation,
            expectedRevision: opts.expectedRevision,
            // No attempt to detach, so this is a single-resource Plan write with no
            // external effects. The capabilities are still passed, but they refuse
            // rather than no-op: an effect marked here would be journalled nowhere,
            // and a rollback registered here would never run.
            apply: (ctx) =>
                opts.decide({
                    ...ctx,
                    markEffect: () => {
                        throw new Error(
                            `${operation} marked an external effect without an attempt resource; pass worktreeId.`,
                        );
                    },
                    registerRollback: () => {
                        throw new Error(
                            `${operation} registered a rollback without an attempt resource; pass worktreeId.`,
                        );
                    },
                }),
        });
    }
    return await runSemanticTransition({
        projectRoot: opts.projectRoot,
        planName: opts.planName,
        operation,
        resources: [
            { kind: "plan", id: opts.planName },
            { kind: "attempt", id: opts.worktreeId },
        ],
        expectedRevision: opts.expectedRevision,
        expectedEffects: [],
        apply: opts.decide,
    });
}

/** One review decision owns the complete Sequence, including every child lock. */
interface SequenceReviewTransitionOptions<T> extends TransitionOptionsBase {
    approved: boolean;
    planNames: string[];
    decide: (ctx: RollbackTransitionContext) => Promise<T>;
}

export async function runSequenceReviewTransition<T>(
    opts: SequenceReviewTransitionOptions<T>,
): Promise<TransitionResult> {
    return await runSemanticTransition({
        projectRoot: opts.projectRoot,
        planName: opts.planName,
        operation: opts.approved ? "sequence_review_approved" : "sequence_review_feedback",
        resources: [{ kind: "catalog" }, ...opts.planNames.map((id) => ({ kind: "plan" as const, id }))],
        expectedEffects: ["sequence_review_prepared", "sequence_review_accepted"],
        apply: opts.decide,
    });
}

/**
 * Semantic boundary for reopening review while retaining its execution attempt.
 */
export async function runReviewReopenTransition<T>(
    opts: TransitionOptionsBase & { worktreeId: string; reopen: (ctx: EffectTransitionContext) => Promise<T> },
): Promise<TransitionResult> {
    return await runSemanticTransition({
        projectRoot: opts.projectRoot,
        planName: opts.planName,
        operation: "review_reopened",
        resources: [
            { kind: "plan", id: opts.planName },
            { kind: "attempt", id: opts.worktreeId },
        ],
        expectedRevision: opts.expectedRevision,
        expectedEffects: ["plan_event_recorded"],
        apply: async (ctx) => {
            const value = await opts.reopen(ctx);
            await ctx.markEffect("review_reopened_settled", { planName: opts.planName, worktreeId: opts.worktreeId });
            return value;
        },
    });
}

/**
 * Transactionally update Plan Front Matter and verify the requested fields.
 */
export async function runPlanFrontMatterTransition({
    projectRoot,
    planName,
    operation,
    updates,
    recoveryAttrs = {},
    expectedRevision,
}: {
    projectRoot: string;
    planName: string;
    operation: string;
    updates: Record<string, unknown>;
    recoveryAttrs?: Record<string, unknown>;
    expectedRevision?: string;
}) {
    return await runPlanTransition({
        projectRoot,
        planName,
        operation,
        expectedRevision,
        apply: async ({ beforePlan }) => {
            if (!beforePlan) throw new Error(`Plan not found: ${planName}`);
            const attrs = await updatePlanFrontMatter(projectRoot, planName, updates, recoveryAttrs, {
                expectedRevision: beforePlan.revision,
            });
            const after = await loadPlan(projectRoot, planName);
            if (!after) throw new Error(`Plan disappeared during ${operation}: ${planName}`);
            for (const [key, value] of Object.entries(updates)) {
                if (value === undefined) continue;
                // These fields are now read-only registry projections, not Plan writes.
                // The worktree operation verifies its own registry mutation.
                if (WORKTREE_CONTEXT_FIELDS.some((field) => field === key)) continue;
                const actual = (after.attrs as unknown as Record<string, unknown>)[key];
                if (JSON.stringify(actual ?? null) !== JSON.stringify(value ?? null)) {
                    throw new Error(`Plan transition ${operation} did not persist ${key}.`);
                }
            }
            return attrs;
        },
    });
}

interface PlanDocumentUpdate {
    projectRoot: string;
    planName: string;
    operation: "collaboration_update" | "collaboration_clear";
    markdown: string;
    controllerUpdates: WorkflowControllerState;
    expectedRevision: string;
    expectedControllerRevision: number;
}

/** Publish a document and its controller state through one recoverable transition. */
export async function writePlanDocumentAndController(opts: PlanDocumentUpdate) {
    const result = await runPlanTransition({
        projectRoot: opts.projectRoot,
        planName: opts.planName,
        operation: opts.operation,
        expectedRevision: opts.expectedRevision,
        apply: async ({ beforePlan }) => {
            if (!beforePlan) throw new Error(`Plan not found: ${opts.planName}`);
            await writeControllerState(
                opts.projectRoot,
                { planName: opts.planName, planId: beforePlan.attrs.planId },
                opts.controllerUpdates,
                { expectedRevision: opts.expectedControllerRevision },
            );
            await writePlanMarkdownWithRevision(beforePlan.path, opts.markdown, beforePlan.revision);
        },
    });
    if (result.status !== "committed") {
        throw new Error(result.message || "The Plan update could not finish. Your previous version was preserved.");
    }
}

/** Return unresolved transition journal records for diagnostics. */
export async function listTransitionRecoveryRecords(projectRoot: string, options: { diagnostic?: boolean } = {}) {
    const dir = options.diagnostic
        ? getTransitionJournalDir(projectRoot)
        : await enteredTransitionJournalDir(projectRoot);
    /** @type {Array<Record<string, unknown>>} */
    const records = [];
    try {
        for await (const entry of await fsReaddir(dir, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
            try {
                records.push(JSON.parse(await fsReadFile(join(dir, entry.name), "utf8")));
            } catch (error) {
                records.push({ state: "needs_recovery", path: join(dir, entry.name), error: compactError(error) });
            }
        }
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    return records;
}

/**
 * Close a record RunWield cannot prove, on the user's word instead of evidence.
 *
 * Some records are genuinely unprovable — the worktree was deleted by hand, a
 * branch was force-pushed, the machine died mid-merge. RunWield must not close
 * those on its own, because closing without proof can hide unpublished work. But
 * refusing forever leaves the Plan permanently stuck, with `rm` on a JSON file as
 * the only way out. That is the corner this exists to remove: the user can take
 * responsibility explicitly, and RunWield records that they did.
 *
 * The record is moved, never deleted. It stays readable under `attested/` so the
 * decision is auditable and recoverable if the attestation turns out to be wrong.
 */
export async function closeTransitionRecordByAttestation(
    projectRoot: string,
    transitionId: string,
    { note }: { note?: string } = {},
): Promise<{ closed: boolean; archivedPath?: string; reason?: string }> {
    const activePath = await enteredTransitionJournalPath(projectRoot, transitionId);
    let record: Record<string, unknown>;
    try {
        record = JSON.parse(await fsReadFile(activePath, "utf8"));
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return { closed: false, reason: `No lifecycle record ${transitionId} to close.` };
        }
        // Unreadable bytes are exactly when the user most needs the escape, so keep
        // going with what we know rather than making the corner permanent.
        record = { transitionId, unreadable: compactError(error) };
    }
    const archiveDir = join(await enteredTransitionJournalDir(projectRoot), "attested");
    const archivedPath = join(archiveDir, `${transitionId}.json`);
    await fsMkdir(archiveDir, { recursive: true });
    await atomicWriteTextFile(
        archivedPath,
        `${JSON.stringify(
            {
                ...record,
                state: "closed_by_user_attestation",
                closedByUserAttestationAt: new Date().toISOString(),
                ...(note ? { attestationNote: note } : {}),
            },
            null,
            2,
        )}\n`,
    );
    await removeJournal(projectRoot, transitionId);
    return { closed: true, archivedPath };
}

/** A durable effect as read back from a journal, before anything is proven. */
export interface JournaledEffect {
    effect: string;
    proof?: Record<string, unknown>;
    completedAt?: string;
}

/**
 * A verdict on one journaled effect, from current repository facts.
 *
 * `settled` means the effect needs nothing further: either its intended
 * postcondition is present, or it provably never landed. Both are closable —
 * what is not closable is not knowing which.
 */
export interface EffectVerdict {
    settled: boolean;
    reason: string;
    /** Set when resolving this effect would destroy something (a branch, a worktree). */
    destructive?: boolean;
}

/** Proves journaled effects from repository facts. Supplied by the reconciliation caller. */
export type EffectProver = (
    effect: JournaledEffect,
    record: Record<string, unknown>,
) => Promise<EffectVerdict> | EffectVerdict;

/** A journal record paired with whether it can be retired without a human. */
export interface TransitionReconciliation {
    transitionId: string;
    planName?: string;
    operation?: string;
    state?: string;
    /** True when repository facts prove the record describes no outstanding work. */
    resolvable: boolean;
    /** Why it is resolvable, or what remains uncertain. */
    reason: string;
    resolved?: boolean;
    /** The effects the record claims, with each one's verdict when a prover ran. */
    effects?: Array<JournaledEffect & { verdict?: EffectVerdict }>;
    /** The recovery recipe the transition itself journaled, when it left one. */
    recoveryActions?: TransitionRecoveryAction[];
    /** Journal file path, so a report can name the artifact it is talking about. */
    path?: string;
}

/**
 * Decide, from current repository facts, which unresolved journals are safe to
 * retire — and retire them when `apply` is set.
 *
 * Without this, a journal is written on failure but nothing ever removes one, so
 * a single interrupted transition blocks its Plan permanently and the only way
 * out is deleting a file by hand. RunWield owns this store, so it has to be able
 * to close its own records.
 *
 * A record is resolvable only on positive evidence: the transition already
 * committed (so only the cleanup delete was lost), it marked no durable effect and
 * the Plan still holds the metadata it read, or a caller-supplied prover confirmed
 * every effect it did mark. Anything else — changed metadata, an effect nothing
 * can vouch for, an irreversible Git move that is not visible in the repository —
 * stays for a human.
 *
 * @param proveEffect supplies repository evidence about journaled effects. Without
 * one, any recorded effect keeps the record open, because this module can see Plan
 * bytes but not Git refs or the worktree registry.
 * @param planName limits reconciliation, including what `apply` removes, to records
 * that name this Plan. Records without a Plan name stay untouched, so a scoped
 * caller can never close another Plan's journal. Without it, reconciliation is
 * repository-wide.
 */
export async function reconcileTransitionRecoveryRecords(
    projectRoot: string,
    {
        apply = false,
        proveEffect,
        planName,
        diagnostic = false,
    }: {
        apply?: boolean;
        proveEffect?: EffectProver;
        planName?: string;
        diagnostic?: boolean;
    } = {},
): Promise<TransitionReconciliation[]> {
    let records = await listTransitionRecoveryRecords(projectRoot, { diagnostic });
    if (planName !== undefined) {
        records = records.filter((record) => record.planName === planName);
    }
    const reconciliations: TransitionReconciliation[] = [];
    for (const record of records) {
        const transitionId = String(record.transitionId || "");
        const planName = typeof record.planName === "string" ? record.planName : undefined;
        const operation = typeof record.operation === "string" ? record.operation : undefined;
        const state = typeof record.state === "string" ? record.state : undefined;
        const recoveryActions = Array.isArray(record.recoveryActions)
            ? (record.recoveryActions as TransitionRecoveryAction[])
            : undefined;
        const path =
            typeof record.path === "string"
                ? record.path
                : transitionId
                  ? getTransitionJournalPath(projectRoot, transitionId)
                  : undefined;
        const base = { transitionId, planName, operation, state, recoveryActions, path };

        if (!transitionId) {
            reconciliations.push({ ...base, resolvable: false, reason: "journal file is unreadable or has no id" });
            continue;
        }
        if (state === "committed") {
            reconciliations.push({
                ...base,
                resolvable: true,
                reason: "transition committed; only its journal cleanup was interrupted",
            });
            continue;
        }
        const completedEffects: JournaledEffect[] = (
            Array.isArray(record.completedEffects) ? record.completedEffects : []
        ).filter(
            (effect: unknown): effect is JournaledEffect =>
                Boolean(effect) && typeof (effect as JournaledEffect).effect === "string",
        );
        if (completedEffects.length > 0) {
            if (!proveEffect) {
                reconciliations.push({
                    ...base,
                    effects: completedEffects,
                    resolvable: false,
                    reason: `durable effects were recorded and need proof before closing: ${completedEffects
                        .map((effect) => effect.effect)
                        .join(", ")}`,
                });
                continue;
            }
            const judged = [];
            for (const effect of completedEffects) {
                judged.push({ ...effect, verdict: await proveEffect(effect, record) });
            }
            const unsettled = judged.filter((effect) => !effect.verdict.settled);
            reconciliations.push({
                ...base,
                effects: judged,
                resolvable: unsettled.length === 0,
                reason:
                    unsettled.length === 0
                        ? judged.map((effect) => `${effect.effect} (${effect.verdict.reason})`).join("; ")
                        : unsettled.map((effect) => `${effect.effect}: ${effect.verdict.reason}`).join("; "),
            });
            continue;
        }
        if (!planName) {
            reconciliations.push({ ...base, resolvable: false, reason: "no Plan recorded; cannot prove Plan state" });
            continue;
        }
        const beforeFacts = (record.beforeFacts || record.before || {}) as {
            plan?: { revision?: unknown; missing?: unknown; controllerState?: WorkflowControllerState };
            revision?: unknown;
            missing?: unknown;
            controllerState?: WorkflowControllerState;
        };
        const journaledPlan = beforeFacts.plan || beforeFacts;
        const journaledRevision = typeof journaledPlan.revision === "string" ? journaledPlan.revision : undefined;
        const current = diagnostic
            ? await inspectPlanStrict(projectRoot, planName).then((result) =>
                  result.kind === "loaded" ? result : null,
              )
            : await loadPlan(projectRoot, planName).catch(() => null);
        if (journaledRevision === undefined && journaledPlan.missing !== true) {
            // No before-revision to compare, and no effect was ever marked. Completed
            // effects are the only ledger of durable change, so nothing here is known to
            // have happened — and anything that did happen without being marked is
            // visible to a different check that never deletes: an untracked worktree or
            // branch, a registry row without a Plan, drifted Plan status. Keeping the
            // record instead would block the Plan forever with nothing able to clear it,
            // which is how a cancelled execution start stranded a user.
            reconciliations.push({
                ...base,
                resolvable: true,
                reason:
                    "no durable effect was recorded, so nothing is known to be outstanding; " +
                    "any leftover worktree, branch, or registry row is reported separately",
            });
            continue;
        }
        // Body drift is not drift: the user owns the body and may rewrite it at any
        // time, so a record whose Front Matter still matches describes no
        // outstanding RunWield work even though the file bytes differ.
        const unchanged =
            journaledPlan.missing === true
                ? !current
                : Boolean(
                      current &&
                      "attrs" in current &&
                      "revision" in current &&
                      (!journaledPlan.controllerState ||
                          controllerStatesEqual(journaledPlan.controllerState, current.attrs)) &&
                      (current.revision === journaledRevision ||
                          (current.frontMatterRevision !== undefined &&
                              current.frontMatterRevision === getKnownFrontMatterRevision(journaledRevision))),
                  );
        reconciliations.push(
            unchanged
                ? { ...base, resolvable: true, reason: "no durable effect recorded and the Plan metadata is unchanged" }
                : {
                      ...base,
                      resolvable: false,
                      reason: "the Plan metadata changed after this transition was journaled",
                  },
        );
    }
    if (apply) {
        for (const reconciliation of reconciliations) {
            if (!reconciliation.resolvable) continue;
            await removeJournal(projectRoot, reconciliation.transitionId);
            reconciliation.resolved = true;
        }
    }
    return reconciliations;
}

export async function applyReviewedPlanMarkdown({
    projectRoot,
    planName,
    reviewedMarkdown,
    expectedRevision,
}: {
    projectRoot: string;
    planName: string;
    reviewedMarkdown: string;
    expectedRevision?: string;
}) {
    return await runPlanTransition({
        projectRoot,
        planName,
        operation: "plan_review_write",
        apply: async ({ beforePlan }) => {
            if (!beforePlan) throw new Error(`Plan not found: ${planName}`);
            if (expectedRevision && beforePlan.revision !== expectedRevision) {
                throw new Error("Plan changed after review opened; reload the review before applying this decision.");
            }
            await writePlanMarkdownWithRevision(beforePlan.path, reviewedMarkdown, beforePlan.revision);
            return parsePlanFrontMatter(reviewedMarkdown).attrs;
        },
    });
}

/**
 * Semantic boundary for settling an implementation checkpoint. Callers provide
 * the already-captured checkpoint proof plus the bounded implementation effect;
 * the journal records the intended postcondition for recovery/doctor scans.
 */
export async function runImplementationCheckpointTransition<T>(
    opts: TransitionOptionsBase & {
        checkpointProof?: Record<string, unknown>;
        resumeInterrupted?: boolean;
        checkpoint: (ctx: EffectTransitionContext) => Promise<T>;
    },
): Promise<TransitionResult> {
    const resources: TransitionResource[] = [{ kind: "plan", id: opts.planName }];
    if (opts.worktreeId) resources.push({ kind: "attempt", id: opts.worktreeId });
    return await runSemanticTransition({
        projectRoot: opts.projectRoot,
        planName: opts.planName,
        operation: "implementation_checkpoint",
        supersedesOperations: opts.resumeInterrupted ? ["implementation_checkpoint"] : [],
        resources,
        expectedRevision: opts.expectedRevision,
        apply: async (ctx) => {
            const value = await opts.checkpoint(ctx);
            await ctx.markEffect("implementation_checkpoint_settled", opts.checkpointProof || {});
            return {
                checkpointProof: opts.checkpointProof || {},
                postconditions: { planEvent: "implementation_finished", registryStatus: "completed" },
                value,
            };
        },
    });
}

/**
 * Semantic boundary for validation pass/fail/retry outcomes.
 */
export async function runValidationOutcomeTransition<T>(
    opts: TransitionOptionsBase & {
        outcome: "passed" | "failed" | "retry" | "merge_failed";
        proof?: Record<string, unknown>;
        settle: (ctx: EffectTransitionContext) => Promise<T>;
    },
): Promise<TransitionResult> {
    const resources: TransitionResource[] = [{ kind: "catalog" }, { kind: "plan", id: opts.planName }];
    if (opts.worktreeId) resources.push({ kind: "attempt", id: opts.worktreeId });
    if (opts.targetRef) resources.push({ kind: "target_ref", id: opts.targetRef });
    return await runSemanticTransition({
        projectRoot: opts.projectRoot,
        planName: opts.planName,
        operation: `validation_${opts.outcome}`,
        resources,
        expectedRevision: opts.expectedRevision,
        apply: async (ctx) => {
            const value = await opts.settle(ctx);
            await ctx.markEffect("validation_outcome_settled", { outcome: opts.outcome, ...(opts.proof || {}) });
            return {
                proof: opts.proof || {},
                postconditions: { outcome: opts.outcome },
                value,
            };
        },
    });
}

/**
 * Semantic boundary for Epic decomposition finalization.
 */
export async function runEpicDecompositionFinalizeTransition<T>(
    opts: TransitionOptionsBase & {
        resources: TransitionResource[];
        finalize: (ctx: EffectTransitionContext) => Promise<T & { childNames?: string[]; alreadyReady?: boolean }>;
    },
): Promise<TransitionResult> {
    return await runSemanticTransition({
        projectRoot: opts.projectRoot,
        planName: opts.planName,
        operation: "epic_decomposition_finalize",
        resources: opts.resources,
        expectedRevision: opts.expectedRevision,
        apply: async (ctx) => {
            const value = await opts.finalize(ctx);
            await ctx.markEffect("decomposition_finalized", {
                children: Array.isArray(value?.childNames) ? value.childNames : [],
                alreadyReady: Boolean(value?.alreadyReady),
            });
            return value;
        },
    });
}

/**
 * Semantic boundary for recovery/reset/recreate/abandon actions.
 */
export async function runRecoveryTransition<T>(
    opts: TransitionOptionsBase & {
        action: "recover" | "reset" | "recreate" | "abandon";
        recover: (ctx: RollbackTransitionContext) => Promise<T>;
    },
): Promise<TransitionResult> {
    const resources: TransitionResource[] = [{ kind: "plan", id: opts.planName }];
    if (opts.worktreeId) resources.push({ kind: "attempt", id: opts.worktreeId });
    return await runSemanticTransition({
        projectRoot: opts.projectRoot,
        planName: opts.planName,
        operation: `recovery_${opts.action}`,
        resources,
        supersedesUnresolved: true,
        expectedRevision: opts.expectedRevision,
        apply: async (ctx) => {
            const value = await opts.recover(ctx);
            await ctx.markEffect(`recovery_${opts.action}_settled`, { action: opts.action });
            return { postconditions: { action: opts.action }, value };
        },
    });
}

/**
 * Semantic boundary for archive/restore file movement.
 */
export async function runArchiveTransition<T>(
    opts: TransitionOptionsBase & { action: "archive" | "restore"; move: (ctx: BaseTransitionContext) => Promise<T> },
): Promise<TransitionResult> {
    const source =
        opts.action === "archive"
            ? (await resolveWorkflowPlanLocation(opts.projectRoot, opts.planName, { readOnly: true })).plan
            : await loadArchivedPlan(opts.projectRoot, opts.planName);
    const projectRoot = source ? getPlanDocumentRoot(source.path) : opts.projectRoot;
    return await runSemanticTransition({
        projectRoot,
        planName: opts.planName,
        operation: `plan_${opts.action}`,
        resources: [{ kind: "catalog" }, { kind: "plan", id: opts.planName }],
        expectedRevision: opts.expectedRevision,
        apply: async (ctx) => {
            const value = await opts.move(ctx);
            await ctx.markEffect(`archive_${opts.action}_settled`, { action: opts.action });
            return { postconditions: { action: opts.action }, value };
        },
    });
}
