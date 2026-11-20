import { fileURLToPath } from "node:url";
import { getHomeDir } from "../constants.ts";
import {
    managedPlanStoreActive,
    managedDocumentRoot,
    readManagedPlan,
    readManagedDocument,
    saveManagedDocument,
} from "./managed.ts";
import { mkdir, readFile, stat, realpath, lstat } from "node:fs/promises";
import { dirname, basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { inspectLocalHomeStore } from "./access.ts";
import { readPlanPackage } from "./packages.ts";
import { withPackageProject, packageWorkflowRevision } from "./workflows.ts";
import { savePlanDocument, savePlanDocumentBatch, type PreparedPlanDocumentEdit } from "./documents.ts";
import {
    getPlanRevisionForText,
    withPlanCatalogLock,
    withPlanLock,
    writePlanMarkdownWithRevisionLocked,
} from "../plan-store.ts";
import { atomicWriteTextFileIfAbsent } from "../shared/atomic-text-file.ts";

export interface PlanFileCommand {
    path: string;
    mode: "write" | "edit" | "read" | "prepare-edit";
    content?: string;
    oldText?: string;
    newText?: string;
}

export interface PlanFileResult {
    message: string;
    content?: string;
    document?: Omit<PreparedPlanDocumentEdit, "body">;
}

export function isCanonicalPlanMarkdownPath(cwd: string, path: string): boolean {
    const absolute = isAbsolute(path) ? path : join(cwd, path);
    const rel = relative(cwd, absolute).replaceAll("\\", "/");
    return rel.startsWith("docs/plans/") && rel.endsWith(".md") && !rel.startsWith("docs/plans/archived/");
}

function exactEdit(content: string, oldText: string, newText: string, path: string): string {
    if (!oldText) throw new Error(`oldText must not be empty for ${path}.`);
    const first = content.indexOf(oldText);
    if (first === -1) throw new Error(`oldText was not found in ${path}. It must match exactly.`);
    if (content.indexOf(oldText, first + 1) !== -1)
        throw new Error(`oldText was found multiple times in ${path}. Add more context.`);
    const next = content.slice(0, first) + newText + content.slice(first + oldText.length);
    if (next === content) throw new Error(`No changes made to ${path}. The replacement produced identical content.`);
    return next;
}

/** Resolve the existing ancestor so new files reached through an alias use the same ownership check. */
async function canonicalFileTarget(path: string): Promise<string> {
    try {
        return await realpath(path);
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        const link = await lstat(path).catch((cause: NodeJS.ErrnoException) => {
            if (cause.code === "ENOENT") return null;
            throw cause;
        });
        if (link?.isSymbolicLink()) throw new Error("The file target is a dangling symbolic link.");
        const parent = dirname(path);
        if (parent === path) return path;
        return join(await canonicalFileTarget(parent), basename(path));
    }
}

function insideProjectStorage(relativePath: string): boolean {
    return relativePath !== ".." && !relativePath.startsWith(".." + sep) && !isAbsolute(relativePath);
}

/** Both the Plan guard and delegated source tool use this exact absolute target. */
export async function resolvePlanFileTarget(cwd: string, requested: string): Promise<string> {
    let path = requested.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ").replace(/^@/, "");
    if (process.platform === "win32") {
        path = path.replace(
            /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i,
            (_match, drive: string, rest: string | undefined) =>
                drive.toUpperCase() + ":\\" + (rest || "").replaceAll("/", "\\"),
        );
    }
    if (path === "~" || path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\")))
        path = join(getHomeDir(), path.slice(2));
    if (path.startsWith("file://")) path = fileURLToPath(path);
    const absolute = resolve(cwd, path);
    const target = await canonicalFileTarget(absolute);
    const homeProjects = join(getHomeDir(), ".wld", "projects");
    const protectedPath = relative(homeProjects, absolute);
    if (insideProjectStorage(protectedPath)) {
        const expected = join(await canonicalFileTarget(homeProjects), protectedPath);
        if (target !== expected) throw new Error("A protected Project path was redirected.");
    }
    return target;
}

export async function savePlanFileBatch(cwd: string, edits: PreparedPlanDocumentEdit[]) {
    if (managedPlanStoreActive()) return await (await import("./managed.ts")).saveManagedDocumentBatch(cwd, edits);
    const store = inspectLocalHomeStore(cwd);
    if (store.kind !== "local") throw new Error("Plan document owner changed.");
    await withPackageProject(cwd, store.identity, () => savePlanDocumentBatch(edits));
}

/** Intercept owned Plan files; undefined means the caller's ordinary file tool owns this path. */
export async function operatePlanFile(cwd: string, command: PlanFileCommand): Promise<PlanFileResult | undefined> {
    const { mode } = command;
    if (!command.path) return;
    const path = await resolvePlanFileTarget(cwd, command.path);
    cwd = await canonicalFileTarget(cwd);
    async function guardProjectStorage() {
        if (mode === "read") return;
        const root = await canonicalFileTarget(join(getHomeDir(), ".wld", "projects"));
        const rel = relative(root, path);
        if (insideProjectStorage(rel))
            throw new Error("Project metadata can only be changed through its owning operation.");
    }
    if (managedPlanStoreActive()) {
        const absolute = isAbsolute(path) ? path : join(cwd, path);
        const rel = relative(managedDocumentRoot(cwd), absolute).replaceAll("\\", "/");
        if (rel && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)) {
            const resource = rel.split("/").at(-1)!;
            if (!["context.md", "validation.md", "manual-qa.md", "integration-report.md"].includes(resource))
                throw new Error("Core owns Plan metadata. Edit an exposed Markdown document instead.");
            const name = rel.slice(0, -(resource.length + 1));
            const plan = await readManagedPlan(cwd, name);
            if (!plan?.attrs.planId) throw new Error("Create the Plan with plan_written contextMarkdown first.");
            if (mode === "write")
                throw new Error("Re-read the Plan and use exact-text edit to preserve concurrent changes.");
            const document = await readManagedDocument(plan.attrs.planId, resource, cwd);
            if (mode === "prepare-edit" && !document.writable) throw new Error("This Plan document cannot be edited.");
            if (mode === "read" || mode === "prepare-edit")
                return {
                    message: "Read Plan document.",
                    content: document.body,
                    document: { planId: document.planId, resource, expectedRevision: document.revision },
                };
            if (command.oldText === undefined || command.newText === undefined)
                throw new Error("Plan edit requires path, oldText, and newText.");
            const edited = exactEdit(document.body, command.oldText, command.newText, path);
            if (/^\ufeff?---\s*\r?\n/.test(edited))
                throw new Error("Live Plan documents must not contain YAML front matter.");
            await saveManagedDocument(plan.attrs.planId, resource, document.revision, edited);
            return { message: `Updated ${resource}.` };
        }
        if (isCanonicalPlanMarkdownPath(cwd, path))
            throw new Error(
                "Repository Plan documents are import sources or delivery copies. Create canonical Plans with plan_written contextMarkdown.",
            );
        await guardProjectStorage();
        return;
    }
    const store = inspectLocalHomeStore(cwd);
    const checkoutDocument = isCanonicalPlanMarkdownPath(cwd, path);
    if (store.kind === "empty" && checkoutDocument)
        throw new Error(
            "Create a canonical Plan with plan_written contextMarkdown; checkout Plan documents are import sources only.",
        );
    const absolute = isAbsolute(path) ? path : join(cwd, path);
    if (store.kind === "local") {
        const root = await canonicalFileTarget(
            join(store.identity.executionAccountHome, ".wld", "projects", store.identity.projectId, "plans"),
        );
        const rel = relative(root, absolute).replaceAll("\\", "/");
        if (rel && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)) {
            const resource = rel.split("/").at(-1)!;
            if (!["context.md", "validation.md", "manual-qa.md", "integration-report.md"].includes(resource))
                throw new Error("Core owns Plan metadata. Edit an exposed Markdown document instead.");
            const name = rel.slice(0, -(resource.length + 1));
            const plan = await readPlanPackage(store.identity, { name });
            if (plan.kind !== "loaded") throw new Error("Create the Plan with plan_written contextMarkdown first.");
            if (mode === "write")
                throw new Error("Re-read the Plan and use exact-text edit to preserve concurrent changes.");
            const document = plan.documents.find((entry) => entry.name === resource);
            if (!document) throw new Error("Plan document not found.");
            if (mode === "read" || mode === "prepare-edit")
                return {
                    message: "Read Plan document.",
                    content: new TextDecoder().decode(document.bytes),
                    document: {
                        planId: plan.metadata.planId,
                        resource,
                        expectedRevision: packageWorkflowRevision(plan),
                    },
                };
            if (command.oldText === undefined || command.newText === undefined)
                throw new Error("Plan edit requires path, oldText, and newText.");
            const edited = exactEdit(new TextDecoder().decode(document.bytes), command.oldText, command.newText, path);
            if (/^\ufeff?---\s*\r?\n/.test(edited))
                throw new Error("Live Plan documents must not contain YAML front matter.");
            await withPackageProject(cwd, store.identity, () =>
                savePlanDocument(plan.metadata.planId, resource, packageWorkflowRevision(plan), edited),
            );
            return { message: `Updated ${resource}.` };
        }
        if (checkoutDocument)
            throw new Error(
                "Repository Plan documents are import sources or delivery copies. Create canonical Plans with plan_written contextMarkdown.",
            );
    }
    await guardProjectStorage();
    if (!checkoutDocument) return;
    const planName = relative(cwd, absolute).replaceAll("\\", "/").slice("docs/plans/".length, -3);
    if (mode === "write") {
        if (command.content === undefined) throw new Error("Plan creation requires string content.");
        await withPlanCatalogLock(cwd, () =>
            withPlanLock(cwd, planName, async () => {
                try {
                    await stat(absolute);
                    throw new Error(
                        `Refusing to overwrite an existing Plan: ${path}. Re-read it and use exact-text edit.`,
                    );
                } catch (error) {
                    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
                }
                await mkdir(dirname(absolute), { recursive: true });
                await atomicWriteTextFileIfAbsent(absolute, command.content!);
            }),
        );
        return { message: `Successfully created Plan ${path}.` };
    }
    const current = await readFile(absolute, "utf8");
    if (mode === "read" || mode === "prepare-edit") return { message: "Read Plan document.", content: current };
    if (command.oldText === undefined || command.newText === undefined)
        throw new Error("Plan edit requires path, oldText, and newText.");
    const expectedRevision = await getPlanRevisionForText(current);
    const next = exactEdit(current, command.oldText, command.newText, path);
    await writePlanMarkdownWithRevisionLocked(cwd, planName, absolute, next, expectedRevision);
    return { message: `Successfully edited Plan ${path}.` };
}
