import { assertEquals } from "../../../../testing/assertions.ts";
import process from "node:process";
import { test } from "node:test";
import { withProcessGlobalTestLock } from "../../../../testing/process-global-lock.ts";
import { prepareClaudeCliCommand, removeClaudeCliMcpConfigFile, removeClaudeCliPromptFile } from "./command.ts";

async function disposePreparedCommand(command: Awaited<ReturnType<typeof prepareClaudeCliCommand>>): Promise<void> {
    await removeClaudeCliPromptFile(command);
    await removeClaudeCliMcpConfigFile(command);
}

test("prepareClaudeCliCommand sets MCP tool idle timeout environment", async () => {
    await withProcessGlobalTestLock(async () => {
        const prior = process.env["CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT"];
        delete process.env["CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT"];
        const command = await prepareClaudeCliCommand({ selector: "sonnet", systemPrompt: "system" });
        try {
            assertEquals(command.env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT, String(24 * 60 * 60 * 1000));
        } finally {
            await disposePreparedCommand(command);
            if (prior === undefined) delete process.env["CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT"];
            else process.env["CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT"] = prior;
        }
    });
});

test("prepareClaudeCliCommand preserves a longer inherited MCP tool idle timeout", async () => {
    await withProcessGlobalTestLock(async () => {
        const prior = process.env["CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT"];
        process.env["CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT"] = "90000000";
        const command = await prepareClaudeCliCommand({ selector: "sonnet", systemPrompt: "system" });
        try {
            assertEquals(command.env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT, "90000000");
        } finally {
            await disposePreparedCommand(command);
            if (prior === undefined) delete process.env["CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT"];
            else process.env["CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT"] = prior;
        }
    });
});
