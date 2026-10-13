import { captureForegroundProcess } from "../../shared/captured-process.ts";
import { test } from "node:test";
import { readFile as fsReadFile, stat as fsStat, writeFile as fsWriteFile } from "node:fs/promises";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { HostedSession } from "../../shared/session/hosted-session.js";
import { runIsolatedAgentSession } from "../../shared/session/session.js";
import { createDelegateAgentTool } from "../delegate-agent.ts";

test("foreground and background delegated model turns inherit parent bash limits", async () => {
    await withRuntimeCommandFixture("delegate-bash-policy-", async ({ projectRoot, setModelResponseFactories }) => {
        const init = await captureForegroundProcess("git", { cwd: projectRoot, args: ["init", "-b", "main"] });
        assert(init.success);
        await fsWriteFile(join(projectRoot, "inspect-me.txt"), "inspect marker\n");
        const session = new HostedSession({ id: crypto.randomUUID(), cwd: projectRoot });
        const makeTool = (bashAllowedCommands?: readonly string[]) =>
            createDelegateAgentTool({
                hostedSession: session,
                cwd: projectRoot,
                parentTools: ["bash", "read"],
                bashAllowedCommands,
                runIsolatedAgentSession,
            });
        const limited = makeTool(["git status"]);
        const call = (mode: "read" | "write", background = false, role?: "verification-adversary") =>
            limited.execute(
                "delegate",
                { mode, background, role, brief: "Inspect status." },
                new AbortController().signal,
                () => {},
                {} as Parameters<typeof limited.execute>[4],
            );
        try {
            for (const background of [false, true]) {
                let toolResult = "";
                setModelResponseFactories([
                    () => fauxAssistantMessage(fauxToolCall("bash", { command: "git status --short" })),
                    (context) => {
                        toolResult = JSON.stringify(context.messages);
                        return fauxAssistantMessage(fauxText("inspection complete"));
                    },
                ]);
                const result = await call("read", background);
                assertEquals(result.details?.ok, true, JSON.stringify(result.details));
                if (background) {
                    assert(result.details?.task_id);
                    const settled = await session.backgroundTasks.wait(result.details.task_id);
                    assertEquals(settled.state, "completed", JSON.stringify(settled));
                    assertStringIncludes(await fsReadFile(settled.log_path, "utf8"), "inspection complete");
                }
                assertStringIncludes(toolResult, "inspect-me.txt");
            }
            for (
                const [mode, role] of [["read", undefined], ["write", undefined], [
                    "write",
                    "verification-adversary",
                ]] as const
            ) {
                let toolResult = "";
                setModelResponseFactories([
                    () => fauxAssistantMessage(fauxToolCall("bash", { command: "git log" })),
                    (context) => {
                        toolResult = JSON.stringify(context.messages);
                        return fauxAssistantMessage(fauxText("blocked"));
                    },
                ]);
                const result = await call(mode, false, role);
                assertEquals(result.details?.ok, true, JSON.stringify(result.details));
                if (role) assertEquals(result.details?.effectiveAuthority, "read");
                assertStringIncludes(toolResult, "Allowed commands: git status");
                assertStringIncludes(toolResult, "report a blocker");
            }
            setModelResponseFactories([
                () => fauxAssistantMessage(fauxToolCall("bash", { command: "touch write-result" })),
                () => fauxAssistantMessage(fauxText("wrote file")),
            ]);
            const unrestricted = makeTool();
            const write = await unrestricted.execute(
                "delegate",
                { mode: "write", brief: "Write file" },
                new AbortController().signal,
                () => {},
                {} as Parameters<typeof unrestricted.execute>[4],
            );
            assertEquals(write.details?.ok, true, JSON.stringify(write.details));
            assertEquals((await fsStat(join(projectRoot, "write-result"))).isFile(), true);
        } finally {
            await session.dispose();
        }
    });
});
