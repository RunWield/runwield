import { inspectProjectIdentity } from "../project-identity.ts";
import {
    readPlanPackage,
    decodePackageMarkdown,
    readPlanPackageInput,
    readPlanPackagePublication,
    samePackagePublicationReference,
    type PackagePublicationReference,
    type PackageDeliveryReceipt,
} from "../plan-package-store.ts";
import {
    currentPackageSelection,
    loadPackageWorkflowPlan,
    selectedPackage,
    updatePackageWorkflowMetadata,
} from "../workflow/package-workflow.ts";
import { isCommitPublishedToTarget } from "../isolated-publication.ts";
import { captureForegroundProcess } from "../captured-process.ts";
import { effectiveDeliveryBranch } from "../workflow/plan-branch.ts";
/** Immutable recording input retained after delivery removes the execution worktree. */
import { join } from "node:path";
import {
    canonicalizeStoredPlanName,
    isChildFeaturePlan,
    isProjectPlan,
    loadPlan,
    parsePlanFrontMatter,
    savePlan,
} from "../../plan-store.js";
import {
    findRecordingControllerByName,
    inspectControllerView,
    writeControllerState,
} from "../workflow/controller-registry.ts";
import type { PublicationAttempt } from "../workflow/publication-attempt.ts";
import { attachEpicChildren, buildActiveWorkRecordSource } from "./generation.js";
import { isTerminalWorkRecordParent } from "./auto-generation.ts";

type WorkRecordSource = import("./generation.js").WorkRecordSource;

async function git(root: string, args: string[]): Promise<string> {
    const result = await captureForegroundProcess("git", { cwd: root, args });
    if (result.code !== 0) throw new Error("The delivered Work Record source could not be read from Git.");
    return new TextDecoder().decode(result.stdout);
}

async function readSource(root: string, commit: string, name: string): Promise<WorkRecordSource> {
    const canonical = canonicalizeStoredPlanName(name).name;
    if (canonical !== name) throw new Error("The delivered Plan name is not canonical.");
    const relativePath = `docs/plans/${name}.md`;
    const markdown = await git(root, ["show", `${commit}:${relativePath}`]);
    const { attrs, body } = parsePlanFrontMatter(markdown);
    return buildActiveWorkRecordSource(name, { path: join(root, relativePath), markdown, attrs, body });
}

/** Called only after publication proof, before reporting completed delivery. */
export async function retainPublishedWorkRecordSource(
    root: string,
    attempt: Pick<PublicationAttempt, "phase" | "packageInput" | "artifactCommit" | "planName" | "planId">,
): Promise<void> {
    if (!["publication_verified", "cleanup_complete"].includes(attempt.phase)) {
        throw new Error("Recording source requires confirmed publication.");
    }
    if (attempt.packageInput) {
        const { workRecordOwner } = await packageDeliverySources(root, attempt.packageInput, true);
        if (!workRecordOwner) return;
        const selection = currentPackageSelection();
        if (!selection) throw new Error("Recording source retention requires admitted package ownership.");
        const owner = await readPlanPackage(selection.identity, { planId: workRecordOwner.planId });
        if (owner.kind !== "loaded") throw new Error(owner.message);
        const newerAttempt = owner.metadata.workflow?.attempt;
        const newerSource = owner.metadata.workflow?.recordingSource;
        if (
            (newerAttempt && newerAttempt.attemptId !== attempt.packageInput.attemptId) ||
            (newerSource &&
                newerSource.attemptId !== attempt.packageInput.attemptId &&
                !samePackagePublicationReference(owner.metadata.workflow?.delivery?.source, attempt.packageInput))
        )
            return;
        if (!samePackagePublicationReference(owner.metadata.workflow?.recordingSource, attempt.packageInput))
            await updatePackageWorkflowMetadata({ planId: workRecordOwner.planId }, {}, undefined, {
                recordingSource: attempt.packageInput,
            });
        return;
    }
    if (!attempt.artifactCommit) throw new Error("The delivered recording source has no artifact commit.");
    const delivered = await readSource(root, attempt.artifactCommit, attempt.planName);
    if (delivered.planId !== attempt.planId) throw new Error("The delivered Plan identity changed.");
    const owner = isChildFeaturePlan(delivered)
        ? await readSource(root, attempt.artifactCommit, delivered.attrs.parentPlan || "")
        : delivered;
    if (!owner.planId) throw new Error("The Work Record source Plan has no identity.");
    const recordingSource = { commit: attempt.artifactCommit, planName: owner.name, planId: owner.planId };
    // A private ref keeps the sealed input readable after branch cleanup and Git GC.
    await git(root, [
        "update-ref",
        `refs/runwield/record-sources/${encodeURIComponent(owner.planId)}`,
        attempt.artifactCommit,
    ]);
    await writeControllerState(root, { planId: attempt.planId, planName: attempt.planName }, { recordingSource });
    if (owner.planId !== attempt.planId) {
        await writeControllerState(root, { planId: owner.planId, planName: owner.name }, { recordingSource });
    }
}

/** Read the delivered input while preserving a stale or edited primary Plan body. */
export async function loadPublishedWorkRecordSource(root: string, planName: string): Promise<WorkRecordSource | null> {
    if (currentPackageSelection()) {
        const selected = await selectedPackage(planName);
        const recordingSource = selected.metadata.workflow?.recordingSource;
        const reference = recordingSource || selected.metadata.workflow?.delivery?.source;
        if (!reference) return null;
        const sources = await packageDeliverySources(root, reference, true);
        const source = sources.workRecordOwner;
        if (recordingSource && source?.planId !== selected.metadata.planId)
            throw new Error("Retained recording source belongs to another recording owner.");
        if (source) {
            const owner = await readPlanPackage(currentPackageSelection()!.identity, { planId: source.planId });
            if (owner.kind !== "loaded") throw new Error(owner.message);
            source.name = owner.metadata.name;
            const writable = await loadPackageWorkflowPlan({ planId: source.planId });
            source.documentRevision = writable.revision;
            source.attrs.workRecord = writable.attrs.workRecord;
        }
        return source || null;
    }
    const local = await loadPlan(root, planName);
    const view = await inspectControllerView(root, { planName, planId: local?.attrs.planId }, {});
    const published = view.state.publicationReceipt;
    const completedSource =
        local?.attrs.deliveryBranch && published && effectiveDeliveryBranch(local.attrs) === published.targetBranch
            ? { commit: published.publishedCommit, planName, planId: local.attrs.planId || "" }
            : undefined;
    const receipt =
        view.state.recordingSource ||
        completedSource ||
        (!local ? (await findRecordingControllerByName(root, planName))?.state.recordingSource : undefined);
    if (!receipt) return null;
    const source = await readSource(root, receipt.commit, receipt.planName);
    if (["reviewed", "validated"].includes(source.attrs.status)) source.attrs.status = "verified";
    if (source.planId !== receipt.planId) throw new Error("The saved recording source identity does not match.");
    const current = await loadPlan(root, source.name);
    if (current && current.attrs.planId !== source.planId) {
        throw new Error("A different Plan now uses the delivered Plan's path. Its record was not changed.");
    }
    if (!current) await savePlan(root, source.name, source.body, source.attrs);
    const writable = current || (await loadPlan(root, source.name));
    if (!writable) throw new Error("The delivered Plan could not be prepared for its Work Record backlink.");
    source.documentRevision = writable.revision;
    // A previous successful retry is authoritative for the backlink, not for source prose.
    if (writable.attrs.workRecord && writable.attrs.workRecord.status !== "failed") {
        source.attrs = { ...source.attrs, workRecord: writable.attrs.workRecord };
    }
    if (!isProjectPlan(source.attrs)) return source;
    const paths = (await git(root, ["ls-tree", "-r", "--name-only", receipt.commit, "--", "docs/plans/"]))
        .trim()
        .split("\n")
        .filter((path) => path.endsWith(".md"));
    const children: WorkRecordSource[] = [];
    for (const path of paths) {
        const name = path.slice("docs/plans/".length, -3);
        if (name === source.name) continue;
        const child = await readSource(root, receipt.commit, name);
        if (child.attrs.parentPlan === source.name) children.push(child);
    }
    return attachEpicChildren([source, ...children])[0];
}

export interface PublishedDeliverySources {
    delivered: WorkRecordSource;
    workRecordOwner?: WorkRecordSource;
}

/** Read-only delivery facts: keep child identity distinct from the Epic recording owner. */
export async function readPublishedDeliverySources(
    root: string,
    attempt: Pick<
        PublicationAttempt,
        "artifactCommit" | "planName" | "planId" | "phase" | "planPaths" | "packageInput"
    >,
): Promise<PublishedDeliverySources> {
    if (attempt.packageInput)
        return await packageDeliverySources(
            root,
            attempt.packageInput,
            ["publication_verified", "cleanup_complete"].includes(attempt.phase),
        );
    if (!attempt.artifactCommit) throw new Error("The delivered Plan artifact commit is missing.");
    const delivered = await readSource(root, attempt.artifactCommit, attempt.planName);
    if (delivered.planId !== attempt.planId) throw new Error("The delivered Plan identity changed.");
    const controller = await inspectControllerView(root, { planName: attempt.planName, planId: attempt.planId }, {});
    delivered.attrs = {
        ...delivered.attrs,
        humanReviewMode: controller.state.humanReviewMode,
        humanReviewDecision: controller.state.humanReviewDecision,
        humanReviewedAt: controller.state.humanReviewedAt,
    };
    if (!isChildFeaturePlan(delivered)) return { delivered, workRecordOwner: delivered };
    // Child branches can contain only child Plans; the Epic document remains in the primary checkout.
    // Its absent recording evidence must not interrupt a confirmed child delivery.
    const parent = await readSource(root, attempt.artifactCommit, delivered.attrs.parentPlan || "").catch(() => null);
    const preparedParentDelivered =
        parent &&
        ["publication_verified", "cleanup_complete"].includes(attempt.phase) &&
        ["reviewed", "validated"].includes(parent.attrs.status) &&
        parent.attrs.epicCompletionMode === "done_enough" &&
        Boolean(attempt.planPaths?.includes(`docs/plans/${parent.name}.md`));
    return {
        delivered,
        workRecordOwner:
            parent && (isTerminalWorkRecordParent(parent.attrs) || preparedParentDelivered) ? parent : undefined,
    };
}

/** The primary checkout may not contain a record created inside the delivered worktree. */
export async function readPublishedRecordMarkdown(
    root: string,
    attempt: PublicationAttempt,
    path: string,
): Promise<string | null> {
    if (
        !["publication_verified", "cleanup_complete"].includes(attempt.phase) ||
        !attempt.publishedCommit ||
        !/^docs\/work-records\/[^/]+\.md$/.test(path)
    ) {
        return null;
    }
    if (attempt.packageInput) {
        const inspected = inspectProjectIdentity(root);
        if (inspected.kind !== "existing") throw new Error("Recording owner is unavailable.");
        await packageDeliverySources(root, attempt.packageInput, true);
        const manifest = await readPlanPackagePublication(inspected.identity, attempt.packageInput);
        return manifest.preparedRecord?.path === path
            ? manifest.preparedRecord.text
            : manifest.copies.find((copy) => copy.kind === "work-record" && copy.path === path)?.text || null;
    }
    try {
        return await git(root, ["show", `${attempt.publishedCommit}:${path}`]);
    } catch {
        return null;
    }
}

/** Match retained receipts, including a prior delivery preserved by a newer attempt. */
async function packageRecordingReceipt(
    root: string,
    reference: PackagePublicationReference,
): Promise<PackageDeliveryReceipt | undefined> {
    const inspected = inspectProjectIdentity(root);
    if (inspected.kind !== "existing") throw new Error("Recording owner is unavailable.");
    const manifest = await readPlanPackagePublication(inspected.identity, reference);
    const current = await readPlanPackage(inspected.identity, { planId: reference.planId });
    if (current.kind !== "loaded") throw new Error(current.message);
    let receipt = current.metadata.workflow?.delivery;
    const visited = new Set<string>();
    while (receipt && !samePackagePublicationReference(receipt.source, reference)) {
        if (visited.has(receipt.source.inputId)) throw new Error("Publication receipt history contains a cycle.");
        visited.add(receipt.source.inputId);
        const prior = await readPlanPackagePublication(inspected.identity, receipt.source);
        if (receipt.validatedCommit !== prior.validatedCommit || receipt.targetBranch !== prior.targetBranch)
            throw new Error("Publication receipt history does not match its retained input.");
        receipt = prior.members.find((member) => member.metadata.planId === reference.planId)?.metadata.workflow
            ?.delivery;
    }
    const proved =
        current.metadata.workflow?.attempt?.attemptId !== reference.attemptId &&
        samePackagePublicationReference(receipt?.source, reference) &&
        receipt &&
        receipt.validatedCommit === manifest.validatedCommit &&
        receipt.targetBranch === manifest.targetBranch;
    return proved ? receipt : undefined;
}

/** Deliberate retry rechecks the publication authority before changing canonical confidence. */
export async function verifyPackageRecordingDelivery(
    root: string,
    reference: PackagePublicationReference,
): Promise<void> {
    const receipt = await packageRecordingReceipt(root, reference);
    if (!receipt) throw new Error("Retained source has no matching delivery receipt.");
    if (
        receipt.mode !== "non_git_in_place" &&
        !(await isCommitPublishedToTarget({
            projectRoot: root,
            targetBranch: receipt.targetBranch,
            commit: receipt.publishedCommit,
        }))
    )
        throw new Error("The retained recording delivery is not confirmed by the publication target.");
}

/** Retained source is addressable without execution/Git copies and never materializes a Plan. */
async function packageDeliverySources(
    root: string,
    reference: PackagePublicationReference,
    confirmed: boolean,
): Promise<PublishedDeliverySources> {
    const inspected = inspectProjectIdentity(root);
    if (inspected.kind !== "existing") throw new Error("Recording owner is unavailable.");
    const manifest = await readPlanPackagePublication(inspected.identity, reference);
    const proved = await packageRecordingReceipt(root, reference);
    if (confirmed && !proved) throw new Error("Retained source has no matching delivery receipt.");
    const sources: WorkRecordSource[] = [];
    const name = (id: string) => manifest.members.find((member) => member.metadata.planId === id)?.metadata.name || id;
    for (const member of manifest.members) {
        const retained = await readPlanPackageInput(inspected.identity, member.input);
        const markdown = decodePackageMarkdown(retained.documents.find((doc) => doc.name === "context.md")!.bytes);
        const metadata = member.metadata;
        const delivered = metadata.planId === reference.planId;
        const completedParent =
            metadata.planId ===
                manifest.members.find((item) => item.metadata.planId === reference.planId)?.metadata.parentPlanId &&
            metadata.definition.type === "sequence" &&
            metadata.definition.status === "reviewed" &&
            metadata.definition.epicCompletionMode === "done_enough";
        const source = buildActiveWorkRecordSource(metadata.name, {
            path: join(retained.path, "context.md"),
            markdown,
            body: markdown,
            attrs: {
                ...metadata.definition,
                ...member.controller,
                ...metadata.controller,
                planId: metadata.planId,
                createdAt: metadata.createdAt,
                parentPlan: metadata.parentPlanId ? name(metadata.parentPlanId) : undefined,
                dependencies: metadata.dependencyPlanIds.map(name),
                status: (delivered || completedParent) && proved ? "verified" : metadata.definition.status,
            } as import("../../plan-store.js").PlanFrontMatter,
        });
        const recordingOwnerId =
            manifest.members.find((item) => item.metadata.planId === manifest.planId)?.metadata.parentPlanId ||
            manifest.planId;
        if (manifest.recordingOutcome && metadata.planId === recordingOwnerId)
            source.attrs.workRecord = manifest.recordingOutcome;
        if (manifest.preparedRecord) {
            const { parseWorkRecordMarkdown } = await import("./markdown.js");
            const record = parseWorkRecordMarkdown(manifest.preparedRecord.text);
            if (record.attrs.provenance?.sourcePlans?.includes(metadata.planId))
                source.attrs.workRecord = {
                    status: "generated",
                    recordId: record.attrs.recordId,
                    path: manifest.preparedRecord.path,
                };
        }
        source.pendingPublication = (delivered || completedParent) && !proved;
        source.relativePath = source.path;
        source.recordingAttemptId = reference.attemptId;
        sources.push(source);
    }
    const family = attachEpicChildren(sources);
    const delivered = family.find((source) => source.planId === reference.planId)!;
    const owner = isChildFeaturePlan(delivered)
        ? family.find((source) => source.name === delivered.attrs.parentPlan)
        : delivered;
    return {
        delivered,
        workRecordOwner:
            owner &&
            (!isChildFeaturePlan(delivered) ||
                isTerminalWorkRecordParent(owner.attrs) ||
                (!confirmed && owner.pendingPublication && owner.attrs.epicCompletionMode === "done_enough"))
                ? owner
                : undefined,
    };
}
