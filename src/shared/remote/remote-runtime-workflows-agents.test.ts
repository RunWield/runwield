import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
    fauxAssistantMessage,
    fauxText,
    fauxToolCall,
    getCurrentSystemPrompt,
    type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import { assertEquals } from "../../testing/assertions.ts";
import { parseRemoteSessionTranscript } from "./session-protocol.ts";
import { assertRemoteStorageAbsent, withRemoteRuntimeFixture } from "./remote-runtime-test-fixture.ts";

for (const mode of ["read", "write", "background"] as const) {
    test(`remote ${mode} delegate completes through the laptop model bridge without Session storage`, async () => {
        await withRemoteRuntimeFixture(async (f) => {
            let parentTurns = 0;
            let childTurns = 0;
            const respond: FauxResponseFactory = (context) => {
                if (
                    getCurrentSystemPrompt(context.messages).includes("Delegated Agent") &&
                    !getCurrentSystemPrompt(context.messages).startsWith("Use project tools")
                ) {
                    return ++childTurns === 1
                        ? fauxAssistantMessage(
                              mode === "write"
                                  ? fauxToolCall("write", { path: "delegate.txt", content: "remote delegate change\n" })
                                  : fauxToolCall("read", { path: "sentinel.txt" }),
                          )
                        : fauxAssistantMessage(fauxText("Delegate completed: remote initial."));
                }
                return ++parentTurns === 1
                    ? fauxAssistantMessage(
                          fauxToolCall("delegate_agent", {
                              mode: mode === "write" ? "write" : "read",
                              background: mode === "background",
                              brief: "Read sentinel.txt and report its contents.",
                          }),
                      )
                    : fauxAssistantMessage(fauxText("Parent received delegate result."));
            };
            f.setModelResponseFactories(Array.from({ length: 8 }, () => respond));
            const client = await f.start();
            await client.read();
            await client.send({ kind: "turn", text: `Delegate this bounded ${mode} task.` });
            const result = await client.read();
            assertEquals(result.ok, true, result.error);
            assert(result.savedId);
            let saved = (await f.control.list(result.savedId))[0].contents || "";
            if (mode === "background") {
                const entry = parseRemoteSessionTranscript(saved).find(
                    (entry) =>
                        entry.type === "message" &&
                        entry.message.role === "toolResult" &&
                        entry.message.toolName === "delegate_agent",
                );
                assert(entry?.type === "message" && entry.message.role === "toolResult");
                const details = entry.message.details;
                assert(
                    details &&
                        typeof details === "object" &&
                        "task_id" in details &&
                        typeof details.task_id === "string",
                );
                await client.send({ kind: "background-wait", text: details.task_id });
                const waited = await client.read();
                assertEquals(waited.ok, true, waited.text);
                assert(waited.text?.includes("Delegate completed: remote initial."));
                saved = (await f.control.list(result.savedId))[0].contents || "";
            }
            await client.close();
            assert(saved.includes("delegate_agent"));
            assert(!saved.includes('"ok":false'), saved);
            assert(saved.includes("Parent received delegate result."));
            if (mode === "background")
                assert(
                    saved.includes("Delegate completed: remote initial."),
                    "The completed result must be saved on the laptop",
                );
            assertEquals(parentTurns, mode === "background" ? 3 : 2);
            assertEquals(childTurns, 2, "A real in-memory child must finish its tool and final model turns");
            assertEquals(f.modelRequests.length, parentTurns + childTurns);
            if (mode === "write")
                assertEquals(await readFile(join(f.remoteProject, "delegate.txt"), "utf8"), "remote delegate change\n");
            assertEquals(await readFile(join(f.projectRoot, "sentinel.txt"), "utf8"), "laptop initial\n");
            await assertRemoteStorageAbsent(f);
        });
    });
}
