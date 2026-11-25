// @ts-nocheck: Callback parameters and result shapes are implicit.
import { readFile as fsReadFile, realpath as fsRealpath } from "node:fs/promises";
/** @module ui/workspace/server/project-artifacts */

import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { registeredWorkRecords, workRecordsForCheckout } from "../../../plan-store/index.ts";
import type { ProjectRegistry } from "@runwield/projects";
import { isCurrentWorkRecord, workRecordNotices } from "../../../shared/work-records/list.ts";

export const PROJECT_ARTIFACT_TYPES = new Set(["work-record", "prd", "adr", "design-system", "domain-language"]);

/** @param {string} markdown @param {string} fallback */
function markdownTitle(markdown, fallback) {
    return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || fallback;
}

/** @param {string} root @param {string} path */
export async function assertContainedProjectPath(root, path) {
    const canonicalRoot = await fsRealpath(root);
    const canonicalPath = await fsRealpath(path);
    const contained = relative(canonicalRoot, canonicalPath).replaceAll("\\", "/");
    if (isAbsolute(contained) || contained === ".." || contained.startsWith("../")) {
        throw new Error("Artifact identity leaves the Project.");
    }
    return canonicalPath;
}

export { assertAuthorizedPlanPath, assertReadablePlanResource } from "../../../plan-store/index.ts";

/** @param {string} root @param {string} relativePath */
export async function readSafeProjectMarkdown(root, relativePath) {
    if (
        !relativePath ||
        relativePath.startsWith("/") ||
        relativePath.split("/").includes("..") ||
        !relativePath.endsWith(".md")
    ) {
        throw new Error("Artifact identity is invalid.");
    }
    const canonicalPath = await assertContainedProjectPath(root, join(root, relativePath));
    return await fsReadFile(canonicalPath, "utf8");
}

/** @param {string} root */
export async function domainLanguagePaths(root) {
    const mapRelativePath = "docs/domain-language-map.md";
    const mapPath = join(root, mapRelativePath);
    try {
        const map = await readSafeProjectMarkdown(root, mapRelativePath);
        const paths = [];
        for (const match of map.matchAll(/\]\(([^)]+domain-language\.md)(?:#[^)]+)?\)/g)) {
            const target = match[1];
            const relativePath = relative(root, resolve(dirname(mapPath), target)).replaceAll("\\", "/");
            if (relativePath === mapRelativePath || relativePath.startsWith("../")) continue;
            paths.push(relativePath);
        }
        return [...new Set(paths)];
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        try {
            await readSafeProjectMarkdown(root, "docs/domain-language.md");
            return ["docs/domain-language.md"];
        } catch (nested) {
            if (nested instanceof Error && "code" in nested && nested.code === "ENOENT") return [];
            throw nested;
        }
    }
}

/** @param {string} type @param {string} sourceId */
function acceptedDocumentationPath(type, sourceId) {
    if (type === "prd" && /^docs\/prd\/(?:[^/]+\/)*[^/]+\.md$/.test(sourceId)) return true;
    if (type === "adr" && /^docs\/adr\/(?:[^/]+\/)*[^/]+\.md$/.test(sourceId)) return true;
    if (type === "design-system" && sourceId === "docs/design-system.md") return true;
    return false;
}

export async function readProjectArtifact(
    root: string,
    type: string,
    sourceId: string,
    registration?: { projectId: string; registry: ProjectRegistry },
) {
    if (!PROJECT_ARTIFACT_TYPES.has(type)) throw new Error("Artifact type is not supported.");
    if (type === "work-record") {
        const records = registration
            ? registeredWorkRecords(registration.projectId, registration.registry)
            : workRecordsForCheckout(root);
        const record = await records.read(sourceId);
        if (!record || !isCurrentWorkRecord(record)) throw new Error("Work Record not found.");
        const sourceLinks = record.attrs.provenance?.sourcePlans || [];
        return {
            kind: "work-record",
            title: record.title,
            markdown: record.markdown,
            path: record.relativePath,
            sourceLinks,
            notices: [
                `Completion confidence: ${record.attrs.completionMode.replaceAll("_", " ")}.`,
                ...workRecordNotices(record),
            ],
        };
    }
    if (type === "domain-language") {
        if (!(await domainLanguagePaths(root)).includes(sourceId)) {
            throw new Error("Domain Language document is not in the current map.");
        }
    } else if (!acceptedDocumentationPath(type, sourceId)) {
        throw new Error("Artifact identity is not accepted for this type.");
    }
    const markdown = await readSafeProjectMarkdown(root, sourceId);
    const labels = {
        prd: "PRD",
        adr: "ADR",
        "design-system": "Design System",
        "domain-language": "Domain Language",
    };
    return {
        kind: type,
        title: markdownTitle(markdown, labels[type] || "Document"),
        markdown,
        path: sourceId,
        notices: [],
    };
}
