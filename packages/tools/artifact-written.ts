import type { Static } from "typebox";
import type { artifactWrittenDefinition } from "./definitions/artifact-written.ts";

type ArtifactWrittenParameters = Static<typeof artifactWrittenDefinition.parameters>;
export type ArtifactWrittenKind = ArtifactWrittenParameters["kind"];

const REQUIRED_PARENT_BY_KIND: Partial<Record<ArtifactWrittenKind, string>> = {
    plan: "docs/plans/",
    prd: "docs/prd/",
    adr: "docs/adr/",
    "work-record": "docs/work-records/",
};

/** Check the kind-specific directory after the caller resolves the real project-relative path. */
export function assertArtifactKindPath(kind: ArtifactWrittenKind, path: string): void {
    const requiredParent = REQUIRED_PARENT_BY_KIND[kind];
    if (requiredParent && !path.startsWith(requiredParent)) {
        throw new Error(`${kind} artifacts must be stored under ${requiredParent}`);
    }
}

/** Use the supplied title, the first top-level Markdown heading, or the artifact filename. */
export function resolveArtifactTitle(path: string, markdown: string, title?: string): string {
    return (
        title?.trim() ||
        markdown
            .split(/\r?\n/)
            .map((line) => line.match(/^#\s+(.+?)\s*$/)?.[1]?.trim())
            .find(Boolean) ||
        path.split("/").at(-1)?.replace(/\.md$/i, "").replaceAll("-", " ") ||
        "Artifact"
    );
}
