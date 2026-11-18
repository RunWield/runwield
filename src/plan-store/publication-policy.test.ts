import { test } from "node:test";
import { equal, ok, rejects, deepEqual } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
    PreparedProjectStore,
    registerHomeProjectOwner,
    withLocalPlanWorkflow,
    sealPackagePublication,
    packagePublicationInput,
} from "./index.ts";
import { withHomeProjectOwner, projectStoreLocation } from "../shared/project-identity.ts";
import { publicationFixture } from "../shared/workflow/testing/package-publication-fixture.ts";
import { git } from "../shared/git-test-fixture.ts";

for (const plans of [false, true]) {
    test(`home-owned recording retains independent execution policy with Plan copies ${plans}`, async () => {
        const fixture = await publicationFixture();
        try {
            const owner = await registerHomeProjectOwner({
                projectId: fixture.identity.projectId,
                repositoryId: fixture.identity.repositoryId,
                displayName: "Execution policy",
            });
            const service = new PreparedProjectStore(owner);
            const candidate = await git(fixture.workflow.executionCwd!, ["rev-parse", "HEAD"]);
            const initial = await service.execute({ kind: "read", planId: "plan-one", resource: "context.md" });
            ok("revision" in initial.result);
            const seal = () =>
                withHomeProjectOwner(owner, () =>
                    withLocalPlanWorkflow(projectStoreLocation(owner), "one", () =>
                        sealPackagePublication("one", fixture.workflow.worktreeId!, candidate, "main", true),
                    ),
                );
            await rejects(seal(), /settings must be frozen/);
            const command = {
                kind: "freeze-publication-policy" as const,
                operationId: randomUUID(),
                planId: "plan-one",
                expectedRevision: initial.result.revision!,
                attemptId: fixture.workflow.worktreeId!,
                policy: { plans, workRecords: !plans, autoGenerateRecords: !plans },
            };
            await rejects(
                service.execute({ ...command, operationId: randomUUID(), attemptId: "another-attempt" }),
                /different execution attempt/,
            );
            const outcome = await service.execute(command);
            equal("status" in outcome.result && outcome.result.status, "completed");
            // A replacement service reconciles the original operation and keeps its exact outcome.
            const restarted = new PreparedProjectStore(owner);
            deepEqual(await restarted.execute(command), outcome);
            const current = await restarted.execute({ kind: "read", planId: "plan-one", resource: "context.md" });
            ok("revision" in current.result);
            await restarted.execute({
                ...command,
                operationId: randomUUID(),
                expectedRevision: current.result.revision!,
                policy: { plans: !plans, workRecords: plans, autoGenerateRecords: plans },
            });
            const reference = await seal();
            const manifest = await packagePublicationInput(fixture.root, reference);
            equal(manifest.planCopies, plans);
            equal(manifest.workRecordCopies, !plans);
            equal(manifest.autoGenerateRecords, !plans);
            equal(
                manifest.copies.some((copy) => copy.kind === "plan"),
                plans,
            );
        } finally {
            await fixture.cleanup();
        }
    });
}
