import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseProjectId, projects, type HomeProjectOwner } from "@runwield/projects";
import { defineCommittedGitFixture } from "../../test-support/git-test-fixture.ts";
import { currentExecutionRecoveryObservation, withManagedExecutionRecovery } from "./execution-recovery.ts";
import {
    capturePlanPackageInput,
    createPlanPackage,
    readPlanPackage,
    updatePlanPackageMetadata,
} from "./package-storage.ts";
import type { ExecutionRecoveryEvidence, ExecutionRecoveryRequest } from "./project-store-wire.ts";

const repository = defineCommittedGitFixture();

async function reserve(owner: HomeProjectOwner, repositoryRoot: string, name: string) {
    const planId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const created = await createPlanPackage(owner, {
        planId,
        name,
        documents: { "context.md": `# ${name}\n`, "validation.md": "" },
    });
    const input = await capturePlanPackageInput(owner, planId);
    const updated = await updatePlanPackageMetadata(owner, planId, created.metadata.revision, {
        workflow: {
            attempt: {
                personalOwner: owner.personalOwner.identity,
                repositoryId: owner.repositoryId,
                repositoryRoot,
                attemptId,
                input: { inputs: [input], definitionHash: "1".repeat(64) },
            },
        },
    });
    const plan = await readPlanPackage(owner, { planId });
    ok(plan.kind === "loaded");
    return { plan, operation: { planId, attemptId, expectedPlanName: name, expectedRevision: updated.revision } };
}

test("canonical recovery observations are isolated by operation and revoked when it ends", async () => {
    const root = await realpath(await repository.checkout());
    const remoteHome = await realpath(await mkdtemp(join(tmpdir(), "execution-recovery-host-")));
    try {
        const local = await projects.checkout.admit(root);
        ok(local.kind === "existing");
        const owner = await projects.home.register({ ...local.identity, displayName: "Recovery scope" });
        const host = {
            projectId: owner.projectId,
            repositoryId: owner.repositoryId,
            repositoryRoot: root,
            personalOwner: { kind: "managed-remote" as const, identity: owner.personalOwner.identity },
        };
        const first = await reserve(owner, root, "first");
        const second = await reserve(owner, root, "second");
        const observe = (request: ExecutionRecoveryRequest): Promise<ExecutionRecoveryEvidence> =>
            Promise.resolve({
                request,
                entry: {
                    id: request.attemptId,
                    planId: request.planId,
                    planName: request.planName,
                    path: join(remoteHome, request.planName),
                    branch: `execution/${request.planName}`,
                    status: request.purpose === "active" ? "active" : "abandoned",
                },
                observedAt: new Date().toISOString(),
            });
        const firstReady = Promise.withResolvers<void>();
        const finishFirst = Promise.withResolvers<void>();
        const releaseDetached = Promise.withResolvers<void>();
        const detachedReads: Promise<ReturnType<typeof currentExecutionRecoveryObservation>>[] = [];
        const refresh = { ...first.operation, action: "refresh" as const };
        const stop = { ...second.operation, action: "stop" as const };
        let applied = false;
        await rejects(
            withManagedExecutionRecovery(
                owner,
                host,
                stop,
                async (request) => {
                    const evidence = await observe(request);
                    return { ...evidence, entry: { ...evidence.entry, id: first.operation.attemptId } };
                },
                () => {
                    applied = true;
                    return Promise.resolve();
                },
            ),
            /proof changed ownership/,
        );
        equal(applied, false);
        equal(currentExecutionRecoveryObservation(owner, second.plan), null);

        const running = withManagedExecutionRecovery(owner, host, refresh, observe, async () => {
            detachedReads.push(
                releaseDetached.promise.then(() => currentExecutionRecoveryObservation(owner, first.plan)),
            );
            firstReady.resolve();
            await finishFirst.promise;
            const selected = await readPlanPackage(owner, { planId: first.operation.planId });
            ok(selected.kind === "loaded");
            const current = currentExecutionRecoveryObservation(owner, selected);
            equal(current?.entry.status, "active");
            equal(current?.entry.id, first.operation.attemptId);
            equal(currentExecutionRecoveryObservation(owner, second.plan), null);
            equal(currentExecutionRecoveryObservation(local.identity, first.plan), null);
            equal(currentExecutionRecoveryObservation(owner, first.plan, undefined, "stop"), null);
            const wrongProject = parseProjectId(crypto.randomUUID());
            ok(wrongProject);
            for (const foreign of [
                { ...owner, projectId: wrongProject },
                { ...owner, repositoryId: crypto.randomUUID() },
                { ...owner, personalOwner: { ...owner.personalOwner, identity: remoteHome } },
            ])
                equal(currentExecutionRecoveryObservation(foreign, first.plan), null);
            const otherAttempt = { ...first.plan.metadata.workflow!.attempt!, attemptId: crypto.randomUUID() };
            equal(currentExecutionRecoveryObservation(owner, first.plan, otherAttempt), null);
        });
        try {
            await Promise.race([firstReady.promise, running]);
            equal(currentExecutionRecoveryObservation(owner, first.plan), null);
            await rejects(
                withManagedExecutionRecovery(owner, host, stop, observe, async () => {
                    detachedReads.push(
                        releaseDetached.promise.then(() => currentExecutionRecoveryObservation(owner, second.plan)),
                    );
                    equal(currentExecutionRecoveryObservation(owner, first.plan), null);
                    const selected = await readPlanPackage(owner, { planId: second.operation.planId });
                    ok(selected.kind === "loaded");
                    equal(currentExecutionRecoveryObservation(owner, selected)?.entry.status, "abandoned");
                    throw new Error("Recovery interrupted.");
                }),
                /Recovery interrupted/,
            );
        } finally {
            finishFirst.resolve();
            try {
                await running;
            } finally {
                releaseDetached.resolve();
            }
        }
        equal(currentExecutionRecoveryObservation(owner, first.plan), null);
        equal(currentExecutionRecoveryObservation(owner, second.plan), null);
        deepEqual(await Promise.all(detachedReads), [null, null]);

        const metadataPath = join(second.plan.path, "plan.wld.json");
        let editedMetadata: string | undefined;
        await rejects(
            withManagedExecutionRecovery(
                owner,
                host,
                stop,
                async (request) => {
                    const evidence = await observe(request);
                    await updatePlanPackageMetadata(owner, stop.planId, stop.expectedRevision, {
                        definition: { ...second.plan.metadata.definition, title: "Edited during host observation" },
                    });
                    editedMetadata = await readFile(metadataPath, "utf8");
                    return evidence;
                },
                () => {
                    applied = true;
                    return Promise.resolve();
                },
            ),
            /does not match the current canonical Plan attempt/,
        );
        equal(applied, false);
        ok(editedMetadata);
        equal(await readFile(metadataPath, "utf8"), editedMetadata);
        const edited = await readPlanPackage(owner, { planId: stop.planId });
        ok(edited.kind === "loaded");
        equal(edited.metadata.revision, stop.expectedRevision + 1);
        equal(edited.metadata.definition.title, "Edited during host observation");
        deepEqual(edited.metadata.workflow?.attempt, second.plan.metadata.workflow?.attempt);
        deepEqual(edited.documents, second.plan.documents);
        equal(currentExecutionRecoveryObservation(owner, edited), null);
    } finally {
        await Promise.all([root, remoteHome].map((path) => rm(path, { recursive: true, force: true })));
    }
});
