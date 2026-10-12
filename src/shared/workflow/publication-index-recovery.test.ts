import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { loadPlan, parsePlanFrontMatter, savePlan } from "../../plan-store.js";
import { defineGitFixture, git } from "../git-test-fixture.ts";
import { publishExecutionWorktreeIsolated } from "../isolated-publication.ts";
import { formatWorkRecordMarkdown, parseWorkRecordMarkdown } from "../work-records/markdown.js";
import { readPublishedRecordMarkdown } from "../work-records/published-source.ts";
import { syncWorkRecordToIndex } from "../work-records/index-adapter.ts";
import { createWorkRecordMnemotecaFixture } from "../work-records/test-fixtures/mnemoteca-port.ts";
import { createTestWorktreeAttempt } from "../worktree-test-helpers.ts";
import {
    advanceStoredPublication,
    cleanupStoredPublication,
    loadPublicationAttempt,
    startPublicationAttempt,
} from "./publication-machine.ts";

const planId = "11111111-1111-4111-8111-111111111111";
const predecessorId = "22222222-2222-4222-8222-222222222222";
const successorId = "33333333-3333-4333-8333-333333333333";
const planPath = "docs/plans/demo.md";
const predecessorPath = "docs/work-records/old.md";
const successorPath = "docs/work-records/new.md";
const recordAttrs = {
    kind: "work_record" as const,
    scope: "planned_change" as const,
    origin: "internal" as const,
    completionMode: "verified" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
};
const repository = defineGitFixture(async (root) => {
    await savePlan(root, "demo", "# Reviewed implementation\n", {
        planId,
        classification: "PLANNED_CHANGE",
        status: "reviewed",
    });
    await Deno.mkdir(join(root, "docs/work-records"), { recursive: true });
    await Deno.writeTextFile(
        join(root, predecessorPath),
        formatWorkRecordMarkdown({
            ...recordAttrs,
            recordId: predecessorId,
            status: "approved",
            provenance: { sourcePlans: ["44444444-4444-4444-8444-444444444444"] },
        }, "# Old behavior\n\n## Summary\n\nOriginal behavior.\n"),
    );
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "Reviewed Plan and prior Work Record"]);
});

Deno.test("remote delivery retains verification through index failure and recovers indexing from its recorded upstream", async () => {
    const root = await repository.checkout();
    const temporary = await Deno.makeTempDir({ prefix: "publication-index-recovery-" });
    const remote = join(temporary, "remote.git");
    const decoy = join(temporary, "unrelated.git");
    try {
        await git(root, ["init", "--bare", remote]);
        await git(root, ["init", "--bare", decoy]);
        await git(root, ["remote", "add", "origin", remote]);
        await git(root, ["push", "-u", "origin", "main"]);
        const primaryHead = await git(root, ["rev-parse", "HEAD"]);
        const primaryPlan = await Deno.readTextFile(join(root, planPath));
        const index = createWorkRecordMnemotecaFixture();
        await syncWorkRecordToIndex(
            root,
            parseWorkRecordMarkdown(await Deno.readTextFile(join(root, predecessorPath))),
            {
                mnemotecaPort: index,
            },
        );

        const entry = await createTestWorktreeAttempt({
            projectRoot: root,
            worktreeRoot: temporary,
            planName: "demo",
            planId,
        });
        const plan = await loadPlan(entry.path, "demo");
        assert(plan);
        await savePlan(entry.path, "demo", plan.body, {
            ...plan.attrs,
            workRecord: { status: "generated", recordId: successorId, path: successorPath },
        }, { expectedRevision: plan.revision });
        await Deno.writeTextFile(
            join(entry.path, successorPath),
            formatWorkRecordMarkdown({
                ...recordAttrs,
                recordId: successorId,
                status: "pending_verification",
                supersedes: [predecessorId],
                provenance: { sourcePlans: [planId] },
            }, "# New behavior\n\n## Summary\n\nDelivered replacement behavior.\n"),
        );
        await Deno.writeTextFile(join(entry.path, "feature.txt"), "Reviewed implementation\n");
        await git(entry.path, ["add", "."]);
        await git(entry.path, ["commit", "-m", "Seal candidate and pending record"]);
        const artifactCommit = await git(entry.path, ["rev-parse", "HEAD"]);
        let attempt = await startPublicationAttempt({
            projectRoot: root,
            attemptId: entry.id,
            planName: "demo",
            targetBranch: "main",
            executionBranch: entry.branch,
            executionCwd: entry.path,
            validatedCommit: artifactCommit,
            targetHeadAtSeal: primaryHead,
        });
        attempt = await advanceStoredPublication(root, attempt, "artifacts_committed", {
            artifactCommit,
            planPaths: [planPath],
        });
        const delivered = await publishExecutionWorktreeIsolated({
            projectRoot: root,
            executionCwd: entry.path,
            executionBranch: entry.branch,
            targetBranch: "main",
            planName: "demo",
            sealedExecutionCommit: artifactCommit,
            allowedPlanPaths: [planPath],
            publicationRoot: attempt.publicationRoot,
            onIntegrated: async (evidence) => {
                attempt = await advanceStoredPublication(root, attempt, "target_integrated", evidence);
            },
            onPublished: async (evidence) => {
                attempt = await advanceStoredPublication(root, attempt, "target_published", evidence);
            },
            // A stopped process did not persist onVerified or index the delivery.
        });
        assertEquals(attempt.phase, "target_published");
        assertEquals(parsePlanFrontMatter(await git(remote, ["show", `main:${planPath}`])).attrs.status, "verified");
        assertEquals(index.snapshot().length, 1);
        await assertRejects(() => git(root, ["cat-file", "-e", `${delivered.publicationCommit}^{commit}`]));
        const failed = await cleanupStoredPublication(root, attempt, {
            run: () => Promise.reject(new Error("Index service unavailable")),
        });
        assertEquals(failed.complete, false);
        assertEquals(failed.attempt.phase, "publication_verified");
        assertStringIncludes(failed.details.join("\n"), "Index service unavailable");
        const completedPlan = await loadPlan(root, "demo");
        assertEquals(completedPlan?.attrs.status, "verified");
        assertEquals(completedPlan?.attrs.publicationReceipt?.publishedCommit, delivered.publicationCommit);
        assertEquals(await Deno.readTextFile(join(root, planPath)), primaryPlan);
        assertEquals(await git(root, ["rev-parse", "HEAD"]), primaryHead);

        // Recover with only persisted state and the recorded remote available.
        await Deno.remove(attempt.publicationRoot, { recursive: true });
        assertEquals(
            await git(root, ["rev-parse", `refs/runwield/deliveries/${encodeURIComponent(entry.id)}`]),
            delivered.publicationCommit,
        );
        const attached = await readPublishedRecordMarkdown(root, failed.attempt, successorPath);
        assert(attached);
        assertStringIncludes(attached, "Delivery destination: `main`");
        assertEquals(parseWorkRecordMarkdown(attached).attrs.status, "approved");
        await git(root, ["remote", "add", "decoy", decoy]);
        await git(root, ["config", "branch.main.remote", "decoy"]);
        await git(root, ["config", "branch.main.merge", "refs/heads/unrelated"]);
        const restarted = await loadPublicationAttempt(root, entry.id);
        assert(restarted);
        assertEquals(restarted.upstreamRemote, "origin");
        assertEquals(restarted.upstreamBranch, "main");
        const recovered = await cleanupStoredPublication(root, restarted, index);
        assertEquals(recovered.complete, true, recovered.details.join("\n"));
        assertEquals(await loadPublicationAttempt(root, entry.id), null);
        const documents = index.snapshot();
        assertEquals(documents.length, 2);
        assert(
            documents.find((document) => document.tags.includes(`work-record:${successorId}`))?.tags.includes(
                "status:approved",
            ),
        );
        assert(
            documents.find((document) => document.tags.includes(`work-record:${predecessorId}`))?.tags.includes(
                "status:superseded",
            ),
        );
        assertEquals((await loadPlan(root, "demo"))?.attrs.status, "verified");
        assertEquals(await Deno.readTextFile(join(root, planPath)), primaryPlan);
        assertEquals(await git(root, ["rev-parse", "HEAD"]), primaryHead);
        // A repeated cleanup retries the derived index without duplicating records.
        const repeated = await cleanupStoredPublication(root, recovered.attempt, index);
        assertEquals(repeated.complete, true);
        assertEquals(index.snapshot().length, 2);
        assertEquals(await readPublishedRecordMarkdown(root, repeated.attempt, successorPath), attached);
    } finally {
        await Deno.remove(root, { recursive: true });
        await Deno.remove(temporary, { recursive: true });
    }
});

for (const mode of ["local", "remote"] as const) {
    Deno.test(`${mode} delayed publication indexing preserves a later supersession after the original Plan is removed`, async () => {
        const root = await repository.checkout();
        const temporary = await Deno.makeTempDir({ prefix: "publication-index-order-" });
        const index = createWorkRecordMnemotecaFixture();
        const laterId = "55555555-5555-4555-8555-555555555555";
        try {
            if (mode === "remote") {
                const remote = join(temporary, "remote.git");
                await git(root, ["init", "--bare", remote]);
                await git(root, ["remote", "add", "origin", remote]);
                await git(root, ["push", "-u", "origin", "main"]);
            }
            const publish = async (
                name: string,
                recordId: string,
                supersedes: string[],
                removeOriginalPlan = false,
            ) => {
                if (mode === "remote") await git(root, ["fetch", "origin", "main"]);
                const entry = await createTestWorktreeAttempt({
                    projectRoot: root,
                    worktreeRoot: temporary,
                    planName: name,
                    planId: name === "demo" ? planId : laterId,
                    baseRef: mode === "remote" ? "refs/remotes/origin/main" : "refs/heads/main",
                    baseBranch: "main",
                });
                const path = `docs/work-records/${name}.md`;
                const existing = await loadPlan(entry.path, name);
                await savePlan(entry.path, name, `# ${name}\n`, {
                    planId: entry.planId,
                    classification: "PLANNED_CHANGE",
                    status: "reviewed",
                    workRecord: { status: "generated", recordId, path },
                }, { expectedRevision: existing?.revision });
                await Deno.writeTextFile(
                    join(entry.path, path),
                    formatWorkRecordMarkdown({
                        ...recordAttrs,
                        recordId,
                        status: "pending_verification",
                        supersedes,
                        provenance: { sourcePlans: [entry.planId!] },
                    }, `# ${name}\n\n## Summary\n\n${name} behavior.\n`),
                );
                if (removeOriginalPlan) await Deno.remove(join(entry.path, planPath));
                await Deno.writeTextFile(join(entry.path, `${name}.txt`), `${name} implementation\n`);
                await git(entry.path, ["add", "."]);
                await git(entry.path, ["commit", "-m", `Prepare ${name}`]);
                const commit = await git(entry.path, ["rev-parse", "HEAD"]);
                let attempt = await startPublicationAttempt({
                    projectRoot: root,
                    attemptId: entry.id,
                    planName: name,
                    targetBranch: "main",
                    executionBranch: entry.branch,
                    executionCwd: entry.path,
                    validatedCommit: commit,
                    targetHeadAtSeal: entry.baseCommit,
                });
                const paths = [`docs/plans/${name}.md`];
                attempt = await advanceStoredPublication(root, attempt, "artifacts_committed", {
                    artifactCommit: commit,
                    planPaths: paths,
                });
                await publishExecutionWorktreeIsolated({
                    projectRoot: root,
                    executionCwd: entry.path,
                    executionBranch: entry.branch,
                    targetBranch: "main",
                    planName: name,
                    sealedExecutionCommit: commit,
                    allowedPlanPaths: paths,
                    publicationRoot: attempt.publicationRoot,
                    onIntegrated: async (evidence) => {
                        attempt = await advanceStoredPublication(root, attempt, "target_integrated", evidence);
                    },
                    onPublished: async (evidence) => {
                        attempt = await advanceStoredPublication(root, attempt, "target_published", evidence);
                    },
                });
                return attempt;
            };

            const first = await publish("demo", successorId, [predecessorId]);
            const delayed = await cleanupStoredPublication(root, first, {
                run: () => Promise.reject(new Error("First index attempt failed")),
            });
            assertEquals(delayed.complete, false);
            const second = await publish("later", laterId, [successorId], true);
            const settled = await cleanupStoredPublication(root, second, index);
            assertEquals(settled.complete, true, settled.details.join("\n"));
            const earlierDocument = () =>
                index.snapshot().find((item) => item.tags.includes(`work-record:${successorId}`));
            assert(earlierDocument()?.tags.includes("status:superseded"));
            const beforeRetry = earlierDocument();
            const restarted = await loadPublicationAttempt(root, first.attemptId);
            assert(restarted);
            const retried = await cleanupStoredPublication(root, restarted, index);
            assertEquals(retried.complete, true, retried.details.join("\n"));
            assertEquals(earlierDocument(), beforeRetry);
            assert(
                index.snapshot().find((item) => item.tags.includes(`work-record:${laterId}`))?.tags.includes(
                    "status:approved",
                ),
            );
            // The retry still discovers its older predecessor from immutable Plan
            // linkage, but reads that predecessor's current canonical state.
            assert(
                index.snapshot().find((item) => item.tags.includes(`work-record:${predecessorId}`))?.tags.includes(
                    "status:superseded",
                ),
            );
        } finally {
            await Deno.remove(root, { recursive: true });
            await Deno.remove(temporary, { recursive: true });
        }
    });
}
