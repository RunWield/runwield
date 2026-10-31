import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { resolveAttachedRoleInstructions } from "./role-instructions.ts";
import { readAttachedAction, applyAttachedReviewDecision, openAttachedReviewRound } from "./coordinator.ts";
import {
    EVIDENCE,
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

test("Codex roles use current host tools and worker language without copied Claude instructions", async () => {
    await withProject(async (root) => {
        for (const role of [
            "router",
            "planner",
            "engineer",
            "frontend-engineer",
            "reviewer",
            "reviewer-feedback-engineer",
            "recorder",
        ] as const) {
            const text = await resolveAttachedRoleInstructions(root, role, "codex");
            assertStringIncludes(text, "Codex");
            assertEquals(text.includes("Claude-hosted"), false);
            assertEquals(text.includes("Claude subagent"), false);
            assertEquals(text.includes("RunWield in Claude Code"), false);
            assertEquals(text.includes("{{"), false);
            if (role !== "reviewer") assertStringIncludes(text, "`exec_command`");
            else {
                assertStringIncludes(text, "RunWield MCP review_diff directly");
                assertEquals(text.includes("## Skills"), false);
            }
        }
        const result = await runOperation("activate", root, {
            ...activateInput(),
            evidence: { ...EVIDENCE, host: "codex", hostVersion: "0.164.0-alpha.11.1" },
        });
        assert(result.ok && result.instructions);
        assertStringIncludes(result.instructions.text, "RunWield in Codex");
        assertStringIncludes(result.instructions.text, "Codex makes every model call");
    });
});

async function writeProjectPlanner(projectRoot: string, body: string): Promise<void> {
    await fsMkdir(join(projectRoot, ".wld", "agents"), { recursive: true });
    await fsWriteFile(join(projectRoot, ".wld", "agents", "planner.md"), `---\npromptOverride: true\n---\n\n${body}\n`);
}

test("Codex planning workers return structured outcomes and leave lifecycle submission with the coordinator", async () => {
    await withProject(async (root) => {
        for (const role of ["router", "planner"] as const) {
            const text = await resolveAttachedRoleInstructions(root, role, "codex");
            const worker = text.split("## Attached planning worker")[1];
            assert(worker);
            assertStringIncludes(worker, "Fetch your own current get_instructions and context");
            assertStringIncludes(worker, "return context.projectSetup paths to the coordinator");
            assertStringIncludes(worker, "structured triage_report outcome");
            assertStringIncludes(worker, "return planName");
            assertStringIncludes(worker, "Make no lifecycle calls");
            assertStringIncludes(worker, "The coordinator submits your result");
            assertEquals(
                (await resolveAttachedRoleInstructions(root, role, "claude-code")).includes(
                    "## Attached planning worker",
                ),
                false,
            );
        }
    });
});

test("activate returns the Router instructions with the pending Triage action", async () => {
    await withProject(async (projectRoot) => {
        const result = await runOperation("activate", projectRoot, activateInput());
        assert(result.ok && result.instructions, JSON.stringify(result));
        assertEquals(result.instructions.role, "router");
        assertEquals(result.instructions.contractVersion, "runwield.attached.triage/1");
        assertStringIncludes(result.instructions.text, BUNDLED_ROUTER_TEXT);
    });
});

test("after a PLANNED_CHANGE Triage, status omits instructions and the Planner fetches them", async () => {
    await withProject(async (projectRoot) => {
        const { planning } = await reachPlanning(projectRoot);
        const status = await runOperation("status", projectRoot, { workflowId: planning.workflowId });
        assert(status.ok && status.workflow.nextAction.kind === "plan");
        assertEquals(status.instructions, undefined);
        const content = await readAttachedAction({
            evidence: EVIDENCE,
            projectRoot,
            workflowId: planning.workflowId,
            actionId: status.workflow.nextAction.actionId,
            content: "instructions",
        });
        assert(content.ok && "instructions" in content);
        assertEquals(content.instructions.role, "planner");
        assertEquals(content.instructions.contractVersion, "runwield.attached.planner/1");
        assertStringIncludes(content.instructions.text, BUNDLED_PLANNER_TEXT);
        assertStringIncludes(content.instructions.text, "- `write`, `write_docs` -> `Write`");
        assertEquals(content.instructions.text.includes("{{"), false, "No template placeholder may reach the host.");
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
            assert(handoff.ok && handoff.workflow.nextAction.kind === "plan");
            const content =
                round === 1
                    ? handoff
                    : await readAttachedAction({
                          evidence: EVIDENCE,
                          projectRoot,
                          workflowId: handoff.workflow.workflowId,
                          actionId: handoff.workflow.nextAction.actionId,
                          content: "instructions",
                      });
            assert(content.ok && "instructions" in content && content.instructions);
            const text = content.instructions.text;
            assertStringIncludes(text, "even when the result has no `instructions`");
            assertStringIncludes(text, "show `review.url` and wait with MCP `status`");
            assertStringIncludes(text, "waitForRevision");
            assertStringIncludes(text, "timeoutMs: 30000");
            assertStringIncludes(text, "context.projectSetup");
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
        assert(status.ok && status.workflow.nextAction.kind === "plan");
        const content = await readAttachedAction({
            evidence: EVIDENCE,
            projectRoot,
            workflowId: planning.workflowId,
            actionId: status.workflow.nextAction.actionId,
            content: "instructions",
        });
        assert(content.ok && "instructions" in content);
        assertStringIncludes(content.instructions.text, "Project Planner: plan only in haiku.");
        assertEquals(content.instructions.text.includes(BUNDLED_PLANNER_TEXT), false);
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

test("Attached roles resolve the current project Skill override without adding Skills to the reviewer", async () => {
    await withProject(async (projectRoot) => {
        const path = join(projectRoot, ".wld", "skills", "diagnose", "SKILL.md");
        await fsMkdir(join(projectRoot, ".wld", "skills", "diagnose"), { recursive: true });
        for (const description of ["Project diagnostic technique", "Updated project diagnostic technique"]) {
            await fsWriteFile(path, `---\nname: diagnose\ndescription: ${description}\n---\nProject body`);
            for (const role of ["engineer", "planner"] as const) {
                const text = await resolveAttachedRoleInstructions(projectRoot, role);
                assertStringIncludes(text, "## Skills");
                assertStringIncludes(text, `- diagnose - ${description} (read: ${path})`);
                assertEquals(text.split("- diagnose -").length - 1, 1);
                assertEquals(text.includes("/bundled-skills/diagnose/SKILL.md"), false);
            }
        }
        assertEquals((await resolveAttachedRoleInstructions(projectRoot, "reviewer")).includes("## Skills"), false);
    });
});
