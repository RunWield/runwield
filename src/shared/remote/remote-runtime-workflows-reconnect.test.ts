import { test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { ok as assert } from "node:assert/strict";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { kill } from "node:process";
import { assertEquals } from "../../testing/assertions.ts";
import { git } from "../workflow/validation-test-helpers.js";
import { assertRemoteStorageAbsent, within, withRemoteRuntimeFixture } from "./remote-runtime-test-fixture.ts";
import {
    ciRuns,
    executeDelivery,
    planDelivery,
    prepareDelivery,
    readWorkflowResult,
    scriptReviewAndRecord,
    snapshotProjectTree,
} from "./remote-runtime-workflows-fixture.ts";

for (const evidenceAvailable of [true, false]) {
    test(`reconnect checks an unsaved publication result without replay (${evidenceAvailable ? "confirmed" : "uncertain"} evidence)`, async () => {
        await withRemoteRuntimeFixture(async (f) => {
            const upstream = await prepareDelivery(f);
            const client = await f.start();
            await client.read();
            const id = await planDelivery(f, client);
            const execution = await executeDelivery(f, client);
            scriptReviewAndRecord(f);
            let interrupted = false;
            f.policy.before = (request, path) => {
                if (
                    path === "/session/request" &&
                    request.kind === "append" &&
                    request.contents.includes('"outcome":"verified"')
                ) {
                    interrupted = true;
                    return Promise.resolve(new Response("unsaved-publication-result", { status: 503 }));
                }
                return Promise.resolve(undefined);
            };
            await client.send({ kind: "workflow-validate" });
            await readWorkflowResult(client);
            assert(interrupted, "Refuse the append before the laptop owner saves it");
            const commands = await readFile(f.remoteCommandLog, "utf8");
            assertEquals(
                commands.split("\n").filter((line) => line.startsWith("push ")).length,
                1,
                "The publication already happened",
            );
            const saved = (await f.control.list(id))[0].contents || "";
            assert(
                !saved.includes('"outcome":"verified"'),
                "No successful publication result can be durable on the laptop",
            );
            assert(saved.includes("Implemented the remote change."));
            await f.dropConnection();
            await client.terminate();
            f.policy.before = undefined;
            const hiddenEvidence: Array<{ from: string; to: string }> = [];
            if (!evidenceAvailable) {
                // Simulate inaccessible canonical delivery evidence, not a saved negative outcome.
                hiddenEvidence.push({
                    from: join(f.remoteProject, "docs/plans/remote-delivery.md"),
                    to: join(f.remoteHome, "lost-plan.md"),
                });
                const runtimeRoot = join(f.remoteHome, "project-runtime");
                for (const entry of await snapshotProjectTree(runtimeRoot)) {
                    if (
                        entry.kind === "file" &&
                        (entry.path.endsWith("worktrees.json") || entry.path.includes("/controller/plans/"))
                    )
                        hiddenEvidence.push({
                            from: join(runtimeRoot, entry.path),
                            to: join(f.remoteHome, `unavailable-${encodeURIComponent(entry.path)}`),
                        });
                }
            }
            for (const item of hiddenEvidence) await rename(item.from, item.to);
            // Cleanup can finish before the terminal Session save. Keep Git registration intact for this crash window.
            if (execution.executionCwd !== f.remoteProject)
                await rename(execution.executionCwd!, join(f.remoteHome, "cleaned-execution"));
            const refs = await git(upstream, ["show-ref"]);
            const ci = await ciRuns(f);
            const models = f.modelRequests.length;
            const evidenceBefore = await readOnlyEvidenceSnapshot(f.remoteProject, f.remoteHome);
            const resumed = await f.start();
            await resumed.read();
            await resumed.send({ kind: "resume-command", sessionId: id });
            const loaded = await resumed.read();
            assertEquals(loaded.ok, true, loaded.error);
            assertEquals(loaded.savedId, id);
            await resumed.send({ kind: "local-recovery" });
            const local = await resumed.read();
            assertEquals(
                ["publication_verified", "cleanup_complete"].includes(local.publicationPhase || ""),
                loaded.workflowContext?.validationProgress?.outcome === "verified",
                "Remote reconnect must agree with local publication recovery for the same evidence",
            );
            assertEquals(
                loaded.workflowContext?.validationProgress?.outcome,
                evidenceAvailable ? "verified" : "paused",
                JSON.stringify(loaded),
            );
            if (!evidenceAvailable) {
                const uncertainty = loaded.workflowContext?.validationProgress?.message;
                assert(uncertainty, JSON.stringify(loaded));
                assert(uncertainty.includes("uncertain"), JSON.stringify(loaded));
                assert(
                    loaded.notices?.some((notice) => notice.includes(uncertainty)),
                    "The restored conversation must show the full uncertain publication result",
                );
            }
            assertEquals(await ciRuns(f), ci, "Reconnect cannot replay CI");
            assertEquals(f.modelRequests.length, models, "Reconnect cannot replay review, repair, or Recorder");
            assertEquals(await git(upstream, ["show-ref"]), refs);
            const after = await readFile(f.remoteCommandLog, "utf8");
            assertEquals(
                after.split("\n").filter((line) => line.startsWith("push ")).length,
                1,
                "Reconnect cannot repeat push",
            );
            assertEquals(
                await readOnlyEvidenceSnapshot(f.remoteProject, f.remoteHome),
                evidenceBefore,
                "Reconnect cannot rewrite remote Plan, transition, publication, or Git evidence",
            );
            for (const item of hiddenEvidence) await rename(item.to, item.from);
            await resumed.send({ kind: "reload" });
            const checked = await resumed.read();
            assertEquals(checked.ok, true, checked.error);
            assertEquals(checked.workflowContext?.validationProgress?.outcome, "verified", JSON.stringify(checked));
            f.setModelMessages([
                fauxAssistantMessage(fauxText("Confirmed the recovered publication without repeating delivery.")),
            ]);
            await resumed.send({ kind: "turn", text: "Confirm the recovered publication. Do not repeat delivery." });
            const continued = await resumed.read();
            assertEquals(continued.ok, true, JSON.stringify(continued));
            assertEquals(await ciRuns(f), ci, "Confirmed publication must not repeat CI");
            assertEquals(f.modelRequests.length, models + 1, "Only the requested confirmation turn may run");
            assertEquals(await git(upstream, ["show-ref"]), refs);
            const continuedCommands = await readFile(f.remoteCommandLog, "utf8");
            assertEquals(continuedCommands.split("\n").filter((line) => line.startsWith("push ")).length, 1);
            await resumed.close();
            await assertRemoteStorageAbsent(f);
        });
    });
}

test("transport loss during active validation resumes with uncertainty, without replaying CI or publication", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        const upstream = await prepareDelivery(f);
        const started = join(f.remoteHome, "ci-started");
        const release = join(f.remoteHome, "ci-release");
        const pidFile = join(f.remoteHome, "ci-pid");
        await writeFile(
            join(f.remoteProject, ".wld/settings.json"),
            JSON.stringify({
                verification_command: `printf 'ci\\n' >> '${join(f.remoteHome, "ci.log")}'; printf '%s' \"$$\" > '${pidFile}'; touch '${started}'; while [ ! -e '${release}' ]; do sleep 0.01; done`,
                codereview: "none",
            }),
        );
        const client = await f.start();
        await client.read();
        const id = await planDelivery(f, client);
        const execution = await executeDelivery(f, client);
        scriptReviewAndRecord(f);
        await client.send({ kind: "workflow-validate" });
        async function waitForFile(path: string) {
            await within(
                (async () => {
                    while (
                        await readFile(path).then(
                            () => false,
                            () => true,
                        )
                    )
                        await new Promise((resolve) => setTimeout(resolve, 10));
                })(),
            );
        }
        async function stopCI() {
            const pid = await readFile(pidFile, "utf8").catch(() => "");
            if (pid) {
                const commandPid = Number(pid);
                assert(Number.isSafeInteger(commandPid) && commandPid > 1, "CI must record its own process group");
                try {
                    kill(-commandPid, "SIGKILL");
                } catch (error) {
                    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
                }
            }
        }
        try {
            await waitForFile(started);
            const before = await readFile(f.store.getCurrentSessionSegment(id)!.transcriptPath, "utf8");
            assert(before.includes('"ci":"running"'), "Disconnect must occur during CI, before any saved success");
            assert(!before.includes('"ci":"passed"'));
            await f.dropConnection(); // Close the real listener and release its laptop writer, not an orderly remote client close.
            await client.terminate();
        } finally {
            // Linux Bun kills CI with its parent; macOS can leave it running. Stop the fixture's
            // blocked command in either case. A killed command cannot acknowledge ci-finished.
            await stopCI();
            await writeFile(release, "release");
        }
        const refs = await git(upstream, ["show-ref"]);
        const models = f.modelRequests.length;
        const evidenceBefore = await readOnlyEvidenceSnapshot(f.remoteProject, f.remoteHome);
        const resumed = await f.start();
        await resumed.read();
        await resumed.send({ kind: "resume-command", sessionId: id });
        const loaded = await resumed.read();
        assertEquals(loaded.ok, true, loaded.error);
        assertEquals(loaded.workflowContext?.validationProgress?.outcome, "paused", JSON.stringify(loaded));
        const uncertainty = loaded.workflowContext?.validationProgress?.message;
        assert(uncertainty);
        assert(uncertainty.includes("uncertain"));
        assert(
            loaded.notices?.some((notice) => notice.includes(uncertainty)),
            "The restored conversation must show the full interrupted validation result",
        );
        assertEquals(await ciRuns(f), 1);
        assertEquals(f.modelRequests.length, models);
        assertEquals(await git(upstream, ["show-ref"]), refs);
        const commands = await readFile(f.remoteCommandLog, "utf8");
        assertEquals(commands.split("\n").filter((line) => line.startsWith("push ")).length, 0);
        assertEquals(await readOnlyEvidenceSnapshot(f.remoteProject, f.remoteHome), evidenceBefore);
        await resumed.send({ kind: "local-validation-recovery" });
        const local = await resumed.read();
        assertEquals(local.result?.kind, loaded.workflowContext?.validationProgress?.outcome, JSON.stringify(local));
        const checkpoint = local.priorValidationCheckpoint;
        assert(checkpoint, JSON.stringify(local));
        assertEquals(checkpoint.state, "running");
        assertEquals(checkpoint.nextPhase, "mechanical");
        assertEquals(local.validationCheckpoint?.state, "paused");
        assertEquals(local.validationCheckpoint?.nextPhase, checkpoint.nextPhase);
        assertEquals(local.validationCheckpoint?.generation, checkpoint.generation);
        assertEquals(local.validationCheckpoint?.attemptId, checkpoint.attemptId);
        assertEquals(await ciRuns(f), 1, "Local recovery cancels before external CI effects");
        assertEquals(f.modelRequests.length, models);
        await resumed.send({ kind: "workflow-validate" });
        const continued = await readWorkflowResult(resumed);
        assertEquals(continued.result?.kind, "verified", JSON.stringify(continued));
        assertEquals(await ciRuns(f), 2, "Only the user-selected retry can rerun interrupted CI");
        const published = await readFile(f.remoteCommandLog, "utf8");
        assertEquals(published.split("\n").filter((line) => line.startsWith("push ")).length, 1);
        assertEquals(
            await git(upstream, ["show", `${execution.triageMeta?.deliveryBranch || "main"}:sentinel.txt`]),
            "remote implemented",
        );
        await resumed.close();
        await assertRemoteStorageAbsent(f);
    });
});

async function readOnlyEvidenceSnapshot(project: string, home: string) {
    const trees = [];
    for (const root of [project, join(home, "project-runtime"), join(home, ".wld/worktrees")]) {
        trees.push({
            root,
            entries: await snapshotProjectTree(root).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error;
                return [];
            }),
        });
    }
    return trees;
}
