import { planDocumentMarkdown, injectFrontMatter } from "../plan-format.ts";
/** Authorization of Plan resources belongs to the owner that selected their source. */
import {
    selectedPackage,
    currentPackageProject,
    currentPackageSelection,
    loadPackageWorkflowPlan,
} from "./workflows.ts";
import { realpath as fsRealpath } from "node:fs/promises";
import { isAbsolute, relative, join } from "node:path";
import { loadTargetPlan } from "../shared/workflow/planning-worktree.ts";
import { inspectProjectRuntimeReadAccess, ProjectRuntimeEntryRefusedError } from "../shared/project-runtime-layout.ts";
import { assertControllerDocumentAvailable, listControllerDocumentWorktrees } from "./controllers.ts";
interface PlanResourceReference {
    path: string;
    planName: string;
    planId?: string;
}
async function assertContainedProjectPath(root: string, path: string) {
    const canonicalRoot = await fsRealpath(root);
    const canonicalPath = await fsRealpath(path);
    const contained = relative(canonicalRoot, canonicalPath).replaceAll("\\", "/");
    if (isAbsolute(contained) || contained === ".." || contained.startsWith("../"))
        throw new Error("Artifact identity leaves the Project.");
    return canonicalPath;
}
/** @param {string} root @param {string} path @param {string} planName */
export async function assertAuthorizedPlanPath(root: string, path: string, planName: string) {
    if (currentPackageProject()) {
        const selected = await selectedPackage(planName);
        if (!selected.documents.some((document) => join(selected.path, document.name) === path))
            throw new Error("Plan path is not an admitted package document.");
        return path;
    }
    const access = await inspectProjectRuntimeReadAccess(root);
    if (access.kind === "blocked") throw new ProjectRuntimeEntryRefusedError(access);
    const attempts =
        access.kind === "pending"
            ? []
            : (await listControllerDocumentWorktrees(root)).filter((entry) => entry.planName === planName);
    if (!attempts.length) return await assertContainedProjectPath(root, path);
    if (attempts.length !== 1) throw new Error("Plan document authority is ambiguous.");
    const attempt = attempts[0];
    assertControllerDocumentAvailable(attempt);
    const canonicalPath = await fsRealpath(path);
    for (const prefix of ["", "archived/"]) {
        const expectedPath = join(attempt.path, "docs", "plans", `${prefix}${planName}.md`);
        try {
            const containedPath = await assertContainedProjectPath(attempt.path, expectedPath);
            if (containedPath === canonicalPath) return canonicalPath;
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
    }
    throw new Error("Plan path is not the registered document authority.");
}

/** Authorize local Git bytes for browsing only. This does not authorize a filesystem write.
 * @param {string} root
 * @param {{ path: string, planName: string }} resource
 */
export async function assertReadablePlanResource(root: string, resource: PlanResourceReference) {
    const selection = currentPackageProject();
    if (selection) {
        if ((await fsRealpath(root)) !== (await fsRealpath(selection.checkoutRoot)))
            throw new Error("Plan resource belongs to another Project.");
        if (!resource.planId) throw new Error("Plan resource identity is missing.");
        const plan = await selectedPackage({ planId: resource.planId });
        if (!plan.documents.some((document) => join(plan.path, document.name) === resource.path))
            throw new Error("Plan resource is not an admitted document.");
        return resource.path;
    }

    const snapshot = resource.path.match(/^([a-f0-9]{40,64}):(.+)$/);
    if (!snapshot) return await assertAuthorizedPlanPath(root, resource.path, resource.planName);
    const access = await inspectProjectRuntimeReadAccess(root);
    if (access.kind === "blocked") throw new ProjectRuntimeEntryRefusedError(access);
    if (snapshot[2] !== `docs/plans/${resource.planName}.md`) throw new Error("Plan snapshot identity is invalid.");
    const plan = await loadTargetPlan(root, resource.planName, snapshot[1]);
    if (!plan || plan.path !== resource.path) throw new Error("Plan snapshot is unavailable.");
    return resource.path;
}

/** Present a coherent selected review document without exposing package metadata or bytes. */
export async function readPlanReviewPresentation(planId?: string) {
    planId ||= currentPackageSelection()?.planId;
    if (!currentPackageProject() || !planId) return undefined;
    const plan = await loadPackageWorkflowPlan({ planId });
    const selected = await selectedPackage({ planId });
    return {
        planId,
        plan: plan.body,
        planName: selected.metadata.name,
        frontmatter: plan.attrs,
        classification: plan.attrs.classification,
        documentRevision: plan.revision,
        linkedFiles: Object.fromEntries(
            selected.documents.map((entry) => [entry.name, new TextDecoder().decode(entry.bytes)]),
        ),
    };
}

/** Resolve the review document from admitted authority, including legacy file-backed review. */
export async function loadReviewPlanDocument(path: string) {
    const { currentPackageSelection } = await import("./workflows.ts");
    const selection = currentPackageSelection();
    if (selection) return await loadPackageWorkflowPlan({ planId: selection.planId });
    const { loadPlanFileStrict } = await import("../plan-store.js");
    return await loadPlanFileStrict(path);
}

/** Identity comparison does not disclose the admitted storage record. */
export function isCurrentPlan(planId: string | undefined): boolean {
    return Boolean(planId && currentPackageSelection()?.planId === planId);
}

/** Resolve where a controller write survives execution checkout cleanup. */
export function planControllerRoot(fallback: string): string {
    return currentPackageProject()?.checkoutRoot || fallback;
}

/** Render metadata only for retained legacy review documents; canonical prose stays metadata-free. */
export function renderPlanReviewMarkdown(
    body: string,
    attrs: Partial<import("../plan-store.js").PlanFrontMatter>,
): string {
    return currentPackageSelection() ? body : planDocumentMarkdown(injectFrontMatter(body, attrs));
}

/** Read document and edit capability together, without requiring a surface to select a storage kind. */
export async function loadPlanDetail(cwd: string, planId: string, reviewOnly = false) {
    const { readLocalHomeStore } = await import("./access.ts");
    const { findPlanEvidenceById, findPlanById, loadPlanBodyById } = await import("../plan-store.js");
    const { readPlanDocuments } = await import("./documents.ts");
    const { isProjectPlan } = await import("../shared/project-plan.ts");
    return await readLocalHomeStore(
        cwd,
        async () => {
            const base = reviewOnly ? await findPlanEvidenceById(cwd, planId) : await findPlanById(cwd, planId);
            if (!base) throw new Error("Plan not found.");
            await assertReadablePlanResource(cwd, { ...base, planName: base.planName || base.name });
            const canonical = Boolean(currentPackageProject());
            const document = canonical ? await readPlanDocuments(planId) : undefined;
            const resource =
                reviewOnly || (!canonical && isProjectPlan(base.attrs)) ? base : await loadPlanBodyById(cwd, planId);
            return {
                resource,
                document,
                bodyEditing:
                    resource.readAvailability?.kind !== "pending" &&
                    !/^[a-f0-9]{40,64}:/.test(resource.path) &&
                    (canonical || !isProjectPlan(resource.attrs)),
            };
        },
        () => {
            throw new Error("Plan not found.");
        },
    );
}
