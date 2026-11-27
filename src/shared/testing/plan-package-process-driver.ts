import type { ActiveExecutionWorkflow } from "@runwield/workflow/state";
/** Subprocess fault injection at actual filesystem boundaries; package machinery remains real. */
import fs from "node:fs";
import promises from "node:fs/promises";
import { mock } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { DriverRequest } from "./plan-package-fixture.ts";

interface ReservedImportMember {
    planId: string;
}
const request: DriverRequest = JSON.parse(process.argv[2]);
const project = join(request.identity.executionAccountHome, ".wld", "projects", request.identity.projectId);
const internal = join(project, "internal", "plan-packages");
const originalRename = fs.renameSync;
const originalMove = promises.rename;
const exit = (boundary: string) => {
    if (request.boundary === boundary) {
        if (request.command === "import" && fs.existsSync(join(internal, "batch.json")))
            console.log(
                JSON.stringify({
                    reservedPlanIds: JSON.parse(fs.readFileSync(join(internal, "batch.json"), "utf8")).members.map(
                        (member: ReservedImportMember) => member.planId,
                    ),
                }),
            );
        process.exit(86);
    }
};
const observedRename = (from: fs.PathLike, to: fs.PathLike) => {
    if (
        String(to).endsWith("/batch.json") &&
        request.boundary === "import-all-moved" &&
        JSON.parse(fs.readFileSync(from, "utf8")).phase === "committed"
    )
        exit("import-all-moved");
    originalRename(from, to);
    const path = String(to);
    if (path.includes("/plans/") && path.endsWith("/context.md")) exit("reviewed-context");
    if (
        (request.command === "review-race" || request.command === "sequence-race") &&
        request.boundary !== "review-metadata" &&
        path.includes("/plans/") &&
        path.endsWith("context.md")
    )
        fs.writeFileSync(request.mutateEvidenceDestination!, "Unreviewed requirements\n");
    if (path.includes("/staging/") && path.endsWith("plan.wld.json")) exit("staged-package");
    if (path.endsWith("/intent.json")) exit("intent");
    if (path.endsWith("/batch.json")) {
        const batch = JSON.parse(fs.readFileSync(path, "utf8"));
        exit(batch.phase === "pending" ? "import-intent" : "import-committed");
    }
    if (path.endsWith("/allocations.json")) exit("import-allocated");
    if (path.includes("/plans/") && path.endsWith("plan.wld.json")) {
        exit("metadata");
        const metadata = JSON.parse(fs.readFileSync(path, "utf8"));
        if (
            request.command === "sequence" &&
            metadata.history?.some((entry: { milestone: string }) => entry.milestone === "approved")
        )
            exit("sequence-first-milestone");
        if (request.command === "sequence-race" && request.boundary === "review-metadata")
            fs.writeFileSync(request.mutateEvidenceDestination!, "Unreviewed requirements\n");
        if (metadata.workflow?.attempt && metadata.definition.status === "ready_for_work") exit("attempt-reserved");
        if (metadata.definition.status === "in_progress") exit("attempt-started");
    }
    if (path.endsWith("/input.wld.json")) {
        if (request.edit) {
            const target = join(project, "plans", request.name ?? "one", request.edit);
            if (request.remove) fs.unlinkSync(target);
            else fs.writeFileSync(target, "edited while capturing\n");
        }
        exit("staged-input");
    }
};
// Bun named builtin imports retain their original binding; replace only the external syscall export.
mock.module("node:fs", () => ({ ...fs, renameSync: observedRename, default: fs }));
Object.defineProperty(promises, "rename", {
    value: async (...args: Parameters<typeof promises.rename>) => {
        const journal = /(?:\/transitions\/|\/plan-transitions\/).+\.json$/.test(String(args[1]))
            ? JSON.parse(fs.readFileSync(args[0], "utf8"))
            : undefined;
        const sequenceAccepted =
            journal?.operation === "sequence_review_approved" &&
            journal.completedEffects?.some(
                (effect: { effect: string }) => effect.effect === "sequence_review_accepted",
            );
        if (sequenceAccepted) exit("sequence-before-acceptance");
        await originalMove(...args);
        if (journal?.operation === "sequence_review_approved" && journal.state === "prepared")
            exit("sequence-prepared");
        if (
            journal?.operation === "sequence_review_approved" &&
            journal.state === "applying" &&
            !journal.packageWrites?.length &&
            journal.completedEffects?.some((effect: { effect: string }) => effect.effect === "sequence_review_prepared")
        )
            exit("sequence-applying");
        if (String(args[1]).includes("/plans/") && String(args[1]).endsWith("context.md")) {
            if (request.command === "review-race" || request.command === "sequence-race")
                fs.writeFileSync(request.mutateEvidenceDestination!, "Unreviewed requirements\n");
            exit("moved-resource");
        }
        if (String(args[1]).includes("/inputs/")) exit("published-input");
        if (String(args[1]).endsWith("/worktrees.json")) {
            const registry = JSON.parse(fs.readFileSync(args[1], "utf8"));
            if (registry.entries?.some((entry: { creationContext?: { files: string[] } }) => entry.creationContext))
                exit("registry-reserved");
        }
        if (journal) {
            if (journal.packageWrites?.length) exit("lifecycle-intent");
            if (sequenceAccepted) exit("sequence-accepted");
            if (
                journal.operation === "implementation_checkpoint" &&
                journal.completedEffects?.some(
                    (effect: { effect: string }) => effect.effect === "implementation_checkpoint_settled",
                )
            )
                exit("implementation-committed");
        }
    },
});
const originalReadFile = promises.readFile;
let changedEvidence = false;
Object.defineProperty(promises, "readFile", {
    value: async (...args: Parameters<typeof promises.readFile>) => {
        const result = await originalReadFile(...args);
        if (!changedEvidence && request.mutateEvidencePath === String(args[0])) {
            changedEvidence = true;
            fs.writeFileSync(
                request.mutateEvidenceDestination || request.mutateEvidencePath,
                request.mutateEvidenceText!,
            );
        }
        return result;
    },
});
const observeHistoryRecovery = request.boundary === "history-after-recovery";
const catalogPath = join(internal, "locks", "catalog.lock");
const intentPath = join(internal, "intent.json");
let recoveredIntent = false;
let releasedRecoveryCatalog = false;
let recoveredHistoryScans = 0;
let readHeldExclusiveCatalog = true;
let readKeptRecoveryCatalog = true;
if (observeHistoryRecovery) {
    const originalRemove = promises.rm;
    Object.defineProperty(promises, "rm", {
        value: async (...args: Parameters<typeof promises.rm>) => {
            await originalRemove(...args);
            if (String(args[0]) === intentPath) recoveredIntent = true;
        },
    });
}

const originalReadDirectory = promises.readdir;
let interruptedScan = false;
Object.defineProperty(promises, "readdir", {
    value: async (...args: Parameters<typeof promises.readdir>) => {
        if (observeHistoryRecovery && recoveredIntent && String(args[0]) === join(project, "plans")) {
            recoveredHistoryScans++;
            readKeptRecoveryCatalog &&= !releasedRecoveryCatalog;
            const catalog = openNativeFileLock(catalogPath, false);
            try {
                readHeldExclusiveCatalog &&= !catalog.tryLockSync();
            } finally {
                catalog.close();
            }
        }
        if (
            request.boundary === "start-rename-during-scan" &&
            !interruptedScan &&
            String(args[0]) === join(project, "plans")
        ) {
            interruptedScan = true;
            const result = spawnSync(
                process.execPath,
                [process.argv[1], JSON.stringify({ ...request, command: "rename", boundary: "metadata" })],
                { encoding: "utf8" },
            );
            if (result.status !== 86)
                throw new Error(`Rename did not reach publication: ${result.stdout} ${result.stderr}`);
        }
        const entries = await originalReadDirectory(...args);
        if (
            request.boundary === "commit-import-during-scan" &&
            !interruptedScan &&
            String(args[0]) === join(project, "plans")
        ) {
            interruptedScan = true;
            const result = spawnSync(
                process.execPath,
                [process.argv[1], JSON.stringify({ ...request, command: "import", boundary: undefined })],
                { encoding: "utf8" },
            );
            if (result.status !== 0) throw new Error(`Import race failed: ${result.stdout} ${result.stderr}`);
        }
        return entries;
    },
});
Object.defineProperty(Bun, "spawn", {
    value: new Proxy(Bun.spawn, {
        apply(target, receiver, args) {
            const child = Reflect.apply(target, receiver, args);
            const command = args[0]?.cmd || args[0];
            if (Array.isArray(command) && command.includes("worktree") && command.includes("add"))
                child.exited.then((code: number) => {
                    if (code === 0) exit("git-created");
                });
            return child;
        },
    }),
});
if (request.command !== "import") mock.module("node:fs/promises", () => ({ ...promises, default: promises }));
const resourceFiles = await import("@runwield/resources/fs");
const { openNativeFileLock } = resourceFiles;
if (observeHistoryRecovery) {
    mock.module("@runwield/resources/fs", () => ({
        ...resourceFiles,
        openNativeFileLock(path: string, create?: boolean | "exclusive") {
            const lock = openNativeFileLock(path, create);
            if (path !== catalogPath) return lock;
            return {
                ...lock,
                close() {
                    if (recoveredIntent) releasedRecoveryCatalog = true;
                    lock.close();
                },
                unlockSync() {
                    if (recoveredIntent) releasedRecoveryCatalog = true;
                    lock.unlockSync();
                },
            };
        },
    }));
}

const store = await import("@runwield/plans/package-storage");
const planId = request.planId ?? "plan-one";
try {
    if (request.command === "hold") {
        const key = createHash("sha256").update(planId).digest("hex");
        const lock = openNativeFileLock(join(internal, "locks", `${key}.lock`));
        await lock.lock(true);
        console.log("ready");
        setInterval(() => {}, 1000);
        await new Promise(() => {});
    } else {
        const current = ["create", "list", "import", "history"].includes(request.command)
            ? null
            : await store.readPlanPackage(
                  request.identity,
                  request.command === "read" && request.name ? { name: request.name } : { planId },
              );
        console.log("ready");
        if (request.barrier)
            while (!fs.existsSync(request.barrier)) await new Promise((resolve) => setTimeout(resolve, 5));
        let result;
        switch (request.command) {
            case "review":
            case "sequence-race":
            case "review-race":
            case "finalize":
            case "resume-finalize":
            case "sequence":
            case "lifecycle":
            case "recover-lifecycle":
            case "execution": {
                if (!current || current.kind !== "loaded") throw new Error("Missing package");
                if (request.command === "sequence" && request.operationId) {
                    const { PreparedProjectStore } = await import("../../plan-store/index.ts");
                    const service = new PreparedProjectStore(request.identity.checkoutRoot);
                    const { result: snapshot } = await service.execute({ kind: "sequence-snapshot", planId });
                    if (!("sequenceDocuments" in snapshot)) throw new Error("Missing Sequence snapshot.");
                    const documents = snapshot.sequenceDocuments;
                    result = await service.execute({
                        kind: "sequence-decision",
                        planId,
                        operationId: request.operationId,
                        expectedRevision: documents[0].revision,
                        documents,
                        decision: {
                            approved: true,
                            approvalAction: "later",
                            documents: documents.map((doc) => ({ planId: doc.planId, plan: doc.plan })),
                        },
                    });
                    break;
                }
                const { openWorkflow } = await import("@runwield/workflow");
                const { withPackageWorkflow, loadPackageWorkflowPlan } = await import("../../plan-store/workflows.ts");
                const { recordPlanEvent } = await import("../../plan-store/index.ts");
                const { preparePlanWorkflow } = await import("../../plan-store/index.ts");
                result = await withPackageWorkflow(
                    request.identity.checkoutRoot,
                    { identity: request.identity, planId, expectedRevision: current.metadata.revision },
                    async () => {
                        await preparePlanWorkflow(request.identity.checkoutRoot, current.metadata.name);
                        if (request.command === "resume-finalize") {
                            const workflow: ActiveExecutionWorkflow = JSON.parse(
                                fs.readFileSync(request.executionContextPath!, "utf8"),
                            );
                            return await (
                                await openWorkflow({
                                    cwd: request.identity.checkoutRoot,
                                    planName: current.metadata.name,
                                }).resumeAttempt({ attemptId: workflow?.packageAttemptId || workflow?.worktreeId })
                            ).acceptCompletion({});
                        }
                        if (request.command === "review-race" || request.command === "review") {
                            const { capturePackageWorkflowInput } = await import("../../plan-store/workflows.ts");
                            const { applySharedPlanReviewDecision } = await import("../../plan-store/index.ts");
                            const plan = await loadPackageWorkflowPlan(current.metadata.name);
                            const input = await capturePackageWorkflowInput(current.metadata.name);
                            return await applySharedPlanReviewDecision({
                                cwd: request.identity.checkoutRoot,
                                planName: current.metadata.name,
                                planPath: plan.path,
                                planWithFrontMatter: plan.markdown,
                                planRevision: plan.revision,
                                originalAttrs: plan.attrs,
                                trustedClassification: "PLANNED_CHANGE",
                                packageInput: input,
                                decision: {
                                    approved: true,
                                    approvalAction: "later",
                                    plan:
                                        request.command === "review-race"
                                            ? plan.markdown + "\nReviewed edit\n"
                                            : plan.markdown,
                                },
                            });
                        }
                        if (request.command === "sequence" || request.command === "sequence-race") {
                            const { prepareSequenceReview, applySequenceReviewDecision } =
                                await import("../../plan-store/index.ts");
                            const documents = await prepareSequenceReview(
                                request.identity.checkoutRoot,
                                current.metadata.name,
                            );
                            return await applySequenceReviewDecision({
                                cwd: request.identity.checkoutRoot,
                                documents,
                                decision: {
                                    approved: true,
                                    approvalAction: "later",
                                    documents: documents.map((doc) => ({
                                        planId: doc.planId,
                                        plan:
                                            request.command === "sequence-race"
                                                ? doc.plan + "\nReviewed edit\n"
                                                : doc.plan,
                                    })),
                                },
                            });
                        }
                        if (request.command === "recover-lifecycle")
                            return await loadPackageWorkflowPlan(current.metadata.name);
                        if (request.command === "execution" || request.command === "finalize") {
                            const attempt = await openWorkflow({
                                cwd: request.identity.checkoutRoot,
                                planName: current.metadata.name,
                                planId,
                            }).startOrResume();
                            const workflow = attempt.state;
                            if (request.command === "finalize") {
                                fs.writeFileSync(request.executionContextPath!, JSON.stringify(workflow));
                                await promises.writeFile(
                                    join(workflow.executionCwd!, "implemented.txt"),
                                    "implementation\n",
                                );
                                return await attempt.acceptCompletion({});
                            }
                            return workflow;
                        }
                        return await recordPlanEvent({
                            cwd: request.identity.checkoutRoot,
                            planName: current.metadata.name,
                            event: "review_approved",
                            currentStatus: "draft",
                        });
                    },
                );
                break;
            }
            case "evidence":
                if (!current || current.kind !== "loaded" || !current.metadata.references.legacyImport)
                    throw new Error("Missing imported package");
                result = await store.readPlanImportEvidence(request.identity, current.metadata.references.legacyImport);
                break;
            case "import":
                result = await (
                    await import("../../plan-store/import-packages.ts")
                ).importPlanPackages(request.identity, request.selection!);
                break;
            case "list":
                result = await store.listPlanPackages(request.identity, true);
                break;
            case "create":
                result = await store.createPlanPackage(request.identity, {
                    planId,
                    name: request.name ?? "one",
                    documents: { "context.md": "# Created\n", "validation.md": "# Validate\n" },
                });
                break;
            case "recover":
                await store.recoverPlanPackages(request.identity);
                break;
            case "read":
                result = current;
                break;
            case "history": {
                const { openProjectPlanStore } = await import("../../plan-store/index.ts");
                const { plans } = await import("@runwield/plans");
                const { history } = openProjectPlanStore(request.identity.projectId, { admitted: request.identity });
                const selectedId = plans.identity.parse(planId);
                if (!selectedId) throw new Error("Invalid Plan ID.");
                const snapshot = await history.list(selectedId);
                result = {
                    history: snapshot,
                    recoveredHistoryScans,
                    readHeldExclusiveCatalog,
                    readKeptRecoveryCatalog,
                    releasedRecoveryCatalog,
                };
                break;
            }
            case "input":
                result = await store.readPlanPackageInput(request.identity, {
                    projectId: request.identity.projectId,
                    planId,
                    inputId: request.inputId!,
                });
                break;
            case "capture":
                result = await store.capturePlanPackageInput(request.identity, planId);
                break;
            default:
                if (!current || current.kind !== "loaded") throw new Error(JSON.stringify(current));
                if (request.command === "metadata")
                    result = await store.updatePlanPackageMetadata(
                        request.identity,
                        planId,
                        current.metadata.revision,
                        { controller: { validationCiAttempts: 3 } },
                    );
                if (request.command === "document")
                    result = await store.savePlanPackageDocument(
                        request.identity,
                        planId,
                        "context.md",
                        current.documents[0].hash,
                        "# Concurrent edit\n",
                    );
                if (request.command === "rename")
                    result = await store.renamePlanPackage(
                        request.identity,
                        planId,
                        current.metadata.revision,
                        request.name ?? "renamed",
                    );
        }
        console.log(JSON.stringify({ kind: "success", result }));
    }
} catch (error) {
    console.log(JSON.stringify({ kind: error instanceof Error ? error.name : "error", message: String(error) }));
    process.exitCode = 2;
}
