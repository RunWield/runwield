export type PackageIssueKind =
    | "missing"
    | "malformed_metadata"
    | "unsupported_metadata"
    | "missing_document"
    | "unsafe_path"
    | "pending_recovery"
    | "unavailable";

export class PlanPackageError extends Error {
    constructor(
        public kind: PackageIssueKind | "collision" | "changed_input",
        message: string,
    ) {
        super(message);
        this.name = "PlanPackageError";
    }
}

declare const planIdBrand: unique symbol;

/** Stable Plan identifier. Legacy Plans may have non-UUID IDs. */
export type PlanId = string & { readonly [planIdBrand]: true };

export function normalizePlanId<T>(value: T): PlanId | undefined {
    const trimmed = typeof value === "string" ? value.trim() : undefined;
    return isPlanId(trimmed) ? trimmed : undefined;
}

export function isPlanId(value: string | null | undefined): value is PlanId {
    return typeof value === "string" && value.length > 0 && value.trim() === value;
}

export interface ExecutionPublicationPolicy {
    plans: boolean;
    workRecords: boolean;
    autoGenerateRecords: boolean;
}

export function assertExecutionPublicationPolicy(policy: ExecutionPublicationPolicy): void {
    if (
        (["plans", "workRecords", "autoGenerateRecords"] as const).some((field) => typeof policy?.[field] !== "boolean")
    )
        throw new Error("Invalid retained publication copy policy.");
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

type PublicationFields = Record<string, string | number | boolean | null>;

function fail(kind: PlanPackageError["kind"], message: string): never {
    throw new PlanPackageError(kind, message);
}

export function assertPublicationMetadataFields(value: PublicationFields, allowed: string[]): PublicationFields {
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
    const value = assertPublicationMetadataFields(JSON.parse(JSON.stringify(reference)), publicationReferenceFields);
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
