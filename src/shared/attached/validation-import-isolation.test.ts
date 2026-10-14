import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { test } from "node:test";
import { writeFile as fsWriteFile, stat as fsStat } from "node:fs/promises";
import { captureForegroundProcess } from "../captured-process.ts";
import { ok as assert } from "node:assert/strict";
import { assertEquals } from "../../testing/assertions.ts";
import { join } from "node:path";
import { attachedValidationFixture } from "./validation-test-fixture.ts";
import { DENO_CONFIG_PATH, EVIDENCE } from "./attached-test-fixture.ts";
import { type AttachedOperationResult } from "./operations.ts";
import process from "node:process";

test("a network-denied fresh Attached coordinator process validates without starting a model executor", async () => {
    const fixture = await attachedValidationFixture();
    try {
        await fsWriteFile(join(fixture.cwd, "marker"), "pass");
        const workflow = await fixture.status();
        const entry = join(fixture.parent, "attached-process.ts");
        const moduleUrl = new URL("./coordinator.ts", import.meta.url).href;
        await fsWriteFile(
            entry,
            `import { denyNetwork } from ${JSON.stringify(new URL("../../testing/deny-network.ts", import.meta.url).href)};
denyNetwork();
const { runAttachedOperation } = await import(${JSON.stringify(moduleUrl)});\n` +
                `const result = await runAttachedOperation("start_validation", ${JSON.stringify(fixture.root)}, ${JSON.stringify(
                    JSON.stringify({
                        operationId: "isolated-validation",
                        workflowId: workflow.workflowId,
                        expectedRevision: workflow.revision,
                        evidence: EVIDENCE,
                        payload: {},
                    }),
                )});\nconsole.log("ATTACHED_RESULT=" + JSON.stringify(result));\n`,
        );
        const output = await captureForegroundProcess(process.execPath, {
            args: runtimeSourceArgs(["run", "-A", "--no-check", "--config", DENO_CONFIG_PATH, entry]),
            cwd: fixture.root,
            env: { PATH: `${fixture.bin}:${process.env["PATH"] || ""}` },
        });
        assert(output.success, new TextDecoder().decode(output.stderr));
        const text = new TextDecoder().decode(output.stdout);
        const result: AttachedOperationResult = JSON.parse(text.slice(text.lastIndexOf("ATTACHED_RESULT=") + 16));
        assert(result.ok && result.workflow.nextAction.kind === "validation");
        assertEquals(result.workflow.nextAction.request.kind, "reviewer");
        assertEquals(
            await fsStat(fixture.modelMarker).then(
                () => true,
                () => false,
            ),
            false,
        );
    } finally {
        await fixture.close();
    }
});
