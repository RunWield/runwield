import {
    EPIC_MANUAL_QA_FILE_NAME,
    EPIC_INTEGRATION_REPORT_FILE_NAME,
    EPIC_ARTIFACT_FILE_NAMES,
    splitPlanName,
} from "../plan-format/artifacts.ts";
export {
    EPIC_MANUAL_QA_FILE_NAME,
    EPIC_INTEGRATION_REPORT_FILE_NAME,
    EPIC_ARTIFACT_FILE_NAMES,
    splitPlanName,
    isEpicArtifactPlanName,
    isEpicArtifactPlanPath,
    assertNotReservedEpicArtifactPlanName,
} from "../plan-format/artifacts.ts";
import { currentPackageSelection, selectedPackage, saveGeneratedManualQaArtifact } from "./workflows.ts";
import { savePlanPackageDocument } from "./packages.ts";
import { recoverWindowsRename } from "../shared/native-file-replace-windows.ts";
import { rename as fsRename } from "node:fs/promises";
import { mkdir as fsMkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { loadPlan } from "../plan-store.js";

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

export function getEpicArtifactPath(projectRoot: string, epicPlanName: string, fileName: string): string {
    const segments = assertSafePlanName(epicPlanName, "Epic Plan name");
    if (segments.length !== 1) throw new Error(`Epic Plan name must be top-level: ${epicPlanName}`);
    if (!EPIC_ARTIFACT_FILE_NAMES.includes(fileName)) throw new Error(`Unknown Epic Artifact: ${fileName}`);
    return join(projectRoot, "docs", "plans", segments[0], fileName);
}

/** Explicit package workflows resolve artifacts beside their ID-selected parent documents. */
export async function resolveEpicArtifactPath(
    projectRoot: string,
    epicPlanName: string,
    fileName: string,
): Promise<string> {
    if (!currentPackageSelection()) return getEpicArtifactPath(projectRoot, epicPlanName, fileName);
    if (!EPIC_ARTIFACT_FILE_NAMES.includes(fileName)) throw new Error(`Unknown Epic Artifact: ${fileName}`);
    return join((await selectedPackage(epicPlanName)).path, fileName);
}

/** Save through the same package document owner used by editor writes. */
export async function saveEpicArtifact(
    projectRoot: string,
    epicPlanName: string,
    fileName: string,
    text: string,
): Promise<void> {
    const path = await resolveEpicArtifactPath(projectRoot, epicPlanName, fileName);
    const selection = currentPackageSelection();
    if (selection) {
        const plan = await selectedPackage(epicPlanName);
        const document = plan.documents.find((doc) => doc.name === fileName);
        if (fileName !== EPIC_INTEGRATION_REPORT_FILE_NAME && fileName !== EPIC_MANUAL_QA_FILE_NAME)
            throw new Error("Unsupported Epic artifact.");
        await savePlanPackageDocument(selection.identity, plan.metadata.planId, fileName, document?.hash ?? null, text);
    } else await writeAtomic(path, text);
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
    const path = await resolveEpicArtifactPath(projectRoot, epicPlanName, EPIC_MANUAL_QA_FILE_NAME);
    const existing = await readTextIfExists(path);
    return {
        exists: Boolean(
            existing?.includes(
                sectionStartMarker(
                    currentPackageSelection() ? (await selectedPackage(childPlanName)).metadata.planId : childPlanName,
                ),
            ),
        ),
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
    if (!currentPackageSelection() && epicSegments.length !== 1)
        throw new Error(`Epic Plan name must be top-level: ${args.epicPlanName}`);
    if (!currentPackageSelection() && (childSegments.length !== 2 || childSegments[0] !== epicSegments[0])) {
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
    const packagePlan = currentPackageSelection() ? await selectedPackage(args.epicPlanName) : null;
    const packageDoc = packagePlan?.documents.find((doc) => doc.name === EPIC_MANUAL_QA_FILE_NAME);
    const path = await resolveEpicArtifactPath(args.projectRoot, args.epicPlanName, EPIC_MANUAL_QA_FILE_NAME);
    const relativePath = projectRelativePath(args.projectRoot, path);
    const existing = packagePlan
        ? packageDoc
            ? new TextDecoder().decode(packageDoc.bytes)
            : null
        : await readTextIfExists(path);
    const markerIdentity = packagePlan ? child.attrs.planId! : args.childPlanName;
    const startMarker = sectionStartMarker(markerIdentity);
    if (existing?.includes(startMarker)) return { status: "already_present", relativePath };
    if (existing && existing.includes("runwield:manual-qa:start") && !existing.includes("runwield:manual-qa:end")) {
        throw new Error(`Manual QA artifact appears malformed: ${relativePath}`);
    }

    const header =
        `# Manual QA for ${args.epicPlanName}\n\n` +
        "This checklist is advisory. It does not change RunWield verification status.\n";
    const section = [
        sectionStartMarker(markerIdentity),
        `## ${args.childHeading.trim() || args.childPlanName}`,
        "",
        checklist,
        sectionEndMarker(markerIdentity),
    ].join("\n");
    const base = existing === null ? header : existing.trimEnd();
    if (packagePlan)
        await saveGeneratedManualQaArtifact(
            args.childPlanName,
            args.epicPlanName,
            packageDoc?.hash ?? null,
            `${base}\n\n${section}\n`,
        );
    else await writeAtomic(path, `${base}\n\n${section}\n`);
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
    if (currentPackageSelection()) return [];
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
    if (currentPackageSelection()) return [];
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
