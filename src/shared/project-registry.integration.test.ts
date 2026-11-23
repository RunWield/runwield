import { projects, type RegisteredProject } from "@runwield/projects";
import { deepEqual, equal } from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { captureForegroundProcess } from "./captured-process.ts";
import { defineCommittedGitFixture } from "./git-test-fixture.ts";
import { openOwnerCoordinationStore } from "./owner-coordination/index.ts";

const fixture = defineCommittedGitFixture();

interface WorkspacePackage {
    name: string;
    dependencies?: Record<string, string>;
}

async function installProjectsForWorker(consumerRoot: string) {
    const sourceRoot = fileURLToPath(new URL("../../packages/", import.meta.url));
    const installed = new Set<string>();
    async function install(name: string) {
        if (installed.has(name)) return;
        installed.add(name);
        const source = join(sourceRoot, basename(name));
        const manifest: WorkspacePackage = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
        equal(manifest.name, name);
        await cp(source, join(consumerRoot, "node_modules", name), {
            recursive: true,
            filter: (file) => basename(file) !== "node_modules",
        });
        for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
            equal(version, "workspace:*", "The fixture installs private workspace dependencies");
            await install(dependency);
        }
    }
    await mkdir(join(consumerRoot, "node_modules", "@runwield"), { recursive: true });
    await install("@runwield/projects");
}

async function readFromWorker(consumerRoot: string, registration: RegisteredProject) {
    const program = `
        import { projects } from "@runwield/projects";
        const registry = projects.registrations.open();
        try {
            const registration = registry.get(process.argv[1]);
            const checkout = projects.checkout.inspect(registration.currentRoot);
            console.log(JSON.stringify([registration, checkout.kind === "existing" && checkout.identity.projectId]));
        } finally {
            registry.close();
        }`;
    const result = await captureForegroundProcess(process.execPath, {
        args: ["--no-install", "-e", program, registration.projectId],
        cwd: consumerRoot,
    });
    equal(result.code, 0, new TextDecoder().decode(result.stderr));
    deepEqual(JSON.parse(new TextDecoder().decode(result.stdout)), [registration, registration.projectId]);
}

test("Workspace and an independent worker resolve the same zero-Plan project before and after a move", async () => {
    const consumer = await mkdtemp(join(tmpdir(), "projects-worker-"));
    const root = await fixture.checkout();
    const moved = root + "-moved";
    const workspace = openOwnerCoordinationStore();
    try {
        await installProjectsForWorker(consumer);
        const admission = await projects.checkout.admit(root);
        equal(admission.kind, "existing");
        if (admission.kind !== "existing") throw Error("Expected admitted checkout");
        const registration = workspace.projects.register({ root });
        equal(registration.projectId, admission.identity.projectId);
        await readFromWorker(consumer, registration);

        await rename(root, moved);
        const movedAdmission = await projects.checkout.admit(moved);
        equal(movedAdmission.kind, "existing");
        const relinked = workspace.projects.relink({ projectId: registration.projectId, newRoot: moved });
        equal(relinked.projectId, registration.projectId);
        equal(relinked.projectId, admission.identity.projectId);
        await readFromWorker(consumer, relinked);
    } finally {
        workspace.close();
        await Promise.all([root, moved, consumer].map((path) => rm(path, { recursive: true, force: true })));
    }
});
