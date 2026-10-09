import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { resolveMcpConfig } from "./config.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";

async function git(cwd: string, args: string[]): Promise<void> {
    const output = await new Deno.Command("git", { cwd, args, stdout: "null", stderr: "null" }).output();
    if (output.code !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

async function writeMode(path: string, text: string, mode = 0o600): Promise<void> {
    await Deno.mkdir(dirname(path), { recursive: true }).catch(() => {});
    await Deno.writeTextFile(path, text, { mode });
    await Deno.chmod(path, mode).catch(() => {});
}

async function makeGitProject(): Promise<string> {
    const root = await Deno.makeTempDir({ prefix: "runwield-mcp-config-" });
    await git(root, ["init"]);
    await Deno.writeTextFile(join(root, ".gitignore"), ".wld/mcp.json\n");
    await git(root, ["add", ".gitignore"]);
    await git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);
    return root;
}

Deno.test("MCP config resolves global, project replacement, disable entries, and request additions", async () => {
    await withProcessGlobalTestLock(async () => {
        const oldHome = Deno.env.get("HOME");
        const home = await Deno.makeTempDir({ prefix: "runwield-mcp-home-" });
        const project = await makeGitProject();
        try {
            Deno.env.set("HOME", home);
            await Deno.mkdir(join(home, ".wld"), { recursive: true, mode: 0o700 });
            await Deno.chmod(join(home, ".wld"), 0o700).catch(() => {});
            await writeMode(
                join(home, ".wld", "mcp.json"),
                JSON.stringify({
                    mcpServers: {
                        shared: { command: "global-shared", args: ["a"], env: { TOKEN: "global" } },
                        disabled: { command: "global-disabled", args: [], env: {} },
                        globalOnly: { command: "global-only", args: [], env: {} },
                    },
                }),
            );
            await Deno.mkdir(join(project, ".wld"), { recursive: true });
            await writeMode(
                join(project, ".wld", "mcp.json"),
                JSON.stringify({
                    mcpServers: {
                        shared: { command: "project-shared", args: ["b"], env: { TOKEN: "project" } },
                        disabled: { enabled: false },
                    },
                }),
            );

            const result = await resolveMcpConfig({
                cwd: project,
                requestServers: [{ name: "requestOnly", command: "/bin/echo", args: [], env: {}, source: "request" }],
            });

            assertEquals(result.warnings, []);
            assertEquals(result.servers.map((server) => [server.name, server.command, server.source]), [
                ["shared", "project-shared", "project"],
                ["globalOnly", "global-only", "global"],
                ["requestOnly", "/bin/echo", "request"],
            ]);
        } finally {
            if (oldHome) Deno.env.set("HOME", oldHome);
            else Deno.env.delete("HOME");
            await Deno.remove(home, { recursive: true });
            await Deno.remove(project, { recursive: true });
        }
    });
});

Deno.test("MCP config skips project file that Git can publish", async () => {
    await withProcessGlobalTestLock(async () => {
        const oldHome = Deno.env.get("HOME");
        const home = await Deno.makeTempDir({ prefix: "runwield-mcp-home-" });
        const project = await Deno.makeTempDir({ prefix: "runwield-mcp-unsafe-" });
        try {
            Deno.env.set("HOME", home);
            await git(project, ["init"]);
            await Deno.mkdir(join(home, ".wld"), { recursive: true, mode: 0o700 });
            await writeMode(join(home, ".wld", "mcp.json"), JSON.stringify({ mcpServers: {} }));
            await Deno.mkdir(join(project, ".wld"), { recursive: true });
            await writeMode(
                join(project, ".wld", "mcp.json"),
                JSON.stringify({
                    mcpServers: { unsafe: { command: "unsafe", args: [], env: {} } },
                }),
            );

            const result = await resolveMcpConfig({ cwd: project });
            assertEquals(result.servers, []);
            assertEquals(result.warnings.length, 1);
            assertStringIncludes(result.warnings[0].message, "ignored by Git");
        } finally {
            if (oldHome) Deno.env.set("HOME", oldHome);
            else Deno.env.delete("HOME");
            await Deno.remove(home, { recursive: true });
            await Deno.remove(project, { recursive: true });
        }
    });
});

Deno.test("MCP config redacts parse and schema errors", async () => {
    await withProcessGlobalTestLock(async () => {
        const oldHome = Deno.env.get("HOME");
        const home = await Deno.makeTempDir({ prefix: "runwield-mcp-home-" });
        const project = await makeGitProject();
        try {
            Deno.env.set("HOME", home);
            await Deno.mkdir(join(home, ".wld"), { recursive: true, mode: 0o700 });
            await writeMode(
                join(home, ".wld", "mcp.json"),
                '{"mcpServers":{"bad":{"command":"raw-global-secret","args":[}',
            );
            await Deno.mkdir(join(project, ".wld"), { recursive: true });
            await writeMode(
                join(project, ".wld", "mcp.json"),
                JSON.stringify({
                    mcpServers: {
                        bad: {
                            command: 7,
                            args: ["raw-project-secret"],
                            env: { TOKEN: "raw-token-secret" },
                        },
                    },
                }),
            );

            const result = await resolveMcpConfig({ cwd: project });
            assertEquals(result.servers, []);
            assertEquals(result.warnings.map((item) => item.stage), ["parse", "parse"]);
            const warningText = result.warnings.map((item) => item.message).join("\n");
            assertEquals(warningText.includes("raw-global-secret"), false);
            assertEquals(warningText.includes("raw-project-secret"), false);
            assertEquals(warningText.includes("raw-token-secret"), false);
        } finally {
            if (oldHome) Deno.env.set("HOME", oldHome);
            else Deno.env.delete("HOME");
            await Deno.remove(home, { recursive: true });
            await Deno.remove(project, { recursive: true });
        }
    });
});

Deno.test("MCP config rejects committed, staged, intent-to-add, symlink, and broad-mode project files", async () => {
    await withProcessGlobalTestLock(async () => {
        const oldHome = Deno.env.get("HOME");
        const home = await Deno.makeTempDir({ prefix: "runwield-mcp-home-" });
        try {
            Deno.env.set("HOME", home);
            await Deno.mkdir(join(home, ".wld"), { recursive: true, mode: 0o700 });
            await writeMode(join(home, ".wld", "mcp.json"), JSON.stringify({ mcpServers: {} }));

            const committedProject = await makeGitProject();
            const stagedProject = await makeGitProject();
            const intentProject = await makeGitProject();
            const symlinkProject = await makeGitProject();
            const modeProject = await makeGitProject();
            try {
                const configText = JSON.stringify({ mcpServers: { unsafe: { command: "unsafe", args: [], env: {} } } });
                await writeMode(join(committedProject, ".wld", "mcp.json"), configText);
                await git(committedProject, ["add", "-f", ".wld/mcp.json"]);
                await git(committedProject, [
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.com",
                    "commit",
                    "-m",
                    "track mcp config",
                ]);
                const committed = await resolveMcpConfig({ cwd: committedProject });
                assertEquals(committed.servers, []);
                assertStringIncludes(committed.warnings[0].message, "tracked or staged");

                await writeMode(join(stagedProject, ".wld", "mcp.json"), configText);
                await git(stagedProject, ["add", "-f", ".wld/mcp.json"]);
                const staged = await resolveMcpConfig({ cwd: stagedProject });
                assertEquals(staged.servers, []);
                assertStringIncludes(staged.warnings[0].message, "tracked or staged");

                await writeMode(join(intentProject, ".wld", "mcp.json"), configText);
                await git(intentProject, ["add", "-N", "-f", ".wld/mcp.json"]);
                const intent = await resolveMcpConfig({ cwd: intentProject });
                assertEquals(intent.servers, []);
                assertStringIncludes(intent.warnings[0].message, "tracked or staged");

                await Deno.mkdir(join(symlinkProject, ".wld"), { recursive: true });
                const symlinkTarget = join(symlinkProject, "outside-mcp.json");
                await Deno.writeTextFile(symlinkTarget, configText);
                await Deno.symlink(symlinkTarget, join(symlinkProject, ".wld", "mcp.json"));
                const symlink = await resolveMcpConfig({ cwd: symlinkProject });
                assertEquals(symlink.servers, []);
                assertStringIncludes(symlink.warnings[0].message, "regular file");

                await writeMode(join(modeProject, ".wld", "mcp.json"), configText, 0o644);
                const broadMode = await resolveMcpConfig({ cwd: modeProject });
                assertEquals(broadMode.servers, []);
                assertStringIncludes(broadMode.warnings[0].message, "mode 0600");
            } finally {
                await Deno.remove(committedProject, { recursive: true });
                await Deno.remove(stagedProject, { recursive: true });
                await Deno.remove(intentProject, { recursive: true });
                await Deno.remove(symlinkProject, { recursive: true });
                await Deno.remove(modeProject, { recursive: true });
            }
        } finally {
            if (oldHome) Deno.env.set("HOME", oldHome);
            else Deno.env.delete("HOME");
            await Deno.remove(home, { recursive: true });
        }
    });
});

Deno.test("MCP config resolves project file from the primary checkout for execution worktrees", async () => {
    await withProcessGlobalTestLock(async () => {
        const oldHome = Deno.env.get("HOME");
        const home = await Deno.makeTempDir({ prefix: "runwield-mcp-home-" });
        const primary = await makeGitProject();
        const worktree = join(dirname(primary), "runwield-mcp-execution-worktree");
        try {
            Deno.env.set("HOME", home);
            await Deno.mkdir(join(home, ".wld"), { recursive: true, mode: 0o700 });
            await writeMode(join(home, ".wld", "mcp.json"), JSON.stringify({ mcpServers: {} }));
            await Deno.mkdir(join(primary, ".wld"), { recursive: true });
            await writeMode(
                join(primary, ".wld", "mcp.json"),
                JSON.stringify({ mcpServers: { primaryOnly: { command: "primary", args: [], env: {} } } }),
            );
            await git(primary, ["worktree", "add", "-b", "fixture-worktree", worktree]);
            await Deno.mkdir(join(worktree, ".wld"), { recursive: true });
            await writeMode(
                join(worktree, ".wld", "mcp.json"),
                JSON.stringify({ mcpServers: { localOnly: { command: "local", args: [], env: {} } } }),
            );

            const result = await resolveMcpConfig({ cwd: worktree });

            assertEquals(result.warnings, []);
            assertEquals(result.servers.map((server) => [server.name, server.command, server.source]), [
                ["primaryOnly", "primary", "project"],
            ]);
        } finally {
            if (oldHome) Deno.env.set("HOME", oldHome);
            else Deno.env.delete("HOME");
            await Deno.remove(home, { recursive: true });
            await Deno.remove(worktree, { recursive: true }).catch(() => {});
            await Deno.remove(primary, { recursive: true });
        }
    });
});
