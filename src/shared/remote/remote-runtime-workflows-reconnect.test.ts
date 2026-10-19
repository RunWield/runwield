import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
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
            await executeDelivery(f, client);
            scriptReviewAndRecord(f);
            let interrupted = false;
            f.policy.before = async (request, path) => {
                if (
                    path === "/session/request" &&
                    request.kind === "append" &&
                    request.contents.includes('"outcome":"verified"')
                ) {
                    interrupted = true;
                    return new Response("unsaved-publication-result", { status: 503 });
                }
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
            if (!evidenceAvailable) {
                // Simulate inaccessible canonical delivery evidence, not a saved negative outcome.
                await rename(
                    join(f.remoteProject, "docs/plans/remote-delivery.md"),
                    join(f.remoteHome, "lost-plan.md"),
                );
                const runtimeRoot = join(f.remoteHome, "project-runtime");
                for (const entry of await snapshotProjectTree(runtimeRoot)) {
                    if (
                        entry.kind === "file" &&
                        (entry.path.endsWith("worktrees.json") || entry.path.includes("/controller/plans/"))
                    )
                        await rename(
                            join(runtimeRoot, entry.path),
                            join(f.remoteHome, `unavailable-${encodeURIComponent(entry.path)}`),
                        );
                }
            }
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
            assertEquals(
                loaded.workflowContext?.validationProgress?.outcome,
                evidenceAvailable ? "verified" : "paused",
                JSON.stringify(loaded),
            );
            if (!evidenceAvailable)
                assert(
                    loaded.workflowContext?.validationProgress?.message?.includes("uncertain"),
                    JSON.stringify(loaded),
                );
            assertEquals(await ciRuns(f), ci, "Reconnect cannot replay CI");
            assertEquals(f.modelRequests.length, models, "Reconnect cannot replay review, repair, or Recorder");
            assertEquals(await git(upstream, ["show-ref"]), refs);
            const after = await readFile(f.remoteCommandLog, "utf8");
            assertEquals(
                after.split("\n").filter((line) => line.startsWith("push ")).length,
                1,
                "Reconnect cannot repeat push",
            );
            await resumed.close();
            assertEquals(
                await readOnlyEvidenceSnapshot(f.remoteProject, f.remoteHome),
                evidenceBefore,
                "Reconnect cannot rewrite remote Plan, transition, publication, or Git evidence",
            );
            await assertRemoteStorageAbsent(f);
        });
    });
}

test("transport loss during active validation resumes with uncertainty, without replaying CI or publication", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        const upstream = await prepareDelivery(f);
        const started = join(f.remoteHome, "ci-started");
        const release = join(f.remoteHome, "ci-release");
        const finished = join(f.remoteHome, "ci-finished");
        await writeFile(
            join(f.remoteProject, ".wld/settings.json"),
            JSON.stringify({
                verification_command: `printf 'ci\\n' >> '${join(f.remoteHome, "ci.log")}'; touch '${started}'; while [ ! -e '${release}' ]; do sleep 0.01; done; touch '${finished}'`,
                codereview: "none",
            }),
        );
        const client = await f.start();
        await client.read();
        const id = await planDelivery(f, client);
        await executeDelivery(f, client);
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
        try {
            await waitForFile(started);
            const before = await readFile(f.store.getCurrentSessionSegment(id)!.transcriptPath, "utf8");
            assert(before.includes('"ci":"running"'), "Disconnect must occur during CI, before any saved success");
            assert(!before.includes('"ci":"passed"'));
            await f.dropConnection(); // Close the real listener and release its laptop writer, not an orderly remote client close.
            await client.terminate();
        } finally {
            // Child08 owns process-tree termination. This fixture releases the external CI subprocess itself.
            await writeFile(release, "release");
        }
        await waitForFile(finished);
        const refs = await git(upstream, ["show-ref"]);
        const models = f.modelRequests.length;
        const evidenceBefore = await readOnlyEvidenceSnapshot(f.remoteProject, f.remoteHome);
        const resumed = await f.start();
        await resumed.read();
        await resumed.send({ kind: "resume-command", sessionId: id });
        const loaded = await resumed.read();
        assertEquals(loaded.ok, true, loaded.error);
        assertEquals(loaded.workflowContext?.validationProgress?.outcome, "paused", JSON.stringify(loaded));
        assert(loaded.workflowContext?.validationProgress?.message?.includes("uncertain"));
        assertEquals(await ciRuns(f), 1);
        assertEquals(f.modelRequests.length, models);
        assertEquals(await git(upstream, ["show-ref"]), refs);
        const commands = await readFile(f.remoteCommandLog, "utf8");
        assertEquals(commands.split("\n").filter((line) => line.startsWith("push ")).length, 0);
        await resumed.close();
        assertEquals(await readOnlyEvidenceSnapshot(f.remoteProject, f.remoteHome), evidenceBefore);
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
