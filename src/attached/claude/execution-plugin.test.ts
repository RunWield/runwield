import { test } from "node:test";
import { readFile as fsReadFile } from "node:fs/promises";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";

test("Claude command instructions automatically dispatch a host worker and return its report through Core", async () => {
    const request = await fsReadFile(new URL("./plugin/commands/request.md", import.meta.url), "utf8");
    const restore = await fsReadFile(new URL("./plugin/commands/implement.md", import.meta.url), "utf8");
    const review = await fsReadFile(new URL("./plugin/commands/plan-review.md", import.meta.url), "utf8");
    for (const source of [request, restore, review]) {
        const text = source.replace(/\s+/g, " ");
        assertStringIncludes(text, "immediately call `start_execution`");
        assertStringIncludes(text, "task_completed");
        assert(/plain[- ]text/.test(text));
        assert(/decline[\s\S]*(?:stop|do not restart|do not automatically restart)/i.test(text));
        assertEquals(text.includes("implementation_complete"), false);
        assertEquals(text.includes("execution handoff is a later Preview step"), false);
    }
    for (const source of [request, review]) {
        assertStringIncludes(source, "waitForRevision");
        assertStringIncludes(source, "timeoutMs");
    }
    for (const source of [request, restore]) {
        const text = source.replace(/\s+/g, " ");
        for (const field of ["executionCwd", "planPath", "planName", "role", "message"]) {
            assertStringIncludes(text, field);
        }
        assertStringIncludes(text, "runwield.attached.implementation/1");
        assertStringIncludes(text, "Do not");
        assert(/host.{0,10}worktree isolation/.test(text));
        assertStringIncludes(text, "worker");
        assertStringIncludes(text, "invoking checkout");
        assertStringIncludes(text, "bullet");
        assertStringIncludes(text, "user-visible message before dispatch");
        assertStringIncludes(text, "instructions");
        assertStringIncludes(text, "Git checkpoint");
    }
});

test("every Claude command shows Core compatibility guidance before continuing", async () => {
    for (const command of ["request", "plan-review", "implement", "validate"]) {
        const source = await fsReadFile(new URL(`./plugin/commands/${command}.md`, import.meta.url), "utf8");
        const text = source.replace(/\s+/g, " ");
        assertStringIncludes(text, "Show any returned `compatibility` notice to the user before continuing");
        assertStringIncludes(text, "`incompatible_adapter`");
        assertStringIncludes(text, "`unsupported_host_version`");
        assertStringIncludes(text, "show Core's update message and stop");
        assertEquals(text.includes("Installation and full preflight are separate capabilities"), false);
    }
});

test("Claude resume commands identify saved work before advancing a cross-host workflow", async () => {
    for (const command of ["plan-review", "implement", "validate"]) {
        const source = await fsReadFile(new URL(`./plugin/commands/${command}.md`, import.meta.url), "utf8");
        const firstStep = source.match(/^1\. ([\s\S]*?)(?=^2\. )/m)?.[1].replace(/\s+/g, " ");
        assert(firstStep, `${command} must identify the workflow before its action instructions.`);
        assert(
            /^First call MCP `status` with `\{ workflowId, inspectOnly: true \}`/.test(firstStep),
            `${command}'s first status call must not advance the workflow.`,
        );
        assertStringIncludes(firstStep, "`{ inspectOnly: true }`");
        const continuation = firstStep.indexOf("call ordinary `status` with that `workflowId`");
        assert(continuation > 0, `${command} must continue the inspected workflow after its summary.`);
        const summary = firstStep.slice(0, continuation);
        for (const field of [
            "workflow.plan.planName",
            "workflow.requestSummary",
            "workflow.nextAction",
            "workflow.originHost",
        ]) {
            assertStringIncludes(summary, `\`${field}\``);
        }
        assertStringIncludes(summary, "do not activate a new request");
        assertStringIncludes(summary, "only inspection, stop after this summary");
        assertStringIncludes(summary, "without another host-switch confirmation");
        assertStringIncludes(summary, "do not import the other host's transcript");
        assertStringIncludes(firstStep, "Only after showing this summary");
        assertStringIncludes(
            firstStep,
            "Do not fetch role instructions, start checks, or dispatch a worker before the summary",
        );
    }
});

test("validation instructions preserve the Core text and selection answer contracts", async () => {
    const text = (await fsReadFile(new URL("./plugin/commands/validate.md", import.meta.url), "utf8")).replace(
        /\s+/g,
        " ",
    );
    assertStringIncludes(text, "`text` request");
    assertStringIncludes(text, 'outcome: "text"');
    assertStringIncludes(text, "`select` request");
    assertStringIncludes(text, 'outcome: "selected"');
    assertStringIncludes(text, "already supplied");
});
