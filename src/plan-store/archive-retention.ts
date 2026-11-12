import { opendir as fsOpendir, stat as fsStat } from "node:fs/promises";
import { join } from "node:path";
import { listArchivedPlans } from "../plan-store.js";
import { getArchivedEpicArtifactPath } from "./artifacts.ts";
import { EPIC_ARTIFACT_FILE_NAMES } from "../plan-format/artifacts.ts";
import { readLocalHomeStore } from "./access.ts";
import { currentPackageProject } from "./workflows.ts";
export type ArchivedPlanUnit = {
    name: string;
    planId: string | undefined;
    archivedAt: string | null | undefined;
    paths: string[];
};

/** Home history is retained; only explicitly retained legacy archives participate in pruning. */
export async function collectArchivedPlanUnits(cwd: string): Promise<ArchivedPlanUnit[]> {
    return await readLocalHomeStore(
        cwd,
        () => (currentPackageProject() ? Promise.resolve([]) : collectLegacyArchivedPlanUnits(cwd)),
        () => Promise.resolve([]),
    );
}
async function pathExists(path: string): Promise<boolean> {
    try {
        await fsStat(path);
        return true;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
    }
}

function projectRelativePath(projectRoot: string, path: string): string {
    return path.startsWith(projectRoot) ? path.slice(projectRoot.length + 1).replaceAll("\\", "/") : path;
}

async function collectLegacyArchivedPlanUnits(cwd: string): Promise<ArchivedPlanUnit[]> {
    const archivedPlans = await listArchivedPlans(cwd);
    const topLevelPlans = new Map(
        archivedPlans.filter((plan) => !plan.name.includes("/")).map((plan) => [plan.name, plan]),
    );
    const names = new Set<string>(topLevelPlans.keys());
    const archivedDir = join(cwd, "docs", "plans", "archived");
    try {
        for await (const entry of await fsOpendir(archivedDir)) {
            if (entry.isFile() && entry.name.endsWith(".md")) names.add(entry.name.slice(0, -3));
            if (entry.isDirectory()) names.add(entry.name);
        }
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
    }

    const units: ArchivedPlanUnit[] = [];
    for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
        const parent = topLevelPlans.get(name);
        const paths = new Set<string>();
        const parentPath = join(archivedDir, `${name}.md`);
        if (await pathExists(parentPath)) paths.add(projectRelativePath(cwd, parentPath));
        const childDir = join(archivedDir, name);
        try {
            for await (const entry of await fsOpendir(childDir)) {
                if (entry.isFile() && entry.name.endsWith(".md")) {
                    paths.add(projectRelativePath(cwd, join(childDir, entry.name)));
                }
            }
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        for (const artifactName of EPIC_ARTIFACT_FILE_NAMES) {
            const artifactPath = getArchivedEpicArtifactPath(cwd, name, artifactName);
            if (await pathExists(artifactPath)) paths.add(projectRelativePath(cwd, artifactPath));
        }
        units.push({
            name,
            planId: parent?.planId,
            archivedAt: parent?.attrs.archivedAt,
            paths: [...paths].sort((a, b) => a.localeCompare(b)),
        });
    }
    return units;
}
