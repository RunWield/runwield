import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { writeFile, readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio";
import { attachedValidationFixture } from "./validation-test-fixture.ts";
import { git } from "../git-test-fixture.ts";
import { prepareIndexRuntime } from "./delivery-test-fixture.ts";
import { CLI_PATH, EVIDENCE, readRecordBytes } from "./attached-test-fixture.ts";
import { parseDiffFiles } from "../workflow/review-diff.ts";
import { listWorkRecords } from "../work-records/store.js";
import {
    findIndexedDocumentIdsByRecordId,
    getWorkRecordIndexCollectionName,
    runMnemotecaWorkRecordCommand,
} from "../work-records/index-adapter.ts";
import { SYSTEM_WORK_RECORD_MNEMOTECA_PORT } from "../work-records/mnemoteca-port.ts";
import { conversation, pendingChat, reviewApi, sendChat } from "./review-chat-test-fixture.ts";
import { loadPlan, savePlan } from "../../plan-store.js";
import type {
    AttachedJsonObject,
    AttachedOperationName,
    AttachedOperationResult,
    AttachedWorkflowView,
} from "./operations.ts";

test("whole Attached delivery starts zero Core model sessions and excludes private host text from durable outcomes", async () => {
    await prepareIndexRuntime();
    const fixture = await attachedValidationFixture({ attrs: { workKind: "FEATURE", humanReviewMode: "always" } });
    const privateHostConversation = "PRIVATE_CLAUDE_CONVERSATION_8d25aacd";
    const client = new Client({ name: EVIDENCE.host, version: EVIDENCE.hostVersion });
    let transport: StdioClientTransport | undefined;
    try {
        const marker = join(fixture.parent, "core-model-turns");
        const hosted = fileURLToPath(new URL("../session/hosted-session.js", import.meta.url));
        const sessions = fileURLToPath(new URL("../session/session.js", import.meta.url));
        const monitor = join(fixture.parent, "monitor.ts");
        await writeFile(
            monitor,
            String.raw`
import { plugin } from "bun";
import { readFileSync } from "node:fs";
const signatures = new Map(${JSON.stringify([
                [hosted, "constructor(options) {"],
                [sessions, "export async function runIsolatedAgentSession(opts) {"],
            ])});
plugin({ name: "count-core-model-sessions", setup(build) {
    build.onLoad({ filter: /\/(hosted-session|session)\.js$/ }, ({path}) => {
        const signature = signatures.get(path);
        if (!signature) return;
        const source = readFileSync(path, "utf8");
        if (!source.includes(signature)) throw new Error("Core turn monitor signature changed");
        return { contents: 'import { appendFileSync as recordCoreTurn } from "node:fs";\n' + source.replace(signature, signature + ' recordCoreTurn(' + ${JSON.stringify(JSON.stringify(marker))} + ', "Core model session");'), loader: "js" };
    });
} });
`,
        );
        transport = new StdioClientTransport({
            command: process.execPath,
            args: ["--preload", monitor, CLI_PATH, "attached", "mcp"],
            cwd: fixture.root,
            env: { ...process.env, PATH: `${fixture.bin}:${process.env["PATH"] || ""}`, BROWSER: "true" },
            stderr: "inherit",
        });
        await client.connect(transport);
        const call = async (
            operation: AttachedOperationName,
            workflow: AttachedWorkflowView,
            payload: AttachedJsonObject = {},
            conversation?: string,
        ): Promise<AttachedOperationResult & { review?: { url: string } }> => {
            const response = await client.callTool({
                name: operation,
                _meta: { hostConversation: privateHostConversation },
                arguments:
                    operation === "status"
                        ? { workflowId: workflow.workflowId }
                        : {
                              workflowId: workflow.workflowId,
                              expectedRevision: workflow.revision,
                              operationId: crypto.randomUUID(),
                              payload,
                              ...(conversation ? { transcript: conversation } : {}),
                          },
            });
            return JSON.parse(JSON.stringify(response.structuredContent));
        };
        const activated = await client.callTool({
            name: "activate",
            arguments: {
                operationId: "plan-chat-workflow",
                payload: { requestText: "Review a selector Plan", hostRequestId: "plan-chat" },
            },
        });
        let planResult: AttachedOperationResult & { review?: { url: string } } = JSON.parse(
            JSON.stringify(activated.structuredContent),
        );
        assert(planResult.ok && planResult.workflow.nextAction.kind === "triage");
        planResult = await call("triage_report", planResult.workflow, {
            actionId: planResult.workflow.nextAction.actionId,
            outcome: {
                routingIntent: "PLANNED_CHANGE",
                workKind: "FEATURE",
                complexity: "MEDIUM",
                summary: "Add a selector",
            },
        });
        assert(planResult.ok && planResult.workflow.nextAction.kind === "plan");
        await savePlan(fixture.root, "chat-plan", "# Selector\n\nAdd a selector.\n", {
            classification: "PLANNED_CHANGE",
            executionAgent: "engineer",
            collaborationRecommendation: "autonomous",
        });
        planResult = await call("plan_written", planResult.workflow, {
            actionId: planResult.workflow.nextAction.actionId,
            planName: "chat-plan",
        });
        assert(planResult.ok && planResult.review);
        const planPage = planResult.review.url;
        const planWorkflowId = planResult.workflow.workflowId;
        await sendChat(planPage, privateHostConversation);
        planResult = await call("status", planResult.workflow);
        assert(planResult.ok);
        planResult = await call("review_reply", planResult.workflow, {
            turnId: pendingChat(planResult.workflow).turnId,
            text: `Plan answer ${privateHostConversation}`,
        });
        assert(planResult.ok);
        assertStringIncludes((await conversation(planPage)).events[0].delta, privateHostConversation);
        const planApproved = await fetch(reviewApi(planPage, "decision"), {
            method: "POST",
            body: JSON.stringify({
                approvalAction: "run",
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
                reviewRevision: 0,
            }),
        });
        assertEquals(planApproved.status, 200, await planApproved.text());
        // This second workflow prepares primary-checkout ignores after the execution fixture was forked.
        // Save only that project setup; an unrelated dirty primary edit would correctly block delivery.
        await git(fixture.root, ["add", ".gitignore"]);
        await git(fixture.root, ["commit", "-m", "Record project runtime ignores"]);
        const rejectedTranscript = await call("start_validation", await fixture.status(), {}, privateHostConversation);
        assert(!rejectedTranscript.ok);
        assertEquals(rejectedTranscript.rejection.code, "transcript_field");
        await writeFile(join(fixture.cwd, "marker"), "pass");
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
        assert(result.review);
        const codePage = result.review.url;
        await sendChat(codePage, privateHostConversation);
        result = await call("status", result.workflow);
        assert(result.ok);
        result = await call("review_reply", result.workflow, {
            turnId: pendingChat(result.workflow).turnId,
            text: `Code answer ${privateHostConversation}`,
        });
        assert(result.ok && result.workflow.nextAction.kind === "code_review");
        assertStringIncludes((await conversation(codePage)).events[0].delta, privateHostConversation);
        assertEquals((await fixture.checkpointBytes()).includes(privateHostConversation), false);
        assertEquals(JSON.stringify((await fixture.plan()).attrs).includes(privateHostConversation), false);
        result = await call("validation_decision", result.workflow, {
            actionId: result.workflow.nextAction.actionId,
            answer: { outcome: "feedback", message: "Export value 3." },
        });
        assert(
            result.ok &&
                result.workflow.nextAction.kind === "validation" &&
                result.workflow.nextAction.request.kind === "repair",
            JSON.stringify(result),
        );
        await writeFile(join(fixture.cwd, "implementation.ts"), "export const value = 3;\n");
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
        // The fake external Recorder receives the actual adapter handoff. Echoing
        // leaked text makes an adapter that forwards the conversation fail here.
        const recorderInput = result.instructions?.text + "\n" + result.workflow.nextAction.request.prompt;
        assertStringIncludes(recorderInput, "value = 3");
        assertEquals(recorderInput.includes(privateHostConversation), false);
        const recorderSummary = recorderInput.includes(privateHostConversation)
            ? privateHostConversation
            : "The implementation exports value 3.";
        result = await call("work_record_completed", result.workflow, {
            actionId: result.workflow.nextAction.actionId,
            title: "Value outcome",
            summary: recorderSummary,
        });
        assert(result.ok && result.workflow.nextAction.kind === "delivered", JSON.stringify(result));
        assertEquals(await readFile(marker, "utf8").catch(() => ""), "");
        const records = await listWorkRecords(fixture.root);
        assertEquals(records.length, 1);
        const options = { mnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT };
        const indexed = await findIndexedDocumentIdsByRecordId(fixture.root, records[0].attrs.recordId, options);
        assertEquals(indexed.length, 1);
        const exportPath = join(fixture.parent, "index.jsonl");
        await runMnemotecaWorkRecordCommand(
            fixture.root,
            [
                "export",
                "--name",
                await getWorkRecordIndexCollectionName(fixture.root),
                "--no-embeddings",
                "--output",
                exportPath,
            ],
            options,
        );
        const indexText = await readFile(exportPath, "utf8");
        assertStringIncludes(indexText, "value 3");
        assertStringIncludes(records[0].body, "value 3");
        for (const artifact of [
            records[0].markdown,
            await readRecordBytes(fixture.root, fixture.workflowId),
            await readRecordBytes(fixture.root, planWorkflowId),
            (await loadPlan(fixture.root, "chat-plan"))?.markdown || "",
            indexText,
            JSON.stringify(await fixture.evidence()),
            await fixture.metrics(),
            (await loadPlan(fixture.root, "p"))?.markdown || "",
        ])
            assertEquals(artifact.includes(privateHostConversation), false);
    } finally {
        await client.close().catch(() => {});
        await transport?.close().catch(() => {});
        await fixture.close();
    }
});
