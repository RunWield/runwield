import { assert, assertEquals } from "@std/assert";
import { attachedValidationFixture } from "./validation-test-fixture.ts";
import { EVIDENCE, spawnAttachedCli } from "./attached-test-fixture.ts";
import { join } from "@std/path";
import { getHomeDir } from "../../constants.js";
import { prepareIndexRuntime } from "./delivery-test-fixture.ts";
import { listWorkRecords } from "../work-records/store.js";
import { findIndexedDocumentIdsByRecordId } from "../work-records/index-adapter.ts";
import { SYSTEM_WORK_RECORD_MNEMOTECA_PORT } from "../work-records/mnemoteca-port.ts";
import { crash } from "./delivery-recovery-test-fixture.ts";

for (const timing of ["before", "after"] as const) {
    Deno.test(`a fresh process reports in-place completion ${timing} Core verification without a Git claim`, async () => {
        await prepareIndexRuntime();
        const fixture = await attachedValidationFixture({ nonGit: true, attrs: { humanReviewMode: "none" } });
        try {
            await Deno.writeTextFile(join(fixture.cwd, "marker"), "pass");
            const started = await fixture.call("start_validation", await fixture.status());
            assert(started.ok && started.workflow.nextAction.kind === "recorder", JSON.stringify(started));
            await crash(
                fixture,
                "work_record_completed",
                {
                    workflowId: fixture.workflowId,
                    expectedRevision: started.workflow.revision,
                    operationId: "interrupted-in-place-record",
                    evidence: EVIDENCE,
                    payload: {
                        actionId: started.workflow.nextAction.actionId,
                        title: "In-place value",
                        summary: "Implemented in place with consent.",
                    },
                },
                "in_place_verified",
                timing,
            );
            const status = await spawnAttachedCli("status", fixture.root, { workflowId: fixture.workflowId });
            assert(status.result.ok);
            const resumed = await spawnAttachedCli("start_validation", fixture.root, {
                workflowId: fixture.workflowId,
                expectedRevision: status.result.workflow.revision,
                operationId: "resume-in-place",
                evidence: EVIDENCE,
                payload: {},
            });
            assert(
                resumed.result.ok && resumed.result.workflow.nextAction.kind === "delivered",
                JSON.stringify(resumed.result) + "\n" +
                    await Deno.readTextFile(join(getHomeDir(), ".wld/debug/validation-errors.jsonl")).catch(() => ""),
            );
            assertEquals(resumed.result.workflow.nextAction.completionMode, "in_place");
            assert(resumed.result.workflow.nextAction.guidance.includes("no Git publication is claimed"));
            const records = await listWorkRecords(fixture.root);
            assertEquals(records.length, 1);
            assertEquals(records[0].attrs.status, "approved");
            assertEquals(
                (await findIndexedDocumentIdsByRecordId(fixture.root, records[0].attrs.recordId, {
                    mnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
                })).length,
                1,
            );
        } finally {
            await fixture.close();
        }
    });
}
