import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskService } from "../src/service.ts";

if (process.argv[2] !== "single-consumer") throw new Error("Select single-consumer");
const root = await mkdtemp(join(tmpdir(), "repair-proof-"));
try {
    const service = new TaskService(root);
    await service.requestRepair("repair-live");
    await service.completeTask("repair-live");
    const state = await new TaskService(root).snapshot();
    assert.deepEqual(
        { consumers: state.consumers, transitions: state.transitions },
        { consumers: [{ taskId: "repair-live", owner: "validation" }], transitions: ["repairing->checking"] },
        "RV-D08-SINGLE-CONSUMER",
    );
    assert.equal(state.phase, "checking");
    const reopened = new TaskService(root);
    await reopened.recover();
    assert.deepEqual(await reopened.snapshot(), state, "Recovery must not replay a consumed live result");
    await reopened.requestRepair("repair-offline");
    await reopened.recordCompletion("repair-offline");
    const restarted = new TaskService(root);
    await restarted.recover();
    await restarted.recover();
    const recovered = await restarted.snapshot();
    assert.equal(recovered.phase, "checking");
    assert.deepEqual(recovered.consumers, [
        { taskId: "repair-live", owner: "validation" },
        { taskId: "repair-offline", owner: "validation" },
    ]);
    assert.deepEqual(recovered.transitions, ["repairing->checking", "repairing->checking"]);
    console.log("PASS single-consumer");
} finally {
    await rm(root, { recursive: true, force: true });
}
