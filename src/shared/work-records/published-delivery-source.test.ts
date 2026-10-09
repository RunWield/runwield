import { assertEquals, assertStringIncludes } from "@std/assert";
import { defineGitFixture, git } from "../git-test-fixture.ts";
import { readPublishedDeliverySources, readPublishedRecordMarkdown } from "./published-source.ts";
import { advancePublicationAttempt, createPublicationAttempt } from "../workflow/publication-attempt.ts";
import {
    readDeliveryEvidence,
    recordDeliveryEvidence,
    saveDeliveredPlanEvidence,
    saveDeliveredWorkRecordEvidence,
} from "../workflow/delivery-evidence.ts";
import { runPlanFrontMatterTransition } from "../workflow/state-transition.ts";
import { savePlan } from "../../plan-store.js";
import { resolveProjectRuntimeLayout } from "../project-runtime-layout.ts";
import { buildDeliveryReport } from "../workflow/delivery-report.ts";

const parent =
    "---\nplanId: parent-id\nclassification: PROJECT\nstatus: verified\nepicCompletionMode: done_enough\nworkRecord:\n  status: generated\n  path: docs/work-records/epic.md\n---\n# Parent\n";
const fixture = defineGitFixture(async (root) => {
    await savePlan(root, "epic/one", "# Approved child\n", {
        planId: "child-id",
        classification: "PLANNED_CHANGE",
        parentPlan: "epic",
        status: "validated",
        humanReviewDecision: "approved",
        humanReviewMode: "always",
        humanReviewedAt: "2026-10-08T10:00:00Z",
    });
    await Deno.writeTextFile(`${root}/docs/plans/epic.md`, parent);
    await Deno.mkdir(`${root}/docs/work-records`, { recursive: true });
    await Deno.writeTextFile(`${root}/docs/work-records/epic.md`, "# Delivered Epic Work Record\n");
    await git(root, ["add", "docs"]);
    await git(root, ["commit", "-m", "sealed delivery"]);
});

Deno.test("sealed delivery keeps child evidence and terminal parent record despite a stale primary Plan", async () => {
    const root = await fixture.checkout();
    try {
        await runPlanFrontMatterTransition({
            projectRoot: root,
            planName: "epic/one",
            operation: "validation_human_review_metadata",
            updates: {
                humanReviewDecision: "approved",
                humanReviewMode: "always",
                humanReviewedAt: "2026-10-08T10:00:00Z",
            },
        });
        const commit = await git(root, ["rev-parse", "HEAD"]);
        const publication = {
            ...createPublicationAttempt({
                attemptId: "a",
                planId: "child-id",
                planName: "epic/one",
                targetBranch: "main",
                executionBranch: "feature",
                executionCwd: root,
                publicationRoot: root,
                validatedCommit: commit,
                targetHeadAtSeal: commit,
            }),
            artifactCommit: commit,
        };
        await Deno.writeTextFile(`${root}/docs/plans/epic/one.md`, "# Unrelated primary edit\n");
        await Deno.remove(`${root}/docs/work-records/epic.md`);
        assertEquals(
            (await git(root, ["show", `${commit}:docs/plans/epic/one.md`])).includes("humanReviewDecision"),
            false,
        );
        const sources = await readPublishedDeliverySources(root, publication);
        assertEquals(sources.delivered.planId, "child-id");
        assertEquals(sources.delivered.attrs.humanReviewDecision, "approved");
        assertEquals(sources.workRecordOwner?.planId, "parent-id");
        assertEquals(sources.workRecordOwner?.attrs.workRecord?.path, "docs/work-records/epic.md");
        const recordMarkdown = await readPublishedRecordMarkdown(
            root,
            publication,
            sources.workRecordOwner?.attrs.workRecord?.path || "",
        );
        assertEquals(recordMarkdown, "# Delivered Epic Work Record\n");
        const record = await saveDeliveredWorkRecordEvidence(root, publication, recordMarkdown || "");
        assertEquals(await Deno.readTextFile(`${root}/${record?.path}`), "# Delivered Epic Work Record\n");
        const artifact = await saveDeliveredPlanEvidence(root, publication, sources.delivered.markdown);
        assertStringIncludes(await Deno.readTextFile(`${root}/${artifact?.path}`), "# Approved child");
        assertEquals(await Deno.readTextFile(`${root}/docs/plans/epic/one.md`), "# Unrelated primary edit\n");
        await Deno.writeTextFile(
            `${root}/docs/plans/epic.md`,
            parent.replace("status: verified", "status: ready_for_work"),
        );
        await git(root, ["add", "docs/plans/epic.md"]);
        await git(root, ["commit", "-m", "unfinished parent"]);
        const unfinished = await readPublishedDeliverySources(root, {
            ...publication,
            artifactCommit: await git(root, ["rev-parse", "HEAD"]),
        });
        assertEquals(unfinished.delivered.planId, "child-id");
        assertEquals(unfinished.workRecordOwner, undefined);
        await git(root, ["rm", "docs/plans/epic.md"]);
        await git(root, ["commit", "-m", "child branch without parent document"]);
        const childOnly = await readPublishedDeliverySources(root, {
            ...publication,
            artifactCommit: await git(root, ["rev-parse", "HEAD"]),
        });
        assertEquals(childOnly.delivered.planId, "child-id");
        assertEquals(childOnly.workRecordOwner, undefined);
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("delivery receipts use the primary runtime from an execution worktree", async () => {
    const root = await fixture.checkout();
    const worktree = `${root}-execution`;
    try {
        await git(root, ["worktree", "add", "-b", "execution", worktree]);
        assertEquals(
            resolveProjectRuntimeLayout(worktree).primary.deliveryEvidenceRoot,
            resolveProjectRuntimeLayout(root).primary.deliveryEvidenceRoot,
        );
        await recordDeliveryEvidence(worktree, "epic/one", "attempt", "ci", "Passed");
        const evidence = await readDeliveryEvidence(root, "epic/one", "attempt");
        assertEquals(evidence.entries.length, 1);
        assertEquals(evidence.artifacts.length, 1);
    } finally {
        await Deno.remove(root, { recursive: true });
        await Deno.remove(worktree, { recursive: true }).catch(() => {});
    }
});

Deno.test("confirmed child delivery keeps the prepared reviewed Epic Work Record in its report", async () => {
    const root = await fixture.checkout();
    try {
        await Deno.writeTextFile(`${root}/docs/plans/epic.md`, parent.replace("status: verified", "status: reviewed"));
        await git(root, ["add", "docs/plans/epic.md"]);
        await git(root, ["commit", "-m", "prepare parent record before publication"]);
        const commit = await git(root, ["rev-parse", "HEAD"]);
        let publication = createPublicationAttempt({
            attemptId: "prepared-parent",
            planId: "child-id",
            planName: "epic/one",
            targetBranch: "main",
            executionBranch: "feature",
            executionCwd: root,
            publicationRoot: root,
            validatedCommit: commit,
            targetHeadAtSeal: commit,
        });
        publication = advancePublicationAttempt(publication, "artifacts_committed", {
            artifactCommit: commit,
            planPaths: ["docs/plans/epic/one.md", "docs/plans/epic.md"],
        });
        publication = advancePublicationAttempt(publication, "target_integrated", {
            targetBaseCommit: commit,
            integrationCommit: commit,
        });
        publication = advancePublicationAttempt(publication, "target_published", {
            publicationMode: "local",
            publishedCommit: commit,
        });
        assertEquals((await readPublishedDeliverySources(root, publication)).workRecordOwner, undefined);
        publication = advancePublicationAttempt(publication, "publication_verified", {
            verifiedAt: "2026-10-08T10:00:00Z",
        });
        assertEquals(
            (await readPublishedDeliverySources(root, {
                ...publication,
                planPaths: ["docs/plans/epic/one.md"],
            })).workRecordOwner,
            undefined,
        );
        for (const phase of ["publication_verified", "cleanup_complete"] as const) {
            const confirmed = phase === "cleanup_complete"
                ? advancePublicationAttempt(publication, phase, { cleanedAt: "2026-10-08T10:01:00Z" })
                : publication;
            const sources = await readPublishedDeliverySources(root, confirmed);
            assertEquals(sources.delivered.planId, "child-id");
            assertEquals(sources.workRecordOwner?.planId, "parent-id");
            assertEquals(sources.workRecordOwner?.attrs.status, "reviewed");
            const markdown = await readPublishedRecordMarkdown(
                root,
                confirmed,
                sources.workRecordOwner?.attrs.workRecord?.path || "",
            );
            assertEquals(markdown, "# Delivered Epic Work Record\n");
            const artifact = await saveDeliveredWorkRecordEvidence(root, confirmed, markdown || "");
            const report = buildDeliveryReport({
                planName: sources.delivered.name,
                attrs: {
                    ...sources.delivered.attrs,
                    workRecord: { ...sources.workRecordOwner?.attrs.workRecord, path: artifact?.path },
                },
                publication: confirmed,
                guidedReview: "auto",
                codeReview: "none",
                workRecordFailed: false,
                semanticRequired: true,
            });
            assertEquals(report.planId, "child-id");
            assertEquals(report.rows.find((row) => row.label === "Work Record")?.outcome, "Created");
            assertEquals(report.artifacts.find((entry) => entry.kind === "work-record")?.path, artifact?.path);
            assertEquals(await Deno.readTextFile(`${root}/${artifact?.path}`), markdown);
        }
        await Deno.writeTextFile(
            `${root}/docs/plans/epic.md`,
            parent
                .replace("status: verified", "status: reviewed").replace("epicCompletionMode: done_enough\n", ""),
        );
        await git(root, ["add", "docs/plans/epic.md"]);
        await git(root, ["commit", "-m", "parent remains unfinished"]);
        assertEquals(
            (await readPublishedDeliverySources(root, {
                ...publication,
                artifactCommit: await git(root, ["rev-parse", "HEAD"]),
            })).workRecordOwner,
            undefined,
        );
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});
