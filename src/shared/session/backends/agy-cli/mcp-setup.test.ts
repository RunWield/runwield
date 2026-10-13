import { delimiter } from "node:path";
import process from "node:process";
import {
    chmod as fsChmod,
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    realpath as fsRealpath,
    rm as fsRm,
    stat as fsStat,
    symlink as fsSymlink,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { assertEquals, assertRejects, assertStringIncludes } from "../../../../testing/assertions.ts";
import { join } from "node:path";
import { withProcessGlobalTestLock } from "../../../../testing/process-global-lock.ts";
import { HostedSession } from "../../hosted-session.js";
import type { ManagedOperationCapability } from "../../managed-operation.ts";
import {
    AGY_MCP_ARGS,
    AGY_MCP_PERMISSION,
    ensureAgyCliMcpSetup,
    inspectAgyCliMcpSetup,
    installAgyCliMcpSetup,
    resolveInstalledWldExecutable,
} from "./mcp-setup.ts";

const WLD_EXECUTABLE = process.platform === "win32" ? "wld.exe" : "wld";
const NATIVE_HEADER =
    process.platform === "win32"
        ? new Uint8Array([0x4d, 0x5a, 0x00, 0x00])
        : new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00]);

async function withSetupHome(callback: (home: string, binDir: string) => Promise<void>): Promise<void> {
    await withProcessGlobalTestLock(async () => {
        const priorHome = process.env["HOME"];
        const priorPath = process.env["PATH"];
        const home = await fsMkdtemp(join(tmpdir(), "runwield-agy-mcp-setup-"));
        const binDir = join(home, "bin");
        try {
            await fsMkdir(binDir, { recursive: true });
            const wldPath = join(binDir, WLD_EXECUTABLE);
            await fsWriteFile(wldPath, NATIVE_HEADER);
            await fsChmod(wldPath, 0o755);
            process.env["HOME"] = home;
            process.env["PATH"] = `${binDir}${delimiter}${priorPath || ""}`;
            await callback(home, binDir);
        } finally {
            if (priorHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = priorHome;
            if (priorPath === undefined) delete process.env["PATH"];
            else process.env["PATH"] = priorPath;
            await fsRm(home, { recursive: true }).catch(() => undefined);
        }
    });
}

async function readJson(path: string) {
    return JSON.parse(await fsReadFile(path, "utf8"));
}

for (const initialText of ["", " \n\t\r\n"]) {
    test(`Agy MCP setup initializes ${initialText === "" ? "empty" : "whitespace-only"} files after approval`, async () => {
        await withSetupHome(async (home, binDir) => {
            const configPath = join(home, ".gemini", "config", "mcp_config.json");
            const settingsPath = join(home, ".gemini", "antigravity-cli", "settings.json");
            await fsMkdir(join(home, ".gemini", "config"), { recursive: true });
            await fsMkdir(join(home, ".gemini", "antigravity-cli"), { recursive: true });
            await fsWriteFile(configPath, initialText);
            await fsWriteFile(settingsPath, initialText);

            const status = await inspectAgyCliMcpSetup();
            assertEquals(status.ok, false);
            assertEquals(status.repairable, true);
            await assertRejects(() => ensureAgyCliMcpSetup(), Error, "needs approval");
            assertEquals(await fsReadFile(configPath, "utf8"), initialText);
            assertEquals(await fsReadFile(settingsPath, "utf8"), initialText);

            const approved = new HostedSession({ id: "agy-mcp-empty-approved", cwd: home });
            approved.setInteractionAdapter({
                requestInteraction: () => ({ outcome: "accepted", value: "approve" }),
                supportsInteraction: () => true,
            });
            await ensureAgyCliMcpSetup({ hostedSession: approved });
            assertEquals(await readJson(configPath), {
                mcpServers: {
                    runwield: { command: await fsRealpath(join(binDir, WLD_EXECUTABLE)), args: [...AGY_MCP_ARGS] },
                },
            });
            assertEquals(await readJson(settingsPath), { permissions: { allow: [AGY_MCP_PERMISSION] } });
            assertEquals((await inspectAgyCliMcpSetup()).ok, true);
        });
    });
}

test("Agy MCP setup installs the exact stable server and preserves unrelated settings", async () => {
    await withSetupHome(async (home, binDir) => {
        const configPath = join(home, ".gemini", "config", "mcp_config.json");
        const settingsPath = join(home, ".gemini", "antigravity-cli", "settings.json");
        await fsMkdir(join(home, ".gemini", "config"), { recursive: true });
        await fsMkdir(join(home, ".gemini", "antigravity-cli"), { recursive: true });
        await fsWriteFile(
            configPath,
            JSON.stringify({ mcpServers: { other: { command: "other", args: ["x"] } }, keep: true }),
        );
        await fsWriteFile(settingsPath, JSON.stringify({ permissions: { allow: ["shell(ls)"] }, theme: "dark" }));

        await installAgyCliMcpSetup();

        const config = await readJson(configPath);
        assertEquals(config.keep, true);
        assertEquals(config.mcpServers.other.command, "other");
        assertEquals(config.mcpServers.runwield.command, await fsRealpath(join(binDir, WLD_EXECUTABLE)));
        assertEquals(config.mcpServers.runwield.args, [...AGY_MCP_ARGS]);
        assertEquals(config.mcpServers.runwield.env, undefined);
        assertEquals(config.mcpServers.runwield.url, undefined);
        const settings = await readJson(settingsPath);
        assertEquals(settings.theme, "dark");
        assertEquals(settings.permissions.allow.includes("shell(ls)"), true);
        assertEquals(settings.permissions.allow.includes(AGY_MCP_PERMISSION), true);
        assertEquals((await inspectAgyCliMcpSetup()).ok, true);
    });
});

test("Agy MCP setup repairs persistent turn data on the runwield server entry", async () => {
    await withSetupHome(async (home, binDir) => {
        const configPath = join(home, ".gemini", "config", "mcp_config.json");
        const settingsPath = join(home, ".gemini", "antigravity-cli", "settings.json");
        await fsMkdir(join(home, ".gemini", "config"), { recursive: true });
        await fsMkdir(join(home, ".gemini", "antigravity-cli"), { recursive: true });
        const command = await fsRealpath(join(binDir, WLD_EXECUTABLE));
        await fsWriteFile(
            configPath,
            JSON.stringify({
                mcpServers: {
                    runwield: {
                        command,
                        args: [...AGY_MCP_ARGS],
                        token: "secret",
                        sessionId: "turn-session",
                        headers: { authorization: "Bearer secret" },
                    },
                },
            }),
        );
        await fsWriteFile(settingsPath, JSON.stringify({ permissions: { allow: [AGY_MCP_PERMISSION] } }));

        assertEquals((await inspectAgyCliMcpSetup()).ok, false);
        await installAgyCliMcpSetup();

        const server = (await readJson(configPath)).mcpServers.runwield;
        assertEquals(server, { command, args: [...AGY_MCP_ARGS] });
        assertEquals((await inspectAgyCliMcpSetup()).ok, true);
    });
});

test("Agy MCP setup accepts an existing standalone wld when switching binaries", async () => {
    await withSetupHome(async (home) => {
        const configPath = join(home, ".gemini", "config", "mcp_config.json");
        const oldCommand = join(home, ".local", "bin", WLD_EXECUTABLE);
        await fsMkdir(join(home, ".local", "bin"), { recursive: true });
        await fsWriteFile(oldCommand, NATIVE_HEADER);
        await fsChmod(oldCommand, 0o755);
        await fsMkdir(join(home, ".gemini", "config"), { recursive: true });
        await fsWriteFile(
            configPath,
            JSON.stringify({
                mcpServers: {
                    runwield: { command: oldCommand, args: [...AGY_MCP_ARGS] },
                    other: { command: "other", args: ["x"] },
                },
            }),
        );
        await fsMkdir(join(home, ".gemini", "antigravity-cli"), { recursive: true });
        await fsWriteFile(
            join(home, ".gemini", "antigravity-cli", "settings.json"),
            JSON.stringify({ permissions: { allow: [AGY_MCP_PERMISSION] } }),
        );

        const status = await inspectAgyCliMcpSetup();
        assertEquals(status.ok, true);
        assertEquals(status.repairable, true);
        await installAgyCliMcpSetup();
        const servers = (await readJson(configPath)).mcpServers;
        assertEquals(servers.runwield, { command: oldCommand, args: [...AGY_MCP_ARGS] });
        assertEquals(servers.other, { command: "other", args: ["x"] });
        assertEquals((await inspectAgyCliMcpSetup()).ok, true);
    });
});

test("Agy MCP setup refuses foreign runwield servers and contradictory permissions", async () => {
    await withSetupHome(async (home) => {
        const configPath = join(home, ".gemini", "config", "mcp_config.json");
        const settingsPath = join(home, ".gemini", "antigravity-cli", "settings.json");
        await fsMkdir(join(home, ".gemini", "config"), { recursive: true });
        await fsMkdir(join(home, ".gemini", "antigravity-cli"), { recursive: true });
        await fsWriteFile(configPath, JSON.stringify({ mcpServers: { runwield: { command: "/tmp/other" } } }));
        await fsWriteFile(settingsPath, JSON.stringify({ permissions: { allow: [] } }));
        await assertRejects(() => installAgyCliMcpSetup(), Error, "mcpServers.runwield");

        const otherWld = join(home, "other", WLD_EXECUTABLE);
        await fsMkdir(join(home, "other"));
        await fsWriteFile(otherWld, NATIVE_HEADER);
        await fsChmod(otherWld, 0o755);
        await fsWriteFile(
            configPath,
            JSON.stringify({
                mcpServers: { runwield: { command: otherWld, args: [...AGY_MCP_ARGS], env: { TOKEN: "other" } } },
            }),
        );
        await assertRejects(() => installAgyCliMcpSetup(), Error, "mcpServers.runwield");

        await fsWriteFile(configPath, JSON.stringify({ mcpServers: {} }));
        await fsWriteFile(settingsPath, JSON.stringify({ permissions: { deny: [AGY_MCP_PERMISSION] } }));
        const error = await assertRejects(() => installAgyCliMcpSetup(), Error, "Ask or Deny");
        assertStringIncludes(error.message, settingsPath);
        assertStringIncludes(error.message, AGY_MCP_PERMISSION);
    });
});

test("Agy MCP setup refuses non-interactive first use without mutating files", async () => {
    await withSetupHome(async (home) => {
        const { ensureAgyCliMcpSetup } = await import("./mcp-setup.ts");
        await assertRejects(() => ensureAgyCliMcpSetup(), Error, "needs approval");
        const status = await inspectAgyCliMcpSetup();
        assertEquals(status.ok, false);
        assertStringIncludes(status.message, "needs approval");
        await assertRejects(() => fsStat(join(home, ".gemini", "config", "mcp_config.json")), Error, "ENOENT");
    });
});

test("Agy MCP setup asks once, accepts explicit approval, and preserves files on decline", async () => {
    await withSetupHome(async (home) => {
        const declined = new HostedSession({ id: "agy-mcp-declined", cwd: home });
        declined.setInteractionAdapter({
            requestInteraction: () => ({ outcome: "accepted", value: "decline" }),
            supportsInteraction: () => true,
        });
        await assertRejects(() => ensureAgyCliMcpSetup({ hostedSession: declined }), Error, "not approved");
        await assertRejects(() => fsStat(join(home, ".gemini", "config", "mcp_config.json")), Error, "ENOENT");

        const approved = new HostedSession({ id: "agy-mcp-approved", cwd: home });
        approved.setInteractionAdapter({
            requestInteraction: (request) => {
                assertStringIncludes(request.prompt, join(".gemini", "config", "mcp_config.json"));
                assertStringIncludes(request.prompt, join(".gemini", "antigravity-cli", "settings.json"));
                assertStringIncludes(request.prompt, `${WLD_EXECUTABLE} mcp agy-cli`);
                assertStringIncludes(request.prompt, AGY_MCP_PERMISSION);
                assertStringIncludes(request.prompt, "persists");
                return { outcome: "accepted", value: "approve" };
            },
            supportsInteraction: () => true,
        });
        await ensureAgyCliMcpSetup({ hostedSession: approved });
        assertEquals((await inspectAgyCliMcpSetup()).ok, true);
    });
});

test("Agy MCP setup approval works during a managed operation", async () => {
    await withSetupHome(async (home) => {
        const approved = new HostedSession({ id: "agy-mcp-managed-approved", cwd: home });
        approved.setManagedMetadata({
            runwieldSessionId: "managed-session",
            projectId: "project",
            piSessionId: "pi-session",
            transcriptPath: join(home, "transcript.jsonl"),
            generation: 1,
            name: null,
            activeAgent: null,
            workflowContext: null,
        });
        const capability: ManagedOperationCapability = {
            runtimeSessionId: approved.id,
            runwieldSessionId: "managed-session",
            operationId: "setup-test",
            proof: {
                runwieldSessionId: "managed-session",
                projectId: "project",
                ownerInstanceId: "owner",
                ownerProcessKind: "test",
                operationId: "setup-test",
                fence: 1,
                phase: "turning",
                expectedGeneration: 1,
            },
            settled: false,
            registerArtifact: () => ({
                artifactId: "artifact",
                kind: "report",
                path: "artifact.log",
                title: "Artifact",
                registeredAt: "2026-09-09T00:00:00.000Z",
                registeredBy: "test",
                sourceSegmentId: null,
            }),
            updateProof() {},
            assertLive() {},
            settle() {},
        };
        approved.setManagedOperationCapability(capability);
        let approvalCalls = 0;
        approved.setInteractionAdapter({
            requestInteraction: () => {
                approvalCalls += 1;
                return { outcome: "accepted", value: "approve" };
            },
            supportsInteraction: () => true,
        });

        await assertRejects(() => ensureAgyCliMcpSetup({ hostedSession: approved }), Error, "not approved");
        assertEquals(approvalCalls, 0);
        await ensureAgyCliMcpSetup({ hostedSession: approved, capability });
        assertEquals(approvalCalls, 1);
        assertEquals((await inspectAgyCliMcpSetup()).ok, true);
    });
});

test("Agy MCP setup rejects malformed files and symbolic links", async () => {
    await withSetupHome(async (home) => {
        const configPath = join(home, ".gemini", "config", "mcp_config.json");
        const settingsPath = join(home, ".gemini", "antigravity-cli", "settings.json");
        await fsMkdir(join(home, ".gemini", "config"), { recursive: true });
        await fsMkdir(join(home, ".gemini", "antigravity-cli"), { recursive: true });

        await fsWriteFile(configPath, "[]");
        await fsWriteFile(settingsPath, JSON.stringify({ permissions: { allow: [] } }));
        await assertRejects(() => installAgyCliMcpSetup(), Error, "must contain a JSON object");

        await fsWriteFile(configPath, '{"mcpServers":');
        assertEquals((await inspectAgyCliMcpSetup()).repairable, false);
        await assertRejects(() => installAgyCliMcpSetup(), Error);
        assertEquals(await fsReadFile(configPath, "utf8"), '{"mcpServers":');

        await fsWriteFile(configPath, JSON.stringify({ mcpServers: {} }));
        await fsRm(settingsPath);
        await fsSymlink(configPath, settingsPath);
        await assertRejects(() => installAgyCliMcpSetup(), Error, "must not be a symbolic link");
    });
});

test("Agy MCP setup refuses malformed permission structures", async () => {
    await withSetupHome(async (home) => {
        const configPath = join(home, ".gemini", "config", "mcp_config.json");
        const settingsPath = join(home, ".gemini", "antigravity-cli", "settings.json");
        await fsMkdir(join(home, ".gemini", "config"), { recursive: true });
        await fsMkdir(join(home, ".gemini", "antigravity-cli"), { recursive: true });
        await fsWriteFile(configPath, JSON.stringify({ mcpServers: {} }));

        await fsWriteFile(settingsPath, JSON.stringify({ permissions: "keep-me" }));
        await assertRejects(() => installAgyCliMcpSetup(), Error, "permissions must be a JSON object");
        assertEquals((await readJson(settingsPath)).permissions, "keep-me");

        await fsWriteFile(settingsPath, JSON.stringify({ permissions: { allow: "keep-me" } }));
        await assertRejects(() => installAgyCliMcpSetup(), Error, "permissions.allow must be a JSON array");
        assertEquals((await readJson(settingsPath)).permissions.allow, "keep-me");
    });
});

test("Agy MCP setup refuses source-run wld commands", async () => {
    await withSetupHome(async (_home, binDir) => {
        process.env["PATH"] = binDir;
        const wldPath = join(binDir, WLD_EXECUTABLE);
        await fsWriteFile(wldPath, '#!/bin/sh\nexec deno run -A src/cli.ts "$@"\n');
        await fsChmod(wldPath, 0o755);
        await assertRejects(() => resolveInstalledWldExecutable(), Error, "standalone wld executable");
    });
});

test("Agy MCP setup refuses non-executable wld commands", async () => {
    await withSetupHome(async (_home, binDir) => {
        process.env["PATH"] = binDir;
        const wldPath = join(binDir, WLD_EXECUTABLE);
        if (process.platform === "win32") await fsWriteFile(wldPath, new Uint8Array([0x7f, 0x45, 0x4c, 0x46]));
        else await fsChmod(wldPath, 0o644);
        await assertRejects(() => resolveInstalledWldExecutable(), Error, "standalone wld executable");
    });
});

test("Agy MCP setup is idempotent and concurrent installers converge", async () => {
    await withSetupHome(async (home) => {
        const configPath = join(home, ".gemini", "config", "mcp_config.json");
        const settingsPath = join(home, ".gemini", "antigravity-cli", "settings.json");

        await Promise.all([installAgyCliMcpSetup(), installAgyCliMcpSetup()]);
        const firstConfig = await fsReadFile(configPath, "utf8");
        const firstSettings = await fsReadFile(settingsPath, "utf8");
        await installAgyCliMcpSetup();

        assertEquals(await fsReadFile(configPath, "utf8"), firstConfig);
        assertEquals(await fsReadFile(settingsPath, "utf8"), firstSettings);
        const config = await readJson(configPath);
        const settings = await readJson(settingsPath);
        assertEquals(Object.keys(config.mcpServers).sort(), ["runwield"]);
        assertEquals(settings.permissions.allow.filter((item: string) => item === AGY_MCP_PERMISSION).length, 1);
    });
});
