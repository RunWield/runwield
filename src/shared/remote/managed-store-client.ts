/** Separate execution process exercising production bootstrap and the public Plan owner. */
import { projects } from "@runwield/projects";
import { stdinStream } from "../../testing/stdin-stream.ts";
import { processLines } from "./remote-runtime-lines.ts";
import { activateRemoteProjectOwner } from "./entry.ts";
import type { RemoteInteractiveConfig } from "./entry.ts";
async function executeManagedFixture() {
    const lines = processLines(stdinStream());
    const input: Pick<RemoteInteractiveConfig, "cwd" | "resources" | "connection"> & {
        copyDocuments: boolean;
        recordParent: boolean;
        remoteTarget: boolean;
        collaborationUrl: string;
    } = JSON.parse((await lines.read()).value || "{}");
    await lines.cancel();
    const { getRunWieldRuntimeDir, getHomeDir } = await import("../../constants.ts");
    const { mkdir: seedDirectory, writeFile: seedFile, rename: moveSeed } = await import("node:fs/promises");
    const { join: seedPath } = await import("node:path");
    const { withRetainedPlanFixture } = await import("../testing/retained-plan-fixture.ts");
    const { createTestWorktreeAttempt, git: fixtureGit } = await import("../worktree-test-helpers.ts");
    const { seedPlanController, planFixtureControllerPath } = await import("../testing/plan-state-fixture.ts");
    const { resolveProjectRuntimeLayout: seedLayout } = await import("../project-runtime-layout.ts");
    const retainedPlanId = crypto.randomUUID();
    const retainedParentId = crypto.randomUUID();
    const abandonedPlanId = crypto.randomUUID();
    await seedDirectory(seedPath(input.cwd, "docs", "plans"), { recursive: true });
    if (input.recordParent)
        await seedFile(
            seedPath(input.cwd, "docs", "plans", "retained-parent.md"),
            `---\nplanId: "${retainedParentId}"\nclassification: "PROJECT"\ntype: "epic"\nstatus: "user_verified"\nuserVerificationNote: "Accepted original parent."\n---\n# Retained parent\n`,
        );
    await seedFile(
        seedPath(input.cwd, "docs", "plans", "retained.md"),
        `---\nplanId: "${retainedPlanId}"\nclassification: "PLANNED_CHANGE"\n${input.recordParent ? 'parentPlan: "retained-parent"\n' : ""}status: "in_progress"\nexecutionMode: "worktree"\n---\n# Retained execution\n`,
    );
    await seedFile(
        seedPath(input.cwd, "docs/plans/abandoned-original.md"),
        `---\nplanId: "${abandonedPlanId}"\nclassification: "PLANNED_CHANGE"\nstatus: "in_progress"\nexecutionMode: "worktree"\n---\n# Original abandonment\n`,
    );
    await fixtureGit(input.cwd, ["add", "docs/plans"]);
    await fixtureGit(input.cwd, ["commit", "-m", "Retained execution fixture"]);
    if (!input.resources.personalOwner) throw new Error("Fixture requires its managed personal owner.");
    const seededAttempts = await projects.launch.withContext(
        { executionAccountHome: getHomeDir(), personalOwner: input.resources.personalOwner },
        () =>
            withRetainedPlanFixture(input.cwd, async () => {
                const attempt = await createTestWorktreeAttempt({
                    projectRoot: input.cwd,
                    planName: "retained",
                    planId: retainedPlanId,
                    attemptId: crypto.randomUUID(),
                });
                await seedPlanController(
                    input.cwd,
                    { planName: "retained", planId: retainedPlanId },
                    { documentWorktreeId: attempt.id, executionReport: "Retained implementation checkpoint." },
                );
                const abandoned = await createTestWorktreeAttempt({
                    projectRoot: input.cwd,
                    planName: "abandoned-original",
                    planId: abandonedPlanId,
                    attemptId: crypto.randomUUID(),
                });
                await seedPlanController(
                    input.cwd,
                    { planName: "abandoned-original", planId: abandonedPlanId },
                    { documentWorktreeId: abandoned.id },
                );
                if (input.recordParent) {
                    const parentAttempt = await createTestWorktreeAttempt({
                        projectRoot: input.cwd,
                        planName: "retained-parent",
                        planId: retainedParentId,
                        attemptId: crypto.randomUUID(),
                    });
                    await seedPlanController(
                        input.cwd,
                        { planName: "retained-parent", planId: retainedParentId },
                        { documentWorktreeId: parentAttempt.id, executionReport: "Original parent controller." },
                    );
                }
                const controllerPath = planFixtureControllerPath(input.cwd, {
                    planName: "retained",
                    planId: retainedPlanId,
                });
                const registryPath = seedLayout(input.cwd).primary.worktreeRegistryPath;
                const runtime = seedPath(getRunWieldRuntimeDir(input.cwd), "internal");
                await seedDirectory(seedPath(runtime, "controller", "plans"), { recursive: true });
                await moveSeed(controllerPath, seedPath(runtime, "controller", "plans", `${retainedPlanId}.json`));
                for (const [planName, planId] of [
                    ["abandoned-original", abandonedPlanId],
                    ...(input.recordParent ? [["retained-parent", retainedParentId]] : []),
                ]) {
                    await moveSeed(
                        planFixtureControllerPath(input.cwd, { planName, planId }),
                        seedPath(runtime, "controller/plans", `${planId}.json`),
                    );
                }
                await moveSeed(registryPath, seedPath(runtime, "worktrees.json"));
                return { retained: attempt, abandoned };
            }),
    );
    const retainedAttempt = seededAttempts.retained;
    const clear = await activateRemoteProjectOwner(input);
    try {
        const {
            authorLocalPlan,
            loadPlan,
            listPlans,
            listPlanHistory,
            showPlanMilestone,
            restorePlanMilestone,
            recordPlanEvent,
            withLocalPlanWorkflow,
            reservePlanExecution,
            readPlanResource,
            savePlanDocument,
            savePlanProse,
            savePlanDefinition,
        } = await import("../../plan-store/index.ts");
        const before = await listPlans(input.cwd);
        if (before.length) throw new Error("Passive catalog must remain empty before authoring.");
        const { selectPlanAccess, resumePlanAttempt, capturePlanAccess } = await import("../../plan-store/index.ts");
        const savedRetainedAccess: import("../../plan-store/index.ts").PlanAccess = JSON.parse(
            JSON.stringify(
                await withLocalPlanWorkflow(input.cwd, "retained", () => Promise.resolve(capturePlanAccess())),
            ),
        );
        const savedAbandonedAccess: import("../../plan-store/index.ts").PlanAccess = JSON.parse(
            JSON.stringify(
                await withLocalPlanWorkflow(input.cwd, "abandoned-original", () =>
                    Promise.resolve(capturePlanAccess()),
                ),
            ),
        );
        const inspectedIdentity = projects.checkout.inspect(input.cwd);
        if (inspectedIdentity.kind !== "existing") throw new Error("Original execution identity is unavailable.");
        const historicalAccess: import("../../plan-store/index.ts").PlanAccess = JSON.parse(
            JSON.stringify({ identity: inspectedIdentity.identity, planId: retainedPlanId, expectedRevision: 1 }),
        );
        await resumePlanAttempt(
            input.cwd,
            historicalAccess,
            retainedAttempt.id,
            async () => {
                if (
                    (await loadPlan(input.cwd, "retained"))?.attrs.executionReport !==
                    "Retained implementation checkpoint."
                )
                    throw new Error("Saved pre-cutover admission lost its original controller.");
            },
            "retained",
        );
        await withLocalPlanWorkflow(input.cwd, "abandoned-original", async () => {
            const { detachPlanExecution } = await import("../../plan-store/index.ts");
            let refused = false;
            try {
                await detachPlanExecution(input.cwd, "abandoned-original", abandonedPlanId);
            } catch {
                refused = true;
            }
            if (!refused) throw new Error("Active original attempt was detached without abandonment proof.");
            await (
                await import("../worktree-registry.ts")
            ).updateEntry(input.cwd, seededAttempts.abandoned.id, { status: "abandoned" });
            await detachPlanExecution(input.cwd, "abandoned-original", abandonedPlanId);
        });
        let abandonedResumeRejected = false;
        try {
            await selectPlanAccess(input.cwd, abandonedPlanId);
        } catch {
            abandonedResumeRejected = true;
        }
        if (!abandonedResumeRejected) throw new Error("Deliberately abandoned original attempt remained resumable.");
        const retainedAccess = await selectPlanAccess(input.cwd, retainedPlanId);
        if (!retainedAccess) throw new Error("Retained execution admission is unavailable.");
        let retainedRecordId = "";
        await resumePlanAttempt(
            input.cwd,
            savedRetainedAccess,
            retainedAttempt.id,
            async () => {
                const retained = await loadPlan(input.cwd, "retained");
                if (
                    !retained ||
                    retained.attrs.planId !== retainedPlanId ||
                    retained.attrs.worktreeId !== retainedAttempt.id ||
                    retained.attrs.executionReport !== "Retained implementation checkpoint."
                )
                    throw new Error("Retained execution did not restore its original controller and worktree.");
                if (
                    input.recordParent &&
                    (await loadPlan(input.cwd, "retained-parent"))?.attrs.executionReport !==
                        "Original parent controller."
                )
                    throw new Error("Related original parent lost its own controller admission.");
                const { loadCanonicalExecutionPlanSource, ensureExecutionPlanFile } =
                    await import("../../plan-store/index.ts");
                const retainedSource = await loadCanonicalExecutionPlanSource(retainedAttempt.path, "retained");
                if (retainedSource.kind !== "loaded" || retainedSource.attrs.planId !== retainedPlanId)
                    throw new Error("Retained execution source was mistaken for a canonical package.");
                const retainedFile = await ensureExecutionPlanFile({
                    executionCwd: retainedAttempt.path,
                    planName: "retained",
                    canonicalSource: retainedSource,
                });
                if (!["present", "reconciled"].includes(retainedFile.kind) || retainedFile.path !== retainedSource.path)
                    throw new Error(
                        `Retained original execution document is unavailable: ${JSON.stringify(retainedFile)}`,
                    );
                const { recordPlanHumanReview } = await import("../../plan-store/index.ts");
                await recordPlanHumanReview(input.cwd, "retained", {
                    humanReviewMode: "ask",
                    humanReviewDecision: "skipped",
                    humanReviewedAt: null,
                });
                const checkpointed = await loadPlan(input.cwd, "retained");
                if (checkpointed?.attrs.humanReviewDecision !== "skipped")
                    throw new Error("Retained checkpoint did not reach its laptop controller.");
                const { retainPublicationCompletion } = await import("../../plan-store/index.ts");
                const { createPublicationAttempt } = await import("../workflow/publication-attempt.ts");
                const { publicationRootForAttempt } = await import("../workflow/publication-machine.ts");
                const unproved = createPublicationAttempt({
                    attemptId: retainedAttempt.id,
                    planId: retainedPlanId,
                    planName: "retained",
                    targetBranch: "main",
                    executionBranch: retainedAttempt.branch,
                    executionCwd: retainedAttempt.path,
                    publicationRoot: publicationRootForAttempt(input.cwd, retainedAttempt.id),
                    validatedCommit: retainedAttempt.baseCommit,
                    targetHeadAtSeal: retainedAttempt.baseCommit,
                });
                let refusedConfidence = false;
                try {
                    await retainPublicationCompletion(input.cwd, {
                        ...unproved,
                        phase: "publication_verified",
                        verifiedAt: new Date().toISOString(),
                        publishedCommit: retainedAttempt.baseCommit,
                    });
                } catch {
                    refusedConfidence = true;
                }
                if (!refusedConfidence || (await loadPlan(input.cwd, "retained"))?.attrs.verifiedAt)
                    throw new Error("A retained client verdict was accepted without independent Git publication.");
                await seedFile(seedPath(retainedAttempt.path, "resumed-sentinel.txt"), "Original execution resumed.\n");
                const { checkpointExecutionWorktree } = await import("../worktree.ts");
                const { stageValidationPassedInExecutionWorktree } = await import("../../plan-store/index.ts");
                const { startPublicationAttempt, advanceStoredPublication, cleanupStoredPublication } =
                    await import("../workflow/publication-machine.ts");
                const { publishExecutionWorktreeIsolated } = await import("../isolated-publication.ts");
                await recordPlanEvent({
                    cwd: retainedAttempt.path,
                    planName: "retained",
                    event: "implementation_finished",
                    currentStatus: "in_progress",
                });
                await recordPlanEvent({
                    cwd: retainedAttempt.path,
                    planName: "retained",
                    event: "mechanical_validation_passed",
                    currentStatus: "implemented",
                });
                await recordPlanEvent({
                    cwd: retainedAttempt.path,
                    planName: "retained",
                    event: "semantic_review_passed",
                    currentStatus: "implemented",
                });
                const candidate = await checkpointExecutionWorktree({
                    worktreePath: retainedAttempt.path,
                    branch: retainedAttempt.branch,
                    planName: "retained",
                });
                let publication = await startPublicationAttempt({
                    projectRoot: input.cwd,
                    attemptId: retainedAttempt.id,
                    planName: "retained",
                    targetBranch: "main",
                    executionBranch: retainedAttempt.branch,
                    executionCwd: retainedAttempt.path,
                    validatedCommit: candidate.executionCommit,
                    targetHeadAtSeal: retainedAttempt.baseCommit,
                });
                const staging = await stageValidationPassedInExecutionWorktree({
                    projectRoot: input.cwd,
                    executionCwd: retainedAttempt.path,
                    planName: "retained",
                    details: {
                        executionMode: "worktree",
                        deliveryEvidence: {
                            version: 1,
                            mode: "worktree_merge",
                            executionCommit: candidate.executionCommit,
                            targetBranch: "main",
                            targetHeadBeforeMerge: retainedAttempt.baseCommit,
                        },
                    },
                });
                const { autoGenerateWorkRecordForCompletedPlan: recordRetained } =
                    await import("../work-records/auto-generation.ts");
                const { SYSTEM_WORK_RECORD_MNEMOTECA_PORT: retainedIndex } =
                    await import("../work-records/mnemoteca-port.ts");
                const retainedRecord = await recordRetained({
                    cwd: input.cwd,
                    planName: "retained",
                    pendingPublication: true,
                    mnemotecaPort: retainedIndex,
                    runRecorderStep: () =>
                        Promise.resolve({
                            title: "Retained delivery",
                            summary: "Delivered the original execution through its laptop owner.",
                        }),
                });
                if (retainedRecord.status !== "generated" && retainedRecord.status !== "linked")
                    throw new Error(`Retained Recorder failed: ${JSON.stringify(retainedRecord)}`);
                retainedRecordId = retainedRecord.recordId || "";
                const artifact = await checkpointExecutionWorktree({
                    worktreePath: retainedAttempt.path,
                    branch: retainedAttempt.branch,
                    planName: "retained",
                    publicationAttemptId: publication.attemptId,
                    publicationPlanPaths: staging.planPaths,
                });
                publication = await advanceStoredPublication(input.cwd, publication, "artifacts_committed", {
                    artifactCommit: artifact.executionCommit,
                    planPaths: staging.planPaths,
                });
                await publishExecutionWorktreeIsolated({
                    projectRoot: input.cwd,
                    executionCwd: publication.executionCwd,
                    executionBranch: publication.executionBranch,
                    targetBranch: publication.targetBranch,
                    planName: publication.planName,
                    sealedExecutionCommit: publication.artifactCommit!,
                    allowedPlanPaths: publication.planPaths!,
                    publicationRoot: publication.publicationRoot,
                    onIntegrated: async (proof) => {
                        publication = await advanceStoredPublication(
                            input.cwd,
                            publication,
                            "target_integrated",
                            proof,
                        );
                    },
                    onPublished: async (proof) => {
                        publication = await advanceStoredPublication(input.cwd, publication, "target_published", proof);
                    },
                    onVerified: async () => {
                        publication = await advanceStoredPublication(input.cwd, publication, "publication_verified", {
                            verifiedAt: new Date().toISOString(),
                        });
                    },
                });
                const cleaned = await cleanupStoredPublication(input.cwd, publication);
                if (!cleaned.complete) throw new Error(`Retained cleanup failed: ${cleaned.details.join("; ")}`);
            },
            "retained",
        );
        const { retryWorkRecordForPlan } = await import("../work-records/auto-generation.ts");
        const { SYSTEM_WORK_RECORD_MNEMOTECA_PORT: retryIndex } = await import("../work-records/mnemoteca-port.ts");
        const retriedRetained = await retryWorkRecordForPlan({
            cwd: input.cwd,
            planName: "retained",
            mnemotecaPort: retryIndex,
            runRecorderStep: () => {
                throw new Error("Accepted retained Recorder sections must survive cleanup.");
            },
        });
        if (retriedRetained.recordId !== retainedRecordId)
            throw new Error(`Retained record retry lost identity: ${JSON.stringify(retriedRetained)}`);
        if ((await listPlans(input.cwd)).length)
            throw new Error("Retained execution became a canonical Plan implicitly.");
        await authorLocalPlan(input.cwd, {
            planName: "public-tool",
            contextMarkdown: "# Public owner\n",
            validationMarkdown: "Initial validation\n",
            definition: { targetBranch: "main" },
        });
        const plan = await loadPlan(input.cwd, "public-tool");
        if (!plan?.attrs.planId) throw new Error("Authored Plan cannot be read through its owner.");
        if (!plan.path.startsWith(`${input.resources.globalRoot}/projects/`))
            throw new Error("Plan locator did not use the mounted personal store.");
        const document = await readPlanResource(
            input.cwd,
            { planId: plan.attrs.planId, planName: "public-tool" },
            "validation.md",
        );
        const edited = await savePlanDocument(
            plan.attrs.planId,
            "validation.md",
            document.revision,
            "Run the real Git fixture.\n",
        );
        await savePlanProse(input.cwd, "public-tool", "# Public owner\nUpdated prose.\n", edited.revision);
        const updated = await loadPlan(input.cwd, "public-tool");
        if (!updated) throw new Error("Edited Plan is unavailable.");
        await savePlanDefinition(
            input.cwd,
            "public-tool",
            { summary: "Exercise managed ownership" },
            { expectedRevision: updated.revision },
        );
        const { capturePlanReviewInput, applyPlanReviewForExecution } = await import("../../plan-store/index.ts");
        const reviewPlan = await loadPlan(input.cwd, "public-tool");
        if (!reviewPlan) throw new Error("Review Plan is unavailable.");
        const {
            assertAuthorizedPlanPath,
            assertReadablePlanResource,
            loadPlanDetail,
            readPlanReviewPresentation,
            findPlanEvidenceById,
            readPlanResourceCatalog,
            resolvePlan,
        } = await import("../../plan-store/index.ts");
        const detail = await loadPlanDetail(input.cwd, plan.attrs.planId);
        const presented = await withLocalPlanWorkflow(input.cwd, "public-tool", () => readPlanReviewPresentation());
        if (
            detail.resource.planId !== plan.attrs.planId ||
            !detail.bodyEditing ||
            presented?.planName !== "public-tool" ||
            (await findPlanEvidenceById(input.cwd, plan.attrs.planId)).path !== plan.path ||
            (await readPlanResourceCatalog(input.cwd)).resources.length !== 1 ||
            (await resolvePlan(input.cwd, "public-tool")).planName !== "public-tool"
        )
            throw new Error("Browser Plan queries lost their managed owner.");
        await assertAuthorizedPlanPath(input.cwd, reviewPlan.path, "public-tool");
        await assertReadablePlanResource(input.cwd, {
            path: reviewPlan.path,
            planName: "public-tool",
            planId: plan.attrs.planId,
        });
        let rejectedForeignPath = false;
        try {
            await assertAuthorizedPlanPath(
                input.cwd,
                seedPath(input.cwd, "docs", "plans", "public-tool.md"),
                "public-tool",
            );
        } catch {
            rejectedForeignPath = true;
        }
        if (!rejectedForeignPath) throw new Error("Managed resource authorization accepted a checkout path.");
        const reviewInput = await capturePlanReviewInput(input.cwd, "public-tool", reviewPlan.revision);
        const reviewed = await applyPlanReviewForExecution({
            cwd: input.cwd,
            planName: "public-tool",
            planPath: reviewPlan.path,
            planRevision: reviewPlan.revision,
            planWithFrontMatter: reviewPlan.markdown,
            originalAttrs: reviewPlan.attrs,
            packageInput: reviewInput,
            trustedClassification: "PLANNED_CHANGE",
            trustedWorkKind: "FEATURE",
            decision: {
                approved: true,
                plan: reviewPlan.markdown + "\nAccepted browser edit.\n",
                approvalAction: "run",
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
            },
        });
        if (!reviewed.approved) throw new Error("Public browser review did not approve the Plan.");
        const attemptId = await withLocalPlanWorkflow(input.cwd, "public-tool", () =>
            reservePlanExecution("public-tool", { targetBranch: "main" }),
        );
        const { createExecutionStartPorts, startActiveExecutionWorkflow } =
            await import("../workflow/execution-start.ts");
        const ready = await loadPlan(input.cwd, "public-tool");
        if (!ready || !ready.markdown.includes("Accepted browser edit.") || ready.attrs.status !== "ready_for_work")
            throw new Error("Approved browser edits and readiness must share the canonical Plan.");
        const execution = await startActiveExecutionWorkflow({
            cwd: input.cwd,
            planName: "public-tool",
            currentStatus: ready.attrs.status,
            triageMeta: ready.attrs,
            ports: createExecutionStartPorts(),
        });
        const { writeFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const { finalizePlanImplementation } = await import("../workflow/implementation-checkpoint.ts");
        await writeFile(join(execution.executionCwd!, "managed-code.txt"), "delivered code\n");
        await finalizePlanImplementation({
            projectRoot: input.cwd,
            planName: "public-tool",
            executionContext: execution,
        });
        await recordPlanEvent({
            cwd: input.cwd,
            planName: "public-tool",
            event: "mechanical_validation_passed",
            currentStatus: "implemented",
        });
        await recordPlanEvent({
            cwd: input.cwd,
            planName: "public-tool",
            event: "semantic_review_passed",
            currentStatus: "implemented",
        });
        let nonGitCompletionRejected = false;
        try {
            await recordPlanEvent({
                cwd: input.cwd,
                planName: "public-tool",
                event: "validation_passed",
                currentStatus: "reviewed",
                details: {
                    executionMode: "non_git_in_place",
                    deliveryEvidence: { version: 1, mode: "non_git_in_place" },
                },
            });
        } catch {
            nonGitCompletionRejected = true;
        }
        if (!nonGitCompletionRejected || (await loadPlan(input.cwd, "public-tool"))?.attrs.status !== "reviewed")
            throw new Error("Git execution completed without matching publication proof.");
        await withLocalPlanWorkflow(input.cwd, "public-tool", async () => {
            const { startPublicationAttempt, advanceStoredPublication, cleanupStoredPublication } =
                await import("../workflow/publication-machine.ts");
            const {
                preparePackageCopies,
                settlePackagePublication,
                freezePlanPublicationPolicy,
                sealPackagePublication,
            } = await import("../../plan-store/index.ts");
            const { publishExecutionWorktreeIsolated } = await import("../isolated-publication.ts");
            const { captureForegroundProcess } = await import("../captured-process.ts");
            const commit = async (cwd: string, ref: string) => {
                const result = await captureForegroundProcess("git", { cwd, args: ["rev-parse", ref] });
                if (!result.success) throw new Error("Git commit unavailable.");
                return new TextDecoder().decode(result.stdout).trim();
            };
            await freezePlanPublicationPolicy("public-tool", attemptId, {
                plans: input.copyDocuments,
                workRecords: input.copyDocuments,
                autoGenerateRecords: true,
            });
            await sealPackagePublication(
                "public-tool",
                attemptId,
                await commit(execution.executionCwd!, "HEAD"),
                "main",
                true,
            );
            const { autoGenerateWorkRecordForCompletedPlan } = await import("../work-records/auto-generation.ts");
            const { SYSTEM_WORK_RECORD_MNEMOTECA_PORT } = await import("../work-records/mnemoteca-port.ts");
            const recorded = await autoGenerateWorkRecordForCompletedPlan({
                cwd: input.cwd,
                planName: "public-tool",
                pendingPublication: true,
                mnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
                runRecorderStep: () =>
                    Promise.resolve({
                        title: "Managed delivery",
                        summary: "Delivered code with laptop-owned evidence.",
                    }),
            });
            if (recorded.status !== "generated" && recorded.status !== "linked")
                throw new Error(`Managed Recorder failed: ${JSON.stringify(recorded)}`);
            let attempt = await startPublicationAttempt({
                projectRoot: input.cwd,
                attemptId,
                planName: "public-tool",
                targetBranch: "main",
                executionBranch: execution.worktreeBranch!,
                executionCwd: execution.executionCwd!,
                validatedCommit: await commit(execution.executionCwd!, "HEAD"),
                targetHeadAtSeal: await commit(input.cwd, "refs/heads/main"),
            });
            let refusedUnpublished = false;
            try {
                await settlePackagePublication(input.cwd, attempt);
            } catch {
                refusedUnpublished = true;
            }
            if (!refusedUnpublished || (await loadPlan(input.cwd, "public-tool"))?.attrs.status !== "reviewed")
                throw new Error("Unpublished Git was incorrectly accepted as delivery.");
            const artifacts = await preparePackageCopies(input.cwd, attempt);
            attempt = await advanceStoredPublication(input.cwd, attempt, "artifacts_committed", artifacts);
            await publishExecutionWorktreeIsolated({
                projectRoot: input.cwd,
                executionCwd: attempt.executionCwd,
                executionBranch: attempt.executionBranch,
                targetBranch: attempt.targetBranch,
                planName: attempt.planName,
                sealedExecutionCommit: attempt.artifactCommit || attempt.validatedCommit,
                allowedPlanPaths: attempt.planPaths || [],
                packageInput: attempt.packageInput,
                publicationRoot: attempt.publicationRoot,
                onIntegrated: async (proof) => {
                    attempt = await advanceStoredPublication(input.cwd, attempt, "target_integrated", proof);
                },
                onPublished: async (proof) => {
                    attempt = await advanceStoredPublication(input.cwd, attempt, "target_published", proof);
                },
                onVerified: async () => {
                    attempt = await advanceStoredPublication(input.cwd, attempt, "publication_verified", {
                        verifiedAt: new Date().toISOString(),
                    });
                },
            });
            await settlePackagePublication(input.cwd, attempt);
            const cleanup = await cleanupStoredPublication(input.cwd, attempt);
            if (!cleanup.complete) throw new Error(`Managed cleanup did not finish: ${cleanup.details.join("; ")}`);
            if ((await loadPlan(input.cwd, "public-tool"))?.attrs.status !== "verified")
                throw new Error("Laptop Plan did not receive confirmed remote Git publication.");
        });
        const { readWorkRecordById, searchWorkRecords } = await import("../work-records/search.ts");
        const { readWorkRecord, listWorkRecords } = await import("../work-records/store.ts");
        const { basename } = await import("node:path");
        const { SYSTEM_WORK_RECORD_MNEMOTECA_PORT } = await import("../work-records/mnemoteca-port.ts");
        const recordId = (await loadPlan(input.cwd, "public-tool"))?.attrs.workRecord?.recordId;
        if (!recordId) throw new Error("Completed Plan lost its record backlink.");
        const records = await listWorkRecords(input.cwd);
        const record = records.find((entry) => entry.attrs.recordId === recordId);
        if (
            !record ||
            record.attrs.status !== "approved" ||
            !record.path.startsWith(`${input.resources.globalRoot}/projects/`)
        )
            throw new Error("Public record catalog lost its canonical owner.");
        if (
            (await readWorkRecordById(input.cwd, recordId, { accessMode: "current" })).status !== "approved" ||
            (await readWorkRecord(input.cwd, basename(record.path))).attrs.recordId !== recordId
        )
            throw new Error("Public record retrieval lost approved delivery.");
        const searched = await searchWorkRecords(input.cwd, "Managed delivery", {
            mnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
        });
        if (!searched.records.some((entry) => entry.recordId === recordId))
            throw new Error("Public record search omitted confirmed delivery.");
        const {
            renamePlan,
            archiveSavedPlan,
            restoreSavedPlan,
            listArchivedPlans,
            loadArchivedPlan,
            deleteArchivedPlanUnit,
        } = await import("../../plan-store/index.ts");
        const delivered = await loadPlan(input.cwd, "public-tool");
        if (!delivered) throw new Error("Published Plan is unavailable for archive.");
        await renamePlan(input.cwd, "public-tool", "renamed-public-tool", delivered.revision);
        await archiveSavedPlan(input.cwd, "renamed-public-tool", { force: true });
        if (
            (await listPlans(input.cwd)).length ||
            (await listArchivedPlans(input.cwd)).length !== 1 ||
            !(await loadArchivedPlan(input.cwd, plan.attrs.planId))
        )
            throw new Error("Archive ownership was lost.");
        let retained = false;
        try {
            await deleteArchivedPlanUnit(input.cwd, "renamed-public-tool");
        } catch (error) {
            retained = error instanceof Error && error.message.includes("requires a confirmed retention preview");
        }
        if (!retained) throw new Error("Name-only deletion bypassed the retention preview.");
        await restoreSavedPlan(input.cwd, plan.attrs.planId, "public-tool");
        if ((await listArchivedPlans(input.cwd)).length || !(await loadPlan(input.cwd, "public-tool")))
            throw new Error("Archive restoration did not preserve identity.");
        const history = await listPlanHistory(input.cwd, plan.attrs.planId);
        const approvedVersion = history.milestones.find((item) => item.milestone === "approved");
        if (!approvedVersion || !history.milestones.some((item) => item.milestone === "delivered"))
            throw new Error("The laptop did not retain the reviewed and delivered inputs.");
        const frozen = await showPlanMilestone(input.cwd, plan.attrs.planId, approvedVersion.version);
        const edit = await savePlanProse(input.cwd, "public-tool", "# Later live edit\n", history.revision);
        const restoredRevision = await restorePlanMilestone(
            input.cwd,
            plan.attrs.planId,
            approvedVersion.version,
            edit,
        );
        const replay = await restorePlanMilestone(input.cwd, plan.attrs.planId, approvedVersion.version, edit);
        const restoredDocument = await loadPlan(input.cwd, "public-tool");
        if (
            restoredRevision !== replay ||
            restoredDocument?.revision !== restoredRevision ||
            restoredDocument.body !== frozen["context.md"] ||
            restoredDocument.attrs.status !== delivered.attrs.status
        )
            throw new Error("Managed history replay changed the restore outcome or current lifecycle state.");
        await authorLocalPlan(input.cwd, {
            planName: "managed-sequence",
            contextMarkdown: "# Sequence\n",
            definition: { classification: "PROJECT", type: "sequence", targetBranch: "main" },
        });
        const { saveChildFeaturePlans, findPlansByParent } = await import("../../plan-store/index.ts");
        const children = await saveChildFeaturePlans(input.cwd, "managed-sequence", [
            {
                title: "First",
                summary: "First step",
                content: "# First\n",
                order: 1,
                dependencies: [],
                affectedPaths: ["first.ts"],
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
            },
            {
                title: "Second",
                summary: "Second step",
                content: "# Second\n",
                order: 2,
                dependencies: ["first"],
                affectedPaths: ["second.ts"],
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
            },
        ]);
        if (
            children.length !== 2 ||
            children.some((child) => !child.path.startsWith(input.resources.globalRoot)) ||
            (await findPlansByParent(input.cwd, "managed-sequence")).length !== 2
        )
            throw new Error("Managed child family did not retain its owner.");
        const { prepareSequenceReview, applySequenceReviewDecision } = await import("../../plan-store/index.ts");
        const sequenceDocuments = await prepareSequenceReview(input.cwd, "managed-sequence");
        if (sequenceDocuments.length !== 3) throw new Error("Managed Sequence snapshot omitted family members.");
        const sequenceDecision = await applySequenceReviewDecision({
            cwd: input.cwd,
            documents: sequenceDocuments,
            decision: {
                approved: true,
                approvalAction: "later",
                documents: sequenceDocuments.map((document) => ({ planId: document.planId, plan: document.plan })),
            },
        });
        if (
            !sequenceDecision.approved ||
            sequenceDecision.recoveryRequired ||
            (await loadPlan(input.cwd, "managed-sequence/first"))?.attrs.status !== "ready_for_work"
        )
            throw new Error(`Managed Sequence review failed: ${JSON.stringify(sequenceDecision)}`);
        const sequenceReplay = await applySequenceReviewDecision({
            cwd: input.cwd,
            documents: sequenceDocuments,
            decision: {
                approved: true,
                approvalAction: "later",
                documents: sequenceDocuments.map((document) => ({ planId: document.planId, plan: document.plan })),
            },
        });
        if (
            sequenceReplay.revision !== sequenceDecision.revision ||
            (await findPlansByParent(input.cwd, "managed-sequence")).some((child) => child.attrs.worktreeId)
        )
            throw new Error("Sequence replay changed its decision or started a later child.");
        await authorLocalPlan(input.cwd, {
            planName: "managed-epic",
            contextMarkdown: "# Epic\n\n## Objective\nDeliver the family.\n",
            definition: { classification: "PROJECT", type: "epic", targetBranch: "epic/managed" },
        });
        await recordPlanEvent({
            cwd: input.cwd,
            planName: "managed-epic",
            event: "review_approved",
            currentStatus: "draft",
        });
        await recordPlanEvent({
            cwd: input.cwd,
            planName: "managed-epic",
            event: "epic_readiness_passed",
            currentStatus: "approved",
        });
        const { finalizePlanDecomposition, recordPlanDeviation, syncEpicChildPlanDeviations, recordIntegrationNotes } =
            await import("../../plan-store/index.ts");
        const decomposed = await finalizePlanDecomposition(input.cwd, "managed-epic", [
            {
                title: "Slice",
                summary: "One slice",
                content: "# Slice\n",
                dependencies: [],
                affectedPaths: ["slice.ts"],
                order: 1,
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
            },
        ]);
        if (decomposed.updated.status !== "ready_for_work" || decomposed.childNames.length !== 1)
            throw new Error("Managed Epic decomposition did not finalize its family.");
        const slice = await loadPlan(input.cwd, "managed-epic/slice");
        if (!slice) throw new Error("Managed Epic child is unavailable.");
        await recordPlanDeviation(
            input.cwd,
            "managed-epic/slice",
            {
                id: "fixture-deviation",
                supersededRequirement: "Old requirement",
                replacementRequirement: "Updated requirement",
                approvedAt: "2026-11-16T00:00:00.000Z",
            },
            slice.revision,
        );
        await syncEpicChildPlanDeviations(input.cwd, "managed-epic/slice");
        await recordIntegrationNotes(input.cwd, "managed-epic", "managed-epic/slice", [
            { check: "Verify the integrated family.", where: "assembled Epic" },
        ]);
        const projected = await loadPlan(input.cwd, "managed-epic");
        if (
            !projected?.markdown.includes("Updated requirement") ||
            !projected.markdown.includes("Verify the integrated family.")
        )
            throw new Error("Epic projections did not reach its canonical owner.");
        const {
            operatePlanFile,
            saveEpicArtifact,
            resolveEpicArtifactPath,
            appendEpicManualQaSection,
            findEpicManualQaSection,
        } = await import("../../plan-store/index.ts");
        const fileEdited = await operatePlanFile(input.cwd, {
            path: projected.path,
            mode: "edit",
            oldText: "Deliver the family.",
            newText: "Deliver and inspect the family.",
        });
        if (
            !fileEdited ||
            !(await operatePlanFile(input.cwd, { path: projected.path, mode: "read" }))?.content?.includes(
                "Deliver and inspect the family.",
            )
        )
            throw new Error("Managed file edit did not reach its owner.");
        let rejectedCheckoutEdit = false;
        try {
            await operatePlanFile(input.cwd, {
                path: seedPath(input.cwd, "docs/plans/managed-epic.md"),
                mode: "write",
                content: "# Wrong owner",
            });
        } catch {
            rejectedCheckoutEdit = true;
        }
        if (!rejectedCheckoutEdit) throw new Error("Managed file tool wrote a checkout Plan.");
        await saveEpicArtifact(input.cwd, "managed-epic", "integration-report.md", "# Integrated family report\n");
        const artifactPath = await resolveEpicArtifactPath(input.cwd, "managed-epic", "integration-report.md");
        if (
            !artifactPath.startsWith(input.resources.globalRoot) ||
            (
                await readPlanResource(
                    input.cwd,
                    { planId: projected.attrs.planId!, planName: "managed-epic" },
                    "integration-report.md",
                )
            ).body !== "# Integrated family report\n"
        )
            throw new Error("Epic artifact lost canonical ownership.");
        const qa = {
            projectRoot: input.cwd,
            epicPlanName: "managed-epic",
            childPlanName: "managed-epic/slice",
            childHeading: "Slice",
            checklistMarkdown: "Manual verification steps for managed-epic/slice\n- [ ] Inspect the integrated slice.",
        };
        let missingAttemptRejected = false;
        try {
            await appendEpicManualQaSection(qa);
        } catch {
            missingAttemptRejected = true;
        }
        if (!missingAttemptRejected) throw new Error("Generated QA accepted a missing attempt.");
        await recordPlanEvent({
            cwd: input.cwd,
            planName: "managed-epic/slice",
            event: "review_approved",
            currentStatus: "draft",
        });
        await recordPlanEvent({
            cwd: input.cwd,
            planName: "managed-epic/slice",
            event: "readiness_passed",
            currentStatus: "approved",
        });
        await withLocalPlanWorkflow(input.cwd, "managed-epic/slice", () =>
            reservePlanExecution("managed-epic/slice", { targetBranch: "epic/managed" }),
        );
        if (
            (await appendEpicManualQaSection(qa)).status !== "recorded" ||
            !(await findEpicManualQaSection(input.cwd, qa.epicPlanName, qa.childPlanName)).exists ||
            (await appendEpicManualQaSection(qa)).status !== "already_present"
        )
            throw new Error("Generated QA did not retain its exact family attempt.");
        const { sharePlanForReview, pullPlanForRevision, pushPlanRevision, unsharePlan } =
            await import("../../plan-store/index.ts");
        const shared = await sharePlanForReview({
            cwd: input.cwd,
            target: "managed-epic/slice",
            planServer: input.collaborationUrl,
            projectSecrets: true,
        });
        if (
            !shared.reviewerUrl ||
            (await loadPlan(input.cwd, "managed-epic/slice"))?.attrs.collaborationSpaceId !== shared.spaceId
        )
            throw new Error("Managed collaboration did not retain canonical ownership.");
        const collaborationOptions = { cwd: input.cwd, target: "managed-epic/slice", projectSecrets: true };
        const pulled = await pullPlanForRevision(collaborationOptions);
        if (pulled.spaceId !== shared.spaceId || pulled.revision !== 1 || pulled.action !== "up-to-date")
            throw new Error("Managed pull did not read the owner collaboration state.");
        let rejectedDuplicate = false;
        try {
            await pushPlanRevision(collaborationOptions);
        } catch (error) {
            if (!(error instanceof Error) || !error.message.includes("Project store request refused (409)"))
                throw error;
            rejectedDuplicate = true;
        }
        if (!rejectedDuplicate || (await pullPlanForRevision(collaborationOptions)).revision !== 1)
            throw new Error("Managed push changed an unchanged shared revision.");
        // An external laptop editor changes real canonical bytes; the execution checkout remains uninvolved.
        await seedFile(
            seedPath(
                input.resources.personalOwner!.identity,
                ".wld/projects",
                inspectedIdentity.identity.projectId,
                "plans/managed-epic/slice/context.md",
            ),
            "# Slice\n\nLaptop-authored revision.\n",
        );
        const pushed = await pushPlanRevision(collaborationOptions);
        if (pushed.revision !== 2 || (await pullPlanForRevision(collaborationOptions)).revision !== 2)
            throw new Error("Managed push did not publish the owner's actual edited bytes.");
        const { parseCollaborationUrl } = await import("../collaboration/urls.ts");
        const { CollaborationClient, SYSTEM_COLLABORATION_FETCH } = await import("../collaboration/client.ts");
        const { importContentKey, encryptJsonPayload } = await import("../collaboration/crypto.ts");
        const remoteMaintainer = parseCollaborationUrl(shared.maintainerUrl);
        const remoteEditor = new CollaborationClient({
            serverUrl: remoteMaintainer.serverUrl,
            bearerCapability: remoteMaintainer.bearerCapability,
            fetch: SYSTEM_COLLABORATION_FETCH,
        });
        const remoteBody = "# Slice\n\nAccepted remote revision.\n";
        const payloadCiphertext = await encryptJsonPayload(
            {
                planId: shared.planId,
                title: "Slice",
                metadata: { ...pulled.attrs, planId: shared.planId },
                body: remoteBody,
            },
            await importContentKey(remoteMaintainer.contentKey),
        );
        await remoteEditor.appendRevision(shared.spaceId, { expectedRevision: 3, payloadCiphertext });
        const nextPull = await pullPlanForRevision(collaborationOptions);
        if (nextPull.revision !== 3 || (await loadPlan(input.cwd, "managed-epic/slice"))?.body !== remoteBody)
            throw new Error("A completed earlier pull concealed new remote feedback.");
        const originalPrompt = globalThis.prompt;
        let declined = false;
        try {
            globalThis.prompt = () => "no";
            try {
                await unsharePlan(collaborationOptions);
            } catch (error) {
                declined = error instanceof Error && error.message.includes("cancelled");
            }
            if (!declined || !(await loadPlan(input.cwd, "managed-epic/slice"))?.attrs.collaborationSpaceId)
                throw new Error("Declining managed unshare changed shared ownership.");
        } finally {
            globalThis.prompt = originalPrompt;
        }
        let unshared: Awaited<ReturnType<typeof unsharePlan>>;
        try {
            globalThis.prompt = () => "yes";
            unshared = await unsharePlan(collaborationOptions);
        } finally {
            globalThis.prompt = originalPrompt;
        }
        if (
            !unshared.localMetadataCleared ||
            !unshared.deletedSecretCount ||
            (await loadPlan(input.cwd, "managed-epic/slice"))?.attrs.collaborationSpaceId
        )
            throw new Error("Managed unshare did not clear owner metadata and secrets.");
        await authorLocalPlan(input.cwd, {
            planName: "recovery",
            contextMarkdown: "# Recover review\n",
            definition: { classification: "PLANNED_CHANGE", workKind: "FEATURE", targetBranch: "main" },
        });
        await recordPlanEvent({
            cwd: input.cwd,
            planName: "recovery",
            event: "review_approved",
            currentStatus: "draft",
        });
        await recordPlanEvent({
            cwd: input.cwd,
            planName: "recovery",
            event: "readiness_passed",
            currentStatus: "approved",
        });
        const recoveryAttempt = await withLocalPlanWorkflow(input.cwd, "recovery", () =>
            reservePlanExecution("recovery", { targetBranch: "main" }),
        );
        await startActiveExecutionWorkflow({
            cwd: input.cwd,
            planName: "recovery",
            currentStatus: "ready_for_work",
            triageMeta: {},
            ports: createExecutionStartPorts(),
        });
        const {
            reconcilePlanExecutionBinding,
            restoreRecreatedPlanExecution,
            runPlanRecoveryEffects,
            resetPlanExecutionMetadata,
            restoreNonGitPlanExecution,
        } = await import("../../plan-store/index.ts");
        if ((await reconcilePlanExecutionBinding(input.cwd, "recovery", recoveryAttempt)).legacyExecutionMode)
            throw new Error("Managed execution repair lost its Git mode.");
        const recreateSource = await loadPlan(input.cwd, "recovery");
        if (!recreateSource) throw new Error("Recreation source is unavailable.");
        let nonGitRefused = false;
        try {
            await restoreNonGitPlanExecution(input.cwd, "recovery", recreateSource.revision);
        } catch {
            nonGitRefused = true;
        }
        if (!nonGitRefused) throw new Error("A Git attempt was changed to non-Git execution.");
        const recreated = await runPlanRecoveryEffects({
            projectRoot: input.cwd,
            planName: "recovery",
            worktreeId: recoveryAttempt,
            action: "recreate",
            expectedRevision: recreateSource.revision,
            recover: async () => {
                const entry = await (await import("../worktree-registry.ts")).findById(input.cwd, recoveryAttempt);
                if (!entry) throw new Error("Original recreation attempt is unavailable.");
                await fixtureGit(input.cwd, ["worktree", "remove", "--force", entry.path]);
                await fixtureGit(input.cwd, ["worktree", "add", entry.path, entry.branch]);
                return await restoreRecreatedPlanExecution(input.cwd, "recovery", recoveryAttempt);
            },
        });
        if (
            recreated.status !== "committed" ||
            (await loadPlan(input.cwd, "recovery"))?.attrs.status !== "ready_for_work"
        )
            throw new Error(`Managed recreation failed: ${JSON.stringify(recreated)}`);
        await startActiveExecutionWorkflow({
            cwd: input.cwd,
            planName: "recovery",
            currentStatus: "ready_for_work",
            triageMeta: {},
            ports: createExecutionStartPorts(),
        });
        const recoveryBefore = await loadPlan(input.cwd, "recovery");
        if (!recoveryBefore) throw new Error("Recovery Plan is unavailable.");
        const { reopenPlanReview, capturePlanExecutionContext, detachPlanExecution } =
            await import("../../plan-store/index.ts");
        let rejectedWrongAttempt = false;
        try {
            await reopenPlanReview(
                input.cwd,
                "recovery",
                crypto.randomUUID(),
                recoveryBefore.attrs.status,
                recoveryBefore.revision,
            );
        } catch {
            rejectedWrongAttempt = true;
        }
        if (!rejectedWrongAttempt || (await loadPlan(input.cwd, "recovery"))?.revision !== recoveryBefore.revision)
            throw new Error("Review reopening accepted another execution attempt.");
        await reopenPlanReview(
            input.cwd,
            "recovery",
            recoveryAttempt,
            recoveryBefore.attrs.status,
            recoveryBefore.revision,
        );
        const recoveredReview = await loadPlan(input.cwd, "recovery");
        if (
            recoveredReview?.attrs.status !== "draft" ||
            (await withLocalPlanWorkflow(input.cwd, "recovery", () => capturePlanExecutionContext("recovery")))
                ?.packageAttemptId !== recoveryAttempt
        )
            throw new Error("Review reopening lost the original reserved execution.");
        let refusedActiveDetach = false;
        try {
            await detachPlanExecution(input.cwd, "recovery", recoveredReview.attrs.planId);
        } catch {
            refusedActiveDetach = true;
        }
        if (!refusedActiveDetach) throw new Error("Owner released an execution without abandonment evidence.");
        const { updateEntry } = await import("../worktree-registry.ts");
        await updateEntry(input.cwd, recoveryAttempt, { status: "abandoned" });
        await detachPlanExecution(input.cwd, "recovery", recoveredReview.attrs.planId);
        await recordPlanEvent({
            cwd: input.cwd,
            planName: "recovery",
            event: "review_approved",
            currentStatus: "draft",
        });
        await recordPlanEvent({
            cwd: input.cwd,
            planName: "recovery",
            event: "readiness_passed",
            currentStatus: "approved",
        });
        let replacement = await withLocalPlanWorkflow(input.cwd, "recovery", () =>
            reservePlanExecution("recovery", { targetBranch: "main" }),
        );
        if (replacement === recoveryAttempt)
            throw new Error("Proven abandonment did not release the original attempt.");
        await startActiveExecutionWorkflow({
            cwd: input.cwd,
            planName: "recovery",
            currentStatus: "ready_for_work",
            triageMeta: {},
            ports: createExecutionStartPorts(),
        });
        await updateEntry(input.cwd, replacement, { status: "abandoned" });
        const beforeReset = await loadPlan(input.cwd, "recovery");
        await resetPlanExecutionMetadata(input.cwd, "recovery", "stop", beforeReset!.revision);
        if ((await loadPlan(input.cwd, "recovery"))?.attrs.status !== "ready_for_work")
            throw new Error("Managed reset did not retain its recovery lifecycle.");
        const resetAttempt = replacement;
        replacement = await withLocalPlanWorkflow(input.cwd, "recovery", () =>
            reservePlanExecution("recovery", { targetBranch: "main" }),
        );
        if (replacement === resetAttempt) throw new Error("Managed reset retained the abandoned reservation.");
        await startActiveExecutionWorkflow({
            cwd: input.cwd,
            planName: "recovery",
            currentStatus: "ready_for_work",
            triageMeta: {},
            ports: createExecutionStartPorts(),
        });
        await recordPlanEvent({
            cwd: input.cwd,
            planName: "recovery",
            event: "manual_user_verified",
            currentStatus: "in_progress",
            details: { userVerificationNote: "Fixture owner accepted this work." },
        });
        const userAccepted = await loadPlan(input.cwd, "recovery");
        if (!userAccepted || userAccepted.attrs.status !== "user_verified" || userAccepted.attrs.verifiedAt)
            throw new Error("User verification fabricated Git publication confidence.");
        const { retainUserVerifiedPlan } = await import("../../plan-store/index.ts");
        await retainUserVerifiedPlan(input.cwd, "recovery", userAccepted.revision, replacement);
        if ((await loadPlan(input.cwd, "recovery"))?.attrs.status !== "user_verified")
            throw new Error("User verification recovery lost its accepted status.");
        const {
            importPlans,
            importedPlanCopyChoice,
            readPlanSessionArtifact,
            collectArchivedPlanUnits,
            discoverPlanDocumentRoot,
            ensurePlanIdentity,
        } = await import("../../plan-store/index.ts");
        const externalImport = seedPath(input.cwd, "import-source.md");
        await seedFile(externalImport, "# Explicit external proposal\n\nPreserve source bytes.\n");
        const imported = await importPlans(input.cwd, externalImport);
        const importedAgain = await importPlans(input.cwd, externalImport);
        if (
            imported.planIds.length !== 1 ||
            importedAgain.planIds[0] !== imported.planIds[0] ||
            (await (await import("node:fs/promises")).readFile(externalImport, "utf8")) !==
                "# Explicit external proposal\n\nPreserve source bytes.\n"
        )
            throw new Error("Managed explicit import changed source bytes or identity.");
        const importedPlan = await loadPlan(input.cwd, imported.planIds[0]);
        if (
            !importedPlan ||
            !importedPlan.path.startsWith(input.resources.globalRoot) ||
            importedPlan.attrs.status !== "draft"
        )
            throw new Error("Explicit import did not produce an independent canonical draft.");
        if ((await ensurePlanIdentity(input.cwd, imported.planIds[0])).planId !== imported.planIds[0])
            throw new Error("Managed identity lookup fell back to the checkout.");
        if (
            (await discoverPlanDocumentRoot(input.cwd, importedPlan.path)).path !== input.cwd ||
            (await collectArchivedPlanUnits(input.cwd)).length
        )
            throw new Error("Managed discovery exposed checkout history as canonical state.");
        const artifact = await readPlanSessionArtifact(
            input.cwd,
            "docs/plans/managed-epic/integration-report.md",
            "epic-artifact",
        );
        if (!artifact.markdown.includes("Integrated family report"))
            throw new Error("Session artifact registration lost its personal owner.");
        if (!(await importedPlanCopyChoice(input.cwd, "docs/plans")))
            throw new Error("Managed import did not request its repository copy choice.");
        await importedPlanCopyChoice(input.cwd, "docs/plans", input.copyDocuments);
        if (await importedPlanCopyChoice(input.cwd, "docs/plans"))
            throw new Error("Managed repository copy choice was not retained.");
        const { archivePlansByStatus } = await import("../../plan-store/index.ts");
        const bulk = await archivePlansByStatus(input.cwd, "draft", { force: true });
        if (
            bulk.failed.length ||
            !["import-source", "managed-epic"].every((name) => bulk.archived.some((entry) => entry.name === name))
        )
            throw new Error(`Managed bulk archive lost its owner: ${JSON.stringify(bulk)}`);
        await restoreSavedPlan(input.cwd, imported.planIds[0]);
        const { runPlansDoctor } = await import("../../plan-store/index.ts");
        const diagnosis = await runPlansDoctor(input.cwd, false);
        if (
            diagnosis.issues.some((issue) =>
                ["package_integrity_error", "registry_plan_identity_mismatch", "registry_dangling_plan_id"].includes(
                    issue.kind,
                ),
            )
        )
            throw new Error(`Managed doctor misrouted Plan identity: ${JSON.stringify(diagnosis)}`);
        const replacementImport = await importPlans(input.cwd, "docs/plans/abandoned-original.md");
        if (!replacementImport.planIds.includes(abandonedPlanId))
            throw new Error("Explicit import changed the abandoned Plan identity.");
        await withLocalPlanWorkflow(input.cwd, "abandoned-original", async () => {
            await recordPlanEvent({
                cwd: input.cwd,
                planName: "abandoned-original",
                event: "review_reopened",
            });
            for (const [event, currentStatus] of [
                ["review_approved", "draft"],
                ["readiness_passed", "approved"],
            ] as const)
                await recordPlanEvent({ cwd: input.cwd, planName: "abandoned-original", event, currentStatus });
            const replacement = await reservePlanExecution("abandoned-original", { targetBranch: "main" });
            if (replacement === seededAttempts.abandoned.id)
                throw new Error("Explicitly imported Plan reused its abandoned attempt.");
            const stillReserved = await reservePlanExecution("abandoned-original", {
                targetBranch: "main",
                suggestedAttemptId: crypto.randomUUID(),
            });
            if (stillReserved !== replacement) throw new Error("A live replacement reservation was replaced.");
        });
        let originalResumeRejected = false;
        let originalResumed = false;
        const abandonedHistoricalAccess: import("../../plan-store/index.ts").PlanAccess = JSON.parse(
            JSON.stringify({ identity: inspectedIdentity.identity, planId: abandonedPlanId, expectedRevision: 1 }),
        );
        try {
            await resumePlanAttempt(
                input.cwd,
                abandonedHistoricalAccess,
                seededAttempts.abandoned.id,
                () => {
                    originalResumed = true;
                    return Promise.resolve();
                },
                "abandoned-original",
            );
        } catch {
            originalResumeRejected = true;
        }
        if (!originalResumeRejected || originalResumed)
            throw new Error("Replacement allowed the abandoned original to resume.");
        let completedSource = "docs/plans/retained.md";
        if (input.remoteTarget) {
            await fixtureGit(input.cwd, ["fetch", "origin", "main"]);
            await seedDirectory(seedPath(input.cwd, "published-import"));
            completedSource = seedPath(input.cwd, "published-import", "retained.md");
            const publishedSource = await (
                await import("../captured-process.ts")
            ).captureForegroundProcess("git", {
                cwd: input.cwd,
                args: ["show", "origin/main:docs/plans/retained.md"],
            });
            if (!publishedSource.success) throw new Error("Published import source is unavailable.");
            await seedFile(completedSource, publishedSource.stdout);
        }
        if (input.recordParent) await importPlans(input.cwd, "docs/plans/retained-parent.md");
        const completedImport = await importPlans(input.cwd, completedSource);
        if (!completedImport.planIds.includes(retainedPlanId))
            throw new Error("Explicit import changed the published Plan identity.");
        await withLocalPlanWorkflow(input.cwd, "retained", async () => {
            await recordPlanEvent({ cwd: input.cwd, planName: "retained", event: "review_reopened" });
            for (const [event, currentStatus] of [
                ["review_approved", "draft"],
                ["readiness_passed", "approved"],
            ] as const)
                await recordPlanEvent({ cwd: input.cwd, planName: "retained", event, currentStatus });
            const replacement = await reservePlanExecution("retained", { targetBranch: "main" });
            if (replacement === retainedAttempt.id)
                throw new Error("Explicitly imported Plan reused its published attempt.");
        });
        const invalidResumes: string[] = [];
        for (const [planName, savedAccess, oldAttemptId] of [
            ["abandoned-original", savedAbandonedAccess, seededAttempts.abandoned.id],
            ["retained", savedRetainedAccess, retainedAttempt.id],
        ] as const) {
            const beforeResume = await loadPlan(input.cwd, planName);
            let rejected = false;
            let resumed = false;
            try {
                await resumePlanAttempt(
                    input.cwd,
                    savedAccess,
                    oldAttemptId,
                    () => {
                        resumed = true;
                        return Promise.resolve();
                    },
                    planName,
                );
            } catch {
                rejected = true;
            }
            if (!rejected || resumed || (await loadPlan(input.cwd, planName))?.revision !== beforeResume?.revision)
                invalidResumes.push(planName);
        }
        if (invalidResumes.length)
            throw new Error(`Saved managed continuation entered replacement attempts: ${invalidResumes.join(", ")}`);
        const { resolveProjectRuntimeLayout } = await import("../project-runtime-layout.ts");
        const finalResult = {
            retainedRecordId,
            retainedPlanId,
            retainedAttemptId: retainedAttempt.id,
            retainedExecutionCwd: retainedAttempt.path,
            planId: plan.attrs.planId,
            attemptId,
            recordId: (await loadPlan(input.cwd, "public-tool"))?.attrs.workRecord?.recordId,
            executionCwd: execution.executionCwd,
            registryPath: resolveProjectRuntimeLayout(input.cwd).primary.worktreeRegistryPath,
            legacyRuntime: getRunWieldRuntimeDir(input.cwd),
            plans: await listPlans(input.cwd),
        };
        clear();
        let closedRejected = false;
        try {
            await listPlans(input.cwd);
        } catch {
            closedRejected = true;
        }
        if (!closedRejected) throw new Error("Closed owner connection fell back to local data.");
        let historyUnavailable = false;
        try {
            await listPlanHistory(input.cwd, plan.attrs.planId);
        } catch {
            historyUnavailable = true;
        }
        if (!historyUnavailable) throw new Error("Disconnected history read selected the execution account.");
        const reconnected = await (
            await import("../captured-process.ts")
        ).captureForegroundProcess(process.execPath, {
            cwd: input.cwd,
            args: [new URL("./managed-store-reconnect-client.ts", import.meta.url).pathname],
            stdinText:
                JSON.stringify({ ...input, planId: imported.planIds[0], expectedPath: importedPlan.path }) + "\n",
        });
        if (!reconnected.success)
            throw new Error(`Managed reconnect failed: ${new TextDecoder().decode(reconnected.stderr)}`);
        console.log(JSON.stringify(finalResult));
    } finally {
        clear();
    }
}
await executeManagedFixture();
