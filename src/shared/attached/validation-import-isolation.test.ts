import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { attachedValidationFixture } from "./validation-test-fixture.ts";
import { DENO_CONFIG_PATH, EVIDENCE } from "./attached-test-fixture.ts";
import type { AttachedOperationResult } from "./operations.ts";

Deno.test("a network-denied fresh Attached coordinator process validates without starting a model executor", async () => {
    const fixture = await attachedValidationFixture();
    try {
        await Deno.writeTextFile(join(fixture.cwd, "marker"), "pass");
        const workflow = await fixture.status();
        const entry = join(fixture.parent, "attached-process.ts");
        const moduleUrl = new URL("./coordinator.ts", import.meta.url).href;
        await Deno.writeTextFile(
            entry,
            `import { runAttachedOperation } from ${JSON.stringify(moduleUrl)};\n` +
                `const result = await runAttachedOperation("start_validation", ${JSON.stringify(fixture.root)}, ${
                    JSON.stringify(JSON.stringify({
                        operationId: "isolated-validation",
                        workflowId: workflow.workflowId,
                        expectedRevision: workflow.revision,
                        evidence: EVIDENCE,
                        payload: {},
                    }))
                });\nconsole.log("ATTACHED_RESULT=" + JSON.stringify(result));\n`,
        );
        const output = await new Deno.Command(Deno.execPath(), {
            args: ["run", "-A", "--deny-net", "--no-check", "--config", DENO_CONFIG_PATH, entry],
            cwd: fixture.root,
            env: { PATH: `${fixture.bin}:${Deno.env.get("PATH") || ""}` },
            stdout: "piped",
            stderr: "piped",
        }).output();
        assert(output.success, new TextDecoder().decode(output.stderr));
        const text = new TextDecoder().decode(output.stdout);
        const result: AttachedOperationResult = JSON.parse(text.slice(text.lastIndexOf("ATTACHED_RESULT=") + 16));
        assert(result.ok && result.workflow.nextAction.kind === "validation");
        assertEquals(result.workflow.nextAction.request.kind, "reviewer");
        assertEquals(await Deno.stat(fixture.modelMarker).then(() => true, () => false), false);
    } finally {
        await fixture.close();
    }
});
