import { basename, dirname, isAbsolute, join, normalize } from "@std/path";
import { denoHelperBinaryExec, type HelperBinaryExec } from "../extensions/helper-binary-exec.ts";

import { remoteMemoryCollection } from "./remote/memory-bridge.ts";
import { remotePersonalResourcesActive } from "./remote/personal-resources.ts";

export interface MemoryCollectionContext {
    cwd: string;
    boundCollection?: string;
    exec?: HelperBinaryExec;
}

function localCollectionName(name: string): string {
    return name === "global" ? "default" : (name || "default");
}

/** Choose one project collection for Memory tools, core injection, and maintenance. */
export async function resolveMemoryCollection(context: MemoryCollectionContext): Promise<string> {
    const bound = context.boundCollection ?? remoteMemoryCollection();
    if (bound) return bound;
    if (remotePersonalResourcesActive()) throw new Error("Remote Memory collection is not bound");
    const { cwd } = context;
    const fallback = localCollectionName(basename(cwd));
    try {
        const exec = context.exec ?? denoHelperBinaryExec;
        const result = await exec("git", ["rev-parse", "--git-common-dir"], { cwd });
        if (result.code !== 0) return fallback;
        const commonDir = result.stdout.trim().split(/\r?\n/).at(-1) || "";
        if (!commonDir) return fallback;
        const absoluteCommonDir = normalize(isAbsolute(commonDir) ? commonDir : join(cwd, commonDir));
        if (basename(absoluteCommonDir) !== ".git") return fallback;
        return localCollectionName(basename(dirname(absoluteCommonDir)));
    } catch {
        return fallback;
    }
}
