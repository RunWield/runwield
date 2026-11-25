export type PackageResource = "context.md" | "validation.md" | "manual-qa.md" | "integration-report.md";
export type PackageResourceRole = "context" | "validation" | "manual-qa" | "integration-report";

export interface PackageDocument {
    name: PackageResource;
    role: PackageResourceRole;
    bytes: Uint8Array;
    hash: string;
}

export const packageResources: readonly PackageResource[] = [
    "context.md",
    "validation.md",
    "manual-qa.md",
    "integration-report.md",
];
export const packageResourceRoles: Readonly<Record<PackageResource, PackageResourceRole>> = {
    "context.md": "context",
    "validation.md": "validation",
    "manual-qa.md": "manual-qa",
    "integration-report.md": "integration-report",
};

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
import { ContainedPathError } from "@runwield/resources/fs";

export function rethrowPackagePathError<T>(error: T): never {
    if (error instanceof ContainedPathError) {
        throw new PlanPackageError(
            "unsafe_path",
            error.reason === "outside_root"
                ? "Path leaves the personal Project store."
                : `Symbolic link in package path: ${error.path}`,
        );
    }
    throw error;
}
