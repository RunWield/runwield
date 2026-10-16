import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { withRemoteRuntimeFixture } from "./remote-runtime-test-fixture.ts";

test("remote MCP lists laptop personal servers without starting them and starts project servers remotely", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        const fixtureServer = fileURLToPath(new URL("../mcp/fixture-server.ts", import.meta.url));
        const personalLog = join(f.homeDir, "personal-mcp.log");
        const serverLog = join(f.remoteHome, "server-personal-mcp.log");
        const projectLog = join(f.remoteProject, "project-mcp.log");
        const definition = (log: string) => ({
            command: process.execPath,
            args: runtimeSourceArgs(["run", "-A", fixtureServer]),
            env: { RUNWIELD_MCP_FIXTURE_LOG: log, LAPTOP_SECRET: "laptop-only-secret" },
        });
        await writeFile(
            join(f.homeDir, ".wld", "mcp.json"),
            JSON.stringify({ mcpServers: { personal: definition(personalLog), overridden: definition(personalLog) } }),
            { mode: 0o600 },
        );
        await writeFile(
            join(f.remoteHome, ".wld", "mcp.json"),
            JSON.stringify({ mcpServers: { serverPersonal: definition(serverLog) } }),
            { mode: 0o600 },
        );
        await mkdir(join(f.remoteProject, ".wld"));
        await writeFile(join(f.remoteProject, ".gitignore"), ".wld/mcp.json\n");
        await writeFile(
            join(f.remoteProject, ".wld", "mcp.json"),
            JSON.stringify({ mcpServers: { overridden: definition(projectLog) } }),
            { mode: 0o600 },
        );
        const snapshot = await fetch(`http://127.0.0.1:${f.connection.port}/mcp/config`, {
            headers: { Authorization: `Bearer ${f.connection.credential}` },
        });
        const text = await snapshot.text();
        assertEquals(text.includes("laptop-only-secret"), false);
        const child = await f.start();
        await child.read();
        await child.send({ kind: "mcp" });
        const status = await child.read();
        assertStringIncludes(JSON.stringify(status.notices), "personal: laptop — not started remotely");
        assertStringIncludes(JSON.stringify(status.notices), "overridden: remote");
        assertEquals(JSON.stringify(status).includes("serverPersonal"), false);
        assertStringIncludes(
            await readFile(projectLog, "utf8"),
            `"cwd":${JSON.stringify(await realpath(f.remoteProject))}`,
        );
        await assertRejects(() => stat(personalLog), Error, "ENOENT");
        await assertRejects(() => stat(serverLog), Error, "ENOENT");
    });
});
