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
import { prepareSequenceReview, validateSequenceReviewDecision } from "../../shared/workflow/sequence-review.ts";
import { startPlanReviewSurface } from "../review/review-launcher.ts";
import { submitPlanForReview } from "../review/plan-review.ts";
import { startWorkspaceServer } from "./server.js";

const sequence = process.argv.includes("--sequence");
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
        definition: {
            classification: sequence ? "PROJECT" : "PLANNED_CHANGE",
            ...(sequence ? { type: "sequence" } : {}),
            workKind: "FEATURE",
            complexity: "MEDIUM",
            status: "draft",
        },
        documents: {
            "context.md":
                "# Canonical home Plan\n\nRevision one: home authority.\n\n[Validation](validation.md#checks)\n\n[Child Plan](nested/child.md)\n\n[Repository README](../../README.md)\n",
            "validation.md":
                "# Validation\n\n## Checks\n\nVerify the canonical home Plan.\n\n[Context](context.md)\n\n[Child Plan](nested/child.md)\n\n[Repository README](../../README.md)\n\n[Outside Project](../../../outside.md)\n",
            "manual-qa.md": "# Manual QA\n\nCheck keyboard and phone navigation.\n",
        },
    });
    await create(fixture.identity, {
        planId: "nested-child",
        name: "nested/child",
        ...(sequence
            ? {
                  parentPlanId: "plan-one",
                  definition: {
                      classification: "PLANNED_CHANGE",
                      status: "draft",
                      order: 1,
                      executionAgent: "engineer",
                      collaborationRecommendation: "autonomous",
                  },
              }
            : {}),
        documents: {
            "context.md": "# Child home Plan\n\n[Parent Plan](../one.md)\n",
            "validation.md": "# Child validation\n",
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
const port = sequence ? 5191 : 5189;
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
        if (sequence) {
            const documents = await prepareSequenceReview(root, plan.metadata.name);
            const surface = await startPlanReviewSurface({
                cwd: root,
                plan: documents[0].plan,
                planPath: documents[0].planPath,
                sequenceDocuments: documents,
                browser: { open: () => Promise.resolve(false) },
                onDecision: (decision) => validateSequenceReviewDecision(root, documents, decision),
            });
            await fs.writeFile(join(directory, "review-url.txt"), surface.url);
            console.log(`Sequence review: ${surface.url}`);
            void surface
                .waitForDecision()
                .then((result) => fs.writeFile(join(directory, "review-result.json"), JSON.stringify(result)));
        } else if (process.argv.includes("--review")) {
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
