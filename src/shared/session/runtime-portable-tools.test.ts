import { fauxAssistantMessage, fauxText, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { equal, ok } from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { SessionRuntime } from "./session-runtime.ts";
import { SessionHost } from "./session-host.ts";
import { openFileSessionStore } from "./file-session-store.ts";

test("portable provider turn receives real read tool bytes", async () => {
    await withRuntimeCommandFixture("portable-tools-", async ({ projectRoot, setModelResponseFactories }) => {
        const marker = `portable-file-${crypto.randomUUID()}`;
        await writeFile(join(projectRoot, "readme.txt"), marker);
        let sawToolBytes = false;
        let toolNames: string[] = [];
        setModelResponseFactories([
            (context) => {
                toolNames = getCurrentTools(context.messages).map((tool) => tool.name);
                return fauxAssistantMessage(fauxToolCall("read", { path: "readme.txt" }));
            },
            (context) => {
                sawToolBytes = context.messages.some((message) =>
                    message.role === "toolResult" && !message.isError &&
                    JSON.stringify(message.content).includes(marker)
                );
                return fauxAssistantMessage(fauxText("Read completed."));
            },
        ]);
        const runtime = new SessionRuntime({
            sessionHost: new SessionHost(),
            sessionStore: openFileSessionStore(),
            ownerProcessKind: "test",
            ownerInstanceId: crypto.randomUUID(),
        });
        try {
            const id = await runtime.createPromptReadySession({ cwd: projectRoot });
            await runtime.promptUserTurn(id, { initialRequest: "Read readme.txt." });
            equal(await runtime.getLastAssistantText(id), "Read completed.");
            ok(toolNames.includes("memory"), `memory extension is available: ${toolNames.join(", ")}`);
            ok(toolNames.includes("code_search"), "code search extension is available to the provider");
            ok(sawToolBytes, "provider receives successful read result containing the real file bytes");
        } finally {
            await runtime.closeAllSessionsWhenIdle();
        }
    });
});
