import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { loadPlan, savePlan } from "../../plan-store.js";
import { makeManagedSessionFixture } from "../../testing/managed-session-fixture.ts";
import { defineGitFixture, git } from "../git-test-fixture.ts";
import { publishExecutionWorktreeIsolated } from "../isolated-publication.ts";
import { createTestWorktreeAttempt } from "../worktree-test-helpers.ts";
import {
    advanceStoredPublication,
    cleanupStoredPublication,
    startPublicationAttempt,
} from "../workflow/publication-machine.ts";

const planId = "11111111-1111-4111-8111-111111111111";
const repository = defineGitFixture(async (root) => {
    await Deno.writeTextFile(join(root, ".gitignore"), ".wld/\n");
    await savePlan(root, "delivery", "# Reviewed delivery\n", {
        planId,
        classification: "PLANNED_CHANGE",
        status: "reviewed",
    });
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "Reviewed Plan"]);
});

Deno.test("published Session restart restores project cwd while retaining removed repair segment origin", async () => {
    await withRuntimeCommandFixture("published-session-restart-", async ({ homeDir, setModelResponseFactory }) => {
        const root = await repository.checkout();
        const temporary = await Deno.makeTempDir({ prefix: "published-session-worktree-" });
        const fixture = await makeManagedSessionFixture({ home: homeDir, projectRoot: root });
        let handle = fixture.openRuntime("test", "before-publication");
        try {
            const remote = join(temporary, "remote.git");
            await git(root, ["init", "--bare", remote]);
            await git(root, ["remote", "add", "origin", remote]);
            await git(root, ["push", "-u", "origin", "main"]);
            const primaryHead = await git(root, ["rev-parse", "HEAD"]);
            const entry = await createTestWorktreeAttempt({
                projectRoot: root,
                worktreeRoot: temporary,
                planName: "delivery",
                planId,
            });
            const origin = await Deno.realPath(entry.path);
            await handle.runtime.rollManagedSessionSegment(handle.adoptedSessionId, {
                kind: "semantic_repair",
                transcriptCwd: origin,
                continuation: { mode: "repair" },
            });
            await handle.runtime.recordPlanAssociation(handle.adoptedSessionId, {
                planId,
                planName: "delivery",
                purpose: "execution",
            });
            await handle.runtime.clearActiveExecutionWorkflow(handle.adoptedSessionId);
            handle = await fixture.restartRuntime(handle, "pending-publication");
            await handle.runtime.synchronizeManagedSession(handle.adoptedSessionId);
            assertEquals(handle.runtime.getSessionSnapshot(handle.adoptedSessionId)?.cwd, origin);

            await Deno.writeTextFile(join(entry.path, "feature.txt"), "Delivered implementation\n");
            await git(entry.path, ["add", "."]);
            await git(entry.path, ["commit", "-m", "Seal implementation"]);
            const commit = await git(entry.path, ["rev-parse", "HEAD"]);
            let attempt = await startPublicationAttempt({
                projectRoot: root,
                attemptId: entry.id,
                planName: "delivery",
                targetBranch: "main",
                executionBranch: entry.branch,
                executionCwd: entry.path,
                validatedCommit: commit,
                targetHeadAtSeal: primaryHead,
            });
            attempt = await advanceStoredPublication(root, attempt, "artifacts_committed", {
                artifactCommit: commit,
                planPaths: ["docs/plans/delivery.md"],
            });
            await publishExecutionWorktreeIsolated({
                projectRoot: root,
                executionCwd: entry.path,
                executionBranch: entry.branch,
                targetBranch: "main",
                planName: "delivery",
                sealedExecutionCommit: commit,
                allowedPlanPaths: ["docs/plans/delivery.md"],
                publicationRoot: attempt.publicationRoot,
                onIntegrated: async (evidence) => {
                    attempt = await advanceStoredPublication(root, attempt, "target_integrated", evidence);
                },
                onPublished: async (evidence) => {
                    attempt = await advanceStoredPublication(root, attempt, "target_published", evidence);
                },
            });
            const cleanup = await cleanupStoredPublication(root, attempt);
            assert(cleanup.complete);
            assertEquals(await Deno.stat(origin).catch(() => null), null);
            assertEquals(await git(root, ["rev-parse", "HEAD"]), primaryHead);
            assertEquals((await loadPlan(root, "delivery"))?.attrs.status, "verified");

            handle = await fixture.restartRuntime(handle, "after-publication");
            await handle.runtime.synchronizeManagedSession(handle.adoptedSessionId);
            assertEquals(
                await Deno.realPath(handle.runtime.getSessionSnapshot(handle.adoptedSessionId)!.cwd),
                await Deno.realPath(root),
            );
            setModelResponseFactory(() => fauxAssistantMessage(fauxText("The delivered Session remains usable.")));
            const followup = await handle.runtime.promptUserTurn(handle.adoptedSessionId, {
                initialRequest: "Explain the delivered change.",
            });
            assertEquals(followup.ok, true);
            assertEquals(
                await Deno.realPath(handle.runtime.getSessionSnapshot(handle.adoptedSessionId)!.cwd),
                await Deno.realPath(root),
            );
            assertEquals(
                await Deno.stat(origin).catch(() => null),
                null,
                "Resume must not recreate the removed checkout.",
            );
            const segment = handle.store.getCurrentSessionSegment(fixture.session.runwieldSessionId);
            assert(segment);
            assertEquals(segment.transcriptCwd, origin);
            const header = JSON.parse((await Deno.readTextFile(segment.transcriptPath)).split("\n")[0]);
            assertEquals(header.cwd, origin);
        } finally {
            await handle.close();
            await fixture.cleanup();
            await Deno.remove(root, { recursive: true });
            await Deno.remove(temporary, { recursive: true });
        }
    });
});
