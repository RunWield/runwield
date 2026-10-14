import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { attachedValidationFixture } from "./validation-test-fixture.ts";
import { prepareIndexRuntime } from "./delivery-test-fixture.ts";
import { DENO_CONFIG_PATH, EVIDENCE } from "./attached-test-fixture.ts";
import { parseDiffFiles } from "../workflow/review-diff.ts";
import { listWorkRecords } from "../work-records/store.js";
import {
    findIndexedDocumentIdsByRecordId,
    getWorkRecordIndexCollectionName,
    runMnemotecaWorkRecordCommand,
} from "../work-records/index-adapter.ts";
import { SYSTEM_WORK_RECORD_MNEMOTECA_PORT } from "../work-records/mnemoteca-port.ts";
import { loadPlan } from "../../plan-store.js";
import type {
    AttachedJsonObject,
    AttachedOperationName,
    AttachedOperationResult,
    AttachedWorkflowView,
} from "./operations.ts";

Deno.test("whole Attached delivery starts zero Core model sessions and excludes private host text from durable outcomes", async () => {
    await prepareIndexRuntime();
    const fixture = await attachedValidationFixture({ attrs: { workKind: "FEATURE", humanReviewMode: "always" } });
    const privateHostConversation = "PRIVATE_CLAUDE_CONVERSATION_8d25aacd";
    try {
        const marker = join(fixture.parent, "core-model-turns");
        const hosted = new URL("../session/hosted-session.js", import.meta.url).href;
        const sessions = new URL("../session/session.js", import.meta.url).href;
        const monitorHosted = join(fixture.parent, "monitor-hosted.js");
        const monitorSessions = join(fixture.parent, "monitor-sessions.js");
        await Deno.writeTextFile(
            monitorHosted,
            `export * from ${JSON.stringify(hosted + "?attached-monitor")};\nimport { HostedSession as Core } from ${
                JSON.stringify(hosted + "?attached-monitor")
            };\nexport class HostedSession extends Core { constructor(options) { Deno.writeTextFileSync(${
                JSON.stringify(marker)
            }, "HostedSession\\n", {append:true}); super(options); } }\n`,
        );
        await Deno.writeTextFile(
            monitorSessions,
            `export * from ${
                JSON.stringify(sessions + "?attached-monitor")
            };\nimport { runIsolatedAgentSession as core } from ${
                JSON.stringify(sessions + "?attached-monitor")
            };\nexport function runIsolatedAgentSession(...args) { Deno.writeTextFileSync(${
                JSON.stringify(marker)
            }, "runIsolatedAgentSession\\n", {append:true}); return core(...args); }\n`,
        );
        const base: { imports: Record<string, string> } = JSON.parse(await Deno.readTextFile(DENO_CONFIG_PATH));
        const imports = Object.fromEntries(
            Object.entries(base.imports).map((
                [key, value],
            ) => [key, value.startsWith(".") ? new URL(value, new URL(`file://${DENO_CONFIG_PATH}`)).href : value]),
        );
        const config = join(fixture.parent, "monitor-config.json");
        await Deno.writeTextFile(
            config,
            JSON.stringify({
                ...base,
                imports: {
                    ...imports,
                    [hosted]: new URL(`file://${monitorHosted}`).href,
                    [sessions]: new URL(`file://${monitorSessions}`).href,
                },
            }),
        );
        const call = async (
            operation: AttachedOperationName,
            workflow: AttachedWorkflowView,
            payload: AttachedJsonObject = {},
        ): Promise<AttachedOperationResult> => {
            const inputPath = join(fixture.parent, "monitor-input.json");
            await Deno.writeTextFile(
                inputPath,
                JSON.stringify({
                    projectRoot: fixture.root,
                    operation,
                    privateHostConversation,
                    input: {
                        workflowId: workflow.workflowId,
                        expectedRevision: workflow.revision,
                        operationId: crypto.randomUUID(),
                        evidence: EVIDENCE,
                        payload,
                    },
                }),
            );
            const output = await new Deno.Command(Deno.execPath(), {
                args: [
                    "run",
                    "-A",
                    "--deny-net",
                    "--quiet",
                    "--no-check",
                    "--config",
                    config,
                    fromFileUrl(new URL("./testing/delivery-process.ts", import.meta.url)),
                    inputPath,
                ],
                env: { PATH: `${fixture.bin}:${Deno.env.get("PATH") || ""}` },
                stdout: "piped",
                stderr: "piped",
            }).output();
            assert(output.success, new TextDecoder().decode(output.stderr));
            const text = new TextDecoder().decode(output.stdout);
            return JSON.parse(text.slice(text.lastIndexOf("ATTACHED_RESULT=") + 16));
        };
        await Deno.writeTextFile(join(fixture.cwd, "marker"), "pass");
        let result = await call("start_validation", await fixture.status());
        assert(result.ok && result.workflow.nextAction.kind === "validation", JSON.stringify(result));
        const reviewer = result.workflow.nextAction;
        assert(reviewer.request.kind === "reviewer");
        for (const file of parseDiffFiles(reviewer.request.fullDiff)) {
            result = await call("review_diff", result.workflow, {
                actionId: reviewer.actionId,
                command: "show",
                scope: "full",
                path: file.path,
                maxBytes: 65536,
            });
            assert(result.ok);
        }
        result = await call("review_complete", result.workflow, { actionId: reviewer.actionId, approved: true });
        assert(result.ok && result.workflow.nextAction.kind === "code_review", JSON.stringify(result));
        result = await call("validation_decision", result.workflow, {
            actionId: result.workflow.nextAction.actionId,
            answer: { outcome: "feedback", message: "Export value 3." },
        });
        assert(
            result.ok && result.workflow.nextAction.kind === "validation" &&
                result.workflow.nextAction.request.kind === "repair",
            JSON.stringify(result),
        );
        await Deno.writeTextFile(join(fixture.cwd, "implementation.ts"), "export const value = 3;\n");
        result = await call("task_completed", result.workflow, {
            actionId: result.workflow.nextAction.actionId,
            message: "- Exported value 3 as requested.",
        });
        assert(result.ok && result.workflow.nextAction.kind === "code_review", JSON.stringify(result));
        result = await call("validation_decision", result.workflow, {
            actionId: result.workflow.nextAction.actionId,
            answer: { outcome: "approved" },
        });
        assert(result.ok && result.workflow.nextAction.kind === "recorder", JSON.stringify(result));
        result = await call("work_record_completed", result.workflow, {
            actionId: result.workflow.nextAction.actionId,
            title: "Value outcome",
            summary: "The implementation exports value 3.",
        });
        assert(result.ok && result.workflow.nextAction.kind === "delivered", JSON.stringify(result));
        assertEquals(await Deno.readTextFile(marker).catch(() => ""), "");
        const records = await listWorkRecords(fixture.root);
        assertEquals(records.length, 1);
        const options = { mnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT };
        const indexed = await findIndexedDocumentIdsByRecordId(fixture.root, records[0].attrs.recordId, options);
        assertEquals(indexed.length, 1);
        const exportPath = join(fixture.parent, "index.jsonl");
        await runMnemotecaWorkRecordCommand(fixture.root, [
            "export",
            "--name",
            await getWorkRecordIndexCollectionName(fixture.root),
            "--no-embeddings",
            "--output",
            exportPath,
        ], options);
        const indexText = await Deno.readTextFile(exportPath);
        assertStringIncludes(indexText, "value 3");
        assertStringIncludes(records[0].body, "value 3");
        for (
            const artifact of [
                records[0].markdown,
                indexText,
                JSON.stringify(await fixture.evidence()),
                await fixture.metrics(),
                (await loadPlan(fixture.root, "p"))?.markdown || "",
            ]
        ) assertEquals(artifact.includes(privateHostConversation), false);
    } finally {
        await fixture.close();
    }
});
