import { test } from "node:test";
import { writeFile as fsWriteFile } from "node:fs/promises";
import { ok as assert } from "node:assert/strict";
import { assertEquals } from "../../testing/assertions.ts";
import { join } from "node:path";
import { attachedValidationFixture } from "./validation-test-fixture.ts";

for (const operationId of ["constructor", "toString", "valueOf"]) {
    test(`validation treats ${operationId} as an identifier and replays only recorded results`, async () => {
        const fixture = await attachedValidationFixture();
        try {
            const workflow = await fixture.status();
            const premature = await fixture.call(
                "task_completed",
                workflow,
                {
                    actionId: "not-pending",
                    message: "- No repair is pending.",
                },
                operationId,
            );
            assert(!premature.ok);
            assertEquals(premature.rejection.code, "action_superseded");

            const started = await fixture.call("start_validation", workflow, {}, operationId);
            assert(started.ok && started.workflow.nextAction.kind === "validation");
            assertEquals(started.workflow.nextAction.request.kind, "repair");
            assertEquals(await fixture.call("start_validation", workflow, {}, operationId), started);
            assertEquals(await fixture.ciCount(), 1);

            await fsWriteFile(join(fixture.cwd, "marker"), "fixed");
            const payload = {
                actionId: started.workflow.nextAction.actionId,
                message: "- Fixed CI by adding the marker.",
            };
            const repairId = operationId === "constructor" ? "toString" : "constructor";
            const repaired = await fixture.call("task_completed", started.workflow, payload, repairId);
            assert(repaired.ok && repaired.workflow.nextAction.kind === "validation");
            assertEquals(repaired.workflow.nextAction.request.kind, "reviewer");
            assertEquals(await fixture.call("task_completed", started.workflow, payload, repairId), repaired);
            assertEquals(await fixture.ciCount(), 2);
        } finally {
            await fixture.close();
        }
    });
}
