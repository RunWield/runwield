import { test } from "node:test";
import { equal, rejects } from "node:assert/strict";
import {
    authorLocalPlan,
    loadPlan,
    readPlanDocuments,
    savePlanDefinition,
    withLocalPlanWorkflow,
    operatePlanFile,
} from "./index.ts";
import { seedPlanState } from "../shared/testing/plan-state-fixture.ts";
import { packageFixture } from "../shared/testing/plan-package-fixture.ts";

test("competing authoring commands preserve one complete context and validation generation", async () => {
    const fixture = await packageFixture();
    try {
        await authorLocalPlan(fixture.root, {
            planName: "proposal",
            contextMarkdown: "# Original\n",
            validationMarkdown: "Original checks\n",
        });
        const before = (await loadPlan(fixture.root, "proposal"))!;
        const results = await Promise.allSettled(
            ["A", "B"].map((generation) =>
                authorLocalPlan(fixture.root, {
                    planName: "proposal",
                    expectedRevision: before.revision,
                    contextMarkdown: `# ${generation}\n`,
                    validationMarkdown: `${generation} checks\n`,
                }),
            ),
        );
        equal(results.filter((result) => result.status === "fulfilled").length, 1);
        equal(results.filter((result) => result.status === "rejected").length, 1);
        const saved = (await loadPlan(fixture.root, "proposal"))!;
        const validation = await withLocalPlanWorkflow(fixture.root, "proposal", () =>
            readPlanDocuments(saved.attrs.planId!, "validation.md"),
        );
        equal(validation.body, `${saved.markdown.slice(2).trim()} checks\n`);
        equal(saved.attrs.status, "draft");
    } finally {
        await fixture.cleanup();
    }
});

test("definition commands reject protected lifecycle fields without changing the Plan", async () => {
    const fixture = await packageFixture();
    try {
        const counterfeitIdentity = { summary: "Counterfeit", planId: "foreign-id" };
        await rejects(
            authorLocalPlan(fixture.root, {
                planName: "proposal",
                contextMarkdown: "# Proposal\n",
                definition: counterfeitIdentity,
            }),
            /protected field: planId/,
        );
        equal(await loadPlan(fixture.root, "proposal"), null);
        await authorLocalPlan(fixture.root, { planName: "proposal", contextMarkdown: "# Proposal\n" });
        const before = (await loadPlan(fixture.root, "proposal"))!;
        const invalidDefinition = { summary: "Unexpected summary", status: "verified" };
        await rejects(
            savePlanDefinition(fixture.root, "proposal", invalidDefinition, { expectedRevision: before.revision }),
            /protected field: status/,
        );
        const after = (await loadPlan(fixture.root, "proposal"))!;
        equal(after.revision, before.revision);
        equal(after.attrs.status, "draft");
        equal(after.markdown, before.markdown);
    } finally {
        await fixture.cleanup();
    }
});

test("Plan file commands preserve exact whitespace and reject a stale edit through the owner interface", async () => {
    const fixture = await packageFixture();
    try {
        await authorLocalPlan(fixture.root, {
            planName: "proposal",
            contextMarkdown: "# Proposal\n\n  exact text  \n",
        });
        const before = (await loadPlan(fixture.root, "proposal"))!;
        await operatePlanFile(fixture.root, {
            path: before.path,
            mode: "edit",
            oldText: "  exact text  ",
            newText: "  new text  ",
        });
        await rejects(
            operatePlanFile(fixture.root, {
                path: before.path,
                mode: "edit",
                oldText: "  exact text  ",
                newText: "lost",
            }),
            /not found/,
        );
        equal((await loadPlan(fixture.root, "proposal"))!.markdown, "# Proposal\n\n  new text  \n");
    } finally {
        await fixture.cleanup();
    }
});

import {
    selectPlanAccess,
    withPlanAccess,
    resumePlanAttempt,
    recordPlanEvent,
    reservePlanExecution,
    capturePlanExecutionContext,
    readFrozenPlanExecutionDocuments,
    type PlanAccess,
} from "./index.ts";

test("serialized Plan access resumes through owner validation and rejects a different repository", async () => {
    const first = await packageFixture();
    const other = await packageFixture();
    try {
        await authorLocalPlan(first.root, { planName: "proposal", contextMarkdown: "# Proposal\n" });
        const access = (await selectPlanAccess(first.root, "proposal"))!;
        const restored: PlanAccess = JSON.parse(JSON.stringify(access));
        equal(
            await withPlanAccess(first.root, restored, async () => (await loadPlan(first.root, "proposal"))!.markdown),
            "# Proposal\n",
        );
        await rejects(
            withPlanAccess(other.root, restored, async () => {}),
            /launch owner and repository/,
        );
        const before = (await loadPlan(first.root, "proposal"))!;
        await authorLocalPlan(first.root, {
            planName: "proposal",
            expectedRevision: before.revision,
            contextMarkdown: "# Changed\n",
        });
        await rejects(
            withPlanAccess(first.root, restored, async () => {}),
            /selection changed/,
        );
    } finally {
        await first.cleanup();
        await other.cleanup();
    }
});

test("execution reservation binds the target once and resumes frozen documents after live edits", async () => {
    const fixture = await packageFixture();
    try {
        await authorLocalPlan(fixture.root, { planName: "proposal", contextMarkdown: "# Reviewed\n" });
        await recordPlanEvent({
            cwd: fixture.root,
            planName: "proposal",
            event: "review_approved",
            currentStatus: "draft",
        });
        await recordPlanEvent({
            cwd: fixture.root,
            planName: "proposal",
            event: "readiness_passed",
            currentStatus: "approved",
        });
        const context = await withLocalPlanWorkflow(fixture.root, "proposal", async () => {
            const attempts = await Promise.all(
                ["attempt-a", "attempt-b"].map((suggestedAttemptId) =>
                    reservePlanExecution("proposal", { targetBranch: "main", suggestedAttemptId }),
                ),
            );
            equal(attempts[0], attempts[1]);
            return (await capturePlanExecutionContext("proposal"))!;
        });
        const live = (await loadPlan(fixture.root, "proposal"))!;
        equal(live.attrs.targetBranch, "main");
        await authorLocalPlan(fixture.root, {
            planName: "proposal",
            expectedRevision: live.revision,
            contextMarkdown: "# Edited later\n",
        });
        const restored: PlanAccess = JSON.parse(JSON.stringify(context.packageSelection));
        const beforeRejectedResume = (await loadPlan(fixture.root, "proposal"))!;
        await rejects(
            resumePlanAttempt(
                fixture.root,
                restored,
                "another-attempt",
                () => Promise.reject(new Error("must not execute")),
                "proposal",
            ),
            /attempt binding changed/,
        );
        equal((await loadPlan(fixture.root, "proposal"))!.revision, beforeRejectedResume.revision);
        await resumePlanAttempt(
            fixture.root,
            restored,
            context.packageAttemptId,
            async () => {
                const frozen = (await readFrozenPlanExecutionDocuments("proposal", context.packageInput))!;
                equal(frozen.approvedMarkdown, "# Reviewed\n");
                await rejects(
                    readFrozenPlanExecutionDocuments("proposal", {
                        ...context.packageInput,
                        definitionHash: "altered",
                    }),
                    /recorded attempt/,
                );
            },
            "proposal",
        );
    } finally {
        await fixture.cleanup();
    }
});

import { savePlanProse, capturePlanReadContext } from "./index.ts";

test("public prose and definition writes enforce revisions while long-lived reads refresh", async () => {
    const fixture = await packageFixture();
    try {
        await authorLocalPlan(fixture.root, { planName: "proposal", contextMarkdown: "# Original\n" });
        const before = (await loadPlan(fixture.root, "proposal"))!;
        const readContext = await withLocalPlanWorkflow(fixture.root, "proposal", () =>
            Promise.resolve(capturePlanReadContext()),
        );
        await savePlanDefinition(
            fixture.root,
            "proposal",
            { summary: "New title" },
            { expectedRevision: before.revision },
        );
        await rejects(
            savePlanProse(fixture.root, "proposal", "# Lost update\n", before.revision),
            /changed|stale|revision/i,
        );
        const current = await readContext(fixture.root, () => loadPlan(fixture.root, "proposal"));
        equal(current!.attrs.summary, "New title");
        await savePlanProse(fixture.root, "proposal", "# Current prose\n", current!.revision);
        const after = (await loadPlan(fixture.root, "proposal"))!;
        equal(after.markdown, "# Current prose\n");
        equal(after.attrs.status, "draft");
        equal(after.attrs.summary, "New title");
        await rejects(
            savePlanDefinition(
                fixture.root,
                "proposal",
                { summary: "Lost title" },
                { expectedRevision: current!.revision },
            ),
            /changed|stale|revision/i,
        );
        equal((await loadPlan(fixture.root, "proposal"))!.revision, after.revision);
    } finally {
        await fixture.cleanup();
    }
});

test("simultaneous first creation serializes catalog discovery and keeps complete distinct Plans", async () => {
    const fixture = await packageFixture();
    try {
        const raced = await Promise.allSettled(
            ["A", "B"].map((value) =>
                authorLocalPlan(fixture.root, {
                    planName: "first",
                    contextMarkdown: `# ${value}\n`,
                    validationMarkdown: `${value} checks\n`,
                }),
            ),
        );
        equal(raced.filter((entry) => entry.status === "fulfilled").length, 1);
        equal(raced.filter((entry) => entry.status === "rejected").length, 1);
        const first = (await loadPlan(fixture.root, "first"))!;
        const validation = await withLocalPlanWorkflow(fixture.root, "first", () =>
            readPlanDocuments(first.attrs.planId!, "validation.md"),
        );
        equal(validation.body, `${first.body.slice(2).trim()} checks\n`);
        await Promise.all(
            ["second", "third"].map((name) =>
                authorLocalPlan(fixture.root, { planName: name, contextMarkdown: `# ${name}\n` }),
            ),
        );
        equal((await loadPlan(fixture.root, "second"))!.body, "# second\n");
        equal((await loadPlan(fixture.root, "third"))!.body, "# third\n");
    } finally {
        await fixture.cleanup();
    }
});

import { renamePlan, findPlanById } from "./index.ts";
test("rename preserves identity and refuses a stale definition without replacing another Plan", async () => {
    const fixture = await packageFixture();
    try {
        await authorLocalPlan(fixture.root, { planName: "old", contextMarkdown: "# Original\n" });
        const before = (await loadPlan(fixture.root, "old"))!;
        await renamePlan(fixture.root, before.attrs.planId!, "new", before.revision);
        equal(await loadPlan(fixture.root, "old"), null);
        const renamed = await findPlanById(fixture.root, before.attrs.planId!);
        equal(renamed.name, "new");
        equal(renamed.body, before.body);
        await rejects(renamePlan(fixture.root, "new", "lost", before.revision), /changed|stale|revision/i);
        equal((await findPlanById(fixture.root, before.attrs.planId!)).name, "new");
    } finally {
        await fixture.cleanup();
    }
});

import { listPlanHistory, restorePlanMilestone, showPlanMilestone } from "./index.ts";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { deepEqual, notEqual } from "node:assert/strict";

test("non-Git history freezes the approved package and restores its membership against a whole-package revision", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "plan-history-"));
    try {
        await authorLocalPlan(cwd, {
            planName: "proposal",
            contextMarkdown: "# Original\n",
            validationMarkdown: "Original checks\n",
        });
        const plan = (await loadPlan(cwd, "proposal"))!;
        const folder = dirname(plan.path);
        const id = plan.attrs.planId!;
        equal((await listPlanHistory(cwd, id)).milestones.length, 0);
        await writeFile(join(folder, "manual-qa.md"), "\ufeffOriginal QA\n");
        await recordPlanEvent({ cwd, planName: "proposal", event: "review_approved", currentStatus: "draft" });
        const history = await listPlanHistory(cwd, "proposal");
        deepEqual(
            history.milestones.map((entry) => entry.milestone),
            ["approved"],
        );
        const version = history.milestones[0].version;
        await writeFile(join(folder, "validation.md"), "Live checks");
        await rejects(restorePlanMilestone(cwd, id, version, history.revision), /[Ss]tale|changed/);
        equal(await readFile(join(folder, "validation.md"), "utf8"), "Live checks");
        await writeFile(join(folder, "integration-report.md"), "Later report");
        await rm(join(folder, "manual-qa.md"));
        const frozen = await showPlanMilestone(cwd, id, version);
        equal(frozen["manual-qa.md"], "\ufeffOriginal QA\n");
        equal(frozen["validation.md"], "Original checks\n");
        const before = await listPlanHistory(cwd, id);
        const revision = await restorePlanMilestone(cwd, id, version, before.revision);
        notEqual(revision, before.revision);
        equal((await loadPlan(cwd, "proposal"))!.attrs.status, "draft");
        equal(await readFile(join(folder, "manual-qa.md"), "utf8"), "\ufeffOriginal QA\n");
        await rejects(access(join(folder, "integration-report.md")), /ENOENT/);
        await recordPlanEvent({ cwd, planName: "proposal", event: "review_approved", currentStatus: "draft" });
        await recordPlanEvent({
            cwd,
            planName: "proposal",
            event: "manual_user_verified",
            currentStatus: "approved",
            details: { userVerificationNote: "Accepted by owner" },
        });
        const milestones = (await listPlanHistory(cwd, id)).milestones;
        deepEqual(
            milestones.map((entry) => entry.milestone),
            ["approved", "approved", "closed"],
        );
        equal(milestones[2].reason, "Accepted by owner");
        notEqual(milestones[0].version, milestones[1].version);
        await recordPlanEvent({ cwd, planName: "proposal", event: "review_reopened", currentStatus: "user_verified" });
        const reopened = (await loadPlan(cwd, "proposal"))!;
        await restorePlanMilestone(cwd, id, milestones[2].version, reopened.revision!);
        const restored = (await loadPlan(cwd, "proposal"))!;
        equal(restored.attrs.status, "draft");
        equal(restored.attrs.userVerifiedAt, reopened.attrs.userVerifiedAt);
        equal(restored.attrs.publicationReceipt, reopened.attrs.publicationReceipt);
        equal(restored.attrs.worktreeId, reopened.attrs.worktreeId);
        await seedPlanState(cwd, "proposal", {
            collaborationState: "remote_canonical",
            collaborationServerUrl: "https://example.test",
            collaborationSpaceId: "space",
        });
        const shared = await listPlanHistory(cwd, id);
        await rejects(restorePlanMilestone(cwd, id, version, shared.revision), /shared Plan is remote-canonical/);
        equal((await listPlanHistory(cwd, id)).revision, shared.revision);
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("an interrupted restore preserves an intervening edit and resumes one complete generation", async () => {
    const fixture = await packageFixture();
    try {
        await authorLocalPlan(fixture.root, {
            planName: "proposal",
            contextMarkdown: "# Approved\n",
            validationMarkdown: "Checks\n",
        });
        await recordPlanEvent({
            cwd: fixture.root,
            planName: "proposal",
            event: "review_approved",
            currentStatus: "draft",
        });
        const { planId, milestones } = await listPlanHistory(fixture.root, "proposal");
        const folder = dirname((await loadPlan(fixture.root, "proposal"))!.path);
        await writeFile(join(folder, "context.md"), "# Before restore\n");
        await writeFile(join(folder, "validation.md"), "Before checks\n");
        const before = await listPlanHistory(fixture.root, planId);
        const revision = await restorePlanMilestone(fixture.root, planId, milestones[0].version, before.revision);
        const batchPath = join(
            fixture.identity.executionAccountHome,
            ".wld",
            "projects",
            fixture.identity.projectId,
            "internal",
            "plan-packages",
            "batch.json",
        );
        const batch = JSON.parse(await readFile(batchPath, "utf8"));
        // Reopen the durable restore intent after one document landed and an editor changed another.
        await writeFile(batchPath, JSON.stringify({ ...batch, phase: "pending" }));
        await writeFile(
            join(folder, "plan.wld.json"),
            JSON.stringify(batch.authoring[0].before.metadata, null, 2) + "\n",
        );
        await writeFile(join(folder, "validation.md"), "External work\n");
        await rejects(listPlanHistory(fixture.root, planId), /changed during authoring/);
        equal(await readFile(join(folder, "validation.md"), "utf8"), "External work\n");
        equal(await readFile(join(folder, "context.md"), "utf8"), "# Approved\n");
        await writeFile(join(folder, "validation.md"), "Before checks\n");
        equal((await listPlanHistory(fixture.root, planId)).revision, revision);
        equal(await readFile(join(folder, "validation.md"), "utf8"), "Checks\n");
        equal((await loadPlan(fixture.root, "proposal"))?.attrs.status, "draft");
    } finally {
        await fixture.cleanup();
    }
});
