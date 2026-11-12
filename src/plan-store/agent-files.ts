import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { inspectLocalHomeStore } from "./access.ts";
import { readPlanPackage } from "./packages.ts";
import { withPackageProject, packageWorkflowRevision } from "./workflows.ts";
import { savePlanDocument } from "./documents.ts";
import {
    getPlanRevisionForText,
    withPlanCatalogLock,
    withPlanLock,
    writePlanMarkdownWithRevisionLocked,
} from "../plan-store.js";
import { atomicWriteTextFileIfAbsent } from "../shared/atomic-text-file.ts";

export interface PlanFileCommand {
    path: string;
    mode: "write" | "edit" | "read";
    content?: string;
    oldText?: string;
    newText?: string;
}

export interface PlanFileResult {
    message: string;
    content?: string;
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

/** Intercept owned Plan files; undefined means the caller's ordinary file tool owns this path. */
export async function operatePlanFile(cwd: string, command: PlanFileCommand): Promise<PlanFileResult | undefined> {
    const { path, mode } = command;
    if (!path) return;
    const store = inspectLocalHomeStore(cwd);
    const checkoutDocument = isCanonicalPlanMarkdownPath(cwd, path);
    if (store.kind === "empty" && checkoutDocument)
        throw new Error(
            "Create a canonical Plan with plan_written contextMarkdown; checkout Plan documents are import sources only.",
        );
    const absolute = isAbsolute(path) ? path : join(cwd, path);
    if (store.kind === "local") {
        const root = join(store.identity.executionAccountHome, ".wld", "projects", store.identity.projectId, "plans");
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
            if (mode === "read")
                return { message: "Read Plan document.", content: new TextDecoder().decode(document.bytes) };
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
    if (mode === "read") return { message: "Read Plan document.", content: current };
    if (command.oldText === undefined || command.newText === undefined)
        throw new Error("Plan edit requires path, oldText, and newText.");
    const expectedRevision = await getPlanRevisionForText(current);
    const next = exactEdit(current, command.oldText, command.newText, path);
    await writePlanMarkdownWithRevisionLocked(cwd, planName, absolute, next, expectedRevision);
    return { message: `Successfully edited Plan ${path}.` };
}
