import { ok } from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineCommittedGitFixture } from "../git-test-fixture.ts";
import { admitProjectIdentity, type ProjectIdentity } from "../project-identity.ts";
import { createPlanPackage, readPlanPackage } from "../../plan-store.js";
import type { CreatePlanPackage, PackageInspection, LoadedPlanPackage } from "../plan-package-store.ts";

const fixture = defineCommittedGitFixture({ "README.md": "package fixture\n" });
export const documents = { "context.md": "# A Plan\n\nProse — 世界\n", "validation.md": "# Verify\n\nRun checks.\n" };
export async function packageFixture() {
    const root = await fs.realpath(await fixture.checkout());
    const admitted = await admitProjectIdentity(root);
    ok(admitted.kind === "existing");
    return { root, identity: admitted.identity, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
export function requirePackage(result: PackageInspection): LoadedPlanPackage {
    ok(result.kind === "loaded", JSON.stringify(result));
    return result;
}
export async function create(identity: ProjectIdentity, input: Partial<CreatePlanPackage> = {}) {
    return await createPlanPackage(identity, { planId: "plan-one", name: "one", documents, ...input });
}
export async function read(identity: ProjectIdentity, planId = "plan-one") {
    return requirePackage(await readPlanPackage(identity, { planId }));
}
export async function tree(root: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    let entries;
    try {
        entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return result;
        throw error;
    }
    for (const entry of entries) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) {
            result[`${entry.name}/`] = "directory";
            for (const [child, bytes] of Object.entries(await tree(path))) result[`${entry.name}/${child}`] = bytes;
        } else if (entry.isSymbolicLink()) result[entry.name] = await fs.readlink(path);
        else result[entry.name] = (await fs.readFile(path)).toString("base64");
    }
    return result;
}
export interface DriverRequest {
    identity: ProjectIdentity;
    command:
        | "sequence"
        | "lifecycle"
        | "execution"
        | "recover-lifecycle"
        | "metadata"
        | "document"
        | "create"
        | "rename"
        | "capture"
        | "read"
        | "input"
        | "hold"
        | "import"
        | "list"
        | "evidence";
    barrier?: string;
    boundary?: string;
    planId?: string;
    name?: string;
    edit?: "context.md" | "validation.md" | "manual-qa.md";
    remove?: boolean;
    inputId?: string;
    selection?: string;
    mutateEvidencePath?: string;
    mutateEvidenceDestination?: string;
    mutateEvidenceText?: string;
}
export function startDriver(request: DriverRequest) {
    const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./plan-package-process-driver.ts", import.meta.url)), JSON.stringify(request)],
        {
            cwd: request.identity.checkoutRoot,
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
        },
    );
    let output = "",
        errors = "";
    child.stdout.on("data", (chunk) => (output += chunk.toString()));
    child.stderr.on("data", (chunk) => (errors += chunk.toString()));
    const done = new Promise<{ code: number | null; output: string; errors: string }>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", (code) => resolve({ code, output, errors }));
    });
    return {
        child,
        done,
        async ready() {
            const deadline = Date.now() + 15000;
            while (!output.includes("ready\n")) {
                if (child.exitCode !== null || Date.now() > deadline)
                    throw new Error(`Driver did not become ready: ${output} ${errors}`);
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
        },
    };
}
export async function driver(request: DriverRequest) {
    const result = await startDriver(request).done;
    return result;
}
