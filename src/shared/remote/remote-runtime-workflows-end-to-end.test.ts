import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertEquals } from "../../testing/assertions.ts";
import { git } from "../workflow/validation-test-helpers.js";
import { assertRemoteStorageAbsent, withRemoteRuntimeFixture } from "./remote-runtime-test-fixture.ts";
import {
    ciRuns,
    executeDelivery,
    planDelivery,
    prepareDelivery,
    readWorkflowResult,
    scriptReviewAndRecord,
    snapshotProjectTree,
} from "./remote-runtime-workflows-fixture.ts";

test("remote planning, API approval, isolated execution, semantic repair and Work Record publication leave laptop project unchanged", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        // Only the declared project runtime storage is excluded; all other paths and bytes are protected.
        const before = await snapshotProjectTree(f.projectRoot, [".wld"]);
        const upstream = await prepareDelivery(f);
        const client = await f.start();
        await client.read();
        const id = await planDelivery(f, client);
        assertEquals(f.store.listSessionArtifacts(id)[0]?.kind, "plan");
        assertEquals(f.store.listSessionPlanAssociations(id)[0]?.planId, "remote-delivery-plan");
        const workflow = await executeDelivery(f, client);
        assert(workflow.executionCwd !== f.remoteProject);
        assert(workflow.executionCwd?.includes(f.remoteHome));
        const model = scriptReviewAndRecord(f, true);
        await client.send({ kind: "workflow-validate" });
        const validated = await readWorkflowResult(client);
        assertEquals(validated.result?.kind, "verified", JSON.stringify(validated));
        assertEquals(model.reviews(), 2);
        assertEquals(model.recordings(), 1, "The real in-memory Recorder must finish through the laptop model bridge");
        assertEquals(
            model.checklists(),
            1,
            "The real in-memory Manual QA agent must finish through the laptop model bridge",
        );
        assertEquals(await ciRuns(f), 2);
        const deliveredBranch = workflow.triageMeta?.deliveryBranch || "main";
        assertEquals(await git(upstream, ["show", `${deliveredBranch}:sentinel.txt`]), "remote delivered");
        const tree = await git(upstream, ["ls-tree", "-r", "--name-only", deliveredBranch]);
        assert(tree.includes("docs/work-records/"), tree);
        const segments = f.store.listSessionTranscriptSegments(id);
        assertEquals(
            segments.map((segment) => segment.kind),
            ["planning", "execution", "semantic_repair"],
        );
        const saved = (await f.control.list(id))[0].contents || "";
        assert(saved.includes('"status":"fix_confirmed"'));
        assert(saved.includes('"label":"AI Code Review","outcome":"Passed"'));
        assert(saved.includes('"label":"Work Record","outcome":"Created"'));
        assert(saved.includes("runwield.manual_qa_checklist"));
        assertEquals(f.store.listSessionArtifacts(id).filter((artifact) => artifact.kind === "plan").length, 1);
        assertEquals(await readFile(join(f.projectRoot, "sentinel.txt"), "utf8"), "laptop initial\n");
        await client.close();
        assertEquals(
            await snapshotProjectTree(f.projectRoot, [".wld"]),
            before,
            "All laptop project paths and bytes must be unchanged",
        );
        await assertRemoteStorageAbsent(f);
    });
});
