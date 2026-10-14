import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { applyAttachedReviewDecision, openAttachedReviewRound } from "./coordinator.ts";
import {
    activateInput,
    pendingTriage,
    planWrittenInput,
    reachPlanning,
    readRecordBytes,
    runOperation,
    submitReview,
    triageReportInput,
    withProject,
} from "./attached-test-fixture.ts";

const BUNDLED_PLANNER_TEXT = "You are the Planner — the Planned Change planning specialist";
const BUNDLED_ROUTER_TEXT = "Your ONLY job is to identify the Routing Intent and call `triage_report`.";

async function writeProjectPlanner(projectRoot: string, body: string): Promise<void> {
    await fsMkdir(join(projectRoot, ".wld", "agents"), { recursive: true });
    await fsWriteFile(join(projectRoot, ".wld", "agents", "planner.md"), `---\npromptOverride: true\n---\n\n${body}\n`);
}

test("activate returns the Router instructions with the pending Triage action", async () => {
    await withProject(async (projectRoot) => {
        const result = await runOperation("activate", projectRoot, activateInput());
        assert(result.ok && result.instructions, JSON.stringify(result));
        assertEquals(result.instructions.role, "router");
        assertEquals(result.instructions.contractVersion, "runwield.attached.triage/1");
        assertStringIncludes(result.instructions.text, BUNDLED_ROUTER_TEXT);
    });
});

test("after a PLANNED_CHANGE Triage, status returns the Planner action and Planner instructions", async () => {
    await withProject(async (projectRoot) => {
        const { planning } = await reachPlanning(projectRoot);
        const status = await runOperation("status", projectRoot, { workflowId: planning.workflowId });
        assert(status.ok && status.instructions, JSON.stringify(status));
        assertEquals(status.workflow.nextAction.kind, "plan");
        assertEquals(status.instructions.role, "planner");
        assertEquals(status.instructions.contractVersion, "runwield.attached.planner/1");
        assertStringIncludes(status.instructions.text, BUNDLED_PLANNER_TEXT);
        assertStringIncludes(status.instructions.text, "- `write`, `write_docs` -> `Write`");
        assertEquals(status.instructions.text.includes("{{"), false, "No template placeholder may reach the host.");
    });
});

test("Planner instructions keep initial submission and feedback review in Claude Code and the browser", async () => {
    await withProject(async (projectRoot) => {
        const workflow = await submitReview(projectRoot);
        for (const round of [1, 2]) {
            const handoff =
                round === 1
                    ? (await reachPlanning(projectRoot)).result
                    : await runOperation("status", projectRoot, { workflowId: workflow.workflowId });
            assert(handoff.ok && handoff.instructions, JSON.stringify(handoff));
            const text = handoff.instructions.text;
            assertStringIncludes(text, "even when the result has no `instructions`");
            assertStringIncludes(text, "show `review.url` and poll `status`");
            assertStringIncludes(text, "read its feedback, image paths, and note");
            assertStringIncludes(text, "Browser edits are already saved; do not apply them twice.");
            assertStringIncludes(text, "Stay in Claude Code and the browser; use no RunWield CLI or TUI commands.");
            assertEquals(text.includes("Plan review in the browser is not available"), false);
            assertEquals(text.includes("`wld` can open and run it"), false);
            assertEquals(text.includes("`instructions` ends the RunWield role"), false);

            if (round === 1) {
                const opened = await openAttachedReviewRound(projectRoot, workflow.workflowId);
                assert(opened.kind === "opened");
                await applyAttachedReviewDecision(projectRoot, workflow.workflowId, opened.basis, {
                    feedback: "Use a selector.",
                });
            } else {
                assert(handoff.workflow.nextAction.kind === "plan");
                const submitted = await runOperation(
                    "plan_written",
                    projectRoot,
                    planWrittenInput({
                        workflowId: workflow.workflowId,
                        actionId: handoff.workflow.nextAction.actionId,
                        expectedRevision: handoff.workflow.revision,
                        operationId: "resubmit",
                    }),
                );
                assert(submitted.ok);
                assertEquals(submitted.workflow.nextAction.kind, "review");
                assertEquals(submitted.instructions, undefined);
                assertEquals(submitted.workflow.review?.round, 2);
            }
        }
    });
});

test("a project planner definition replaces the bundled Planner instructions on the next response", async () => {
    await withProject(async (projectRoot) => {
        const { planning } = await reachPlanning(projectRoot);
        await writeProjectPlanner(projectRoot, "Project Planner: plan only in haiku.");
        const status = await runOperation("status", projectRoot, { workflowId: planning.workflowId });
        assert(status.ok && status.instructions, JSON.stringify(status));
        assertStringIncludes(status.instructions.text, "Project Planner: plan only in haiku.");
        assertEquals(status.instructions.text.includes(BUNDLED_PLANNER_TEXT), false);
    });
});

test("a replayed operation returns the instructions in effect now, and the record saves none", async () => {
    await withProject(async (projectRoot) => {
        const triage = pendingTriage(await runOperation("activate", projectRoot, activateInput()));
        const first = await runOperation("triage_report", projectRoot, triageReportInput(triage));
        assert(first.ok && first.instructions);
        assertStringIncludes(first.instructions.text, BUNDLED_PLANNER_TEXT);

        await writeProjectPlanner(projectRoot, "Project Planner: changed after Triage.");
        const replayed = await runOperation("triage_report", projectRoot, triageReportInput(triage));
        assert(replayed.ok && replayed.instructions);
        assertEquals(replayed.workflow, first.workflow);
        assertStringIncludes(replayed.instructions.text, "Project Planner: changed after Triage.");
        assertEquals((await readRecordBytes(projectRoot, triage.workflowId)).includes('"instructions"'), false);
    });
});

test("a closed workflow result carries no role instructions", async () => {
    await withProject(async (projectRoot) => {
        const triage = pendingTriage(await runOperation("activate", projectRoot, activateInput()));
        const outcome = { routingIntent: "INQUIRY", complexity: "LOW", summary: "question" };
        const closed = await runOperation("triage_report", projectRoot, triageReportInput({ ...triage, outcome }));
        assert(closed.ok, JSON.stringify(closed));
        assertEquals(closed.instructions, undefined);
    });
});
