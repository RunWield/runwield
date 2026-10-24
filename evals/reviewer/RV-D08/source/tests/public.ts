import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskService } from "../src/service.ts";

const root = await mkdtemp(join(tmpdir(), "repair-public-"));
try {
    const service = new TaskService(root);
    await service.addTask("task-1");
    await service.completeTask("task-1");
    assert.equal((await new TaskService(root).snapshot()).tasks[0].completed, true);
    assert.equal((await service.snapshot()).phase, "idle");
    assert.deepEqual((await service.snapshot()).notifications, ["task-1"]);
    console.log("PASS ordinary task completion is durable");
    await assert.rejects(service.completeTask("missing"), /Task not found/);
    console.log("PASS unknown completion is refused");
} finally {
    await rm(root, { recursive: true, force: true });
}
