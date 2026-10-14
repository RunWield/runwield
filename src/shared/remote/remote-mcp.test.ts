import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { withRemoteRuntimeFixture } from "./remote-runtime-test-fixture.ts";

Deno.test("remote MCP lists laptop personal servers without starting them and starts project servers remotely", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        const fixtureServer = fromFileUrl(new URL("../mcp/fixture-server.ts", import.meta.url));
        const personalLog = join(f.homeDir, "personal-mcp.log");
        const serverLog = join(f.remoteHome, "server-personal-mcp.log");
        const projectLog = join(f.remoteProject, "project-mcp.log");
        const definition = (log: string) => ({
            command: Deno.execPath(),
            args: ["run", "-A", fixtureServer],
            env: { RUNWIELD_MCP_FIXTURE_LOG: log, LAPTOP_SECRET: "laptop-only-secret" },
        });
        await Deno.writeTextFile(
            join(f.homeDir, ".wld", "mcp.json"),
            JSON.stringify({ mcpServers: { personal: definition(personalLog), overridden: definition(personalLog) } }),
            { mode: 0o600 },
        );
        await Deno.writeTextFile(
            join(f.remoteHome, ".wld", "mcp.json"),
            JSON.stringify({ mcpServers: { serverPersonal: definition(serverLog) } }),
            { mode: 0o600 },
        );
        await Deno.mkdir(join(f.remoteProject, ".wld"));
        await Deno.writeTextFile(join(f.remoteProject, ".gitignore"), ".wld/mcp.json\n");
        await Deno.writeTextFile(
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
            await Deno.readTextFile(projectLog),
            `"cwd":${JSON.stringify(await Deno.realPath(f.remoteProject))}`,
        );
        await assertRejects(() => Deno.stat(personalLog), Deno.errors.NotFound);
        await assertRejects(() => Deno.stat(serverLog), Deno.errors.NotFound);
    });
});
