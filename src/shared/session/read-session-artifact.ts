import { readFile as fsReadFile, realpath as fsRealpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { SessionArtifactReference } from "./file-session-store-types.ts";

/** Load a registered artifact without following links outside its Project. */
export async function readSessionArtifact(root: string, artifact: SessionArtifactReference) {
    const canonicalRoot = await fsRealpath(root);
    const absolutePath = await fsRealpath(resolve(canonicalRoot, artifact.path));
    const artifactRelativePath = relative(canonicalRoot, absolutePath);
    if (!artifactRelativePath || artifactRelativePath === ".." || artifactRelativePath.startsWith(`..${sep}`)) {
        throw new Error("Session artifact is outside its Project.");
    }
    return {
        ...artifact,
        markdown: await fsReadFile(absolutePath, "utf8"),
        imageBaseDir: dirname(absolutePath),
    };
}
