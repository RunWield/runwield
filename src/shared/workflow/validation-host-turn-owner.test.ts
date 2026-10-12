import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { getLockHostname } from "../process-liveness.ts";
import { updatePlanFrontMatter } from "../../plan-store.js";
import { recordValidationRepairCompletion } from "./validation-supervisor.ts";
import { complete, hostFixture, hostRequest } from "./testing/validation-host-fixture.ts";

for (const state of ["awaiting_repair", "ready", "paused"] as const) {
    Deno.test(`a live validation owner retains a saved ${state} checkpoint`, async () => {
        const fixture = await hostFixture();
        try {
            const repair = hostRequest(await fixture.processTurn(), "repair");
            const plan = await fixture.plan();
            const pending = plan.attrs.validationCheckpoint;
            assertExists(pending);
            await updatePlanFrontMatter(
                fixture.cwd,
                "p",
                {
                    validationCheckpoint: { ...pending, state, ownerPid: Deno.pid, ownerHostname: getLockHostname() },
                },
                plan.attrs,
                {
                    expectedRevision: plan.revision,
                    expectedControllerRevision: plan.controllerRevision,
                },
            );
            const checkpoint = await fixture.checkpointBytes();
            const evidence = await fixture.evidence();
            const active = await fixture.processTurn();
            assertEquals(active.kind, "paused");
            if (active.kind === "paused") assertEquals(active.recovery?.code, "validation_owner_active");
            const completion = await fixture.processTurn(complete(repair));
            assertEquals(completion.kind, "paused");
            if (completion.kind === "paused") assertEquals(completion.recovery?.code, "validation_owner_active");
            await assertRejects(() =>
                recordValidationRepairCompletion({
                    projectRoot: fixture.cwd,
                    planName: "p",
                    repairGeneration: repair.repairGeneration,
                    report: "Must not release the live owner.",
                })
            );
            assertEquals(await fixture.checkpointBytes(), checkpoint);
            assertEquals(await fixture.ciCount(), 1);
            assertEquals(await fixture.evidence(), evidence);
        } finally {
            await fixture.close();
        }
    });
}

for (const changedOwnerField of ["ownerPid", "ownerHostname"] as const) {
    Deno.test(`validation settlement cannot release a changed ${changedOwnerField}`, async () => {
        const fixture = await hostFixture({ command: "sh slow-ci.sh" });
        const holder = new Deno.Command(Deno.execPath(), {
            args: ["eval", "await new Promise(resolve => setTimeout(resolve, 60000))"],
            stdout: "null",
            stderr: "null",
        }).spawn();
        let turn: ReturnType<typeof fixture.turn> | undefined;
        try {
            await Deno.writeTextFile(
                join(fixture.cwd, "slow-ci.sh"),
                "printf ci\\n >> ci-count\ntouch ci-started\nwhile [ ! -f ci-release ]; do sleep 0.05; done\nexit 0\n",
            );
            turn = fixture.turn();
            const deadline = Date.now() + 30000;
            while (!await Deno.stat(join(fixture.cwd, "ci-started")).then(() => true, () => false)) {
                if (Date.now() > deadline) throw new Error("CI did not start.");
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            const plan = await fixture.plan();
            const checkpoint = plan.attrs.validationCheckpoint;
            assertExists(checkpoint);
            assertEquals(checkpoint.ownerPid, Deno.pid);
            const replacement = {
                ...checkpoint,
                ...(changedOwnerField === "ownerPid" ? { ownerPid: holder.pid } : { ownerHostname: "new-owner-host" }),
            };
            await updatePlanFrontMatter(fixture.cwd, "p", { validationCheckpoint: replacement }, plan.attrs, {
                expectedRevision: plan.revision,
                expectedControllerRevision: plan.controllerRevision,
            });
            await Deno.writeTextFile(join(fixture.cwd, "ci-release"), "release");
            hostRequest(await turn, "reviewer");
            const saved = (await fixture.plan()).attrs.validationCheckpoint;
            assertEquals(saved?.generation, replacement.generation);
            assertEquals(saved?.ownerPid, replacement.ownerPid);
            assertEquals(saved?.ownerHostname, replacement.ownerHostname);
            assertEquals(await fixture.ciCount(), 1);
        } finally {
            await Deno.writeTextFile(join(fixture.cwd, "ci-release"), "release").catch(() => {});
            await turn?.catch(() => {});
            holder.kill();
            await holder.status;
            await fixture.close();
        }
    });
}
