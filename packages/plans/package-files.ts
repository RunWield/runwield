import { projects, type ProjectStoreIdentity } from "@runwield/projects";
import { assertContainedPath, ensurePrivateDir, syncParentDirectory } from "@runwield/resources/fs";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { EPIC_ARTIFACT_FILE_NAMES } from "./format/artifacts.ts";
import {
    packageResourceRoles,
    packageResources,
    PlanPackageError,
    rethrowPackagePathError,
    type PackageDocument,
} from "./package-data.ts";

export function normalizePackageName(name: string): string {
    if (typeof name !== "string" || !name || name !== name.trim())
        throw new PlanPackageError("unsafe_path", "Invalid package name.");
    const segments = name.split("/");
    const reserved = ["context", "validation", "plan.wld.json", ...EPIC_ARTIFACT_FILE_NAMES.map((n) => n.slice(0, -3))];
    if (
        segments.some(
            (segment) =>
                !segment ||
                segment === "." ||
                segment === ".." ||
                /[\\<>:"|?*]/.test(segment) ||
                [...segment].some((character) => character.charCodeAt(0) < 32) ||
                /[. ]$/.test(segment) ||
                /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(segment) ||
                reserved.includes(segment.toLowerCase().replace(/\.md$/, "")),
        )
    ) {
        throw new PlanPackageError("unsafe_path", "Unsafe or reserved package name.");
    }
    return segments.join("/");
}

export function localPackageLayout(identity: ProjectStoreIdentity) {
    if (identity.personalOwner.kind !== "execution-account")
        throw new PlanPackageError("unavailable", "Managed-remote packages require their personal-store transport.");
    projects.home.assertStoreIdentity(identity);
    const home = identity.executionAccountHome;
    const root = join(home, ".wld", "projects", identity.projectId);
    const internal = join(root, "internal", "plan-packages");
    return { home, root, internal, plans: join(root, "plans"), stages: join(internal, "staging") };
}

export async function statPackagePath(path: string) {
    try {
        return await fs.lstat(path);
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
    }
}

export async function readPackageFile(home: string, path: string): Promise<Uint8Array | null> {
    await assertContainedPath(home, path).catch(rethrowPackagePathError);
    const info = await statPackagePath(path);
    if (!info) return null;
    if (!info.isFile()) throw new PlanPackageError("unsafe_path", `Package resource is not a regular file: ${path}`);
    return await fs.readFile(path);
}

export async function readPackageDocuments(home: string, path: string): Promise<PackageDocument[]> {
    const documents: PackageDocument[] = [];
    for (const name of packageResources) {
        const bytes = await readPackageFile(home, join(path, name));
        if (!bytes) {
            if (name === "context.md" || name === "validation.md")
                throw new PlanPackageError("missing_document", `Missing required document: ${name}`);
        } else documents.push({ name, role: packageResourceRoles[name], bytes, hash: packageFileDigest(bytes) });
    }
    return documents;
}

export async function ensurePackageDirectory(home: string, path: string): Promise<void> {
    await assertContainedPath(home, path).catch(rethrowPackagePathError);
    const created: string[] = [];
    for (let cursor = path; cursor !== home && dirname(cursor) !== cursor; cursor = dirname(cursor)) {
        if (!(await statPackagePath(cursor))) created.push(cursor);
    }
    ensurePrivateDir(path);
    for (const entry of created) syncParentDirectory(entry);
}

export function packageFileDigest(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}
