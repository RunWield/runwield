/** Disposable composed owner Workspace for package surface verification. */
import fs from "node:fs/promises";
import { join } from "node:path";
import { defineCommittedGitFixture } from "../../shared/git-test-fixture.ts";
import { packageFixture, create } from "../../shared/testing/plan-package-fixture.ts";
import { inspectProjectIdentity } from "../../shared/project-identity.ts";
import { readPlanPackage } from "../../shared/plan-package-store.ts";
import { withPackageWorkflow } from "../../shared/workflow/package-workflow.ts";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { writeWorkRecord, listWorkRecords } from "../../shared/work-records/store.ts";
import { recordAttrs, recordBody } from "../../shared/work-records/test-fixtures/package-records.ts";
import { submitPlanForReview } from "../review/plan-review.ts";
import { startWorkspaceServer } from "./server.js";

const directory = process.argv[2];
if (!directory) throw new Error("Supply a disposable evidence directory.");
await fs.mkdir(directory, { recursive: true });
const statePath = join(directory, "project-root.txt");
let root: string;
try {
    root = (await fs.readFile(statePath, "utf8")).trim();
} catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const fixture = await packageFixture();
    root = fixture.root;
    await create(fixture.identity, {
        definition: { classification: "PLANNED_CHANGE", workKind: "FEATURE", complexity: "MEDIUM", status: "draft" },
        documents: {
            "context.md": "# Canonical home Plan\n\nRevision one: home authority.\n\n[Validation](validation.md)\n",
            "validation.md": "# Validation\n\nVerify the canonical home Plan.\n",
            "manual-qa.md": "# Manual QA\n\nCheck keyboard and phone navigation.\n",
        },
    });
    await fs.mkdir(join(root, "docs/plans"), { recursive: true });
    await fs.writeFile(join(root, "docs/plans/one.md"), "# Stale delivery copy\n");
    await fs.writeFile(statePath, root);
}
const inspected = inspectProjectIdentity(root);
if (inspected.kind !== "existing") throw new Error("QA Project identity is unavailable.");
const plan = await readPlanPackage(inspected.identity, { planId: "plan-one" });
if (plan.kind !== "loaded") throw new Error(plan.message);
if (process.argv.includes("--malformed")) {
    const malformed = await readPlanPackage(inspected.identity, { planId: "broken-qa" });
    if (malformed.kind === "missing") {
        const broken = await create(inspected.identity, { planId: "broken-qa", name: "broken-qa" });
        await fs.writeFile(join(broken.path, "plan.wld.json"), "{");
    }
}
const store = openOwnerCoordinationStore({ dbPath: join(directory, "owner.sqlite3") });
const project = store.registerProject({ root, displayName: "Home Plan verification" });
const emptyStatePath = join(directory, "empty-root.txt");
let emptyRoot: string;
try {
    emptyRoot = (await fs.readFile(emptyStatePath, "utf8")).trim();
} catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    emptyRoot = await defineCommittedGitFixture({ "README.md": "Unimported Project\n" }).checkout();
    await fs.writeFile(emptyStatePath, emptyRoot);
}
const emptyProject = store.registerProject({ root: emptyRoot, displayName: "Unimported Project" });
await fs.writeFile(join(directory, "empty-project-id.txt"), emptyProject.projectId);
const pairing = store.createPairingRequest();
store.approvePairingRequest(pairing.code);
const device = store.claimPairingRequest(pairing.proof);
await fs.writeFile(join(directory, "browser-auth.json"), JSON.stringify(device), { mode: 0o600 });
const port = 5189;
await withPackageWorkflow(
    root,
    {
        identity: inspected.identity,
        planId: plan.metadata.planId,
        expectedRevision: plan.metadata.revision,
    },
    async () => {
        if (!(await listWorkRecords(root, { createDir: false })).length)
            await writeWorkRecord(root, recordAttrs(), recordBody);
        startWorkspaceServer({ mode: "owner", host: "127.0.0.1", port, store });
        if (process.argv.includes("--review")) {
            void submitPlanForReview({
                cwd: root,
                planName: plan.metadata.name,
                planPath: join(plan.path, "context.md"),
                browser: { open: () => Promise.resolve(false) },
                onSurfaceReady: (surface) => {
                    void fs.writeFile(join(directory, "review-url.txt"), surface.url);
                    console.log(`Review: ${surface.url}`);
                },
            }).then((result) => fs.writeFile(join(directory, "review-result.json"), JSON.stringify(result)));
        }
    },
);
console.log(`http://127.0.0.1:${port}/projects/${project.projectId}/plans/plan-one`);
