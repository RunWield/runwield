import process from "node:process";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText, getSystemMessageText } from "@earendil-works/pi-ai";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { parseGuidedReviewMetadataLine, parseGuidedReviewUsageEventLine } from "../guided-review/protocol.ts";
import { AGENTS } from "../../constants.js";
import { listAvailableAgents, loadAgentDef } from "../../shared/session/agents.js";
import { getCliCommandDefinitions, requiresProjectDirectoryConsent } from "../registry.js";
import { runAiReviewCommand } from "./index.ts";

test("ai-review runs the read-only AI Reviewer and emits usage, metadata, and final JSON", async () => {
    await withRuntimeCommandFixture("ai-review-command-", async ({ projectRoot, setModelResponseFactory }) => {
        const result = JSON.stringify({ schemaVersion: 1, specSource: null, findings: [] });
        let systemPrompt = "";
        setModelResponseFactory((context) => {
            systemPrompt = context.messages
                .filter((message) => message.role === "system")
                .map((message) => getSystemMessageText(message))
                .join("\n");
            return fauxAssistantMessage(fauxText(result));
        });
        process.chdir(projectRoot);
        let stdout = "";
        let stderr = "";
        const events: string[] = [];
        const code = await runAiReviewCommand({
            readStdin: () => Promise.resolve("Review this patch; return findings JSON."),
            writeStdout: (text) => {
                stdout += text;
                events.push("stdout");
            },
            writeStderr: async (text) => {
                await Promise.resolve();
                stderr += text;
                events.push("stderr");
            },
        });
        assertEquals(code, 0);
        assertStringIncludes(systemPrompt, "You are the AI Reviewer");
        assertEquals(stdout, `${result}\n`);
        const frames = stderr.trim().split("\n");
        const usage = frames.map(parseGuidedReviewUsageEventLine).find(Boolean);
        const metadata = frames.map(parseGuidedReviewMetadataLine).find(Boolean);
        assertEquals((usage?.usage.inputTokens || 0) > 0, true);
        assertEquals((usage?.usage.outputTokens || 0) > 0, true);
        assertEquals(metadata?.provider, "runtime-command-fixture");
        assertEquals(metadata?.model, "fixture-model");
        assertEquals(events, ["stderr", "stderr", "stdout"]);
    });
});

test("ai-review rejects an empty prompt without starting a Session", async () => {
    let stdout = "";
    let stderr = "";
    assertEquals(
        await runAiReviewCommand({
            readStdin: () => Promise.resolve(" \n"),
            writeStdout: (text) => {
                stdout += text;
            },
            writeStderr: (text) => {
                stderr += text;
            },
        }),
        1,
    );
    assertEquals(stdout, "");
    assertStringIncludes(stderr, "requires a prompt on stdin");
});

test("AI Reviewer is workflow-only with read tools and read-only git commands", async () => {
    const definition = await loadAgentDef(AGENTS.AI_REVIEWER);
    assertEquals(definition.displayName, "AI Reviewer");
    assertEquals(definition.workflowOnly, true);
    assertEquals(
        (await listAvailableAgents()).some((agent) => agent.name === AGENTS.AI_REVIEWER),
        false,
    );
    for (const tool of definition.tools) {
        assertEquals(
            ["read", "grep", "find", "ls", "bash", "web_fetch", "set_session_name"].includes(tool) ||
                tool.startsWith("code_"),
            true,
            tool,
        );
    }
    assertEquals(definition.bashAllowedCommands?.includes("git show"), true);
    for (const command of definition.bashAllowedCommands || []) {
        assertEquals(command.startsWith("git "), true, command);
    }
    assertEquals(requiresProjectDirectoryConsent("ai-review"), true);
    assertEquals(
        getCliCommandDefinitions().some((command) => command.name === "ai-review"),
        false,
    );
});
