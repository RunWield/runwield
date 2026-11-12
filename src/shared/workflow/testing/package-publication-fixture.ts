import fs from "node:fs/promises";
import { join } from "node:path";
import { packageFixture, create, read } from "../../testing/plan-package-fixture.ts";
import { loadPackageWorkflowPlan, type PackageWorkflowSelection } from "../../../plan-store/workflows.ts";
import { withPackageWorkflow } from "../../../plan-store/workflows.ts";
import { recordPlanEvent } from "../plan-lifecycle.js";
import { createExecutionStartPorts, startActiveExecutionWorkflow } from "../execution-start.ts";
import { finalizePlanImplementation } from "../implementation-checkpoint.ts";
import { git } from "../../git-test-fixture.ts";
import { captureForegroundProcess } from "../../captured-process.ts";
import type { DeliveryCopy, PackageDocuments } from "../../../plan-store/packages.ts";

export async function publicationFixture(
    plans = false,
    records: DeliveryCopy[] = [],
    family?: "child" | "epic" | "last-child",
    local = false,
    documents?: PackageDocuments,
    supersedes?: string[],
) {
    const f = await packageFixture();
    const remote = `${f.root}-remote.git`;
    await git(f.root, ["clone", "--bare", f.root, remote]);
    if (!local) {
        await git(f.root, ["remote", "add", "origin", remote]);
        await git(f.root, ["config", "branch.main.remote", "origin"]);
        await git(f.root, ["config", "branch.main.merge", "refs/heads/main"]);
    }
    if (family === "child" || family === "last-child")
        await create(f.identity, {
            planId: "parent",
            name: "parent",
            documents: { "context.md": "# Delivered Epic context\n", "validation.md": "Epic verification\n" },
            definition: {
                classification: "PROJECT",
                type: "sequence",
                ...(family === "last-child"
                    ? { status: "ready_for_work" as const }
                    : {
                          status: "closed_without_verification" as const,
                          epicCompletionMode: "done_enough" as const,
                          closedWithoutVerificationReason: "Scope accepted",
                      }),
                targetBranch: "main",
                tickets: [{ url: "https://example.com/epic/1", title: "Epic ticket" }],
            },
        });
    if (family && family !== "last-child")
        await create(f.identity, {
            planId: "sibling",
            name: "sibling",
            parentPlanId: family !== "epic" ? "parent" : "plan-one",
            definition: {
                classification: "PLANNED_CHANGE",
                status: "verified",
                targetBranch: "main",
                tickets: [{ url: "https://example.com/child/2", title: "Child ticket" }],
            },
        });
    const p = await create(f.identity, {
        ...(documents ? { documents } : {}),
        ...(family === "child" || family === "last-child" ? { parentPlanId: "parent" } : {}),
        definition: {
            classification: family === "epic" ? "PROJECT" : "PLANNED_CHANGE",
            ...(family === "epic" ? { type: "sequence" as const } : {}),
            status: "draft",
            ...(supersedes ? { supersedes } : {}),
            ...(family === "epic" ? {} : { executionAgent: "engineer", collaborationRecommendation: "autonomous" }),
            targetBranch: "main",
        },
    });
    const selection: PackageWorkflowSelection = {
        identity: f.identity,
        planId: p.metadata.planId,
        expectedRevision: 1,
        deliveryCopies: { plans, workRecords: records },
    };
    let workflow = await withPackageWorkflow(f.root, selection, async () => {
        await recordPlanEvent({ cwd: f.root, planName: "one", event: "review_approved", currentStatus: "draft" });
        await recordPlanEvent({ cwd: f.root, planName: "one", event: "readiness_passed", currentStatus: "approved" });
        const workflow = await startActiveExecutionWorkflow({
            cwd: f.root,
            planName: "one",
            currentStatus: "ready_for_work",
            triageMeta: (await loadPackageWorkflowPlan("one")).attrs,
            ports: createExecutionStartPorts(),
        });
        await fs.writeFile(join(workflow.executionCwd!, "code.txt"), "code\n");
        await finalizePlanImplementation({ projectRoot: f.root, planName: "one", executionContext: workflow });
        await recordPlanEvent({
            cwd: f.root,
            planName: "one",
            event: "mechanical_validation_passed",
            currentStatus: "implemented",
        });
        await recordPlanEvent({
            cwd: f.root,
            planName: "one",
            event: "semantic_review_passed",
            currentStatus: "implemented",
        });
        return workflow;
    });
    const configPath = join(f.root, ".wld/package-driver.json");
    const config = {
        projectRoot: f.root,
        attemptId: workflow.worktreeId!,
        planName: "one",
        targetBranch: "main",
        executionBranch: workflow.worktreeBranch!,
        executionCwd: workflow.executionCwd!,
        packageSelection: selection,
    };
    return {
        ...f,
        remote,
        p,
        get workflow() {
            return workflow;
        },
        config,
        async implementNext(context?: string) {
            const current = await read(f.identity);
            if (context !== undefined) await fs.writeFile(join(current.path, "context.md"), context);
            await withPackageWorkflow(
                f.root,
                { ...selection, expectedRevision: current.metadata.revision },
                async () => {
                    await recordPlanEvent({
                        cwd: f.root,
                        planName: "one",
                        event: "review_reopened",
                        currentStatus: "verified",
                    });
                    await recordPlanEvent({
                        cwd: f.root,
                        planName: "one",
                        event: "review_approved",
                        currentStatus: "draft",
                    });
                    await recordPlanEvent({
                        cwd: f.root,
                        planName: "one",
                        event: "readiness_passed",
                        currentStatus: "approved",
                    });
                    workflow = await startActiveExecutionWorkflow({
                        cwd: f.root,
                        planName: "one",
                        currentStatus: "ready_for_work",
                        triageMeta: (await loadPackageWorkflowPlan("one")).attrs,
                        ports: createExecutionStartPorts(),
                    });
                    await fs.writeFile(join(workflow.executionCwd!, "code.txt"), "second implementation\n");
                    await finalizePlanImplementation({
                        projectRoot: f.root,
                        planName: "one",
                        executionContext: workflow,
                    });
                    await recordPlanEvent({
                        cwd: f.root,
                        planName: "one",
                        event: "mechanical_validation_passed",
                        currentStatus: "implemented",
                    });
                    await recordPlanEvent({
                        cwd: f.root,
                        planName: "one",
                        event: "semantic_review_passed",
                        currentStatus: "implemented",
                    });
                    Object.assign(config, {
                        attemptId: workflow.worktreeId!,
                        executionBranch: workflow.worktreeBranch!,
                        executionCwd: workflow.executionCwd!,
                    });
                },
            );
        },
        async scope<T>(run: () => Promise<T>) {
            return await withPackageWorkflow(
                f.root,
                { ...selection, expectedRevision: (await read(f.identity)).metadata.revision },
                run,
            );
        },
        async drive(crashAfter?: string, operation?: "revalidate" | "validate") {
            await fs.mkdir(join(f.root, ".wld"), { recursive: true });
            await fs.writeFile(configPath, JSON.stringify({ ...config, crashAfter, operation }));
            const result = await captureForegroundProcess(process.execPath, {
                cwd: f.root,
                args: [new URL("./package-publication-process.ts", import.meta.url).pathname, configPath],
            });
            return {
                code: result.code,
                text: new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr),
            };
        },
        async cleanup() {
            await git(f.root, ["worktree", "remove", "--force", workflow.executionCwd!]).catch(() => {});
            await fs.rm(remote, { recursive: true, force: true });
            await f.cleanup();
        },
    };
}
