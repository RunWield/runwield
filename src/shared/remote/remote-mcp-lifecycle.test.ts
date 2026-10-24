import { test } from "node:test";
import { readFile, writeFile, copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxText, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { withRemoteRuntimeFixture } from "./remote-runtime-test-fixture.ts";

// A real root binds while discovery is empty, then retains that binding across updates and replacement.
test("remote root sees personal inventory changes, handoff retains its process, and reload replaces it", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        const toolsPath = join(f.homeDir, "tools.txt");
        const log = join(f.homeDir, "lifecycle.log");
        await writeFile(toolsPath, "");
        // An unignored project file must not disable a valid personal entry.
        await mkdir(join(f.remoteProject, ".wld"), { recursive: true });
        await writeFile(join(f.remoteProject, ".wld/mcp.json"), '{"mcpServers":{"personal":{"enabled":false}}}', {
            mode: 0o600,
        });
        const definition = {
            command: process.execPath,
            args: runtimeSourceArgs(["run", "-A", fileURLToPath(new URL("../mcp/fixture-server.ts", import.meta.url))]),
            env: { RUNWIELD_MCP_FIXTURE_LOG: log, RUNWIELD_MCP_FIXTURE_TOOLS_PATH: toolsPath },
        };
        await writeFile(join(f.homeDir, ".wld/mcp.json"), JSON.stringify({ mcpServers: { personal: definition } }), {
            mode: 0o600,
        });
        await copyFile(join(f.resources, "agents/remote-runtime.md"), join(f.resources, "agents/next.md"));
        let inventory: string[] = [];
        const response = (context: Parameters<Parameters<typeof f.setModelResponseFactory>[0]>[0]) => {
            inventory = getCurrentTools(context.messages).map((tool) => tool.name);
            return fauxAssistantMessage(fauxText("Inventory observed."));
        };
        f.setModelResponseFactories([response]);
        const child = await f.start();
        await child.read();
        await child.send({ kind: "turn", text: "Observe initial inventory." });
        assertEquals((await child.read()).ok, true);
        assertEquals(
            inventory.some((name) => name.startsWith("mcp__personal__")),
            false,
        );
        await writeFile(toolsPath, "appeared");
        // Wait for discovery through the native status command, not a second model turn.
        for (let i = 0; i < 100; i++) {
            await child.send({ kind: "mcp" });
            if (JSON.stringify((await child.read()).notices).includes("1 tools")) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        f.setModelResponseFactories([response]);
        await child.send({ kind: "turn", text: "Observe added tool." });
        assertEquals((await child.read()).ok, true);
        assertEquals(inventory.includes("mcp__personal__appeared"), true);
        await child.send({ kind: "handoff", text: "next" });
        assertEquals((await child.read()).ok, true);
        assertEquals((await readFile(log, "utf8")).split('"event":"started"').length - 1, 1);
        f.setModelResponseFactories([
            () => fauxAssistantMessage(fauxToolCall("mcp__personal__appeared", { marker: "after-handoff" })),
            (context) => {
                assertStringIncludes(JSON.stringify(context.messages), "fixture-result:after-handoff");
                return fauxAssistantMessage(fauxText("Called after handoff."));
            },
        ]);
        await child.send({ kind: "turn", text: "Call the personal tool." });
        assertEquals((await child.read()).ok, true);
        assertEquals((await readFile(log, "utf8")).split('"event":"started"').length - 1, 1);
        await writeFile(toolsPath, "");
        for (let i = 0; i < 100; i++) {
            await child.send({ kind: "mcp" });
            if (JSON.stringify((await child.read()).notices).includes("0 tools")) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        f.setModelResponseFactories([response]);
        await child.send({ kind: "turn", text: "Observe withdrawn tool." });
        assertEquals((await child.read()).ok, true);
        assertEquals(inventory.includes("mcp__personal__appeared"), false);
        await writeFile(toolsPath, "after_reload");
        await child.send({ kind: "reload" });
        assertEquals((await child.read()).ok, true);
        const final = await readFile(log, "utf8");
        assertEquals(final.split('"event":"started"').length - 1, 2);
        assertEquals(final.split('"event":"shutdown"').length - 1, 1);
        f.setModelResponseFactories([response]);
        await child.send({ kind: "turn", text: "Observe reloaded tool." });
        assertEquals((await child.read()).ok, true);
        assertEquals(inventory.includes("mcp__personal__after_reload"), true);
    });
});
