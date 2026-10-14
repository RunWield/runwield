import { spawnNativeProcess } from "../../shared/foreground-process.ts";
import { collectProcessOutput } from "../../testing/subprocess-output.ts";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import {
    chmod as fsChmod,
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    realpath as fsRealpath,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { getCwd } from "../../constants.js";
import process from "node:process";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";

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

test("wld mcp help documents the agy-cli adapter and setup", async () => {
    const result = await runCli(["mcp", "--help"]);
    assertEquals(result.code, 0);
    assertStringIncludes(result.stdout, "wld mcp agy-cli");
    assertStringIncludes(result.stdout, "wld mcp agy-cli --setup");
    assertEquals(result.stderr.includes("[RunWield] Fatal error"), false);
});

test("wld mcp rejects unknown adapters and does not write protocol output", async () => {
    const result = await runCli(["mcp", "unknown"]);
    assertEquals(result.code, 1);
    assertEquals(result.stdout, "");
    assertStringIncludes(result.stderr, "Unknown MCP adapter: unknown");
});

test("wld mcp agy-cli rejects unknown options", async () => {
    const result = await runCli(["mcp", "agy-cli", "--executable-kind"]);
    assertEquals(result.code, 1);
    assertEquals(result.stdout, "");
    assertStringIncludes(result.stderr, "Unknown MCP option: --executable-kind");
    assertStringIncludes(result.stderr, "Usage: wld mcp agy-cli [--setup]");
});

test("wld mcp agy-cli refuses missing bridge environment before stdio startup", async () => {
    await withProcessGlobalTestLock(async () => {
        const home = await fsMkdtemp(join(tmpdir(), "runwield-mcp-command-home-"));
        try {
            const result = await runCli(["mcp", "agy-cli"], { HOME: home });
            assertEquals(result.code, 1);
            assertEquals(result.stdout, "");
            assertStringIncludes(result.stderr, "RunWield MCP bridge is not available");
        } finally {
            await fsRm(home, { recursive: true }).catch(() => undefined);
        }
    });
});

test("wld mcp agy-cli --setup asks on stderr and installs after yes", async () => {
    await withProcessGlobalTestLock(async () => {
        const home = await fsMkdtemp(join(tmpdir(), "runwield-mcp-command-setup-home-"));
        const binDir = join(home, "bin");
        try {
            await fsMkdir(binDir, { recursive: true });
            const wldPath = join(binDir, process.platform === "win32" ? "wld.exe" : "wld");
            await fsWriteFile(
                wldPath,
                process.platform === "win32"
                    ? new Uint8Array([0x4d, 0x5a, 0, 0])
                    : new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00]),
            );
            await fsChmod(wldPath, 0o755);

            const result = await runCli(["mcp", "agy-cli", "--setup"], { HOME: home, PATH: binDir }, "yes\n");

            assertEquals(result.code, 0);
            assertEquals(result.stdout, "");
            assertStringIncludes(result.stderr, "Type yes to approve");
            const config = JSON.parse(await fsReadFile(join(home, ".gemini", "config", "mcp_config.json"), "utf8"));
            const settings = JSON.parse(
                await fsReadFile(join(home, ".gemini", "antigravity-cli", "settings.json"), "utf8"),
            );
            assertEquals(config.mcpServers.runwield.command, await fsRealpath(wldPath));
            assertEquals(config.mcpServers.runwield.args, ["mcp", "agy-cli"]);
            assertEquals(config.mcpServers.runwield.env, undefined);
            assertEquals(settings.permissions.allow.includes("mcp(runwield/*)"), true);
        } finally {
            await fsRm(home, { recursive: true }).catch(() => undefined);
        }
    });
});
