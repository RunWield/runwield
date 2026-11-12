import type { WorkRecordMnemotecaPort } from "../shared/work-records/mnemoteca-port.ts";
import { getDeliveryCopyPolicy, shouldAutoGenerateWorkRecordsOnPlanCompletion } from "../shared/settings.js";
import { preparedPackageRecordCopy, settlePreparedPackageRecord } from "../shared/work-records/package-recording.ts";
/** Package input and settlement at the existing publication state-machine boundary. */
import { retainPublishedWorkRecordSource, readPublishedDeliverySources } from "./published-source.ts";
import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { captureForegroundProcess } from "../shared/captured-process.ts";
import { inspectProjectIdentity } from "../shared/project-identity.ts";
import {
    capturePlanPackageInput,
    decodePackageMarkdown,
    listPlanPackages,
    readPlanPackageInput,
    readPlanPackagePublication,
    retainPlanPackagePublication,
    readPlanPackage,
    withPlanPackageLocks,
    findPlanPackagePublication,
    findPlanPackageRecordingPreparation,
    samePackagePublicationReference,
    type PackagePublicationReference,
    type PackagePublicationManifest,
    type DeliveryCopy,
} from "./packages.ts";
import {
    currentPackageSelection,
    selectedPackage,
    assertPackageWorkflowInput,
    packageController,
    packageWorkflowLocks,
    updatePackageWorkflowMetadata,
} from "./workflows.ts";
import type { PublicationAttempt, PublicationPhaseEvidence } from "../shared/workflow/publication-attempt.ts";
import { checkpointExecutionWorktree } from "../shared/worktree.js";
import { gitStatusPaths } from "../shared/git-runtime-safety.ts";
import { isRunWieldOwnedRuntimePath } from "../shared/runwield-owned-paths.ts";

type PackageCandidateEvidence = Pick<
    PublicationAttempt,
    "packageInput" | "validatedCommit" | "targetBranch" | "attemptId" | "planId" | "artifactCommit"
>;

async function git(root: string, args: string[]) {
    const result = await captureForegroundProcess("git", { cwd: root, args });
    return { code: result.code, text: new TextDecoder().decode(result.stdout).trim() };
}
export async function packagePublicationInput(
    root: string,
    reference: PackagePublicationReference,
): Promise<PackagePublicationManifest> {
    const inspected = inspectProjectIdentity(root);
    if (inspected.kind !== "existing") throw new Error("Publication owner is unavailable.");
    return await readPlanPackagePublication(inspected.identity, reference);
}

export async function sealPackagePublication(
    planName: string,
    attemptId: string,
    validatedCommit: string,
    targetBranch: string,
    preparation = false,
) {
    const selection = currentPackageSelection();
    if (!selection) throw new Error("Package publication requires explicit admission.");
    const catalog = await listPlanPackages(selection.identity, true);
    if (catalog.issues.length) throw new Error(catalog.issues[0].message);
    const plan = await selectedPackage(planName);
    const ownerId = plan.metadata.parentPlanId || plan.metadata.planId;
    const family = catalog.packages.filter(
        (p) =>
            p.metadata.planId === ownerId ||
            p.metadata.planId === plan.metadata.planId ||
            p.metadata.parentPlanId === ownerId,
    );
    return await withPlanPackageLocks(
        selection.identity,
        family.map((p) => p.metadata.planId),
        async () => {
            const current = await selectedPackage(planName);
            const workflow = current.metadata.workflow;
            const priorReference = preparation ? workflow?.recordingPreparation : workflow?.publication;
            if (priorReference) {
                const prior = await readPlanPackagePublication(selection.identity, priorReference);
                if (prior.attemptId === attemptId && prior.targetBranch === targetBranch) {
                    if (preparation || prior.validatedCommit === validatedCommit) return priorReference;
                    const controller = await packageController(current);
                    if (current.metadata.definition.status !== "reviewed" || controller.validationPhase !== "delivery")
                        throw new Error("The changed candidate requires validation and review.");
                    const source = await retainPlanPackagePublication(selection.identity, {
                        ...prior,
                        validatedCommit,
                    });
                    await updatePackageWorkflowMetadata(planName, {}, undefined, { ...workflow, publication: source });
                    return source;
                }
            }
            const controller = await packageController(current);
            const binding = workflow?.attempt;
            if (
                !binding ||
                binding.attemptId !== attemptId ||
                binding.repositoryId !== selection.identity.repositoryId ||
                binding.personalOwner !== selection.identity.personalOwner.identity ||
                current.metadata.definition.status !== "reviewed" ||
                controller.validationPhase !== "delivery"
            )
                throw new Error("Package publication requires this attempt's validation and review evidence.");
            const durable = await findPlanPackagePublication(
                selection.identity,
                current.metadata.planId,
                attemptId,
                validatedCommit,
                preparation ? "recording" : undefined,
            );
            if (durable) {
                const retained = await readPlanPackagePublication(selection.identity, durable);
                if (
                    retained.targetBranch !== targetBranch ||
                    binding.input.inputs.some(
                        (ref) =>
                            !retained.members.some(
                                (member) => member.input.planId === ref.planId && member.input.inputId === ref.inputId,
                            ),
                    )
                )
                    throw new Error("Durable publication input does not match this attempt.");
                await updatePackageWorkflowMetadata(planName, {}, undefined, {
                    ...workflow,
                    [preparation ? "recordingPreparation" : "publication"]: durable,
                });
                return durable;
            }
            if (!preparation && workflow?.recordingPreparation) {
                const frozen = await readPlanPackagePublication(selection.identity, workflow.recordingPreparation);
                if (frozen.attemptId !== attemptId || frozen.targetBranch !== targetBranch)
                    throw new Error("Recording preparation belongs to another delivery attempt.");
                const record = await preparedPackageRecordCopy(frozen.attemptId);
                const recordingOwner = await readPlanPackage(selection.identity, { planId: ownerId });
                if (recordingOwner.kind !== "loaded") throw new Error(recordingOwner.message);
                const source = await retainPlanPackagePublication(selection.identity, {
                    ...frozen,
                    stage: undefined,
                    validatedCommit,
                    preparedRecord: record,
                    recordingOutcome: recordingOwner.metadata.workflow?.workRecord,
                    copies: [...frozen.copies, ...(record && frozen.workRecordCopies && targetBranch ? [record] : [])],
                });
                await updatePackageWorkflowMetadata(planName, {}, undefined, { ...workflow, publication: source });
                return source;
            }
            await assertPackageWorkflowInput(planName, binding.input);
            const members = [];
            for (const member of family) {
                const fresh = await readPlanPackage(selection.identity, { planId: member.metadata.planId });
                if (fresh.kind !== "loaded") throw new Error(fresh.message);
                const input =
                    binding.input.inputs.find((ref) => ref.planId === fresh.metadata.planId) ||
                    (await capturePlanPackageInput(selection.identity, fresh.metadata.planId));
                members.push({ metadata: fresh.metadata, controller: await packageController(fresh), input });
            }
            const policy = getDeliveryCopyPolicy(selection.identity.checkoutRoot);
            const planCopies = Boolean(targetBranch) && (selection.deliveryCopies?.plans ?? policy.plans);
            const copies: DeliveryCopy[] = [...(selection.deliveryCopies?.workRecords || [])];
            if (copies.some((copy) => copy.kind !== "work-record"))
                throw new Error("Prepared Work Record payload has another document kind.");
            if (planCopies) {
                const retained = await readPlanPackageInput(
                    selection.identity,
                    binding.input.inputs.find((ref) => ref.planId === current.metadata.planId)!,
                );
                copies.push(
                    ...retained.documents.map((doc) => ({
                        kind: "plan" as const,
                        path: `docs/plans/${current.metadata.name}/${doc.name}`,
                        text: decodePackageMarkdown(doc.bytes),
                    })),
                );
            }
            const source = await retainPlanPackagePublication(selection.identity, {
                planId: current.metadata.planId,
                attemptId,
                validatedCommit,
                targetBranch,
                planCopies,
                ...(preparation
                    ? {
                          stage: "recording" as const,
                          workRecordCopies: policy.workRecords,
                          autoGenerateRecords: shouldAutoGenerateWorkRecordsOnPlanCompletion(
                              selection.identity.checkoutRoot,
                          ),
                      }
                    : {}),
                members,
                copies,
            });
            await updatePackageWorkflowMetadata(planName, {}, undefined, {
                ...workflow,
                [preparation ? "recordingPreparation" : "publication"]: source,
            });
            return source;
        },
    );
}

/** Read exact bytes, distinguishing an absent destination from an unreadable Git object. */
async function committedCopy(root: string, commit: string, path: string): Promise<string | null> {
    const entry = await git(root, ["ls-tree", "-z", commit, "--", path]);
    if (entry.code !== 0) throw new Error("Could not inspect delivery copy destinations.");
    if (!entry.text) return null;
    if (!entry.text.startsWith("100644 blob "))
        throw new Error(`Delivery copy is not a regular Markdown file: ${path}`);
    const blob = await captureForegroundProcess("git", { cwd: root, args: ["show", `${commit}:${path}`] });
    if (blob.code !== 0) throw new Error("Could not read delivery copy bytes.");
    return decodePackageMarkdown(blob.stdout);
}

/** Only the same Plan's prior proven, unedited copy may be replaced. */
async function assertOwnedPreviousCopy(
    ownerRoot: string,
    gitRoot: string,
    manifest: PackagePublicationManifest,
    commit: string,
    copy: DeliveryCopy,
    current: string,
): Promise<void> {
    const receipt = manifest.members.find((member) => member.metadata.planId === manifest.planId)?.metadata.workflow
        ?.delivery;
    if (
        !receipt ||
        receipt.mode === "non_git_in_place" ||
        receipt.source.inputId === manifest.inputId ||
        receipt.source.planId !== manifest.planId ||
        receipt.targetBranch !== manifest.targetBranch
    )
        throw new Error(`Delivery copy collides with unrelated content: ${copy.path}`);
    const previous = await packagePublicationInput(ownerRoot, receipt.source);
    const priorCopy = previous.copies.find((prior) => prior.kind === copy.kind && prior.path === copy.path);
    if (
        receipt.validatedCommit !== previous.validatedCommit ||
        receipt.targetBranch !== previous.targetBranch ||
        !priorCopy ||
        current !== priorCopy.text ||
        (await git(gitRoot, ["merge-base", "--is-ancestor", receipt.publishedCommit, commit])).code !== 0
    )
        throw new Error(`Delivery copy ownership or unchanged bytes cannot be proven: ${copy.path}`);
}

async function changedCopyPaths(
    ownerRoot: string,
    gitRoot: string,
    manifest: PackagePublicationManifest,
    base: string,
): Promise<string[]> {
    const changed: string[] = [];
    for (const copy of manifest.copies) {
        const current = await committedCopy(gitRoot, base, copy.path);
        if (current !== null) await assertOwnedPreviousCopy(ownerRoot, gitRoot, manifest, base, copy, current);
        if (current !== copy.text) changed.push(copy.path);
    }
    return changed.sort();
}

/** Verify exact payload and code boundary; commit messages alone are not evidence. */
export async function packageArtifactEvidence(
    root: string,
    attempt: PackageCandidateEvidence,
    commit: string,
    gitRoot = root,
): Promise<PublicationPhaseEvidence | null> {
    if (!attempt.packageInput) throw new Error("Package publication input is missing.");
    const manifest = await packagePublicationInput(root, attempt.packageInput);
    if (
        manifest.validatedCommit !== attempt.validatedCommit ||
        manifest.targetBranch !== attempt.targetBranch ||
        manifest.attemptId !== attempt.attemptId ||
        manifest.planId !== attempt.planId
    )
        throw new Error("Package publication candidate identity changed.");
    const changedPaths = await changedCopyPaths(root, gitRoot, manifest, attempt.validatedCommit);
    if (!changedPaths.length)
        return commit === attempt.validatedCommit
            ? { planPaths: manifest.copies.map((copy) => copy.path), copiesPrepared: true }
            : null;
    const parent = await git(gitRoot, ["rev-parse", `${commit}^`]);
    if (parent.code !== 0 || parent.text !== attempt.validatedCommit) return null;
    const paths = await git(gitRoot, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", commit]);
    const changed = paths.text.split("\0").filter(Boolean).sort();
    if (paths.code !== 0 || JSON.stringify(changed) !== JSON.stringify(changedPaths)) return null;
    for (const copy of manifest.copies) {
        const blob = await captureForegroundProcess("git", { cwd: gitRoot, args: ["show", `${commit}:${copy.path}`] });
        if (blob.code !== 0 || decodePackageMarkdown(blob.stdout) !== copy.text) return null;
    }
    return { artifactCommit: commit, planPaths: manifest.copies.map((c) => c.path), copiesPrepared: true };
}

/** Exact frozen writes left before the copies commit are artifacts, not implementation changes. */
export async function uncommittedPackageCopyPaths(attempt: PublicationAttempt): Promise<string[]> {
    if (!attempt.packageInput || attempt.artifactCommit) return [];
    const cwd = attempt.executionCwd;
    const manifest = await packagePublicationInput(cwd, attempt.packageInput);
    const changed = new Set(await changedCopyPaths(cwd, cwd, manifest, attempt.validatedCommit));
    const dirty = new Set(await gitStatusPaths(cwd));
    const owned: string[] = [];
    for (const copy of manifest.copies) {
        if (!dirty.has(copy.path) || !changed.has(copy.path)) continue;
        const pathspec = `:(literal)${copy.path}`;
        const committed = await git(cwd, ["diff", "--quiet", attempt.validatedCommit, "HEAD", "--", pathspec]);
        if (committed.code === 1) continue;
        if (committed.code !== 0) throw new Error("Could not inspect unfinished delivery copies.");
        let cursor = cwd;
        let regular = true;
        for (const segment of copy.path.split("/")) {
            cursor = join(cursor, segment);
            const stat = await fs.lstat(cursor).catch((error) => {
                if (error.code === "ENOENT") return null;
                throw error;
            });
            if (
                !stat ||
                stat.isSymbolicLink() ||
                (cursor === join(cwd, copy.path) && (!stat.isFile() || stat.mode & 0o111))
            ) {
                regular = false;
                break;
            }
        }
        if (!regular || (await fs.readFile(cursor, "utf8")) !== copy.text) continue;
        const staged = await git(cwd, ["diff", "--cached", "--quiet", "HEAD", "--", pathspec]);
        if (staged.code === 1) {
            const unstaged = await git(cwd, ["diff", "--quiet", "--", pathspec]);
            if (unstaged.code === 1) continue;
            if (unstaged.code !== 0) throw new Error("Could not inspect staged delivery copies.");
        } else if (staged.code !== 0) throw new Error("Could not inspect staged delivery copies.");
        owned.push(copy.path);
    }
    return owned;
}

/** The single assembler accepts both Plan and already prepared Work Record documents. */
export async function preparePackageCopies(
    root: string,
    attempt: PublicationAttempt,
): Promise<PublicationPhaseEvidence> {
    const manifest = await packagePublicationInput(root, attempt.packageInput!);
    const head = await git(attempt.executionCwd, ["rev-parse", "HEAD"]);
    const existing = await packageArtifactEvidence(attempt.executionCwd, attempt, head.text);
    if (existing) return existing;
    if (head.code !== 0 || head.text !== attempt.validatedCommit)
        throw new Error("Publication source requires revalidation.");
    const permitted = new Map(manifest.copies.map((copy) => [copy.path, copy.text]));
    const dirty = (await gitStatusPaths(attempt.executionCwd)).filter((path) => !isRunWieldOwnedRuntimePath(path));
    for (const path of dirty) {
        if (
            !permitted.has(path) ||
            (await fs.readFile(join(attempt.executionCwd, path), "utf8")) !== permitted.get(path)
        )
            throw new Error("Publication source changed after validation.");
    }
    for (const copy of manifest.copies) {
        const base = await committedCopy(attempt.executionCwd, attempt.validatedCommit, copy.path);
        if (base !== null)
            await assertOwnedPreviousCopy(root, attempt.executionCwd, manifest, attempt.validatedCommit, copy, base);
        const path = join(attempt.executionCwd, copy.path);
        // Never follow an execution-checkout symlink while materializing a copy.
        let cursor = attempt.executionCwd;
        for (const segment of copy.path.split("/")) {
            cursor = join(cursor, segment);
            const stat = await fs.lstat(cursor).catch((error) => {
                if (error.code === "ENOENT") return null;
                throw error;
            });
            if (stat?.isSymbolicLink()) throw new Error("Delivery copy destination contains a symbolic link.");
        }
        const current = await fs.readFile(path, "utf8").catch((error) => {
            if (error.code === "ENOENT") return null;
            throw error;
        });
        if (current !== null && current !== copy.text && current !== base)
            throw new Error(`Delivery copy collides with editor content: ${copy.path}`);
        await fs.mkdir(dirname(path), { recursive: true });
        await fs.writeFile(path, copy.text);
    }
    const result = await checkpointExecutionWorktree({
        worktreePath: attempt.executionCwd,
        branch: attempt.executionBranch,
        planName: attempt.planName,
        mergeTargetRef: attempt.targetHeadAtSeal,
        publicationAttemptId: attempt.attemptId,
        publicationPlanPaths: manifest.copies.map((copy) => copy.path),
    });
    const evidence = await packageArtifactEvidence(attempt.executionCwd, attempt, result.executionCommit);
    if (!evidence) throw new Error("Delivery copies do not match the frozen input.");
    return evidence;
}

async function settlePackageParent(manifest: PackagePublicationManifest, verifiedAt: string): Promise<void> {
    const selection = currentPackageSelection()!;
    const child = manifest.members.find((member) => member.metadata.planId === manifest.planId);
    const parent = manifest.members.find((member) => member.metadata.planId === child?.metadata.parentPlanId);
    if (
        parent?.metadata.definition.type !== "sequence" ||
        parent.metadata.definition.status !== "reviewed" ||
        parent.metadata.definition.epicCompletionMode !== "done_enough"
    )
        return;
    const liveParent = await readPlanPackage(selection.identity, { planId: parent.metadata.planId });
    if (liveParent.kind !== "loaded") throw new Error(liveParent.message);
    await packageWorkflowLocks([{ planId: liveParent.metadata.planId }], async () => {
        const current = await readPlanPackage(selection.identity, { planId: parent.metadata.planId });
        if (current.kind !== "loaded") throw new Error(current.message);
        // An old child delivery cannot finish a reopened or newly executing parent.
        if (
            current.metadata.workflow?.attempt ||
            JSON.stringify(current.metadata.definition) !== JSON.stringify(parent.metadata.definition)
        )
            return;
        await updatePackageWorkflowMetadata(
            { planId: current.metadata.planId },
            {
                status: "verified",
                verifiedAt,
            },
        );
    });
}

/** Called only by publication reconciliation after fresh target proof, before registry pruning. */
export async function settlePackagePublication(root: string, attempt: PublicationAttempt): Promise<void> {
    const selection = currentPackageSelection();
    if (
        !selection ||
        selection.planId !== attempt.planId ||
        !attempt.packageInput ||
        !attempt.verifiedAt ||
        !attempt.publishedCommit ||
        !attempt.publicationMode
    )
        throw new Error("Package settlement requires admitted ownership and confirmed publication.");
    const manifest = await packagePublicationInput(root, attempt.packageInput);
    const plan = await selectedPackage(attempt.planName);
    const prior = plan.metadata.workflow?.delivery;
    const binding = plan.metadata.workflow?.attempt;
    if (
        samePackagePublicationReference(prior?.source, attempt.packageInput) &&
        prior?.publishedCommit === attempt.publishedCommit &&
        prior.validatedCommit === attempt.validatedCommit &&
        prior.targetBranch === attempt.targetBranch &&
        prior.mode === attempt.publicationMode &&
        plan.metadata.definition.status === "verified" &&
        samePackagePublicationReference(plan.metadata.workflow?.publication, attempt.packageInput) &&
        !binding
    ) {
        await settlePackageParent(manifest, attempt.verifiedAt);
        return;
    }
    if (prior && (plan.metadata.definition.status !== "reviewed" || binding?.attemptId !== attempt.attemptId)) {
        // Historical receipt proof can settle records, but cannot mutate a reopened/newer Plan attempt.
        await readPublishedDeliverySources(root, { ...attempt, phase: "publication_verified" });
        return;
    }
    if (
        plan.metadata.definition.status !== "reviewed" ||
        !binding ||
        binding.attemptId !== attempt.attemptId ||
        binding.repositoryId !== attempt.packageInput.repositoryId ||
        binding.personalOwner !== attempt.packageInput.personalOwner ||
        !samePackagePublicationReference(plan.metadata.workflow?.publication, attempt.packageInput)
    )
        throw new Error("Publication proof does not apply to the current package attempt.");
    await updatePackageWorkflowMetadata(
        plan.metadata.name,
        {
            status: "verified",
            verifiedAt: attempt.verifiedAt,
            publicationReceipt: {
                validatedCommit: attempt.validatedCommit,
                publishedCommit: attempt.publishedCommit,
                targetBranch: attempt.targetBranch,
            },
        },
        undefined,
        {
            ...plan.metadata.workflow,
            delivery: {
                source: attempt.packageInput,
                validatedCommit: attempt.validatedCommit,
                publishedCommit: attempt.publishedCommit,
                targetBranch: attempt.targetBranch,
                mode: attempt.publicationMode,
                verifiedAt: attempt.verifiedAt,
            },
            attempt: undefined,
        },
    );
    await settlePackageParent(manifest, attempt.verifiedAt);
}

/** Target proof includes the exact immutable payload, independently of optional Git metadata. */
export async function packageTargetEvidence(
    ownerRoot: string,
    gitRoot: string,
    attempt: PackageCandidateEvidence,
    commit: string,
): Promise<boolean> {
    const candidate = attempt.artifactCommit || attempt.validatedCommit;
    if (!(await packageArtifactEvidence(ownerRoot, attempt, candidate, gitRoot))) return false;
    if ((await git(gitRoot, ["merge-base", "--is-ancestor", candidate, commit])).code !== 0) return false;
    const manifest = await packagePublicationInput(ownerRoot, attempt.packageInput!);
    for (const copy of manifest.copies) {
        const blob = await captureForegroundProcess("git", { cwd: gitRoot, args: ["show", `${commit}:${copy.path}`] });
        if (blob.code !== 0 || decodePackageMarkdown(blob.stdout) !== copy.text) return false;
    }
    return true;
}

export async function settlePackageInPlace(planName: string, mnemotecaPort: WorkRecordMnemotecaPort): Promise<void> {
    const selected = await selectedPackage(planName);
    const attemptId = selected.metadata.workflow?.attempt?.attemptId;
    if (!attemptId) throw new Error("In-place completion requires its bound execution attempt.");
    const source = await sealPackagePublication(planName, attemptId, "", "");
    const plan = await selectedPackage(planName);
    const controller = await packageController(plan);
    if (controller.deliveryEvidence?.mode !== "non_git_in_place" || controller.executionMode !== "non_git_in_place")
        throw new Error("In-place completion requires explicit non-Git evidence.");
    const verifiedAt = new Date().toISOString();
    await settlePackageParent(
        await readPlanPackagePublication(currentPackageSelection()!.identity, source),
        verifiedAt,
    );
    await updatePackageWorkflowMetadata(planName, { status: "verified", verifiedAt }, undefined, {
        ...plan.metadata.workflow,
        publication: source,
        attempt: undefined,
        delivery: {
            source,
            validatedCommit: "",
            publishedCommit: "",
            targetBranch: "",
            mode: "non_git_in_place",
            verifiedAt,
        },
    });
    await settlePreparedPackageRecord(
        currentPackageSelection()!.identity.checkoutRoot,
        await readPlanPackagePublication(currentPackageSelection()!.identity, source),
        mnemotecaPort,
    );
    await retainPublishedWorkRecordSource(currentPackageSelection()!.identity.checkoutRoot, {
        phase: "publication_verified",
        packageInput: source,
        planName,
        planId: plan.metadata.planId,
    });
}

export async function assertPackageCopyTargets(
    ownerRoot: string,
    gitRoot: string,
    reference: PackagePublicationReference,
    target: string,
): Promise<void> {
    const manifest = await packagePublicationInput(ownerRoot, reference);
    for (const copy of manifest.copies) {
        const existing = await committedCopy(gitRoot, target, copy.path);
        if (existing !== null) await assertOwnedPreviousCopy(ownerRoot, gitRoot, manifest, target, copy, existing);
    }
}

/** Remove only a proven unpublished copies commit before validating a changed code candidate. */
export async function retirePackageCopies(root: string, attempt: PublicationAttempt): Promise<void> {
    if (!attempt.packageInput) return;
    const manifest = await packagePublicationInput(root, attempt.packageInput);
    if (!manifest.copies.length) return;
    const cwd = attempt.executionCwd;
    const markers = await git(cwd, [
        "log",
        "--format=%H",
        `--grep=^RunWield-Publication-Attempt: ${attempt.attemptId}$`,
        "HEAD",
    ]);
    if (markers.code !== 0) throw new Error("Could not inspect unpublished copy history.");
    const candidates = markers.text.split("\n").filter(Boolean);
    let copiesCommit: string | undefined;
    let parent = "";
    for (const candidate of candidates) {
        const parents = await git(cwd, ["show", "-s", "--format=%P", candidate]);
        if (parents.code !== 0 || parents.text.split(" ").length !== 1) continue;
        const paths = await git(cwd, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", candidate]);
        if (
            paths.code !== 0 ||
            JSON.stringify(paths.text.split("\0").filter(Boolean).sort()) !==
                JSON.stringify(await changedCopyPaths(root, cwd, manifest, parents.text))
        )
            continue;
        let matches = true;
        for (const copy of manifest.copies) {
            const bytes = await captureForegroundProcess("git", { cwd, args: ["show", `${candidate}:${copy.path}`] });
            if (bytes.code !== 0 || decodePackageMarkdown(bytes.stdout) !== copy.text) matches = false;
        }
        if (matches) {
            copiesCommit = candidate;
            parent = parents.text;
            break;
        }
    }
    if (!copiesCommit) {
        // A completed strip restores exactly the candidate's prior payload (which may include older owned copies).
        const same = await git(cwd, [
            "diff",
            "--quiet",
            manifest.validatedCommit,
            "HEAD",
            "--",
            ...manifest.copies.map((copy) => copy.path),
        ]);
        if (same.code !== 0) throw new Error("Unpublished copy ownership cannot be proven.");
        const dirty = (await gitStatusPaths(cwd)).filter((path) => manifest.copies.some((copy) => copy.path === path));
        const owned = new Set(await uncommittedPackageCopyPaths(attempt));
        if (dirty.some((path) => !owned.has(path)))
            throw new Error("Edited delivery copies are preserved; restore their sealed bytes before revalidation.");
        for (const path of dirty) {
            const base = await committedCopy(cwd, attempt.validatedCommit, path);
            const pathspec = `:(literal)${path}`;
            const indexed = await git(cwd, ["ls-files", "--cached", "--", pathspec]);
            if (indexed.code !== 0) throw new Error("Could not inspect unfinished delivery copy index.");
            if (indexed.text) {
                const restored = await git(cwd, [
                    "restore",
                    `--source=${attempt.validatedCommit}`,
                    "--staged",
                    "--",
                    pathspec,
                ]);
                if (restored.code !== 0) throw new Error("Could not retire the staged delivery copy.");
            }
            if (base === null) await fs.unlink(join(cwd, path));
            else await fs.writeFile(join(cwd, path), base);
        }
        return;
    }
    for (const copy of manifest.copies) {
        if ((await fs.readFile(join(cwd, copy.path), "utf8")) !== copy.text)
            throw new Error("Edited delivery copies are preserved; restore their sealed bytes before revalidation.");
    }
    const checkpoint = await checkpointExecutionWorktree({
        worktreePath: cwd,
        branch: attempt.executionBranch,
        planName: attempt.planName,
    });
    const backup = `refs/runwield/revalidation/${attempt.packageInput.inputId}`;
    if ((await git(cwd, ["update-ref", backup, checkpoint.executionCommit])).code !== 0)
        throw new Error("Cannot retain the code candidate before revalidation.");
    const rebased = await git(cwd, ["rebase", "--onto", parent, copiesCommit, attempt.executionBranch]);
    if (rebased.code !== 0) {
        await git(cwd, ["rebase", "--abort"]);
        throw new Error("Unpublished copies could not be separated from code; the original candidate is retained.");
    }
}

/** Refuse an inapplicable package reference before publication can change Git. */
export async function assertPackagePublicationOwner(attempt: PublicationAttempt): Promise<void> {
    if (!attempt.packageInput) return;
    const selected = await selectedPackage(attempt.planName);
    const workflow = selected.metadata.workflow;
    const binding = workflow?.attempt;
    if (!samePackagePublicationReference(workflow?.publication, attempt.packageInput))
        throw new Error("Package publication reference no longer matches the active attempt.");
    if (
        binding &&
        binding.attemptId === attempt.attemptId &&
        binding.repositoryId === attempt.packageInput.repositoryId &&
        binding.personalOwner === attempt.packageInput.personalOwner &&
        selected.metadata.definition.status === "reviewed"
    )
        return;
    const receipt = workflow?.delivery;
    if (
        !binding &&
        selected.metadata.definition.status === "verified" &&
        samePackagePublicationReference(receipt?.source, attempt.packageInput) &&
        receipt?.validatedCommit === attempt.validatedCommit &&
        receipt.publishedCommit === attempt.publishedCommit &&
        receipt.targetBranch === attempt.targetBranch
    )
        return;
    throw new Error("Package publication no longer owns this execution.");
}

/** The publisher checks the same frozen payload before any target effect, including repaired clones. */
export async function assertPackagePublicationCandidate(
    ownerRoot: string,
    gitRoot: string,
    reference: PackagePublicationReference,
    candidate: string,
    integrated: string,
): Promise<void> {
    const manifest = await packagePublicationInput(ownerRoot, reference);
    const evidence: PackageCandidateEvidence = {
        packageInput: reference,
        validatedCommit: manifest.validatedCommit,
        targetBranch: manifest.targetBranch,
        attemptId: manifest.attemptId,
        planId: manifest.planId,
        artifactCommit: candidate,
    };
    if (!(await packageTargetEvidence(ownerRoot, gitRoot, evidence, integrated)))
        throw new Error("Publication candidate differs from its retained code or delivery copies.");
}

/** A durable recording snapshot already owns source selection during delivery resumption. */
export async function recoverPackageRecordingPreparation(planName: string): Promise<boolean> {
    const selection = currentPackageSelection();
    if (!selection) return false;
    const plan = await selectedPackage(planName);
    const binding = plan.metadata.workflow?.attempt;
    if (!binding) return false;
    const reference =
        plan.metadata.workflow?.recordingPreparation ||
        (await findPlanPackageRecordingPreparation(selection.identity, plan.metadata.planId, binding.attemptId));
    if (!reference) return false;
    const manifest = await readPlanPackagePublication(selection.identity, reference);
    const controller = await packageController(plan);
    if (
        manifest.stage !== "recording" ||
        manifest.attemptId !== binding.attemptId ||
        binding.repositoryId !== manifest.repositoryId ||
        binding.personalOwner !== manifest.personalOwner ||
        binding.input.inputs.some(
            (input) =>
                !manifest.members.some(
                    (member) => member.input.planId === input.planId && member.input.inputId === input.inputId,
                ),
        )
    )
        throw new Error("Retained recording input does not apply to this delivery attempt.");
    // A changed implementation returns to CI and review while retaining the original Plan input.
    if (plan.metadata.definition.status !== "reviewed" || controller.validationPhase !== "delivery") return false;
    if (!plan.metadata.workflow?.recordingPreparation)
        await updatePackageWorkflowMetadata(planName, {}, undefined, { recordingPreparation: reference });
    return true;
}

/** Reserve recording evidence for an in-place completion without exposing its attempt metadata. */
export async function preparePlanInPlacePublication(planName: string): Promise<boolean> {
    if (!currentPackageSelection()) return false;
    const plan = await selectedPackage(planName);
    const attempt = plan.metadata.workflow?.attempt;
    if (!attempt) throw new Error("In-place publication requires a recorded execution attempt.");
    await sealPackagePublication(planName, attempt.attemptId, "", "", true);
    return true;
}
