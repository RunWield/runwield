import { equal, ok, rejects } from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { activateRemoteProjectOwner, type RemoteInteractiveConfig } from "./entry.ts";

const [command, json] = process.argv.slice(2);
type ComposedRemoteInput = Pick<RemoteInteractiveConfig, "cwd" | "resources" | "connection"> & { attemptId?: string };
const input: ComposedRemoteInput = JSON.parse(json);
const managed = command.startsWith("managed");
const clear = managed ? await activateRemoteProjectOwner(input) : () => {};
try {
    const {
        importPlans,
        listPlans,
        loadPlan,
        savePlanProse,
        withLocalPlanWorkflow,
        recordPlanEvent,
        freezePlanPublicationPolicy,
        sealPackagePublication,
        stageValidationPassedInExecutionWorktree,
        preparePackageCopies,
        settlePackagePublication,
        listOwnedWorkRecords,
        readPublishedDeliverySources,
        readPublishedRecordMarkdown,
    } = await import("../../plan-store/index.ts");
    if (command === "managed-author" || command === "managed-author-rename") {
        const { authorLocalPlan, renamePlan } = await import("../../plan-store/index.ts");
        if (command === "managed-author")
            await authorLocalPlan(input.cwd, { planName: "repeatable", contextMarkdown: "# New Plan\n" });
        const plan = await loadPlan(input.cwd, "repeatable");
        ok(plan?.attrs.planId);
        if (command === "managed-author-rename") await renamePlan(input.cwd, "repeatable", "renamed", plan.revision);
        console.log(plan.attrs.planId);
    } else if (command === "manual-prune-seed" || command === "managed-prune" || command === "manual-prune-list") {
        const { runWorkRecordsCommand } = await import("../../cmd/wr/index.ts");
        const { SYSTEM_WORK_RECORD_MNEMOTECA_PORT } = await import("../work-records/mnemoteca-port.ts");
        const { setExactProjectCustomSetting } = await import("../settings.ts");
        if (!managed) process.env.SSH_CONNECTION = "192.0.2.2 54321 192.0.2.1 22";
        if (command === "manual-prune-seed") {
            const { writeWorkRecord } = await import("../work-records/store.ts");
            const { recordAttrs, recordBody } = await import("../work-records/test-fixtures/package-records.ts");
            await writeWorkRecord(
                input.cwd,
                recordAttrs({ recordId: "aaaa1111-1111-4111-8111-111111111111" }),
                recordBody,
            );
            setExactProjectCustomSetting("workRecords", { retentionDays: 0, retentionKeepLast: 0 }, input.cwd);
        } else if (managed) {
            await runWorkRecordsCommand(["prune", "--yes"], { mnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT });
        } else
            console.log(JSON.stringify((await listOwnedWorkRecords(input.cwd)).map((record) => record.attrs.recordId)));
    } else if (command.startsWith("managed-history-")) {
        const { runPlansCommand } = await import("../../cmd/plans/index.ts");
        const { authorLocalPlan, listPlanHistory } = await import("../../plan-store/index.ts");
        if (command === "managed-history-missing") {
            await rejects(runPlansCommand(["history", "missing"]), /requires an admitted Plan/);
            await rejects(
                runPlansCommand(["history", "show", "missing", crypto.randomUUID()]),
                /requires an admitted Plan/,
            );
        } else if (command === "managed-history-seed") {
            await authorLocalPlan(input.cwd, { planName: "proposal", contextMarkdown: "# Original\n" });
            await recordPlanEvent({ cwd: input.cwd, planName: "proposal", event: "review_approved" });
            const history = await listPlanHistory(input.cwd, "proposal");
            console.log(JSON.stringify(history));
        } else if (command === "managed-history-restore") {
            await runPlansCommand(["history", "restore", "proposal", input.attemptId!]);
        } else if (command === "managed-history-list") {
            await runPlansCommand(["history", "proposal"]);
        } else {
            await runPlansCommand(["history", "show", "proposal", input.attemptId!]);
        }
    } else if (command === "managed-route-import") {
        const { resolvePlanWithPrimaryRecovery } = await import("../../plan-store/index.ts");
        const selected = join(input.cwd, "docs/plans/explicit.md");
        const original =
            "---\nplanId: explicit-id\nclassification: PLANNED_CHANGE\nstatus: draft\n---\n# Explicit remote source\n";
        await mkdir(join(selected, ".."), { recursive: true });
        await writeFile(selected, original);
        await rejects(resolvePlanWithPrimaryRecovery(input.cwd, "explicit"), /No canonical Plan/);
        equal((await listPlans(input.cwd)).length, 0);
        const imported = await resolvePlanWithPrimaryRecovery(input.cwd, selected);
        equal(imported.plan.attrs.planId, "explicit-id");
        ok(imported.plan.markdown.includes("Explicit remote source"));
        equal(await readFile(selected, "utf8"), original);
        await savePlanProse(input.cwd, "explicit", "# Current canonical prose\n", imported.plan.revision);
        const repeated = await resolvePlanWithPrimaryRecovery(input.cwd, selected);
        ok(repeated.plan.markdown.includes("Current canonical prose"));
        equal((await listPlans(input.cwd)).length, 1);
        equal(await readFile(selected, "utf8"), original);
        console.log(JSON.stringify({ planId: repeated.plan.attrs.planId }));
    } else if (command === "managed-resume") {
        const { loadPublicationAttempt, cleanupStoredPublication } = await import("../workflow/publication-machine.ts");
        ok(input.attemptId);
        await withLocalPlanWorkflow(input.cwd, "family/first", async () => {
            const attempt = await loadPublicationAttempt(input.cwd, input.attemptId!);
            ok(attempt);
            ok((await cleanupStoredPublication(input.cwd, attempt)).complete);
        });
        equal((await loadPlan(input.cwd, "family/first"))?.attrs.status, "verified");
        console.log(
            JSON.stringify({ records: (await listOwnedWorkRecords(input.cwd)).map((record) => record.attrs.recordId) }),
        );
    } else if (command.endsWith("read")) {
        const plan = await loadPlan(input.cwd, "family/second");
        ok(plan);
        ok(plan.markdown.includes(managed ? "Laptop sibling sentinel" : "Remote personal decoy"));
        console.log(
            JSON.stringify({
                planId: plan.attrs.planId,
                revision: plan.revision,
                markdown: plan.markdown,
                path: plan.path,
            }),
        );
    } else {
        const sources = join(input.cwd, managed ? "managed-import" : "manual-import");
        await mkdir(join(sources, "family"), { recursive: true });
        const originals = [
            ["family", "family-id", "classification: PROJECT\ntype: sequence", "Epic scope"],
            ["family/first", "first-id", "classification: PLANNED_CHANGE\nparentPlan: family\norder: 1", "First child"],
            [
                "family/second",
                "second-id",
                "classification: PLANNED_CHANGE\nparentPlan: family\norder: 2",
                managed ? "Original sibling" : "Remote personal decoy",
            ],
        ];
        for (const [name, id, attrs, body] of originals)
            await writeFile(
                join(sources, `${name}.md`),
                `---\nplanId: ${id}\n${name === "family" ? "status: closed_without_verification\nepicCompletionMode: done_enough\nclosedWithoutVerificationReason: Accepted scope" : "status: draft"}\ntargetBranch: main\n${attrs}\n---\n# ${body}\n`,
            );
        equal((await listPlans(input.cwd)).length, command === "manual-deliver" ? 3 : 0);
        equal((await importPlans(input.cwd, sources)).kind, command === "manual-deliver" ? "existing" : "committed");
        await importPlans(input.cwd, sources);
        equal((await listPlans(input.cwd)).length, 3);
        const sibling = await loadPlan(input.cwd, "family/second");
        ok(sibling);
        if (managed) await savePlanProse(input.cwd, "family/second", "# Laptop sibling sentinel\n", sibling.revision);
        if (command === "manual-seed") {
            console.log(
                JSON.stringify({ path: sibling.path, markdown: sibling.markdown, planId: sibling.attrs.planId }),
            );
        } else {
            const { startActiveExecutionWorkflow, createExecutionStartPorts } =
                await import("../workflow/execution-start.ts");
            const { finalizePlanImplementation } = await import("../workflow/implementation-checkpoint.ts");
            const { prepareSessionPlanningWorktree } = await import("../workflow/session-planning-worktree.ts");
            const { git } = await import("../git-test-fixture.ts");
            const { startPublicationAttempt, advanceStoredPublication, cleanupStoredPublication } =
                await import("../workflow/publication-machine.ts");
            const { publishExecutionWorktreeIsolated } = await import("../isolated-publication.ts");
            const { setExactProjectCustomSetting } = await import("../settings.ts");
            setExactProjectCustomSetting("plans", { deliveryCopies: false }, input.cwd);
            setExactProjectCustomSetting("workRecords", { deliveryCopies: false }, input.cwd);
            const execution = await withLocalPlanWorkflow(input.cwd, "family/first", async () => {
                await recordPlanEvent({
                    cwd: input.cwd,
                    planName: "family/first",
                    event: "review_approved",
                    currentStatus: "draft",
                });
                await recordPlanEvent({
                    cwd: input.cwd,
                    planName: "family/first",
                    event: "readiness_passed",
                    currentStatus: "approved",
                });
                const plan = await loadPlan(input.cwd, "family/first");
                ok(plan);
                const execution = await startActiveExecutionWorkflow({
                    cwd: input.cwd,
                    planName: "family/first",
                    currentStatus: "ready_for_work",
                    triageMeta: plan.attrs,
                    ports: createExecutionStartPorts(),
                });
                ok(execution.executionCwd && execution.worktreeId);
                await writeFile(
                    join(execution.executionCwd, managed ? "managed-sentinel" : "manual-sentinel"),
                    "Delivered sentinel\n",
                );
                await finalizePlanImplementation({
                    projectRoot: input.cwd,
                    planName: "family/first",
                    executionContext: execution,
                });
                for (const event of ["mechanical_validation_passed", "semantic_review_passed"] as const)
                    await recordPlanEvent({
                        cwd: input.cwd,
                        planName: "family/first",
                        event,
                        currentStatus: "implemented",
                    });
                return execution;
            });
            const later = await withLocalPlanWorkflow(input.cwd, "family/second", () =>
                prepareSessionPlanningWorktree(input.cwd, "family/second"),
            );
            ok(later.plan?.markdown.includes(managed ? "Laptop sibling sentinel" : "Remote personal decoy"));
            await withLocalPlanWorkflow(input.cwd, "family/first", async () => {
                await freezePlanPublicationPolicy("family/first", execution.worktreeId!, {
                    plans: false,
                    workRecords: false,
                    autoGenerateRecords: true,
                });
                const commit = await git(execution.executionCwd!, ["rev-parse", "HEAD"]);
                if (managed) {
                    await rejects(
                        stageValidationPassedInExecutionWorktree({
                            projectRoot: input.cwd,
                            executionCwd: execution.executionCwd!,
                            planName: "family/second",
                            details: { executionMode: "worktree" },
                        }),
                        /Cannot prepare publication.*draft/,
                    );
                    await rejects(
                        stageValidationPassedInExecutionWorktree({
                            projectRoot: input.cwd,
                            executionCwd: execution.executionCwd!,
                            planName: "family/first",
                            details: { executionMode: "worktree", worktreeId: "another-attempt" },
                        }),
                        /another execution attempt/,
                    );
                }
                const staging = await stageValidationPassedInExecutionWorktree({
                    projectRoot: input.cwd,
                    executionCwd: execution.executionCwd!,
                    planName: "family/first",
                    details: {
                        executionMode: "worktree",
                        deliveryEvidence: {
                            version: 1,
                            mode: "worktree_merge",
                            executionCommit: commit,
                            targetBranch: "main",
                            targetHeadBeforeMerge: await git(input.cwd, ["rev-parse", "main"]),
                        },
                    },
                });
                equal(staging.attrs.status, "reviewed");
                ok(staging.planPaths.includes("docs/plans/family/first.md"));
                equal((await loadPlan(input.cwd, "family/first"))?.attrs.status, "reviewed");
                await sealPackagePublication("family/first", execution.worktreeId!, commit, "main", true);
                const { autoGenerateWorkRecordForCompletedPlan } = await import("../work-records/auto-generation.ts");
                const { SYSTEM_WORK_RECORD_MNEMOTECA_PORT } = await import("../work-records/mnemoteca-port.ts");
                const recorded = await autoGenerateWorkRecordForCompletedPlan({
                    cwd: input.cwd,
                    planName: "family/first",
                    pendingPublication: true,
                    mnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
                    runRecorderStep: () =>
                        Promise.resolve({
                            title: managed ? "Laptop composed delivery" : "Manual composed delivery",
                            summary: "Delivered the imported child while preserving its sibling draft.",
                        }),
                });
                ok(recorded.status === "generated" || recorded.status === "linked", JSON.stringify(recorded));
                let attempt = await startPublicationAttempt({
                    projectRoot: input.cwd,
                    attemptId: execution.worktreeId!,
                    planName: "family/first",
                    targetBranch: "main",
                    executionBranch: execution.worktreeBranch!,
                    executionCwd: execution.executionCwd!,
                    validatedCommit: commit,
                    targetHeadAtSeal: await git(input.cwd, ["rev-parse", "main"]),
                });
                attempt = await advanceStoredPublication(
                    input.cwd,
                    attempt,
                    "artifacts_committed",
                    await preparePackageCopies(input.cwd, attempt),
                );
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
                equal((await loadPlan(input.cwd, "family/first"))?.attrs.status, "verified");
                const cleanup = await cleanupStoredPublication(input.cwd, attempt);
                ok(cleanup.complete, JSON.stringify(cleanup));
                const delivered = await readPublishedDeliverySources(input.cwd, cleanup.attempt);
                const recordPath = delivered.workRecordOwner?.attrs.workRecord?.path;
                ok(recordPath);
                const record = await readPublishedRecordMarkdown(input.cwd, cleanup.attempt, recordPath);
                ok(record?.includes(managed ? "Laptop composed delivery" : "Manual composed delivery"));
                equal(await readPublishedRecordMarkdown(input.cwd, cleanup.attempt, "../another-record.md"), null);
            });
            equal((await loadPlan(input.cwd, "family/first"))?.attrs.status, "verified");
            for (const [name, , , body] of originals)
                ok((await readFile(join(sources, `${name}.md`), "utf8")).includes(`# ${body}`));
            console.log(
                JSON.stringify({
                    executionCwd: execution.executionCwd,
                    attemptId: execution.worktreeId,
                    sibling: (await loadPlan(input.cwd, "family/second"))?.markdown,
                    records: (await listOwnedWorkRecords(input.cwd)).map((record) => record.attrs.recordId),
                }),
            );
        }
    }
} finally {
    clear();
}
