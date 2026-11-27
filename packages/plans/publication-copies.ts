import { decodePackageMarkdown } from "./format.ts";
import {
    assertPublicationMetadataFields,
    type PackagePublicationReference,
} from "@runwield/project-runtime/publication-evidence";
import { PlanPackageError } from "./package-data.ts";

export {
    assertPackagePublicationReference,
    type ExecutionPublicationPolicy,
    type PackagePublicationReference,
} from "@runwield/project-runtime/publication-evidence";

export interface DeliveryCopy {
    readonly kind: "plan" | "work-record";
    readonly path: string;
    readonly text: string;
}
export interface ProjectPublicationCopies {
    /** Read frozen repository destinations and content for this Project's retained input. */
    read(reference: PackagePublicationReference): Promise<readonly DeliveryCopy[]>;
}

export interface PublicationCandidate {
    packageInput?: PackagePublicationReference;
    validatedCommit: string;
    targetBranch: string;
    attemptId: string;
    planId: string;
    artifactCommit?: string;
}

export interface PublicationCopyEvidence {
    artifactCommit?: string;
    planPaths: string[];
    copiesPrepared: true;
}

export type MaterializedPublicationCopies =
    { kind: "committed"; evidence: PublicationCopyEvidence } | { kind: "written"; paths: string[] };

function fail(kind: PlanPackageError["kind"], message: string): never {
    throw new PlanPackageError(kind, message);
}

export function assertDeliveryCopies(copies: DeliveryCopy[]): void {
    if (!Array.isArray(copies)) fail("malformed_metadata", "Invalid delivery copies.");
    const paths = new Set<string>();
    for (const copy of copies) {
        assertPublicationMetadataFields(JSON.parse(JSON.stringify(copy)), ["kind", "path", "text"]);
        if (
            typeof copy.text !== "string" ||
            typeof copy.path !== "string" ||
            !["plan", "work-record"].includes(copy.kind) ||
            !copy.path.startsWith(copy.kind === "plan" ? "docs/plans/" : "docs/work-records/") ||
            !copy.path.endsWith(".md") ||
            copy.path.includes("\\") ||
            copy.path
                .split("/")
                .some(
                    (part) =>
                        !part ||
                        part === "." ||
                        part === ".." ||
                        [...part].some((character) => character.charCodeAt(0) < 32),
                ) ||
            paths.has(copy.path)
        )
            fail("unsafe_path", "Unsafe or duplicate delivery copy destination.");
        if (decodePackageMarkdown(new TextEncoder().encode(copy.text)) !== copy.text)
            fail("malformed_metadata", "Delivery copy is not valid UTF-8 Markdown.");
        paths.add(copy.path);
    }
}

export function samePackagePublicationReference(
    left: PackagePublicationReference | undefined,
    right: PackagePublicationReference,
): boolean {
    return Boolean(
        left &&
        left.kind === right.kind &&
        left.projectId === right.projectId &&
        left.personalOwner === right.personalOwner &&
        left.repositoryId === right.repositoryId &&
        left.planId === right.planId &&
        left.attemptId === right.attemptId &&
        left.inputId === right.inputId &&
        left.digest === right.digest,
    );
}
