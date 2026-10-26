import { EVIDENCE } from "./attached-test-fixture.ts";
import { test } from "node:test";
import { ok as assert, strictEqual as equal, deepStrictEqual } from "node:assert/strict";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readAttachedAction } from "./coordinator.ts";
import { attachedValidationFixture } from "./validation-test-fixture.ts";
import { resolveValidationCommand } from "../workflow/validation-local-ci.ts";

test("a configured validation command runs unchanged without a command question", async () => {
    const command = "printf supplied > chosen-command; sh verify.sh";
    const fixture = await attachedValidationFixture({ command });
    try {
        await writeFile(join(fixture.cwd, "marker"), "pass");
        const started = await fixture.call("start_validation", await fixture.status());
        assert(started.ok && started.workflow.nextAction.kind === "validation");
        equal(started.workflow.nextAction.request.kind, "reviewer");
        equal(await resolveValidationCommand(fixture.cwd, "exact-project"), command);
        equal(await readFile(join(fixture.cwd, "chosen-command"), "utf8"), "supplied");
        equal(await fixture.ciCount(), 1);
    } finally {
        await fixture.close();
    }
});

test("a missing command exposes the exact durable question and runs nothing until a valid answer", async () => {
    const fixture = await attachedValidationFixture({ command: null });
    try {
        const started = await fixture.call("start_validation", await fixture.status());
        assert(started.ok && started.workflow.nextAction.kind === "validation");
        const action = started.workflow.nextAction;
        assert(action.request.kind === "decision");
        equal(action.request.interaction.type, "text");
        assert(action.request.interaction.prompt);
        const prompt = await readAttachedAction({
            evidence: EVIDENCE,
            projectRoot: fixture.root,
            workflowId: fixture.workflowId,
            actionId: action.actionId,
            content: "instructions",
        });
        assert(prompt.ok && "request" in prompt);
        deepStrictEqual(prompt.request, action.request);
        const resumed = await fixture.call("start_validation", await fixture.status());
        assert(resumed.ok);
        deepStrictEqual(resumed.workflow.nextAction, action);
        const invalid = await fixture.call("validation_decision", resumed.workflow, {
            actionId: action.actionId,
            answer: { outcome: "text", value: "   " },
        });
        assert(!invalid.ok);
        equal(await resolveValidationCommand(fixture.cwd, "exact-project"), "");
        equal(await fixture.ciCount(), 0);
        const waiting = await fixture.status();
        equal(waiting.nextAction.kind, "validation_recovery");
        const recovered = await fixture.call("start_validation", waiting);
        assert(recovered.ok && recovered.workflow.nextAction.kind === "validation");
        deepStrictEqual(recovered.workflow.nextAction.request, action.request);
        equal(await fixture.ciCount(), 0);
    } finally {
        await fixture.close();
    }
});

test("an explicit Plan command can answer Core's question and remains the exact saved command", async () => {
    const fixture = await attachedValidationFixture({ command: null });
    const command = "printf plan > chosen-command; sh verify.sh";
    try {
        await appendFile(join(fixture.cwd, "docs/plans/p.md"), `\n## Verification Plan\n\nRun \`${command}\`.\n`);
        await writeFile(join(fixture.cwd, "marker"), "pass");
        const started = await fixture.call("start_validation", await fixture.status());
        assert(started.ok && started.workflow.nextAction.kind === "validation");
        assert(started.workflow.nextAction.request.kind === "decision");
        equal(await fixture.ciCount(), 0);
        const answered = await fixture.call("validation_decision", started.workflow, {
            actionId: started.workflow.nextAction.actionId,
            answer: { outcome: "text", value: command },
        });
        assert(answered.ok && answered.workflow.nextAction.kind === "validation");
        equal(answered.workflow.nextAction.request.kind, "reviewer");
        equal(await resolveValidationCommand(fixture.cwd, "exact-project"), command);
        equal(await readFile(join(fixture.cwd, "chosen-command"), "utf8"), "plan");
        equal(await fixture.ciCount(), 1);
        const restored = await fixture.call("start_validation", await fixture.status());
        assert(restored.ok);
        equal(await fixture.ciCount(), 1);
    } finally {
        await fixture.close();
    }
});
