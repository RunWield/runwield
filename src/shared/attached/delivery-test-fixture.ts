import { assert } from "@std/assert";
import { join } from "@std/path";
import { attachedValidationFixture } from "./validation-test-fixture.ts";
import { parseDiffFiles } from "../workflow/review-diff.ts";
import type { AttachedWorkflowView } from "./operations.ts";

let indexRuntime: Promise<void> | undefined;
export function prepareIndexRuntime(): Promise<void> {
    return indexRuntime ||= (async () => {
        const output = await new Deno.Command("mnemoteca", { args: ["setup"], stdout: "piped", stderr: "piped" })
            .output();
        assert(output.success, new TextDecoder().decode(output.stderr));
    })();
}

type Fixture = Awaited<ReturnType<typeof attachedValidationFixture>>;
export async function inspectSemantic(fixture: Fixture, workflow: AttachedWorkflowView) {
    const action = workflow.nextAction;
    assert(action.kind === "validation" && action.request.kind === "reviewer", JSON.stringify(workflow));
    for (
        const file of parseDiffFiles(
            action.request.requiredScope === "full" ? action.request.fullDiff : action.request.repairDiff,
        )
    ) {
        const read = await fixture.call("review_diff", workflow, {
            actionId: action.actionId,
            command: "show",
            scope: action.request.requiredScope,
            path: file.path,
            maxBytes: 65536,
        });
        assert(read.ok, JSON.stringify(read));
        workflow = read.workflow;
    }
    return { workflow, actionId: action.actionId };
}
export async function approveSemantic(fixture: Fixture, workflow: AttachedWorkflowView) {
    const inspected = await inspectSemantic(fixture, workflow);
    const result = await fixture.call("review_complete", inspected.workflow, {
        actionId: inspected.actionId,
        approved: true,
    });
    assert(result.ok, JSON.stringify(result));
    return result;
}
export async function toDelivery(fixture: Fixture) {
    await prepareIndexRuntime();
    await Deno.writeTextFile(join(fixture.cwd, "marker"), "pass");
    const result = await fixture.call("start_validation", await fixture.status());
    assert(result.ok, JSON.stringify(result));
    return await approveSemantic(fixture, result.workflow);
}
