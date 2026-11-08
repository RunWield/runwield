import { test } from "node:test";
import { equal, ok, rejects } from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { packageFixture, create, read } from "../testing/plan-package-fixture.ts";
import { withPackageWorkflow, loadPackageWorkflowPlan } from "./package-workflow.ts";
import { recordPlanEvent } from "./plan-lifecycle.js";
import { createExecutionStartPorts, startActiveExecutionWorkflow } from "./execution-start.ts";
import { finalizePlanImplementation } from "./implementation-checkpoint.ts";
import { runValidationAttempt } from "./validation-supervisor.ts";
import { setExactProjectCustomSetting } from "../settings.js";
import { git } from "../git-test-fixture.ts";
import { inspectWorktreeRegistry } from "../worktree-registry.js";
import { coverage } from "./testing/validation-host-fixture.ts";
import type { ValidationHostResume } from "./validation-host-contract.ts";
import { readPlanPackage, readPlanPackagePublication } from "../plan-package-store.ts";
import { loadPublishedWorkRecordSource } from "../work-records/published-source.ts";

for (const remote of [false, true])
    for (const plans of [false, true]) {
        test(`real package validation publishes ${remote ? "remote" : "local"} with Plan copies ${plans}`, async () => {
            const f = await packageFixture();
            const remotePath = `${f.root}-remote.git`;
            let execution = "";
            try {
                setExactProjectCustomSetting("verification_command", "test -f result.txt", f.root);
                setExactProjectCustomSetting("codereview", "none", f.root);
                await git(f.root, ["add", ".wld/settings.json"]);
                await git(f.root, ["commit", "-m", "verification"]);
                if (remote) {
                    await git(f.root, ["clone", "--bare", f.root, remotePath]);
                    await git(f.root, ["remote", "add", "origin", remotePath]);
                    await git(f.root, ["config", "branch.main.remote", "origin"]);
                    await git(f.root, ["config", "branch.main.merge", "refs/heads/main"]);
                }
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
                    { identity: f.identity, planId: p.metadata.planId, expectedRevision: 1, deliveryCopies: { plans } },
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
                            currentStatus: "ready_for_work",
                            triageMeta: (await loadPackageWorkflowPlan("one")).attrs,
                            ports: createExecutionStartPorts(),
                        });
                        execution = workflow.executionCwd!;
                        await fs.writeFile(join(execution, "result.txt"), "delivered implementation\n");
                        await finalizePlanImplementation({
                            projectRoot: f.root,
                            planName: "one",
                            executionContext: workflow,
                        });
                        await rejects(fs.access(join(execution, "docs/plans")));
                        let resume: ValidationHostResume | undefined;
                        let reviews = 0;
                        for (let turn = 0; turn < 8; turn++) {
                            const result = await runValidationAttempt({
                                projectRoot: f.root,
                                planName: "one",
                                runtime: { kind: "host" },
                                hostResume: resume,
                            });
                            if (result.kind === "verified") break;
                            ok(result.kind === "host_request", JSON.stringify(result));
                            const request = result.hostRequest;
                            ok(request?.kind === "reviewer", JSON.stringify(request));
                            reviews++;
                            resume = {
                                kind: "reviewer",
                                identity: request.identity,
                                outcome: { approved: true },
                                coverage: coverage(request),
                            };
                        }
                        ok(
                            reviews >= 1,
                            `review count ${reviews}; ${JSON.stringify((await read(f.identity)).metadata)}`,
                        );
                        const settled = await read(f.identity);
                        equal(settled.metadata.definition.status, "verified");
                        equal(settled.metadata.workflow?.attempt, undefined);
                        ok(settled.metadata.workflow?.delivery);
                        equal((await inspectWorktreeRegistry(f.root)).entries.length, 0);
                        const receipt = settled.metadata.workflow.delivery;
                        const manifest = await readPlanPackagePublication(f.identity, receipt.source);
                        equal(manifest.planCopies, plans);
                        const target = remote ? remotePath : f.root;
                        equal(await git(target, ["show", "main:result.txt"]), "delivered implementation");
                        const paths = await git(target, ["ls-tree", "-r", "--name-only", "main"]);
                        equal(paths.includes("docs/plans/one/context.md"), plans);
                        equal(paths.includes("plan.wld.json"), false);
                        equal(await fs.readFile(join(p.path, "context.md"), "utf8"), "# A Plan\n\nProse — 世界\n");
                        const legacyBefore = await fs
                            .readFile(join(f.root, "docs/plans/one.md"), "utf8")
                            .catch(() => null);
                        equal(legacyBefore, null, `Unexpected checkout Plan before Recorder: ${legacyBefore}`);
                        const source = await loadPublishedWorkRecordSource(f.root, "one");
                        equal(source?.attrs.status, "verified");
                        equal(source?.body, "# A Plan\n\nProse — 世界\n");
                        await rejects(fs.access(join(f.root, "docs/plans/one.md")));
                    },
                );
            } finally {
                if (execution) await git(f.root, ["worktree", "remove", "--force", execution]).catch(() => {});
                await fs.rm(remotePath, { recursive: true, force: true });
                await f.cleanup();
            }
        });
    }

for (const child of [false, true]) {
    test(`non-Git package validation retains in-place proof and Sequence completion ${child}`, async () => {
        const { tmpdir } = await import("node:os");
        const { admitProjectIdentity } = await import("../project-identity.ts");
        const { rememberNonGitExecutionConsent } = await import("../non-git-execution-consent.ts");
        const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "package-in-place-")));
        try {
            const admitted = await admitProjectIdentity(root);
            ok(admitted.kind === "existing");
            const identity = admitted.identity;
            await rememberNonGitExecutionConsent("featurePlan", root);
            setExactProjectCustomSetting("verification_command", "test -f result.txt", root);
            setExactProjectCustomSetting("codereview", "none", root);
            if (child)
                await create(identity, {
                    planId: "parent",
                    name: "parent",
                    definition: { classification: "PROJECT", type: "sequence", status: "ready_for_work" },
                });
            const p = await create(identity, {
                ...(child ? { parentPlanId: "parent" } : {}),
                definition: {
                    classification: "PLANNED_CHANGE",
                    status: "draft",
                    executionAgent: "engineer",
                    collaborationRecommendation: "autonomous",
                },
            });
            await withPackageWorkflow(root, { identity, planId: p.metadata.planId, expectedRevision: 1 }, async () => {
                await recordPlanEvent({ cwd: root, planName: "one", event: "review_approved", currentStatus: "draft" });
                await recordPlanEvent({
                    cwd: root,
                    planName: "one",
                    event: "readiness_passed",
                    currentStatus: "approved",
                });
                const workflow = await startActiveExecutionWorkflow({
                    cwd: root,
                    planName: "one",
                    currentStatus: "ready_for_work",
                    triageMeta: (await loadPackageWorkflowPlan("one")).attrs,
                    ports: createExecutionStartPorts(),
                });
                equal(workflow.executionMode, "non_git_in_place");
                await fs.writeFile(join(root, "result.txt"), "in-place work\n");
                await finalizePlanImplementation({ projectRoot: root, planName: "one", executionContext: workflow });
                const result = await runValidationAttempt({
                    projectRoot: root,
                    planName: "one",
                    runtime: { kind: "host" },
                });
                equal(result.kind, "verified", JSON.stringify(result));
                const settled = await read(identity);
                equal(settled.metadata.workflow?.delivery?.mode, "non_git_in_place");
                equal(settled.metadata.workflow?.delivery?.publishedCommit, "");
                equal(settled.metadata.definition.status, "verified");
                if (child) {
                    const parent = await readPlanPackage(identity, { planId: "parent" });
                    ok(parent.kind === "loaded");
                    equal(parent.metadata.definition.status, "verified");
                    equal((await loadPublishedWorkRecordSource(root, "one"))?.planId, "parent");
                }
                await rejects(fs.access(join(root, "docs/plans/one.md")));
            });
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });
}
