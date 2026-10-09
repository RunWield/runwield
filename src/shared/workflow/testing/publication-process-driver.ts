import { publishExecutionWorktreeIsolated } from "../../isolated-publication.ts";
import { withPlanLock } from "../../../plan-store.js";
import { checkpointExecutionWorktree } from "../../worktree.js";
import { findById } from "../../worktree-registry.js";
import {
    advanceStoredPublication,
    cleanupStoredPublication,
    failStoredPublication,
    loadPublicationAttempt,
    reconcileStoredPublication,
    startPublicationAttempt,
} from "../publication-machine.ts";

type DriverConfig = {
    projectRoot: string;
    attemptId: string;
    planName: string;
    targetBranch: string;
    executionBranch: string;
    executionCwd: string;
    crashAfter?: string;
};

function crash(config: DriverConfig, boundary: string): void {
    if (config.crashAfter === boundary) Deno.exit(86);
}

async function git(cwd: string, args: string[]): Promise<string> {
    const output = await new Deno.Command("git", { cwd, args, stdout: "piped", stderr: "piped" }).output();
    if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
    return new TextDecoder().decode(output.stdout).trim();
}

async function removePublicationArtifacts(config: DriverConfig, publicationRoot: string): Promise<void> {
    await new Deno.Command("git", {
        cwd: config.projectRoot,
        args: ["worktree", "remove", "--force", config.executionCwd],
        stdout: "null",
        stderr: "null",
    }).output();
    await new Deno.Command("git", {
        cwd: config.projectRoot,
        args: ["branch", "-D", config.executionBranch],
        stdout: "null",
        stderr: "null",
    }).output();
    await Deno.remove(publicationRoot, { recursive: true }).catch(() => {});
}

const configPath = Deno.args[0];
if (!configPath) throw new Error("publication process driver requires a config path");
const config = JSON.parse(await Deno.readTextFile(configPath)) as DriverConfig;
await withPlanLock(config.projectRoot, config.planName, async () => {
    let attempt = await loadPublicationAttempt(config.projectRoot, config.attemptId);

    if (!attempt) {
        const entry = await findById(config.projectRoot, config.attemptId, { migrate: false });
        if (!entry) return;
        const candidate = await checkpointExecutionWorktree({
            worktreePath: config.executionCwd,
            branch: config.executionBranch,
            planName: config.planName,
        });
        crash(config, "candidate_effect");
        attempt = await startPublicationAttempt({
            projectRoot: config.projectRoot,
            attemptId: config.attemptId,
            planName: config.planName,
            targetBranch: config.targetBranch,
            executionBranch: config.executionBranch,
            executionCwd: config.executionCwd,
            validatedCommit: candidate.executionCommit,
            targetHeadAtSeal: await git(config.projectRoot, ["rev-parse", `refs/heads/${config.targetBranch}`]),
        });
        crash(config, "candidate_receipt");
    }

    attempt = await reconcileStoredPublication(config.projectRoot, attempt);
    if (attempt.phase === "candidate_sealed") {
        const planPath = `docs/plans/${config.planName}.md`;
        await Deno.mkdir(`${config.executionCwd}/docs/plans`, { recursive: true });
        await Deno.writeTextFile(
            `${config.executionCwd}/${planPath}`,
            `---\nplanId: ${attempt.planId}\nclassification: PLANNED_CHANGE\nstatus: reviewed\n---\n# Matrix Plan\n`,
        );
        await Deno.writeTextFile(`${config.executionCwd}/artifact-count.txt`, "1\n");
        const artifact = await checkpointExecutionWorktree({
            worktreePath: config.executionCwd,
            branch: config.executionBranch,
            planName: config.planName,
            mergeTargetRef: attempt.targetHeadAtSeal,
            publicationAttemptId: attempt.attemptId,
            publicationPlanPaths: [planPath],
        });
        crash(config, "artifact_effect");
        attempt = await advanceStoredPublication(config.projectRoot, attempt, "artifacts_committed", {
            artifactCommit: artifact.executionCommit,
            planPaths: [planPath],
        });
        crash(config, "artifact_receipt");
    }

    if (attempt.phase !== "publication_verified" && attempt.phase !== "cleanup_complete") {
        const artifactCommit = attempt.artifactCommit;
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
                publicationRoot: attempt.publicationRoot,
                onIntegrated: async (evidence) => {
                    crash(config, "integration_effect");
                    attempt = await advanceStoredPublication(
                        config.projectRoot,
                        attempt!,
                        "target_integrated",
                        evidence,
                    );
                    crash(config, "integration_receipt");
                },
                onPublished: async (evidence) => {
                    crash(config, "target_effect");
                    attempt = await advanceStoredPublication(
                        config.projectRoot,
                        attempt!,
                        "target_published",
                        evidence,
                    );
                    crash(config, "target_receipt");
                },
                onVerified: async () => {
                    attempt = await advanceStoredPublication(config.projectRoot, attempt!, "publication_verified", {
                        verifiedAt: new Date().toISOString(),
                    });
                    crash(config, "verification_receipt");
                },
            });
        } catch (caught) {
            const failure = caught instanceof Error ? caught : new Error(String(caught));
            const kind = "mergeFailureKind" in failure && typeof failure.mergeFailureKind === "string"
                ? failure.mergeFailureKind
                : "publication_failed";
            await failStoredPublication(config.projectRoot, attempt, { kind, message: failure.message });
            throw failure;
        }
    }

    attempt = await loadPublicationAttempt(config.projectRoot, config.attemptId);
    if (!attempt) return;
    attempt = await reconcileStoredPublication(config.projectRoot, attempt);
    if (attempt.phase === "publication_verified") {
        if (config.crashAfter === "cleanup_effect" || config.crashAfter === "cleanup_receipt") {
            await removePublicationArtifacts(config, attempt.publicationRoot);
            crash(config, "cleanup_effect");
            attempt = await advanceStoredPublication(config.projectRoot, attempt, "cleanup_complete", {
                cleanedAt: new Date().toISOString(),
            });
            crash(config, "cleanup_receipt");
        }
        const cleanup = await cleanupStoredPublication(config.projectRoot, attempt);
        if (!cleanup.complete) throw new Error(`publication cleanup incomplete: ${cleanup.details.join("; ")}`);
        crash(config, "registry_pruned");
        attempt = cleanup.attempt;
    }
    if (attempt.phase === "cleanup_complete") await cleanupStoredPublication(config.projectRoot, attempt);
});
