/** Immutable recording input retained after delivery removes the execution worktree. */
import { join } from "@std/path";
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
    const result = await new Deno.Command("git", { cwd: root, args, stdout: "piped", stderr: "piped" }).output();
    if (!result.success) throw new Error("The delivered Work Record source could not be read from Git.");
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
export async function retainPublishedWorkRecordSource(root: string, attempt: PublicationAttempt): Promise<void> {
    if (!["publication_verified", "cleanup_complete"].includes(attempt.phase)) {
        throw new Error("Recording source requires confirmed publication.");
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
    const local = await loadPlan(root, planName);
    const view = await inspectControllerView(root, { planName, planId: local?.attrs.planId }, {});
    const receipt = view.state.recordingSource ||
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
    const writable = current || await loadPlan(root, source.name);
    if (!writable) throw new Error("The delivered Plan could not be prepared for its Work Record backlink.");
    source.documentRevision = writable.revision;
    // A previous successful retry is authoritative for the backlink, not for source prose.
    if (writable.attrs.workRecord && writable.attrs.workRecord.status !== "failed") {
        source.attrs = { ...source.attrs, workRecord: writable.attrs.workRecord };
    }
    if (!isProjectPlan(source.attrs)) return source;
    const paths = (await git(root, ["ls-tree", "-r", "--name-only", receipt.commit, "--", "docs/plans/"]))
        .trim().split("\n").filter((path) => path.endsWith(".md"));
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
    attempt: PublicationAttempt,
): Promise<PublishedDeliverySources> {
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
    const preparedParentDelivered = parent &&
        ["publication_verified", "cleanup_complete"].includes(attempt.phase) &&
        ["reviewed", "validated"].includes(parent.attrs.status) &&
        parent.attrs.epicCompletionMode === "done_enough" &&
        Boolean(attempt.planPaths?.includes(`docs/plans/${parent.name}.md`));
    return {
        delivered,
        workRecordOwner: parent && (isTerminalWorkRecordParent(parent.attrs) || preparedParentDelivered)
            ? parent
            : undefined,
    };
}

/** The primary checkout may not contain a record created inside the delivered worktree. */
export async function readPublishedRecordMarkdown(
    root: string,
    attempt: PublicationAttempt,
    path: string,
): Promise<string | null> {
    if (!attempt.artifactCommit || !path.startsWith("docs/work-records/") || path.split("/").includes("..")) {
        return null;
    }
    try {
        return await git(root, ["show", `${attempt.artifactCommit}:${path}`]);
    } catch {
        return null;
    }
}
