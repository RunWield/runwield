import { decodePackageMarkdown } from "./format.ts";
import { isPlanId } from "./identity.ts";
import { PlanPackageError } from "./package-data.ts";

export interface ExecutionPublicationPolicy {
    plans: boolean;
    workRecords: boolean;
    autoGenerateRecords: boolean;
}
export interface DeliveryCopy {
    readonly kind: "plan" | "work-record";
    readonly path: string;
    readonly text: string;
}
/** The reference returned when Plans seals an attempt. Pass it back unchanged. */
export interface PackagePublicationReference {
    readonly kind: "package";
    readonly projectId: string;
    readonly personalOwner: string;
    readonly repositoryId: string;
    readonly planId: string;
    readonly attemptId: string;
    readonly inputId: string;
    readonly digest: string;
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

type PublicationFields = Record<string, string | number | boolean | null>;

function fail(kind: PlanPackageError["kind"], message: string): never {
    throw new PlanPackageError(kind, message);
}

function publicationFields(value: PublicationFields, allowed: string[]): PublicationFields {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).some((key) => !allowed.includes(key))
    )
        fail("malformed_metadata", "Invalid metadata fields.");
    return value;
}

const publicationReferenceFields = [
    "kind",
    "projectId",
    "personalOwner",
    "repositoryId",
    "planId",
    "attemptId",
    "inputId",
    "digest",
];
export function assertPackagePublicationReference(reference: PackagePublicationReference): PackagePublicationReference {
    const value = publicationFields(JSON.parse(JSON.stringify(reference)), publicationReferenceFields);
    if (
        value.kind !== "package" ||
        publicationReferenceFields.some((key) => typeof value[key] !== "string" || !value[key]) ||
        !/^[0-9a-f-]{36}$/.test(reference.inputId) ||
        !/^[0-9a-f]{64}$/.test(reference.digest)
    )
        fail("malformed_metadata", "Invalid package publication reference.");
    if (!isPlanId(reference.planId)) fail("malformed_metadata", "Invalid Plan ID.");
    return reference;
}

export function assertDeliveryCopies(copies: DeliveryCopy[]): void {
    if (!Array.isArray(copies)) fail("malformed_metadata", "Invalid delivery copies.");
    const paths = new Set<string>();
    for (const copy of copies) {
        publicationFields(JSON.parse(JSON.stringify(copy)), ["kind", "path", "text"]);
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
