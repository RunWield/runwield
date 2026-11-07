import { updatePlanPackageMetadata } from "../plan-package-store.ts";
import { getWorktreeRegistryPath } from "../worktree-registry.js";
import { settleDiscardedRecoveryAttempt } from "../../cmd/load-plan/plan-recovery-discard.ts";
import { preparePlanWorkflow } from "./plan-preparation.ts";
import { createGitPort } from "../git-port.ts";
import { systemLocalCIPort } from "./validation-local-ci.ts";
import { SYSTEM_WORK_RECORD_MNEMOTECA_PORT } from "../work-records/mnemoteca-port.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { HostedSession } from "../session/hosted-session.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { executePlan } from "./plan-executor.ts";
import { finalizePlanImplementation } from "./implementation-checkpoint.ts";
import { runValidationAttempt } from "./validation-supervisor.ts";
import { admitProjectIdentity, inspectProjectIdentity } from "../project-identity.ts";
import { test } from "node:test";
import { equal, ok, rejects, deepEqual } from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { create, read, packageFixture, startDriver } from "../testing/plan-package-fixture.ts";
import { withPackageWorkflow, loadPackageWorkflowPlan } from "./package-workflow.ts";
import { recordPlanEvent } from "./plan-lifecycle.js";
import { startActiveExecutionWorkflow, createExecutionStartPorts } from "./execution-start.ts";
import { inspectWorktreeRegistry } from "../worktree-registry.js";
import { git } from "../git-test-fixture.ts";

test("package execution prepares an isolated code worktree without materializing the Plan", async () => {
    const f = await packageFixture();
    try {
        const p = await create(f.identity, {
            definition: {
                classification: "PLANNED_CHANGE",
                status: "draft",
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
                targetBranch: "main",
            },
        });
        const workflow = await withPackageWorkflow(
            f.root,
            { identity: f.identity, planId: p.metadata.planId, expectedRevision: 1 },
            async () => {
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
                const plan = await loadPackageWorkflowPlan("one");
                return await startActiveExecutionWorkflow({
                    cwd: f.root,
                    planName: "one",
                    triageMeta: plan.attrs,
                    currentStatus: "ready_for_work",
                    ports: createExecutionStartPorts(),
                });
            },
        );
        ok(workflow.executionCwd && workflow.executionCwd !== f.root);
        equal(workflow.executionMode, "worktree");
        await rejects(fs.access(join(workflow.executionCwd, "docs/plans/one.md")));
        equal((await read(f.identity)).metadata.definition.status, "in_progress");
        const entries = (await inspectWorktreeRegistry(f.root)).entries;
        equal(entries.length, 1);
        equal(entries[0].id, (await read(f.identity)).metadata.workflow?.attempt?.attemptId);
        equal(await fs.readFile(join(workflow.executionCwd, "README.md"), "utf8"), "package fixture\n");
        const current = await read(f.identity);
        await withPackageWorkflow(
            f.root,
            { identity: f.identity, planId: p.metadata.planId, expectedRevision: current.metadata.revision },
            async () => {
                await rejects(
                    recordPlanEvent({
                        cwd: f.root,
                        planName: "one",
                        event: "validation_passed",
                        currentStatus: "in_progress",
                    }),
                    /completion requires applicable publication evidence/,
                );
            },
        );
        await git(f.root, ["worktree", "remove", "--force", workflow.executionCwd]);
    } finally {
        await f.cleanup();
    }
});

test("two linked clones racing execution retain one package attempt and one code worktree", async () => {
    const f = await packageFixture();
    const remote = `${f.root}-remote.git`;
    const clone = `${f.root}-clone`;
    try {
        await git(f.root, ["clone", "--bare", f.root, remote]);
        await git(f.root, ["remote", "add", "origin", remote]);
        await admitProjectIdentity(f.root);
        await git(f.root, ["clone", remote, clone]);
        const pending = inspectProjectIdentity(clone);
        ok(pending.kind === "pending");
        const linked = await admitProjectIdentity(clone, {
            choice: { kind: "link", candidates: pending.candidates, projectId: f.identity.projectId },
        });
        ok(linked.kind === "existing");
        await git(clone, ["config", "user.name", "Fixture"]);
        await git(clone, ["config", "user.email", "fixture@example.com"]);
        await fs.writeFile(join(clone, "README.md"), "latest remote code\n");
        await git(clone, ["add", "README.md"]);
        await git(clone, ["commit", "-m", "advance target"]);
        await git(clone, ["push", "origin", "main"]);
        const latestTarget = await git(clone, ["rev-parse", "HEAD"]);
        const sibling = await create(f.identity, { planId: "sibling", name: "sibling" });
        const p = await create(f.identity, {
            definition: {
                classification: "PLANNED_CHANGE",
                status: "draft",
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
                targetBranch: "main",
            },
        });
        await withPackageWorkflow(
            f.root,
            { identity: f.identity, planId: p.metadata.planId, expectedRevision: 1 },
            async () => {
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
            },
        );
        const barrier = join(f.root, "start-barrier");
        const first = startDriver({ identity: f.identity, command: "execution", barrier });
        const second = startDriver({ identity: linked.identity, command: "execution", barrier });
        await Promise.all([first.ready(), second.ready()]);
        await fs.writeFile(barrier, "go");
        const outcomes = await Promise.all([first.done, second.done]);
        equal(outcomes.filter((result) => result.code === 0).length, 1, JSON.stringify(outcomes));
        ok(
            outcomes.some((result) => result.output.includes("PackageExecutionContinuation")),
            JSON.stringify(outcomes),
        );
        const entries = [
            ...(await inspectWorktreeRegistry(f.root)).entries,
            ...(await inspectWorktreeRegistry(clone)).entries,
        ];
        equal(entries.length, 1);
        equal(entries[0].baseCommit, latestTarget);
        await fs.writeFile(join(sibling.path, "context.md"), "# Live sibling edit from another checkout\n");
        await withPackageWorkflow(
            clone,
            { identity: linked.identity, planId: "sibling", expectedRevision: 1 },
            async () => {
                equal((await loadPackageWorkflowPlan("sibling")).body, "# Live sibling edit from another checkout\n");
            },
        );
        const binding = (await read(f.identity)).metadata.workflow?.attempt;
        equal(entries[0].id, binding?.attemptId);
        equal(entries[0].planId, p.metadata.planId);
        await settleDiscardedRecoveryAttempt(binding!.repositoryRoot, "one", p.metadata.planId, entries[0], true);
        const otherIdentity = binding!.repositoryId === f.identity.repositoryId ? linked.identity : f.identity;
        const current = await read(f.identity);
        const prepared = await preparePlanWorkflow(otherIdentity.checkoutRoot, "one", {
            identity: otherIdentity,
            planId: p.metadata.planId,
            expectedRevision: current.metadata.revision,
        });
        equal(prepared.plan?.attrs.worktreeId, undefined);
        equal((await read(f.identity)).metadata.workflow?.attempt, undefined);
        equal(await fs.readFile(join(entries[0].path, "README.md"), "utf8"), "latest remote code\n");
        await git(binding!.repositoryRoot, ["worktree", "remove", "--force", entries[0].path]);
    } finally {
        await fs.rm(clone, { recursive: true, force: true });
        await fs.rm(remote, { recursive: true, force: true });
        await f.cleanup();
    }
});

test("package dispatch supplies frozen complete context and checkpoints real implementation", async () => {
    await withRuntimeCommandFixture("package-dispatch-", async ({ projectRoot, setModelResponseFactories }) => {
        await git(projectRoot, ["init", "-b", "main"]);
        await git(projectRoot, ["config", "user.name", "Fixture"]);
        await git(projectRoot, ["config", "user.email", "fixture@example.com"]);
        await fs.writeFile(join(projectRoot, "README.md"), "base\n");
        await git(projectRoot, ["add", "README.md"]);
        await git(projectRoot, ["commit", "-m", "fixture"]);
        const admitted = await admitProjectIdentity(projectRoot);
        ok(admitted.kind === "existing");
        const identity = admitted.identity;
        await create(identity, {
            planId: "parent",
            name: "parent",
            documents: { "context.md": "# Required parent context\n", "validation.md": "Parent verification\n" },
            definition: { classification: "PROJECT", type: "sequence", status: "ready_for_work", targetBranch: "main" },
        });
        const p = await create(identity, {
            parentPlanId: "parent",
            definition: {
                classification: "PLANNED_CHANGE",
                status: "draft",
                order: 1,
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
                targetBranch: "main",
            },
        });
        const manager = SessionManager.inMemory(projectRoot);
        const session = new HostedSession({ id: "package-dispatch", cwd: projectRoot });
        session.setRootSessionManager(manager);
        let prompt = "";
        let turns = 0;
        setModelResponseFactories([
            (context) => {
                prompt += JSON.stringify(context.messages);
                turns++;
                return fauxAssistantMessage(
                    fauxToolCall("write", { path: "implemented.txt", content: "package implementation\n" }),
                );
            },
            () => fauxAssistantMessage(fauxToolCall("task_completed", { message: "Implemented and checked." })),
        ]);
        try {
            await withPackageWorkflow(
                projectRoot,
                { identity, planId: p.metadata.planId, expectedRevision: 1 },
                async () => {
                    await recordPlanEvent({
                        cwd: projectRoot,
                        planName: "one",
                        event: "review_approved",
                        currentStatus: "draft",
                    });
                    await recordPlanEvent({
                        cwd: projectRoot,
                        planName: "one",
                        event: "readiness_passed",
                        currentStatus: "approved",
                    });
                    const result = await executePlan({
                        planName: "one",
                        triageMeta: (await loadPackageWorkflowPlan("one")).attrs,
                        hostedSession: session,
                        sessionManager: manager,
                    });
                    equal(result.executionComplete, true, JSON.stringify({ result, turns }));
                    ok(prompt.includes("Required parent context"));
                    ok(prompt.includes("Parent verification"));
                    ok(prompt.includes("Run checks."));
                    const current = await read(identity);
                    equal(current.metadata.definition.status, "implemented");
                    equal(
                        await fs.readFile(join(result.executionContext!.executionCwd!, "implemented.txt"), "utf8"),
                        "package implementation\n",
                    );
                    await rejects(fs.access(join(result.executionContext!.executionCwd!, "docs/plans/one.md")));
                    const input = current.metadata.workflow!.attempt!.input;
                    await fs.writeFile(join(p.path, "context.md"), "# Later editor change\n");
                    deepEqual((await read(identity)).metadata.workflow!.attempt!.input, input);
                    await rejects(
                        finalizePlanImplementation({
                            projectRoot,
                            planName: "one",
                            executionContext: result.executionContext,
                        }),
                        /changed/,
                    );
                    await rejects(
                        runValidationAttempt({
                            projectRoot,
                            planName: "one",
                            runtime: {
                                kind: "core",
                                args: {
                                    planName: "one",
                                    hostedSession: session,
                                    planContent: "",
                                    triageMeta: {},
                                    git: createGitPort(),
                                    localCI: systemLocalCIPort,
                                    workRecordMnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
                                },
                            },
                        }),
                        /documents changed/,
                    );
                    equal((await read(identity)).metadata.controller.verifiedAt, undefined);
                    await git(projectRoot, ["worktree", "remove", "--force", result.executionContext!.executionCwd!]);
                },
            );
        } finally {
            session.dispose();
        }
    });
});

test("attempt authority rejects owner, repository and Plan substitution while a missing checkout keeps documents readable", async () => {
    const f = await packageFixture();
    try {
        const p = await create(f.identity, {
            definition: {
                classification: "PLANNED_CHANGE",
                status: "draft",
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
                targetBranch: "main",
            },
        });
        await withPackageWorkflow(
            f.root,
            { identity: f.identity, planId: p.metadata.planId, expectedRevision: 1 },
            async () => {
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
                const workflow = await startActiveExecutionWorkflow({
                    cwd: f.root,
                    planName: "one",
                    triageMeta: (await loadPackageWorkflowPlan("one")).attrs,
                    currentStatus: "ready_for_work",
                    ports: createExecutionStartPorts(),
                });
                const original = (await read(f.identity)).metadata.workflow!;
                for (const override of [{ personalOwner: "foreign" }, { repositoryId: crypto.randomUUID() }]) {
                    const current = await read(f.identity);
                    await updatePlanPackageMetadata(f.identity, p.metadata.planId, current.metadata.revision, {
                        workflow: { ...original, attempt: { ...original.attempt!, ...override } },
                    });
                    await rejects(loadPackageWorkflowPlan("one"), /owner changed/);
                }
                const current = await read(f.identity);
                await updatePlanPackageMetadata(f.identity, p.metadata.planId, current.metadata.revision, {
                    workflow: original,
                });
                const registryPath = getWorktreeRegistryPath(f.root);
                const registry = await fs.readFile(registryPath, "utf8");
                await fs.writeFile(
                    registryPath,
                    registry.replace(`"planId": "${p.metadata.planId}"`, `"planId": "substituted"`),
                );
                await rejects(loadPackageWorkflowPlan("one"), /different Plan/);
                await fs.writeFile(registryPath, registry);
                await git(f.root, ["worktree", "remove", "--force", workflow.executionCwd!]);
                equal((await preparePlanWorkflow(f.root, "one")).plan?.path, join(p.path, "context.md"));
                equal((await read(f.identity)).metadata.definition.status, "in_progress");
                equal((await inspectWorktreeRegistry(f.root)).entries.length, 1);
            },
        );
    } finally {
        await f.cleanup();
    }
});

for (const scenario of ["default-target", "reset-abandoned"] as const) {
    test(`package execution completes after ${scenario}`, async () => {
        const f = await packageFixture();
        const paths: string[] = [];
        try {
            const p = await create(f.identity, {
                definition: {
                    classification: "PLANNED_CHANGE",
                    status: "draft",
                    executionAgent: "engineer",
                    collaborationRecommendation: "autonomous",
                },
            });
            await withPackageWorkflow(
                f.root,
                { identity: f.identity, planId: p.metadata.planId, expectedRevision: 1 },
                async () => {
                    const start = async () => {
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
                        const retained = (await read(f.identity)).metadata.workflow!.readiness!;
                        const workflow = await startActiveExecutionWorkflow({
                            cwd: f.root,
                            planName: "one",
                            triageMeta: (await loadPackageWorkflowPlan("one")).attrs,
                            currentStatus: "ready_for_work",
                            ports: createExecutionStartPorts(),
                        });
                        deepEqual(workflow.packageInput!.inputs, retained.inputs);
                        equal((await read(f.identity)).metadata.definition.targetBranch, "main");
                        paths.push(workflow.executionCwd!);
                        return workflow;
                    };
                    let workflow = await start();
                    if (scenario === "reset-abandoned") {
                        const oldId = workflow.worktreeId;
                        await recordPlanEvent({
                            cwd: f.root,
                            planName: "one",
                            event: "plan_held",
                            currentStatus: "in_progress",
                        });
                        const entry = (await inspectWorktreeRegistry(f.root)).entries.find(
                            (entry) => entry.id === oldId,
                        )!;
                        await settleDiscardedRecoveryAttempt(f.root, "one", p.metadata.planId, entry, true);
                        await recordPlanEvent({
                            cwd: f.root,
                            planName: "one",
                            event: "hold_reset_to_draft",
                            currentStatus: "on_hold",
                        });
                        equal((await read(f.identity)).metadata.workflow?.attempt, undefined);
                        workflow = await start();
                        ok(workflow.worktreeId !== oldId);
                        equal(
                            (await inspectWorktreeRegistry(f.root)).entries.find((entry) => entry.id === oldId)?.status,
                            "abandoned",
                        );
                    }
                    await fs.writeFile(join(workflow.executionCwd!, "result.txt"), "implemented\n");
                    await finalizePlanImplementation({
                        projectRoot: f.root,
                        planName: "one",
                        executionContext: workflow,
                    });
                    equal((await read(f.identity)).metadata.definition.status, "implemented");
                },
            );
        } finally {
            for (const path of paths) await git(f.root, ["worktree", "remove", "--force", path]);
            await f.cleanup();
        }
    });
}
