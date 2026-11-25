import { readFile as fsReadFile, realpath as fsRealpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
    isPlanSessionArtifactReference,
    readPlanSessionArtifact,
    type RegisteredPlanSessionProject,
} from "../../plan-store/index.ts";
import type { SessionArtifactReference } from "./file-session-store-types.ts";

/** Load a registered artifact without following links outside its Project. */
export async function readSessionArtifact(
    root: string,
    artifact: SessionArtifactReference,
    registration?: RegisteredPlanSessionProject,
) {
    const { kind, path } = artifact;
    const planArtifact = kind === "plan" || kind === "epic-artifact";
    if (planArtifact && isPlanSessionArtifactReference(path, kind)) {
        const { markdown, imageBaseDir } = await readPlanSessionArtifact(root, path, kind, registration);
        return { ...artifact, markdown, imageBaseDir };
    }
    const canonicalRoot = await fsRealpath(root);
    const absolutePath = await fsRealpath(resolve(canonicalRoot, path));
    const artifactRelativePath = relative(canonicalRoot, absolutePath);
    if (
        !artifactRelativePath ||
        isAbsolute(artifactRelativePath) ||
        artifactRelativePath === ".." ||
        artifactRelativePath.startsWith(`..${sep}`)
    ) {
        throw new Error("Session artifact is outside its Project.");
    }
    if (planArtifact && isPlanSessionArtifactReference(artifactRelativePath, kind)) {
        const { markdown, imageBaseDir } = await readPlanSessionArtifact(
            root,
            artifactRelativePath,
            kind,
            registration,
        );
        return { ...artifact, markdown, imageBaseDir };
    }
    return {
        ...artifact,
        markdown: await fsReadFile(absolutePath, "utf8"),
        imageBaseDir: dirname(absolutePath),
    };
}
