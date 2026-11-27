import { spawnNativeProcess } from "@runwield/resources/process";
import { collectProcessOutput } from "../../testing/subprocess-output.ts";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { test } from "node:test";
import { getCwd } from "../../constants.ts";
import process from "node:process";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";

async function runCli(args: string[], env: Record<string, string> = {}, stdinText = "") {
    const child = spawnNativeProcess(process.execPath, {
        cwd: getCwd(),
        args: runtimeSourceArgs(["run", "-A", "--unstable-no-legacy-abort", join(getCwd(), "src", "cli.ts"), ...args]),
        stdin: stdinText ? "piped" : "null",
        stdout: "piped",
        stderr: "piped",
        env,
    });
    if (stdinText) {
        const writer = child.stdin.getWriter();
        await writer.write(new TextEncoder().encode(stdinText));
        await writer.close();
    }
    const output = await collectProcessOutput(child);
    return {
        code: output.code,
        stdout: new TextDecoder().decode(output.stdout),
        stderr: new TextDecoder().decode(output.stderr),
    };
}

test("wld mcp help documents the Session commands", async () => {
    const result = await runCli(["mcp", "--help"]);
    assertEquals(result.code, 0);
    assertStringIncludes(result.stdout, "/mcp reconnect <server>");
    assertEquals(result.stderr, "");
});

test("wld mcp rejects shell arguments and points to the Session command", async () => {
    const result = await runCli(["mcp", "unknown"]);
    assertEquals(result.code, 1);
    assertEquals(result.stdout, "");
    assertStringIncludes(result.stderr, "Unknown shell MCP argument: unknown");
    assertStringIncludes(result.stderr, "Use /mcp in a RunWield Session.");
});
