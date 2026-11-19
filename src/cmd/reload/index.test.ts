import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { isMascotEnabled } from "../../shared/settings.ts";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { runReloadCommand } from "./index.ts";

for (const deferred of [false, true]) {
    test(`reload applies manual settings to a ${deferred ? "deferred" : "active"} Session`, async () => {
        await withRuntimeCommandFixture("reload-mascot-", async ({ projectRoot }) => {
            const runtime = createSessionRuntime();
            const sessionId = await runtime.createPromptReadySession({
                cwd: projectRoot,
                agentName: "router",
                deferPersistenceUntilFirstMessage: deferred,
            });
            const messages: string[] = [];
            try {
                assertEquals(isMascotEnabled(projectRoot), true);
                const path = join(projectRoot, ".wld", "settings.json");
                await fsMkdir(join(projectRoot, ".wld"), { recursive: true });
                await fsWriteFile(path, JSON.stringify({ mascot: false }));
                assertEquals(isMascotEnabled(projectRoot), true);
                await runReloadCommand([], {
                    sessionRuntime: runtime,
                    sessionId,
                    uiAPI: {
                        appendSystemMessage: (message: string) => {
                            messages.push(message);
                        },
                        appendAgentMessageStart: () => ({ appendText: () => {} }),
                        requestRender: () => {},
                        promptSelect: () => Promise.resolve(null),
                        promptText: () => Promise.resolve(null),
                        showModelSelector: () => {},
                        abortActivePrompt: () => {},
                    },
                });
                assertStringIncludes(
                    messages.join("\n"),
                    deferred
                        ? "Agent context will rebuild on the next managed turn."
                        : "Successfully reloaded configs, themes, and agent context.",
                );
                assertEquals(isMascotEnabled(projectRoot), false);
            } finally {
                await runtime.closeAllSessions();
            }
        });
    });
}
