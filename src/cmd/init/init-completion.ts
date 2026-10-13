import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { join } from "node:path";
import { getCwd } from "../../constants.js";
import { isInitDone } from "./init-state.ts";

export const INIT_DOMAIN_LANGUAGE_PATH = "docs/domain-language.md";

export async function hasProjectInitArtifact(projectRoot = getCwd()): Promise<boolean> {
    try {
        const path = join(projectRoot, INIT_DOMAIN_LANGUAGE_PATH);
        const info = await fsStat(path);
        if (!info.isFile()) return false;
        return (await fsReadFile(path, "utf8")).trim().length > 0;
    } catch {
        return false;
    }
}

export async function isProjectInitComplete(projectRoot = getCwd()): Promise<boolean> {
    return await isInitDone(projectRoot) && await hasProjectInitArtifact(projectRoot);
}

export async function requireProjectInitArtifact(projectRoot = getCwd()): Promise<void> {
    if (await hasProjectInitArtifact(projectRoot)) return;
    throw new Error(
        `Init agent finished without creating ${INIT_DOMAIN_LANGUAGE_PATH}. ` +
            "Initialization was not marked complete; run /init to retry.",
    );
}
