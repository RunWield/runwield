import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { retryWorkRecordForPlan } from "../work-records/auto-generation.ts";
import { listWorkRecords } from "../work-records/index.ts";
import { recordPlanEvent, stageValidationPassedInExecutionWorktree } from "./plan-lifecycle.js";
import { autoGenerateWorkRecordForCompletedPlan } from "../work-records/auto-generation.ts";
import { publishExecutionWorktreeIsolated } from "../isolated-publication.ts";
import { advancePublicationAttempt, createPublicationAttempt } from "./publication-attempt.ts";
import { createTestWorktreeAttempt, git, makeRepo } from "../worktree-test-helpers.ts";
import { removeWorktreeGitArtifacts } from "../worktree.js";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { HostedSession } from "../session/hosted-session.js";
import type { RuntimeSystemStatusEvent, SessionRuntimeEvent } from "../session/session-runtime-events.js";
import { createValidationSessionPort } from "./validation-session-adapter.ts";
import { createProgressRecord } from "./validation-emit.ts";
import { createGitPort } from "../git-port.ts";
import { createWorkRecordMnemotecaFixture } from "../work-records/test-fixtures/mnemoteca-port.ts";
import { buildVerifiedResult } from "./validation-publication.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { loadPlan, PlanLockTimeoutError, savePlan } from "../../plan-store.js";

import { classifyValidationOperationalError, type GitPublicationErrorKind } from "./validation-operational-errors.ts";
import { decideValidationRecovery, DEFAULT_VALIDATION_RETRY_POLICY } from "./validation-recovery.ts";
import {
    annotatePublicationStage,
    normalizePublicationFailure,
    publicationFailureNeedsUserAction,
} from "./validation-merge-repair.ts";
import { publicationFailureKindFromMergeKind } from "./validation-publication.ts";
import { buildValidationUserMessage } from "./validation-user-messages.ts";

function decidePublicationFailure(kind: GitPublicationErrorKind) {
    return decideValidationRecovery({
        failure: classifyValidationOperationalError({
            source: "git_publication",
            kind,
            operation: "publication",
            message: `${kind} during publication`,
        }),
        attempt: 1,
        correctionAttempt: 1,
        nextPhase: "delivery",
        policy: DEFAULT_VALIDATION_RETRY_POLICY,
        randomUnit: 0,
    });
}

Deno.test("publication dispatches merge repair only for a content conflict", () => {
    const cases: Array<{ kind: GitPublicationErrorKind; action: "retry" | "correct" | "pause" | "halt" }> = [
        { kind: "target_reference_race", action: "retry" },
        { kind: "remote_unavailable", action: "retry" },
        { kind: "content_conflict", action: "correct" },
        { kind: "primary_checkout_dirty", action: "pause" },
        { kind: "post_publication_bookkeeping", action: "pause" },
        { kind: "permission_denied", action: "halt" },
        { kind: "policy_violation", action: "halt" },
    ];

    for (const scenario of cases) {
        const decision = decidePublicationFailure(scenario.kind);
        assertEquals(decision.action, scenario.action, scenario.kind);
    }
});

Deno.test("permission and branch-policy failures halt publication", () => {
    const permissionDenied = decidePublicationFailure("permission_denied");
    assertEquals(permissionDenied.action, "halt");
    assertEquals(permissionDenied.result.kind, "terminal");

    const policyViolation = decidePublicationFailure("policy_violation");
    assertEquals(policyViolation.action, "halt");
    assertEquals(policyViolation.result.kind, "terminal");
});

Deno.test("publication maps local merge conflicts to correction and protected-branch rejection to fatal", () => {
    assertEquals(publicationFailureKindFromMergeKind("local_publication_conflict"), "content_conflict");
    assertEquals(
        decidePublicationFailure(publicationFailureKindFromMergeKind("local_publication_conflict")).action,
        "correct",
    );

    assertEquals(publicationFailureKindFromMergeKind("policy_violation"), "policy_violation");
    assertEquals(decidePublicationFailure(publicationFailureKindFromMergeKind("policy_violation")).action, "halt");
});

Deno.test("publication offers Retry only when the user can change the outcome", () => {
    assertEquals(
        publicationFailureNeedsUserAction(normalizePublicationFailure(new Error("internal publication failure"))),
        false,
    );
    assertEquals(
        publicationFailureNeedsUserAction(
            normalizePublicationFailure(
                Object.assign(new Error("conflict"), { mergeFailureKind: "isolated_publication_conflict" }),
            ),
        ),
        true,
    );
    assertEquals(
        publicationFailureNeedsUserAction(
            normalizePublicationFailure(
                Object.assign(new Error("push failed"), { mergeFailureKind: "publication_push_failed" }),
            ),
        ),
        true,
    );
});

Deno.test("publication failures retain the stage that actually failed", () => {
    const error = annotatePublicationStage(new Error("pre-commit hook failed"), "candidate_checkpoint");
    const failure = normalizePublicationFailure(error);
    assertEquals(failure.reason, "pre-commit hook failed");
    assertEquals(failure.publicationStage, "candidate_checkpoint");
});

Deno.test("a checkpoint failure does not claim the saved publication copy is incomplete", () => {
    const message = buildValidationUserMessage({
        kind: "publication_blocked",
        planName: "demo",
        stage: "candidate_checkpoint",
    });
    assertEquals(message.includes("saved copy"), false);
    assertEquals(message.includes("Update RunWield"), false);
    assertEquals(message.includes("Git could not save the final validation files"), true);
});

Deno.test("publication explains a busy Plan operation without prescribing a failed reload", () => {
    const failure = normalizePublicationFailure(
        annotatePublicationStage(new PlanLockTimeoutError("/private/project/catalog.lock"), "lifecycle_staging"),
    );
    const message = buildValidationUserMessage({
        kind: "publication_blocked",
        planName: "demo",
        stage: failure.publicationStage || "git_publication",
        blockedByPlanLock: failure.blockedByPlanLock,
    });
    assertEquals(message.includes("another RunWield operation"), true);
    assertEquals(message.includes("review decision are saved"), true);
    assertEquals(message.includes("Let that operation finish, then retry publication"), true);
    assertEquals(message.includes("/private/project"), false);
    assertEquals(message.includes("Load this Plan and run validation again"), false);
});

for (const primaryCopy of ["stale", "missing"] as const) {
    for (const remote of [false, true]) {
        if (!remote && primaryCopy === "missing") continue;
        for (const epic of [false, true]) {
            Deno.test(`verified ${epic ? "Epic child" : "standalone"} completion retains preflight recording failure after ${remote ? "remote" : "local"} delivery (${primaryCopy} primary)`, async () => {
                await withRuntimeCommandFixture(
                    "record-completion-",
                    async ({ projectRoot: fixtureRoot, setModelMessages }) => {
                        const projectRoot = remote ? await makeRepo() : fixtureRoot;
                        const planName = epic ? "epic/01-child" : "completed";
                        const ownerName = epic ? "epic" : planName;
                        const planPath = `docs/plans/${planName}.md`;
                        if (epic) {
                            await savePlan(projectRoot, ownerName, "# Epic\n", {
                                planId: "parent-plan",
                                classification: "PROJECT",
                                status: "ready_for_work",
                            });
                        }
                        if (remote) {
                            await savePlan(projectRoot, planName, "# Completed\n", {
                                planId: "completed-plan",
                                classification: "PLANNED_CHANGE",
                                status: "implemented",
                                ...(epic ? { parentPlan: ownerName, order: 1 } : {}),
                            });
                            await git(projectRoot, ["add", ".gitignore", "docs/plans"]);
                            await git(projectRoot, ["commit", "-m", "Save source Plan"]);
                        }
                        const worktreeRoot = remote
                            ? await Deno.makeTempDir({ prefix: "record-outcome-worktree-" })
                            : undefined;
                        const worktree = worktreeRoot
                            ? await createTestWorktreeAttempt({
                                projectRoot,
                                planName,
                                planId: "completed-plan",
                                worktreeRoot,
                            })
                            : undefined;
                        const remoteRoot = remote
                            ? await Deno.makeTempDir({ prefix: "record-outcome-remote-" })
                            : undefined;
                        const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd: projectRoot });
                        const events: RuntimeSystemStatusEvent[] = [];
                        hostedSession.setEventSink((event: SessionRuntimeEvent) => {
                            if (event.type === "system_status") events.push(event);
                        });
                        const session = createValidationSessionPort(hostedSession);
                        try {
                            const sourceRoot = worktree?.path || projectRoot;
                            const existing = await loadPlan(sourceRoot, planName);
                            await savePlan(sourceRoot, planName, "# Completed\n", {
                                planId: "completed-plan",
                                classification: "PLANNED_CHANGE",
                                status: worktree || epic ? "reviewed" : "verified",
                                ...(epic ? { parentPlan: ownerName, order: 1 } : {}),
                            }, { expectedRevision: existing?.revision });
                            let planPaths = [planPath];
                            if (worktree) {
                                const staged = await stageValidationPassedInExecutionWorktree({
                                    projectRoot,
                                    executionCwd: sourceRoot,
                                    planName,
                                    details: {
                                        executionMode: "worktree",
                                        deliveryEvidence: {
                                            version: 1,
                                            mode: "worktree_merge",
                                            executionCommit: await git(sourceRoot, ["rev-parse", "HEAD"]),
                                            targetBranch: "main",
                                            targetHeadBeforeMerge: await git(projectRoot, ["rev-parse", "HEAD"]),
                                        },
                                    },
                                });
                                planPaths = staged.planPaths;
                            } else if (epic) {
                                await recordPlanEvent({
                                    cwd: sourceRoot,
                                    planName,
                                    event: "validation_passed",
                                    currentStatus: "reviewed",
                                    details: {
                                        executionMode: "non_git_in_place",
                                        deliveryEvidence: { version: 1, mode: "non_git_in_place" },
                                    },
                                });
                            }
                            if (epic) {
                                assertEquals(
                                    (await loadPlan(sourceRoot, ownerName))?.attrs.epicCompletionMode,
                                    "done_enough",
                                );
                                assertEquals((await loadPlan(sourceRoot, planName))?.attrs.workRecord, undefined);
                            }
                            await Deno.mkdir(`${sourceRoot}/docs/work-records`, { recursive: true });
                            const invalidRecord = "# Existing invalid record without front matter\n";
                            await Deno.writeTextFile(`${sourceRoot}/docs/work-records/invalid.md`, invalidRecord);
                            const recording = await autoGenerateWorkRecordForCompletedPlan({
                                cwd: sourceRoot,
                                planName,
                                mnemotecaPort: createWorkRecordMnemotecaFixture(),
                                pendingPublication: Boolean(worktree),
                            });
                            assertEquals(recording.status, "failed");
                            assertStringIncludes(recording.error || "", "invalid.md");
                            assertEquals(recording.targetPlanName, ownerName);
                            const saved = await loadPlan(sourceRoot, ownerName);
                            assertEquals(saved?.attrs.status, worktree ? "reviewed" : "verified");
                            assertEquals(saved?.attrs.workRecord?.status, "failed");
                            assertStringIncludes(saved?.attrs.workRecord?.error || "", "invalid.md");
                            assertEquals(
                                await Deno.readTextFile(`${sourceRoot}/docs/work-records/invalid.md`),
                                invalidRecord,
                            );
                            let publication;
                            if (worktree) {
                                await git(worktree.path, ["add", ".gitignore", "docs"]);
                                await git(worktree.path, ["commit", "-m", "Seal failed recording outcome"]);
                                const commit = await git(worktree.path, ["rev-parse", "HEAD"]);
                                publication = advancePublicationAttempt(
                                    createPublicationAttempt({
                                        attemptId: worktree.id,
                                        planId: "completed-plan",
                                        planName,
                                        targetBranch: "main",
                                        executionBranch: worktree.branch,
                                        executionCwd: worktree.path,
                                        publicationRoot: worktree.path,
                                        validatedCommit: commit,
                                        targetHeadAtSeal: await git(projectRoot, ["rev-parse", "HEAD"]),
                                    }),
                                    "artifacts_committed",
                                    { artifactCommit: commit, planPaths },
                                );
                                if (!remoteRoot) throw new Error("Remote fixture missing");
                                await git(remoteRoot, ["init", "--bare"]);
                                await git(projectRoot, ["remote", "add", "origin", remoteRoot]);
                                await git(projectRoot, ["push", "-u", "origin", "main"]);
                                const delivered = await publishExecutionWorktreeIsolated({
                                    projectRoot,
                                    executionCwd: worktree.path,
                                    executionBranch: worktree.branch,
                                    targetBranch: "main",
                                    planName,
                                    sealedExecutionCommit: commit,
                                    allowedPlanPaths: planPaths,
                                });
                                assert(delivered.publicationMode === "remote");
                                publication = advancePublicationAttempt(publication, "target_integrated", {
                                    targetBaseCommit: delivered.targetHeadBeforeMerge,
                                    integrationCommit: delivered.publicationCommit,
                                });
                                publication = advancePublicationAttempt(publication, "target_published", {
                                    publicationMode: delivered.publicationMode,
                                    publishedCommit: delivered.publicationCommit,
                                    upstreamRemote: delivered.upstreamRemote,
                                    upstreamBranch: delivered.upstreamBranch,
                                });
                                assertEquals(await git(remoteRoot, ["rev-parse", "main"]), delivered.publicationCommit);
                                publication = advancePublicationAttempt(publication, "publication_verified", {
                                    verifiedAt: new Date().toISOString(),
                                });
                                assertStringIncludes(
                                    await git(remoteRoot, ["show", `main:docs/plans/${ownerName}.md`]),
                                    "invalid.md",
                                );
                                await removeWorktreeGitArtifacts({ projectRoot, path: worktree.path, force: true });
                                assertEquals((await loadPlan(projectRoot, ownerName))?.attrs.workRecord, undefined);
                            }
                            session.setCurrentProgress(createProgressRecord({ kind: "workflow", stage: "merge" }));
                            const result = await buildVerifiedResult(
                                {
                                    planName,
                                    planContent: "# Completed",
                                    triageMeta: { classification: "PLANNED_CHANGE", status: "verified" },
                                    session,
                                    git: createGitPort(),
                                    localCI: {
                                        run: () => {
                                            throw new Error("Completion must not rerun CI");
                                        },
                                    },
                                    workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
                                },
                                projectRoot,
                                undefined,
                                "main",
                                publication,
                            );
                            assertEquals(result.kind, "verified");
                            const final = events.at(-1);
                            assertEquals(final?.level, "warning");
                            assertEquals(final?.validationProgress?.outcome, "verified");
                            assertEquals(final?.validationProgress?.checks.merge, "passed");
                            assertEquals(final?.validationProgress?.workRecordFailed, true);
                            assertStringIncludes(final?.message || "", "Work Record failed");
                            assertStringIncludes(final?.message || "", "wld wr backfill");
                            assertEquals(final?.validationProgress?.workRecordPlanName, planName);
                            if (remote && remoteRoot) {
                                const primaryHead = await git(projectRoot, ["rev-parse", "HEAD"]);
                                const remoteHead = await git(remoteRoot, ["rev-parse", "main"]);
                                const originalBody = (await loadPlan(projectRoot, ownerName))?.body;
                                if (primaryCopy === "missing") {
                                    await Deno.remove(`${projectRoot}/docs/plans/${planName}.md`);
                                    if (epic) await Deno.remove(`${projectRoot}/docs/plans/${ownerName}.md`);
                                }
                                setModelMessages([fauxAssistantMessage(fauxToolCall("work_record_completed", {
                                    title: "Recovered delivered record",
                                    summary: "Recorded only the delivered work.",
                                }))]);
                                const retried = await retryWorkRecordForPlan({
                                    cwd: projectRoot,
                                    planName,
                                    mnemotecaPort: createWorkRecordMnemotecaFixture(),
                                });
                                assertEquals(retried.status, "generated", retried.message);
                                assertEquals((await listWorkRecords(projectRoot)).length, 1);
                                if (primaryCopy === "stale") {
                                    assertEquals((await loadPlan(projectRoot, ownerName))?.body, originalBody);
                                } else {assertEquals(
                                        (await loadPlan(projectRoot, ownerName))?.attrs.planId,
                                        epic ? "parent-plan" : "completed-plan",
                                    );}
                                assertEquals(await git(projectRoot, ["rev-parse", "HEAD"]), primaryHead);
                                assertEquals(await git(remoteRoot, ["rev-parse", "main"]), remoteHead);
                                const again = await retryWorkRecordForPlan({
                                    cwd: projectRoot,
                                    planName,
                                    mnemotecaPort: createWorkRecordMnemotecaFixture(),
                                });
                                assertEquals(again.reason, "existing_backlink");
                            }
                        } finally {
                            hostedSession.dispose();
                            if (remote) await Deno.remove(projectRoot, { recursive: true });
                            if (worktreeRoot) await Deno.remove(worktreeRoot, { recursive: true });
                            if (remoteRoot) await Deno.remove(remoteRoot, { recursive: true });
                        }
                    },
                );
            });
        }
    }
}
