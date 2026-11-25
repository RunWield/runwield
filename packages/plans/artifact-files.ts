import { mkdir, readFile, rename, rm, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { assertContainedPath, recoverWindowsRename } from "@runwield/resources/fs";
import {
    EPIC_ARTIFACT_FILE_NAMES,
    isEpicArtifactName,
    splitPlanName,
    type EpicArtifactName,
} from "./format/artifacts.ts";
import { PLANS_DIR_NAME } from "./classification.ts";

export { hasManualQaSection, prepareManualQaSection } from "./manual-qa.ts";

export type MoveEpicArtifactResult = {
    fileName: string;
    fromPath: string;
    toPath: string;
    relativePath: string;
};

/** Resolve the original checkout layout used by retained executions and archives. */
export function checkoutEpicArtifactPath(root: string, epicName: string, name: string, archived = false): string {
    const segments = splitPlanName(epicName);
    if (segments.length !== 1) throw new Error(`Epic Plan name must be top-level: ${epicName}`);
    if (segments[0] === "." || segments[0] === ".." || segments[0].includes("\\"))
        throw new Error(`Epic Plan name contains an unsafe path segment: ${epicName}`);
    if (!isEpicArtifactName(name)) throw new Error(`Unknown Epic Artifact: ${name}`);
    const docs = join(root, PLANS_DIR_NAME);
    return join(archived ? join(docs, "archived") : docs, segments[0], name);
}

async function readTextIfExists(path: string): Promise<string | null> {
    try {
        return await readFile(path, "utf8");
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
    }
}

export async function readCheckoutEpicArtifact(
    root: string,
    epicName: string,
    name: EpicArtifactName,
    archived = false,
) {
    const base = await realpath(root);
    const path = checkoutEpicArtifactPath(base, epicName, name, archived);
    try {
        const file = await realpath(path);
        const within = relative(base, file);
        if (!within || within === ".." || within.startsWith(`..${sep}`) || resolve(base, within) !== file)
            throw new Error("Epic artifact must remain inside its admitted Project.");
        return await readTextIfExists(file);
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
    }
}

export async function writeCheckoutEpicArtifact(
    root: string,
    epicName: string,
    name: EpicArtifactName,
    body: string,
): Promise<void> {
    const base = await realpath(root);
    const path = checkoutEpicArtifactPath(base, epicName, name);
    await assertContainedPath(base, path);
    const tmp = `${path}.${crypto.randomUUID()}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmp, body);
    try {
        await rename(tmp, path);
    } catch (error) {
        if (!(error instanceof Error && recoverWindowsRename(error, tmp, path))) {
            await rm(tmp, { force: true }).catch(() => {});
            throw error;
        }
    }
}

export async function moveCheckoutEpicArtifacts(
    root: string,
    epicName: string,
    archive: boolean,
): Promise<MoveEpicArtifactResult[]> {
    const base = await realpath(root);
    const moved: MoveEpicArtifactResult[] = [];
    try {
        for (const name of EPIC_ARTIFACT_FILE_NAMES) {
            const fromPath = checkoutEpicArtifactPath(base, epicName, name, !archive);
            await assertContainedPath(base, fromPath);
            if ((await readTextIfExists(fromPath)) === null) continue;
            const toPath = checkoutEpicArtifactPath(base, epicName, name, archive);
            await assertContainedPath(base, toPath);
            const relativePath = relative(base, toPath).replaceAll("\\", "/");
            if ((await readTextIfExists(toPath)) !== null)
                throw new Error(`Epic Artifact already exists: ${relativePath}`);
            await mkdir(dirname(toPath), { recursive: true });
            await rename(fromPath, toPath);
            moved.push({ fileName: name, fromPath, toPath, relativePath });
        }
        return moved;
    } catch (error) {
        for (const item of moved.toReversed()) await rename(item.toPath, item.fromPath).catch(() => {});
        throw error;
    }
}
