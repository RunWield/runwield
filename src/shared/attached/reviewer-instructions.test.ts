import { test } from "node:test";
import { ok as assert, strictEqual as equal } from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getHomeDir } from "../../constants.js";
import { attachedValidationFixture } from "./validation-test-fixture.ts";
import { inspectSemantic } from "./delivery-test-fixture.ts";
import { loadReviewerPrompt } from "../workflow/validation-prompts.ts";
import { readAttachedAction } from "./coordinator.ts";
import { ATTACHED_OPERATIONS } from "./operations.ts";

async function writePractice(body: string) {
    const directory = join(getHomeDir(), ".wld/agents/shared-practice");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "review-practice.md"), `---\nname: Fixture review practice\n---\n\n${body}\n`);
}

test("the actual Attached reviewer handoff includes the home review practice", async () => {
    const fixture = await attachedValidationFixture();
    try {
        await writePractice(
            "Read NOTES.md. If it lacks `acceptance: reviewed`, report a new finding titled `acceptance-notes`.",
        );
        assert((await loadReviewerPrompt()).systemPrompt.includes("acceptance-notes"));
        await writeFile(join(fixture.cwd, "marker"), "pass");
        const result = await fixture.call("start_validation", await fixture.status());
        assert(result.ok && result.workflow.nextAction.kind === "validation");
        assert(result.workflow.nextAction.request.kind === "reviewer");
        assert(
            result.instructions?.text.includes("acceptance-notes"),
            "The Core tool result must pass the layered review practice to the actual Claude reviewer.",
        );
    } finally {
        await fixture.close();
    }
});

test("replaying a reviewer handoff loads the current home policy without rerunning CI", async () => {
    const fixture = await attachedValidationFixture();
    try {
        await writeFile(join(fixture.cwd, "marker"), "pass");
        await writePractice("Policy before the reviewer was dispatched.");
        const workflow = await fixture.status();
        const first = await fixture.call("start_validation", workflow, {}, "reviewer-policy-replay");
        assert(first.ok && first.instructions?.text.includes("Policy before the reviewer was dispatched."));
        await writePractice("Policy after the reviewer was dispatched.");
        const replayed = await fixture.call("start_validation", workflow, {}, "reviewer-policy-replay");
        assert(replayed.ok && replayed.instructions);
        assert(replayed.instructions.text.includes("Policy after the reviewer was dispatched."));
        equal(replayed.instructions.text.includes("Policy before the reviewer was dispatched."), false);
        equal(await fixture.ciCount(), 1);
    } finally {
        await fixture.close();
    }
});

for (const scope of ["home", "project"])
    test(`${scope} discovery and verify policy survives real finding and repair rounds`, async () => {
        const fixture = await attachedValidationFixture();
        try {
            await writePractice("Home review policy: require the NOTES.md acceptance line.");
            if (scope === "project") {
                const directory = join(fixture.cwd, ".wld/agents/shared-practice");
                await mkdir(directory, { recursive: true });
                await writeFile(
                    join(directory, "review-practice.md"),
                    "---\nname: Project practice\n---\n\nProject review policy: require the NOTES.md acceptance line.\n",
                );
            }
            await writeFile(join(fixture.cwd, "marker"), "pass");
            let result = await fixture.call("start_validation", await fixture.status());
            let findingId = "";
            for (let round = 1; round <= 3; round++) {
                assert(result.ok && result.workflow.nextAction.kind === "validation");
                const action = result.workflow.nextAction;
                assert(action.request.kind === "reviewer");
                equal(action.request.reviewMode, round === 3 ? "verify" : "discovery");
                const policy = await loadReviewerPrompt(action.request.reviewMode, fixture.cwd);
                assert(result.instructions);
                assert(result.instructions.text.startsWith(policy.systemPrompt));
                const schema = ATTACHED_OPERATIONS.find((operation) => operation.name === "review_complete")!
                    .inputSchema.properties.payload;
                assert(result.instructions.text.includes(JSON.stringify(schema, null, 2)));
                assert(result.instructions.text.includes("Core includes the canonical review_complete payload schema"));
                assert(
                    result.instructions.text.includes(
                        scope === "project" ? "Project review policy:" : "Home review policy:",
                    ),
                );
                if (scope === "project") equal(result.instructions.text.includes("Home review policy:"), false);
                assert(result.instructions.text.includes(action.request.prompt));
                assert(
                    result.instructions.text.indexOf("## Attached independent reviewer") > policy.systemPrompt.length,
                );
                const inspected = await inspectSemantic(fixture, result.workflow);
                result = await fixture.call("review_complete", inspected.workflow, {
                    actionId: inspected.actionId,
                    approved: round === 3,
                    findings: [
                        round === 1
                            ? {
                                  title: "acceptance-notes",
                                  status: "new",
                                  requirement: "Require the NOTES.md acceptance line",
                                  evidence: "NOTES.md is absent",
                              }
                            : {
                                  id: findingId,
                                  title: "acceptance-notes",
                                  status: round === 3 ? "fix_confirmed" : "fix_rejected",
                                  ...(round === 2
                                      ? { rejectionReason: "NOTES.md still lacks the acceptance line" }
                                      : {}),
                              },
                    ],
                });
                assert(result.ok);
                if (round === 3) break;
                const repair = result.workflow.nextAction;
                assert(repair.kind === "validation" && repair.request.kind === "repair");
                if (round === 1) {
                    const assigned = repair.request.prompt.match(/\bR\d+-\d+\b/);
                    assert(assigned, "Core must supply the canonical ledger ID to the repair worker");
                    findingId = assigned[0];
                } else {
                    assert(repair.request.prompt.includes(findingId));
                }
                await writeFile(
                    join(fixture.cwd, "NOTES.md"),
                    round === 1 ? "Attempted repair\n" : "acceptance: reviewed\n",
                );
                result = await fixture.call("task_completed", result.workflow, {
                    actionId: repair.actionId,
                    message: `- Addressed ${findingId}; rerun checks and independent review.`,
                });
                assert(result.ok && result.workflow.nextAction.kind === "validation");
                const report = await readAttachedAction({
                    projectRoot: fixture.root,
                    workflowId: fixture.workflowId,
                    actionId: result.workflow.nextAction.actionId,
                    content: "repair_report",
                });
                assert(report.ok && "content" in report);
                equal(report.content, `- Addressed ${findingId}; rerun checks and independent review.`);
            }
            assert(result.ok);
            equal(result.workflow.nextAction.kind, "code_review");
            equal(await fixture.ciCount(), 3);
        } finally {
            await fixture.close();
        }
    });
