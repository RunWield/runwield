import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { findPlansByParent, loadPlan, savePlan, updatePlanFrontMatter } from "../../plan-store.js";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";
import { createGitPort } from "../git-port.ts";
import { HostedSession } from "../session/hosted-session.js";
import { addEntry } from "../worktree-registry.js";
import { recordPlanEvent } from "./plan-lifecycle.js";
import { continueWorkflowValidation } from "./validation-supervisor.ts";
import { attachRecorder, makeUi } from "./validation-test-helpers.js";

const fixture = defineCommittedGitFixture({ ".gitignore": ".wld/\n", "app.ts": "// app\n" });

async function register(root: string, path: string, id: string, planName: string, retired = false) {
    await addEntry(root, {
        id,
        planId: planName,
        planName,
        path,
        branch: `worktree/${id}`,
        baseBranch: "main",
        baseRef: "refs/heads/main",
        baseCommit: await git(path, ["rev-parse", "HEAD"]),
        baseTree: await git(path, ["rev-parse", "HEAD^{tree}"]),
        executionBaselineTree: await git(path, ["rev-parse", "HEAD^{tree}"]),
        status: retired ? "abandoned" : "completed",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    });
}

for (const event of ["manual_user_verified", "validation_passed"] as const) {
    Deno.test(`${event} reads independently added siblings from their own worktrees`, async () => {
        const root = await fixture.checkout();
        const temp = await Deno.makeTempDir({ prefix: "rw-sibling-authority-" });
        const a = join(temp, "a");
        const b = join(temp, "b");
        try {
            await savePlan(root, "epic", "# Epic\n", {
                planId: "epic",
                classification: "PROJECT",
                status: "ready_for_work",
            });
            await savePlan(root, "epic/a", "# A\n", {
                planId: "epic/a",
                classification: "PLANNED_CHANGE",
                parentPlan: "epic",
                status: event === "validation_passed" ? "reviewed" : "implemented",
            });
            await git(root, ["add", "."]);
            await git(root, ["commit", "-m", "first child"]);
            await git(root, ["worktree", "add", "-b", "worktree/a", a]);
            await savePlan(root, "epic/b", "# B\n", {
                planId: "epic/b",
                classification: "PLANNED_CHANGE",
                parentPlan: "epic",
                status: "implemented",
            });
            await git(root, ["add", "."]);
            await git(root, ["commit", "-m", "second child"]);
            await git(root, ["worktree", "add", "-b", "worktree/b", b]);
            await register(root, a, "a", "epic/a");
            await register(root, b, "b", "epic/b");
            const sibling = await loadPlan(b, "epic/b");
            assert(sibling);
            await updatePlanFrontMatter(b, "epic/b", { status: "user_verified" }, {}, {
                expectedRevision: sibling.revision,
            });
            const primary = await loadPlan(root, "epic");
            assert(primary);
            assertEquals((await findPlansByParent(a, "epic")).map((plan) => plan.name).sort(), ["epic/a", "epic/b"]);
            const child = await loadPlan(a, "epic/a");
            assert(child);
            await recordPlanEvent({
                cwd: root,
                planName: "epic/a",
                event,
                currentStatus: child.attrs.status,
                details: {
                    userVerificationNote: "Checked independently.",
                    deliveryEvidence: {
                        version: 1,
                        mode: "worktree_merge",
                        executionCommit: await git(a, ["rev-parse", "HEAD"]),
                        targetBranch: "main",
                        targetHeadBeforeMerge: await git(root, ["rev-parse", "HEAD"]),
                    },
                },
            });
            assertEquals(
                (await loadPlan(a, "epic/a"))?.attrs.status,
                event === "validation_passed" ? "verified" : "user_verified",
            );
            assertEquals((await loadPlan(a, "epic"))?.attrs.status, "verified");
            assertEquals((await loadPlan(root, "epic"))?.markdown, primary.markdown);
        } finally {
            for (const tree of [a, b]) await git(root, ["worktree", "remove", "--force", tree]).catch(() => {});
            await Deno.remove(root, { recursive: true });
            await Deno.remove(temp, { recursive: true });
        }
    });
}

for (const surface of ["primary", "execution"]) {
    Deno.test(`validation from ${surface} ignores a retired Session directory and runs CI in the registered successor`, async () => {
        const root = await fixture.checkout();
        const temp = await Deno.makeTempDir({ prefix: "rw-validation-authority-" });
        const retired = join(temp, "retired");
        const current = join(temp, "current");
        const session = attachRecorder(
            new HostedSession({ id: "stale-session", cwd: surface === "primary" ? root : retired }),
            makeUi(),
        );
        try {
            await savePlan(root, "demo", "# Demo\n", {
                planId: "demo",
                classification: "PLANNED_CHANGE",
                status: "ready_for_work",
                targetBranch: "main",
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
            });
            await git(root, ["add", "."]);
            await git(root, ["commit", "-m", "Plan"]);
            await git(root, ["worktree", "add", "-b", "worktree/retired", retired]);
            await git(root, ["worktree", "add", "-b", "worktree/current", current]);
            await register(root, retired, "retired", "demo", true);
            await register(root, current, "current", "demo");
            const plan = await loadPlan(current, "demo");
            assert(plan);
            await updatePlanFrontMatter(current, "demo", { status: "implemented" }, {}, {
                expectedRevision: plan.revision,
            });
            await Deno.writeTextFile(join(current, "app.ts"), "// implemented\n");
            const implemented = await loadPlan(current, "demo");
            assert(implemented);
            session.setActiveExecutionWorkflow({
                planName: "demo",
                triageMeta: plan.attrs,
                executionAgent: "engineer",
                executionMode: "worktree",
                projectRoot: root,
                executionCwd: retired,
                worktreeId: "retired",
                worktreeBranch: "worktree/retired",
            });
            let ciRuns = 0;
            await continueWorkflowValidation({
                hostedSession: session,
                planName: "demo",
                planContent: implemented.markdown,
                triageMeta: implemented.attrs,
                git: createGitPort(),
                localCI: {
                    run: async ({ cwd }) => {
                        assertEquals(cwd, await Deno.realPath(current));
                        ciRuns++;
                        return { kind: "completed", exitCode: 0, output: "ok" };
                    },
                },
                semanticReviewPort: { runIsolatedAgentSession: () => Promise.reject(new Error("stop after CI proof")) },
                workRecordMnemotecaPort: { run: () => Promise.reject(new Error("publication is not expected")) },
            });
            assertEquals(ciRuns, 1);
            const afterCi = await loadPlan(current, "demo");
            assertEquals(afterCi?.attrs.status, "implemented");
            assertEquals(afterCi?.attrs.validationPhase, "semantic");
            assertEquals((await loadPlan(retired, "demo"))?.attrs.status, "ready_for_work");
        } finally {
            session.dispose();
            for (const tree of [retired, current]) {
                await git(root, ["worktree", "remove", "--force", tree]).catch(() => {});
            }
            await Deno.remove(root, { recursive: true });
            await Deno.remove(temp, { recursive: true });
        }
    });
}
