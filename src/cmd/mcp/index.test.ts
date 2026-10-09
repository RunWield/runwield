import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";

async function runCli(args: string[], env: Record<string, string> = {}, stdinText = "") {
    const command = new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--unstable-no-legacy-abort", join(Deno.cwd(), "src", "cli.ts"), ...args],
        stdin: stdinText ? "piped" : "null",
        stdout: "piped",
        stderr: "piped",
        env,
    });
    const child = command.spawn();
    if (stdinText) {
        const writer = child.stdin.getWriter();
        await writer.write(new TextEncoder().encode(stdinText));
        await writer.close();
    }
    const output = await child.output();
    return {
        code: output.code,
        stdout: new TextDecoder().decode(output.stdout),
        stderr: new TextDecoder().decode(output.stderr),
    };
}

Deno.test("wld mcp help documents the agy-cli adapter and setup", async () => {
    const result = await runCli(["mcp", "--help"]);
    assertEquals(result.code, 0);
    assertStringIncludes(result.stdout, "wld mcp agy-cli");
    assertStringIncludes(result.stdout, "wld mcp agy-cli --setup");
    assertEquals(result.stderr.includes("[RunWield] Fatal error"), false);
});

Deno.test("wld mcp rejects unknown adapters and does not write protocol output", async () => {
    const result = await runCli(["mcp", "unknown"]);
    assertEquals(result.code, 1);
    assertEquals(result.stdout, "");
    assertStringIncludes(result.stderr, "Unknown MCP adapter: unknown");
});

Deno.test("wld mcp agy-cli rejects unknown options", async () => {
    const result = await runCli(["mcp", "agy-cli", "--executable-kind"]);
    assertEquals(result.code, 1);
    assertEquals(result.stdout, "");
    assertStringIncludes(result.stderr, "Unknown MCP option: --executable-kind");
    assertStringIncludes(result.stderr, "Usage: wld mcp agy-cli [--setup]");
});

Deno.test("wld mcp agy-cli refuses missing bridge environment before stdio startup", async () => {
    await withProcessGlobalTestLock(async () => {
        const home = await Deno.makeTempDir({ prefix: "runwield-mcp-command-home-" });
        try {
            const result = await runCli(["mcp", "agy-cli"], { HOME: home });
            assertEquals(result.code, 1);
            assertEquals(result.stdout, "");
            assertStringIncludes(result.stderr, "RunWield MCP bridge is not available");
        } finally {
            await Deno.remove(home, { recursive: true }).catch(() => undefined);
        }
    });
});

Deno.test("wld mcp agy-cli --setup asks on stderr and installs after yes", async () => {
    await withProcessGlobalTestLock(async () => {
        const home = await Deno.makeTempDir({ prefix: "runwield-mcp-command-setup-home-" });
        const binDir = join(home, "bin");
        try {
            await Deno.mkdir(binDir, { recursive: true });
            const wldPath = join(binDir, "wld");
            await Deno.writeFile(wldPath, new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00]));
            await Deno.chmod(wldPath, 0o755);

            const result = await runCli(
                ["mcp", "agy-cli", "--setup"],
                { HOME: home, PATH: binDir },
                "yes\n",
            );

            assertEquals(result.code, 0);
            assertEquals(result.stdout, "");
            assertStringIncludes(result.stderr, "Type yes to approve");
            const config = JSON.parse(await Deno.readTextFile(join(home, ".gemini", "config", "mcp_config.json")));
            const settings = JSON.parse(
                await Deno.readTextFile(join(home, ".gemini", "antigravity-cli", "settings.json")),
            );
            assertEquals(config.mcpServers.runwield.command, await Deno.realPath(wldPath));
            assertEquals(config.mcpServers.runwield.args, ["mcp", "agy-cli"]);
            assertEquals(config.mcpServers.runwield.env, undefined);
            assertEquals(settings.permissions.allow.includes("mcp(runwield/*)"), true);
        } finally {
            await Deno.remove(home, { recursive: true }).catch(() => undefined);
        }
    });
});
