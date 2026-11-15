import { test } from "node:test";
import { equal, ok, rejects } from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { admitProjectIdentity } from "../project-identity.ts";
import { rememberNonGitExecutionConsent } from "../non-git-execution-consent.ts";
import { create, read } from "../testing/plan-package-fixture.ts";
import { loadPackageWorkflowPlan } from "../../plan-store/workflows.ts";
import { withPackageWorkflow } from "../../plan-store/workflows.ts";
import { recordPlanEvent } from "./plan-lifecycle.js";
import { startActiveExecutionWorkflow, createExecutionStartPorts } from "./execution-start.ts";
import { finalizePlanImplementation } from "./implementation-checkpoint.ts";
import { continueWorkflowValidation } from "./validation.ts";
import { HostedSession } from "../session/hosted-session.js";
import { createGitPort } from "../git-port.ts";
import { setExactProjectCustomSetting } from "../settings.js";
import { runLocalCI } from "./validation-local-ci.ts";
import { createWorkRecordMnemotecaFixture } from "../work-records/test-fixtures/mnemoteca-port.ts";
import { loadPlan } from "../../plan-store/index.ts";

test("session validation resumes the exact non-Git package attempt outside its original scope", async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "package-session-validation-")));
    const session = new HostedSession({ id: "in-place-validation", cwd: root });
    try {
        const admitted = await admitProjectIdentity(root);
        ok(admitted.kind === "existing");
        const identity = admitted.identity;
        await rememberNonGitExecutionConsent("featurePlan", root);
        setExactProjectCustomSetting("verification_command", "test -f result.txt", root);
        setExactProjectCustomSetting("codereview", "none", root);
        const plan = await create(identity);
        const workflow = await withPackageWorkflow(
            root,
            { identity, planId: plan.metadata.planId, expectedRevision: 1 },
            async () => {
                await recordPlanEvent({ cwd: root, planName: "one", event: "review_approved", currentStatus: "draft" });
                await recordPlanEvent({
                    cwd: root,
                    planName: "one",
                    event: "readiness_passed",
                    currentStatus: "approved",
                });
                return await startActiveExecutionWorkflow({
                    cwd: root,
                    planName: "one",
                    currentStatus: "ready_for_work",
                    triageMeta: (await loadPackageWorkflowPlan("one")).attrs,
                    ports: createExecutionStartPorts(),
                });
            },
        );
        ok(workflow.packageAttemptId);
        equal(workflow.worktreeId, undefined);
        await fs.writeFile(join(root, "result.txt"), "implemented\n");
        await finalizePlanImplementation({ projectRoot: root, planName: "one", executionContext: workflow });
        const implemented = await loadPlan(root, "one");
        ok(implemented);
        const args = {
            hostedSession: session,
            planName: "one",
            planContent: implemented.markdown,
            triageMeta: implemented.attrs,
            executionContext: workflow,
            git: createGitPort(),
            localCI: { run: runLocalCI },
            workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
        };
        session.setActiveExecutionWorkflow({ ...workflow, packageAttemptId: "another-attempt" });
        const before = (await read(identity)).metadata.revision;
        await rejects(continueWorkflowValidation(args), /Recorded Plan execution attempt binding changed/);
        equal((await read(identity)).metadata.revision, before);
        session.setActiveExecutionWorkflow(workflow);
        const result = await continueWorkflowValidation(args);
        equal(result.kind, "verified", JSON.stringify(result));
        const delivered = await read(identity);
        equal(delivered.metadata.workflow?.delivery?.source.attemptId, workflow.packageAttemptId);
        equal(delivered.metadata.definition.status, "verified");
    } finally {
        session.dispose();
        await fs.rm(root, { recursive: true, force: true });
    }
});
