import { PlanPackageError } from "@runwield/plan-storage-format";
import { ContainedPathError } from "@runwield/resources/fs";
import { decodePackageMarkdown } from "./format/implementation.ts";

export { PlanPackageError };
export type { PackageIssueKind } from "@runwield/plan-storage-format";

export type PackageResource = "context.md" | "validation.md" | "manual-qa.md" | "integration-report.md";
export type PackageResourceRole = "context" | "validation" | "manual-qa" | "integration-report";

export interface PackageDocument {
    name: PackageResource;
    role: PackageResourceRole;
    bytes: Uint8Array;
    hash: string;
}

export interface PackageDocuments {
    "context.md": string;
    "validation.md": string;
    "manual-qa.md"?: string;
    "integration-report.md"?: string;
}

export function packageDocumentText(documents: readonly PackageDocument[]): PackageDocuments {
    const result: PackageDocuments = { "context.md": "", "validation.md": "" };
    for (const document of documents) result[document.name] = decodePackageMarkdown(document.bytes);
    return result;
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
