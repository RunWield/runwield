import { holdPlanFixtureLock } from "../../testing/plan-state-fixture.ts";
import { withRetainedPlanFixture } from "../../testing/retained-plan-fixture.ts";
import { type PackageWorkflowSelection } from "../../../plan-store/workflows.ts";
import { withPackageWorkflow } from "../../../plan-store/workflows.ts";
import { readPlanPackage } from "../../../plan-store/packages.ts";
import { advancePublicationAttempt } from "@runwield/workflow/publication";
import { openPublication } from "@runwield/workflow/publication-runtime";
import { captureForegroundProcess } from "@runwield/resources/process";
import { mkdir as fsMkdir, readFile as fsReadFile, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import process from "node:process";
import { publishExecutionWorktreeIsolated } from "../../isolated-publication.ts";

import { checkpointExecutionWorktree } from "../../worktree.ts";
import { findById, updatePublication } from "../../worktree-registry.ts";

type DriverConfig = {
    projectRoot: string;
    attemptId: string;
    planName: string;
    targetBranch: string;
    executionBranch: string;
    executionCwd: string;
    crashAfter?: string;
    operation?: "revalidate" | "validate";
    packageSelection?: PackageWorkflowSelection;
    retainedCheckoutInput?: boolean;
};

function crash(config: DriverConfig, boundary: string): void {
    if (config.crashAfter === boundary) process.exit(86);
}

async function git(cwd: string, args: string[]): Promise<string> {
    const output = await captureForegroundProcess("git", { cwd, args });
    if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
    return new TextDecoder().decode(output.stdout).trim();
}

async function removePublicationArtifacts(config: DriverConfig, publicationRoot: string): Promise<void> {
    await git(config.projectRoot, ["worktree", "remove", "--force", config.executionCwd]);
    await git(config.projectRoot, ["branch", "-D", config.executionBranch]);
    await fsRm(publicationRoot, { recursive: true, force: true });
}

const configPath = process.argv.slice(2)[0];
if (!configPath) throw new Error("publication process driver requires a config path");
const config = JSON.parse(await fsReadFile(configPath, "utf8")) as DriverConfig;
const run = async () => {
    if (config.operation === "validate") {
        const { runHostValidation } = await import("./run-host-validation.ts");
        let result = await runHostValidation({
            projectRoot: config.projectRoot,
            planName: config.planName,
        });
        if (result.kind === "host_request" && result.request.kind === "recorder") {
            result = await runHostValidation({
                projectRoot: config.projectRoot,
                planName: config.planName,
                resume: {
                    kind: "recorder",
                    identity: result.request.identity,
                    sections: JSON.stringify({ title: "Delivered Epic", summary: "Retained terminal Epic input." }),
                },
            });
        }
        if (result.kind !== "verified") throw new Error(JSON.stringify(result));
        return;
    }
    return await holdPlanFixtureLock(config.projectRoot, config.planName, async () => {
        if (config.operation === "revalidate") {
            const { openPublication } = await import("@runwield/workflow/publication-runtime");
            await openPublication(config.projectRoot).revalidate(config.planName);
            return;
        }
        let attempt = await openPublication(config.projectRoot).attempt(config.attemptId).load();

        if (!attempt) {
            const entry = await findById(config.projectRoot, config.attemptId);
            if (!entry) {
                if (config.packageSelection) {
                    const packagePlan = await readPlanPackage(config.packageSelection.identity, {
                        planId: config.packageSelection.planId,
                    });
                    if (
                        packagePlan.kind !== "loaded" ||
                        packagePlan.metadata.workflow?.delivery?.source.attemptId !== config.attemptId
                    )
                        throw new Error("Missing registry entry is not package settlement evidence.");
                }
                return;
            }
            const candidate = await checkpointExecutionWorktree({
                worktreePath: config.executionCwd,
                branch: config.executionBranch,
                planName: config.planName,
            });
            crash(config, "candidate_effect");
            attempt = await openPublication(config.projectRoot)
                .attempt(config.attemptId)
                .start({
                    planName: config.planName,
                    targetBranch: config.targetBranch,
                    executionBranch: config.executionBranch,
                    executionCwd: config.executionCwd,
                    validatedCommit: candidate.executionCommit,
                    targetHeadAtSeal: await git(config.projectRoot, ["rev-parse", `refs/heads/${config.targetBranch}`]),
                });
            crash(config, "candidate_receipt");
        }

        attempt = await openPublication(config.projectRoot).resume(attempt).reconcile();
        if (attempt.phase === "candidate_sealed" && attempt.packageInput) {
            const evidence = await openPublication(config.projectRoot).resume(attempt).prepareCopies();
            crash(config, "artifact_effect");
            attempt = await openPublication(config.projectRoot)
                .resume(attempt)
                .advance("artifacts_committed", evidence);
            crash(config, "artifact_receipt");
        }
        if (attempt.phase === "candidate_sealed") {
            const planPath = `docs/plans/${config.planName}.md`;
            await fsMkdir(`${config.executionCwd}/docs/plans`, { recursive: true });
            await fsWriteFile(
                `${config.executionCwd}/${planPath}`,
                `---\nplanId: ${attempt.planId}\nclassification: PLANNED_CHANGE\nstatus: reviewed\n---\n# Matrix Plan\n`,
            );
            await fsWriteFile(`${config.executionCwd}/artifact-count.txt`, "1\n");
            const artifact = await checkpointExecutionWorktree({
                worktreePath: config.executionCwd,
                branch: config.executionBranch,
                planName: config.planName,
                mergeTargetRef: attempt.targetHeadAtSeal,
                publicationAttemptId: attempt.attemptId,
                publicationPlanPaths: [planPath],
            });
            crash(config, "artifact_effect");
            attempt = await openPublication(config.projectRoot)
                .resume(attempt)
                .advance("artifacts_committed", {
                    artifactCommit: artifact.executionCommit,
                    planPaths: [planPath],
                });
            crash(config, "artifact_receipt");
        }

        if (attempt.phase !== "publication_verified" && attempt.phase !== "cleanup_complete") {
            const artifactCommit =
                attempt.artifactCommit || (attempt.packageInput ? attempt.validatedCommit : undefined);
            if (!artifactCommit) throw new Error("publication process driver requires committed artifacts");
            try {
                await publishExecutionWorktreeIsolated({
                    projectRoot: config.projectRoot,
                    executionCwd: attempt.executionCwd,
                    executionBranch: attempt.executionBranch,
                    targetBranch: attempt.targetBranch,
                    planName: attempt.planName,
                    sealedExecutionCommit: artifactCommit,
                    allowedPlanPaths: attempt.planPaths || [],
                    packageInput: attempt.packageInput,
                    publicationRoot: attempt.publicationRoot,
                    onIntegrated: async (evidence) => {
                        crash(config, "integration_effect");
                        attempt = await openPublication(config.projectRoot)
                            .resume(attempt!)
                            .advance("target_integrated", evidence);
                        crash(config, "integration_receipt");
                    },
                    onPublished: async (evidence) => {
                        crash(config, "target_effect");
                        attempt = await openPublication(config.projectRoot)
                            .resume(attempt!)
                            .advance("target_published", evidence);
                        crash(config, "target_receipt");
                    },
                    onVerified: async () => {
                        attempt = await openPublication(config.projectRoot).resume(attempt!).verify();
                        crash(config, "verification_receipt");
                    },
                });
            } catch (caught) {
                const failure = caught instanceof Error ? caught : new Error(String(caught));
                const kind =
                    "mergeFailureKind" in failure && typeof failure.mergeFailureKind === "string"
                        ? failure.mergeFailureKind
                        : "publication_failed";
                await openPublication(config.projectRoot)
                    .resume(attempt)
                    .recordFailure({ kind, message: failure.message });
                throw failure;
            }
        }

        attempt = await openPublication(config.projectRoot).attempt(config.attemptId).load();
        if (!attempt) return;
        attempt = await openPublication(config.projectRoot).resume(attempt).reconcile();
        if (attempt.phase === "publication_verified") {
            if (config.crashAfter === "cleanup_effect" || config.crashAfter === "cleanup_receipt") {
                await removePublicationArtifacts(config, attempt.publicationRoot);
                crash(config, "cleanup_effect");
                const completed = advancePublicationAttempt(attempt, "cleanup_complete", {
                    cleanedAt: new Date().toISOString(),
                });
                await updatePublication(config.projectRoot, attempt.attemptId, attempt, completed);
                crash(config, "cleanup_receipt");
            }
            const cleanup = await openPublication(config.projectRoot).resume(attempt).cleanup();
            if (!cleanup.complete) throw new Error(`publication cleanup incomplete: ${cleanup.details.join("; ")}`);
            crash(config, "registry_pruned");
            attempt = cleanup.attempt;
        }
        if (attempt.phase === "cleanup_complete") await openPublication(config.projectRoot).resume(attempt).cleanup();
    });
};

if (config.packageSelection) {
    const selected = await readPlanPackage(config.packageSelection.identity, {
        planId: config.packageSelection.planId,
    });
    if (selected.kind !== "loaded") throw new Error(selected.message);
    await withPackageWorkflow(
        config.projectRoot,
        { ...config.packageSelection, expectedRevision: selected.metadata.revision },
        run,
    );
} else if (config.retainedCheckoutInput) await withRetainedPlanFixture(config.projectRoot, run);
else await run();
