import { projects } from "@runwield/projects";
import { test } from "node:test";
import { equal, ok, rejects, deepEqual } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
    PreparedProjectStore,
    withLocalPlanWorkflow,
    selectedPublicationCopies,
    openProjectPlanStore,
} from "./index.ts";
import { publicationFixture } from "../shared/workflow/testing/package-publication-fixture.ts";
import { git } from "../shared/git-test-fixture.ts";

for (const plans of [false, true]) {
    test(`home-owned recording retains independent execution policy with Plan copies ${plans}`, async () => {
        const fixture = await publicationFixture();
        try {
            const owner = await projects.home.register({
                projectId: fixture.identity.projectId,
                repositoryId: fixture.identity.repositoryId,
                displayName: "Execution policy",
            });
            const service = new PreparedProjectStore(owner);
            const candidate = await git(fixture.workflow.executionCwd!, ["rev-parse", "HEAD"]);
            const initial = await service.execute({ kind: "read", planId: "plan-one", resource: "context.md" });
            ok("revision" in initial.result);
            const seal = () =>
                projects.home.withOwner(owner, () =>
                    withLocalPlanWorkflow(projects.home.storeLocation(owner), "one", () =>
                        selectedPublicationCopies.seal("one", fixture.workflow.worktreeId!, candidate, "main", true),
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
            const result = await restarted.execute({ kind: "read-publication", planId: "plan-one", reference });
            ok("manifest" in result.result);
            const manifest = result.result.manifest;
            const store = openProjectPlanStore(owner.projectId, { admitted: owner });
            const copies = await store.publicationCopies.read(reference);
            deepEqual(copies, manifest.copies);
            await rejects(store.publicationCopies.read({ ...reference, digest: "0".repeat(64) }), /missing or changed/);
            await rejects(
                store.publicationCopies.read({ ...reference, personalOwner: "another-owner" }),
                /another owner or repository/,
            );
            await rejects(store.publicationCopies.read({ ...reference, projectId: randomUUID() }), /another Project/);
            equal(manifest.planCopies, plans);
            equal(manifest.workRecordCopies, !plans);
            equal(manifest.autoGenerateRecords, !plans);
            equal(
                copies.some((copy) => copy.kind === "plan"),
                plans,
            );
        } finally {
            await fixture.cleanup();
        }
    });
}
