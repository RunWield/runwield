import { recoverWindowsRename } from "./native-file-replace-windows.ts";
import { rename as fsRename } from "node:fs/promises";
import { mkdir as fsMkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { loadPlan } from "../plan-store.js";

export const EPIC_MANUAL_QA_FILE_NAME = "manual-qa.md";
/** The latest failing Epic integration gate report; a repair child is planned from it. */
export const EPIC_INTEGRATION_REPORT_FILE_NAME = "integration-report.md";
export const EPIC_ARTIFACT_FILE_NAMES = Object.freeze([EPIC_MANUAL_QA_FILE_NAME, EPIC_INTEGRATION_REPORT_FILE_NAME]);
const EPIC_ARTIFACT_PLAN_SEGMENTS = new Set(EPIC_ARTIFACT_FILE_NAMES.map((fileName) => fileName.replace(/\.md$/, "")));

export type AppendEpicManualQaSectionArgs = {
    projectRoot: string;
    epicPlanName: string;
    childPlanName: string;
    childHeading: string;
    checklistMarkdown: string;
};

export type AppendEpicManualQaSectionResult = {
    status: "recorded" | "already_present";
    relativePath: string;
};

export type MoveEpicArtifactResult = {
    fileName: string;
    fromPath: string;
    toPath: string;
    relativePath: string;
};

function splitPlanName(planName: string): string[] {
    return String(planName || "")
        .split("/")
        .map((segment) => segment.trim())
        .filter(Boolean);
}

function assertSafePlanName(planName: string, label: string): string[] {
    const segments = splitPlanName(planName);
    if (segments.length === 0) throw new Error(`${label} is required.`);
    for (const segment of segments) {
        if (segment === "." || segment === ".." || segment.includes("\\")) {
            throw new Error(`${label} contains an unsafe path segment: ${planName}`);
        }
    }
    return segments;
}

function projectRelativePath(projectRoot: string, path: string): string {
    return relative(projectRoot, path).replaceAll("\\", "/");
}

export function isEpicArtifactPlanName(planName: string): boolean {
    const segments = splitPlanName(planName.replace(/\.md$/i, ""));
    return segments.length === 2 && EPIC_ARTIFACT_PLAN_SEGMENTS.has(segments[1]);
}

export function isEpicArtifactPlanPath(path: string): boolean {
    const normalized = path.replaceAll("\\", "/");
    const parts = normalized.split("/");
    const docsIndex = parts.lastIndexOf("docs");
    if (docsIndex < 0 || parts[docsIndex + 1] !== "plans") return false;
    const rest = parts.slice(docsIndex + 2);
    return rest.length === 2 && EPIC_ARTIFACT_FILE_NAMES.includes(rest[1]);
}

export function assertNotReservedEpicArtifactPlanName(planName: string): void {
    if (!isEpicArtifactPlanName(planName)) return;
    throw new Error(`${planName} is reserved for an Epic Artifact. Choose a different child Plan name and call again.`);
}

export function getEpicArtifactPath(projectRoot: string, epicPlanName: string, fileName: string): string {
    const segments = assertSafePlanName(epicPlanName, "Epic Plan name");
    if (segments.length !== 1) throw new Error(`Epic Plan name must be top-level: ${epicPlanName}`);
    if (!EPIC_ARTIFACT_FILE_NAMES.includes(fileName)) throw new Error(`Unknown Epic Artifact: ${fileName}`);
    return join(projectRoot, "docs", "plans", segments[0], fileName);
}

function markerChild(childPlanName: string): string {
    return childPlanName.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function sectionStartMarker(childPlanName: string): string {
    return `<!-- runwield:manual-qa:start child="${markerChild(childPlanName)}" -->`;
}

export async function findEpicManualQaSection(
    projectRoot: string,
    epicPlanName: string,
    childPlanName: string,
): Promise<{ exists: boolean; relativePath: string }> {
    const path = getEpicArtifactPath(projectRoot, epicPlanName, EPIC_MANUAL_QA_FILE_NAME);
    const existing = await readTextIfExists(path);
    return {
        exists: Boolean(existing?.includes(sectionStartMarker(childPlanName))),
        relativePath: projectRelativePath(projectRoot, path),
    };
}

function sectionEndMarker(childPlanName: string): string {
    return `<!-- runwield:manual-qa:end child="${markerChild(childPlanName)}" -->`;
}

function validateChecklistMarkdown(childPlanName: string, checklistMarkdown: string): string {
    const trimmed = String(checklistMarkdown || "").trim();
    const lines = trimmed.split(/\r?\n/);
    const heading = lines[0]?.trim() || "";
    if (heading !== `Manual verification steps for ${childPlanName}`) {
        throw new Error(`Manual QA checklist must start with "Manual verification steps for ${childPlanName}".`);
    }
    const checkboxes = lines.filter((line) => /^- \[ \] \S/.test(line.trim()));
    if (checkboxes.length < 1 || checkboxes.length > 6) {
        throw new Error("Manual QA checklist must contain 1 to 6 unchecked checklist items.");
    }
    const checked = lines.find((line) => /^- \[[xX]\]/.test(line.trim()));
    if (checked) throw new Error("Manual QA checklist must not contain checked items when generated.");
    return trimmed;
}

async function readTextIfExists(path: string): Promise<string | null> {
    try {
        return await fsReadFile(path, "utf8");
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
    }
}

async function writeAtomic(path: string, text: string): Promise<void> {
    await fsMkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${crypto.randomUUID()}.tmp`;
    await fsWriteFile(tmp, text);
    try {
        await fsRename(tmp, path);
    } catch (error) {
        if (!(error instanceof Error && recoverWindowsRename(error, tmp, path))) throw error;
    }
}

export async function appendEpicManualQaSection(
    args: AppendEpicManualQaSectionArgs,
): Promise<AppendEpicManualQaSectionResult> {
    const epicSegments = assertSafePlanName(args.epicPlanName, "Epic Plan name");
    const childSegments = assertSafePlanName(args.childPlanName, "Child Plan name");
    if (epicSegments.length !== 1) throw new Error(`Epic Plan name must be top-level: ${args.epicPlanName}`);
    if (childSegments.length !== 2 || childSegments[0] !== epicSegments[0]) {
        throw new Error(`Child Plan ${args.childPlanName} must belong to Epic ${args.epicPlanName}.`);
    }

    const child = await loadPlan(args.projectRoot, args.childPlanName);
    if (!child) throw new Error(`Child Plan not found: ${args.childPlanName}`);
    if (child.attrs.parentPlan !== args.epicPlanName) {
        throw new Error(`Child Plan ${args.childPlanName} is not linked to Epic ${args.epicPlanName}.`);
    }
    const epic = await loadPlan(args.projectRoot, args.epicPlanName);
    if (!epic) throw new Error(`Epic Plan not found: ${args.epicPlanName}`);
    if (epic.attrs.classification !== "PROJECT") throw new Error(`${args.epicPlanName} is not an Epic Plan.`);

    const checklist = validateChecklistMarkdown(args.childPlanName, args.checklistMarkdown);
    const path = getEpicArtifactPath(args.projectRoot, args.epicPlanName, EPIC_MANUAL_QA_FILE_NAME);
    const relativePath = projectRelativePath(args.projectRoot, path);
    const existing = await readTextIfExists(path);
    const startMarker = sectionStartMarker(args.childPlanName);
    if (existing?.includes(startMarker)) return { status: "already_present", relativePath };
    if (existing && existing.includes("runwield:manual-qa:start") && !existing.includes("runwield:manual-qa:end")) {
        throw new Error(`Manual QA artifact appears malformed: ${relativePath}`);
    }

    const header =
        `# Manual QA for ${args.epicPlanName}\n\n` +
        "This checklist is advisory. It does not change RunWield verification status.\n";
    const section = [
        sectionStartMarker(args.childPlanName),
        `## ${args.childHeading.trim() || args.childPlanName}`,
        "",
        checklist,
        sectionEndMarker(args.childPlanName),
    ].join("\n");
    const base = existing === null ? header : existing.trimEnd();
    await writeAtomic(path, `${base}\n\n${section}\n`);
    return { status: "recorded", relativePath };
}

export function getActiveEpicArtifactPaths(projectRoot: string, epicPlanName: string): string[] {
    return EPIC_ARTIFACT_FILE_NAMES.map((fileName) => getEpicArtifactPath(projectRoot, epicPlanName, fileName));
}

export function getArchivedEpicArtifactPath(projectRoot: string, epicPlanName: string, fileName: string): string {
    const segments = assertSafePlanName(epicPlanName, "Epic Plan name");
    if (segments.length !== 1) throw new Error(`Epic Plan name must be top-level: ${epicPlanName}`);
    if (!EPIC_ARTIFACT_FILE_NAMES.includes(fileName)) throw new Error(`Unknown Epic Artifact: ${fileName}`);
    return join(projectRoot, "docs", "plans", "archived", segments[0], fileName);
}

async function moveFileIfPresent(
    projectRoot: string,
    fileName: string,
    fromPath: string,
    toPath: string,
): Promise<MoveEpicArtifactResult | null> {
    const text = await readTextIfExists(fromPath);
    if (text === null) return null;
    if ((await readTextIfExists(toPath)) !== null) {
        throw new Error(`Epic Artifact already exists: ${projectRelativePath(projectRoot, toPath)}`);
    }
    await fsMkdir(dirname(toPath), { recursive: true });
    await fsRename(fromPath, toPath);
    return { fileName, fromPath, toPath, relativePath: projectRelativePath(projectRoot, toPath) };
}

export async function moveEpicArtifactsToArchive(
    projectRoot: string,
    epicPlanName: string,
): Promise<MoveEpicArtifactResult[]> {
    const moved: MoveEpicArtifactResult[] = [];
    try {
        for (const fileName of EPIC_ARTIFACT_FILE_NAMES) {
            const result = await moveFileIfPresent(
                projectRoot,
                fileName,
                getEpicArtifactPath(projectRoot, epicPlanName, fileName),
                getArchivedEpicArtifactPath(projectRoot, epicPlanName, fileName),
            );
            if (result) moved.push(result);
        }
        return moved;
    } catch (error) {
        for (const item of moved.toReversed()) await fsRename(item.toPath, item.fromPath).catch(() => {});
        throw error;
    }
}

export async function moveEpicArtifactsFromArchive(
    projectRoot: string,
    epicPlanName: string,
): Promise<MoveEpicArtifactResult[]> {
    const moved: MoveEpicArtifactResult[] = [];
    try {
        for (const fileName of EPIC_ARTIFACT_FILE_NAMES) {
            const result = await moveFileIfPresent(
                projectRoot,
                fileName,
                getArchivedEpicArtifactPath(projectRoot, epicPlanName, fileName),
                getEpicArtifactPath(projectRoot, epicPlanName, fileName),
            );
            if (result) moved.push(result);
        }
        return moved;
    } catch (error) {
        for (const item of moved.toReversed()) await fsRename(item.toPath, item.fromPath).catch(() => {});
        throw error;
    }
}
