import { deepEqual, equal, ok, rejects, throws } from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { normalizePlanId, type PlanId } from "@runwield/plan-storage-format";
import { enter } from "@runwield/project-runtime";
import { parseProjectId, projects, type ProjectId } from "@runwield/projects";
import { openNativeFileLock } from "@runwield/resources/fs";
import { getHomeDir } from "@runwield/resources/home";
import { defineCommittedGitFixture } from "../../test-support/git-test-fixture.ts";
import { openPlanServerConnection } from "./plan-server.ts";
import { openShareAttemptJournal, type ShareAttempt } from "./share-attempt-journal.ts";

const repository = defineCommittedGitFixture();
const serverUrl = "https://plans.example.test";

function attemptPath(storeDirectory: string, projectId: ProjectId, planId: PlanId): string {
    const key = createHash("sha256")
        .update(JSON.stringify([projectId, planId]))
        .digest("hex");
    return join(storeDirectory, "plan-share-attempts", `${key}.json`);
}

async function shareAttempt(planId: string, projectSecrets: boolean): Promise<ShareAttempt> {
    return {
        requestId: randomUUID(),
        serverUrl,
        projectSecrets,
        prepared: await openPlanServerConnection(serverUrl).prepareSharedSpace({
            planId,
            title: "Pending share",
            metadata: {},
            body: "# Pending share\n",
        }),
        bodyHash: "original-plan-body-hash",
        startedAt: new Date().toISOString(),
        mayHaveCreated: true,
    };
}

test("the checkout journal resumes existing project-scoped bytes and settles only a matching Shared Space", async () => {
    const admission = await projects.checkout.admit(await repository.checkout());
    ok(admission.kind === "existing");
    const project = admission.identity;
    const planId = normalizePlanId("historical-share-id");
    ok(planId);
    const attempt = await shareAttempt(planId, true);
    const created = {
        spaceId: "original-space",
        planId,
        createdAt: attempt.startedAt,
        updatedAt: attempt.startedAt,
        latestRevision: 1,
    };
    const layout = await enter(project);
    const path = attemptPath(dirname(layout.primary.projectSecretStorePath), project.projectId, planId);
    const contents = JSON.stringify({
        version: 2,
        projectId: project.projectId,
        identity: "anonymous",
        ...attempt,
        created,
    });
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, contents, { mode: 0o600 });

    const journal = openShareAttemptJournal(project);
    await journal.withAttempt(planId, ({ current, save }) => {
        deepEqual(current, { ...attempt, created });
        throws(() => save({ ...attempt, projectSecrets: false }), /secret store changed/);
    });
    await journal.settle(planId, { serverUrl, spaceId: "another-space" });
    await journal.settle(planId, { serverUrl: "https://other.example.test", spaceId: created.spaceId });
    await journal.settle(planId, { requestId: randomUUID() });
    equal(await readFile(path, "utf8"), contents);
    await journal.settle(planId, { serverUrl, spaceId: created.spaceId });
    await rejects(stat(path), { code: "ENOENT" });
});

test("Home Project sharing holds the lock across an await and revokes it when the callback ends", async () => {
    const projectId = parseProjectId(randomUUID());
    const planId = normalizePlanId("pending-home-share");
    ok(projectId && planId);
    const project = await projects.home.register({ projectId, repositoryId: randomUUID(), displayName: "Share owner" });
    const journal = openShareAttemptJournal(project);
    const attempt = await shareAttempt(planId, false);
    const path = attemptPath(join(getHomeDir(), ".wld"), projectId, planId);
    const ready = Promise.withResolvers<void>();
    const allowWrite = Promise.withResolvers<void>();
    const writing = journal.withAttempt(planId, async (locked) => {
        ready.resolve();
        await allowWrite.promise;
        locked.save(attempt);
        return locked;
    });
    const settling = (async () => {
        try {
            await Promise.race([ready.promise, writing]);
            const probe = openNativeFileLock(`${path}.lock`, false);
            try {
                equal(probe.tryLockSync(true), false);
            } finally {
                probe.close();
            }
            // Queue settlement while the first callback is still waiting to write.
            return openShareAttemptJournal(project).settle(planId, { requestId: attempt.requestId });
        } finally {
            allowWrite.resolve();
        }
    })();
    const [stale] = await Promise.all([writing, settling]);
    await rejects(stat(path), { code: "ENOENT" });

    const replacement = { ...attempt, requestId: randomUUID() };
    await journal.withAttempt(planId, ({ current, save }) => {
        equal(current, undefined);
        save(replacement);
        throws(() => stale.save(attempt), /lock is no longer held/);
        throws(() => stale.finish(), /lock is no longer held/);
    });
    await journal.settle(planId, { requestId: attempt.requestId });
    await journal.withAttempt(planId, ({ current }) => {
        deepEqual(current, { ...replacement, created: undefined });
    });
    await journal.settle(planId, { requestId: replacement.requestId });
    await journal.withAttempt(planId, ({ current }) => equal(current, undefined));
});
