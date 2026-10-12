import process from "node:process";
import { readFile as fsReadFile } from "node:fs/promises";
import { test } from "node:test";
import {
    fauxAssistantMessage,
    fauxText,
    getSystemMessageText,
    type Message,
    type TranscriptContext,
} from "@earendil-works/pi-ai";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { openFileSessionStore } from "../../shared/session/file-session-store.ts";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import {
    GUIDED_REVIEW_EVENT_PREFIX,
    parseGuidedReviewMetadataLine,
    parseGuidedReviewUsageEventLine,
} from "./protocol.ts";
import { runGuidedReviewCommand } from "./index.ts";

interface DeferredSignal {
    promise: Promise<void>;
    resolve: () => void;
}

function deferredSignal(): DeferredSignal {
    let resolve = () => {};
    const promise = new Promise<void>((next) => {
        resolve = next;
    });
    return { promise, resolve };
}

function estimateFauxTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

function contentToText(content: Message["content"]): string {
    if (typeof content === "string") return content;
    return content.map((block) => {
        if (block.type === "text") return block.text;
        if (block.type === "thinking") return block.thinking;
        if ("arguments" in block) return `${block.name}:${JSON.stringify(block.arguments)}`;
        return `[image:${block.mimeType}:${block.data.length}]`;
    }).join("\n");
}

function messageToText(message: Message): string {
    if (message.role === "system") {
        return [
            getSystemMessageText(message),
            ...(message.toolsRemoved?.map((tool) => `tool-:${JSON.stringify(tool)}`) ?? []),
            ...(message.toolsAdded?.map((tool) => `tool+:${JSON.stringify(tool)}`) ?? []),
        ].filter((part) => part.length > 0).join("\n");
    }
    if (message.role === "toolResult") {
        return [
            message.toolName,
            ...message.content.map((block) => contentToText([block])),
        ].join("\n");
    }
    return contentToText(message.content);
}

function estimateFirstFauxUsage(context: TranscriptContext, output: string) {
    const parts = context.messages.map((message) => `${message.role}:${messageToText(message)}`);
    const inputTokens = estimateFauxTokens(parts.join("\n\n"));
    return {
        inputTokens,
        outputTokens: estimateFauxTokens(output),
        cacheReadTokens: 0,
        cacheWriteTokens: inputTokens,
        costUsd: 0,
    };
}

test("guided-review emits the exact runtime usage frame before completing and cleans up its listener and Session", async () => {
    await withRuntimeCommandFixture(
        "guided-review-command-usage-",
        async ({ projectRoot, setModelResponseFactory }) => {
            const reviewJson = JSON.stringify({
                schemaVersion: "1.0",
                title: "Fixture Guided Review",
                sections: [{ title: "Core", role: "core", blocks: [] }],
                everythingElse: [],
            });
            let expectedUsage = {
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                costUsd: 0,
            };
            setModelResponseFactory((context) => {
                expectedUsage = estimateFirstFauxUsage(context, reviewJson);
                return fauxAssistantMessage(fauxText(reviewJson));
            });
            process.chdir(projectRoot);
            let stdout = "";
            let stderr = "";
            const outputEvents: string[] = [];
            const usageWriteStarted = deferredSignal();
            const usageWriteReleased = deferredSignal();

            const command = runGuidedReviewCommand({
                readStdin: () => Promise.resolve("Generate the fixture Guided Review."),
                writeStdout: (text) => {
                    outputEvents.push("stdout");
                    stdout += text;
                },
                writeStderr: (text) => {
                    outputEvents.push("stderr");
                    stderr += text;
                    usageWriteStarted.resolve();
                    return usageWriteReleased.promise;
                },
            });

            await usageWriteStarted.promise;
            assertStringIncludes(stderr, GUIDED_REVIEW_EVENT_PREFIX);
            assertEquals(stdout, "");
            assertEquals(
                await Promise.race([
                    command.then(() => "completed"),
                    new Promise((resolve) => setTimeout(() => resolve("pending"), 20)),
                ]),
                "pending",
            );

            usageWriteReleased.resolve();
            const code = await command;

            const expectedFrame = { version: 1, type: "usage" as const, usage: expectedUsage };
            assertEquals(code, 0);
            assertEquals(outputEvents, ["stderr", "stderr", "stdout"]);
            const [usageLine, metadataLine] = stderr.trim().split("\n");
            assertEquals(parseGuidedReviewUsageEventLine(usageLine), expectedFrame);
            const metadata = parseGuidedReviewMetadataLine(metadataLine);
            assertEquals(metadata?.provider, "runtime-command-fixture");
            assertEquals(metadata?.model, "fixture-model");
            assertEquals(typeof metadata?.thinkingLevel, "string");
            assertEquals(stdout, `${reviewJson}\n`);

            const store = openFileSessionStore();
            try {
                const project = store.listSessionProjects().find((candidate) =>
                    candidate.registeredRoot === projectRoot
                );
                if (!project) throw new Error("Expected the guided-review command to create a Session project.");
                const sessions = await store.listProjectSessions(project.projectId);
                assertEquals(sessions.sessions.length, 1);
                const cleanedUp = store.inspectSessionActivation(sessions.sessions[0].runwieldSessionId);
                assertEquals(cleanedUp.activation?.state, "idle");
                assertEquals(cleanedUp.activation?.ownerProcessKind, null);
                assertEquals(cleanedUp.activation?.operationId, null);
            } finally {
                store.close();
            }

            const commandSource = await fsReadFile(new URL("./index.ts", import.meta.url), "utf8");
            const unsubscribeIndex = commandSource.indexOf("unsubscribe();");
            const closeIndex = commandSource.indexOf("runtime.closeSession(sessionId);");
            assertEquals(unsubscribeIndex > 0, true);
            assertEquals(closeIndex > unsubscribeIndex, true);
        },
    );
});
