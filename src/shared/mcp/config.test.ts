import { captureForegroundProcess } from "../captured-process.ts";
import { test } from "node:test";
import { tmpdir } from "node:os";
import {
    chmod as fsChmod,
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    rm as fsRm,
    symlink as fsSymlink,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import process from "node:process";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { dirname, join } from "node:path";
import { resolveMcpConfig } from "./config.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";

async function git(cwd: string, args: string[]): Promise<void> {
    const output = await captureForegroundProcess("git", { cwd, args });
    if (output.code !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

async function writeMode(path: string, text: string, mode = 0o600): Promise<void> {
    await fsMkdir(dirname(path), { recursive: true }).catch(() => {});
    await fsWriteFile(path, text, { mode });
    await fsChmod(path, mode).catch(() => {});
}

async function makeGitProject(): Promise<string> {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-mcp-config-"));
    await git(root, ["init"]);
    await fsWriteFile(join(root, ".gitignore"), ".wld/mcp.json\n");
    await git(root, ["add", ".gitignore"]);
    await git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);
    return root;
}

test("MCP config resolves global, project replacement, disable entries, and request additions", async () => {
    await withProcessGlobalTestLock(async () => {
        const oldHome = process.env["HOME"];
        const home = await fsMkdtemp(join(tmpdir(), "runwield-mcp-home-"));
        const project = await makeGitProject();
        try {
            process.env["HOME"] = home;
            await fsMkdir(join(home, ".wld"), { recursive: true, mode: 0o700 });
            await fsChmod(join(home, ".wld"), 0o700).catch(() => {});
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
            await fsMkdir(join(project, ".wld"), { recursive: true });
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
            assertEquals(
                result.servers.map((server) => [server.name, server.command, server.source]),
                [
                    ["shared", "project-shared", "project"],
                    ["globalOnly", "global-only", "global"],
                    ["requestOnly", "/bin/echo", "request"],
                ],
            );
        } finally {
            if (oldHome) process.env["HOME"] = oldHome;
            else delete process.env["HOME"];
            await fsRm(home, { recursive: true });
            await fsRm(project, { recursive: true });
        }
    });
});

test("MCP config skips project file that Git can publish", async () => {
    await withProcessGlobalTestLock(async () => {
        const oldHome = process.env["HOME"];
        const home = await fsMkdtemp(join(tmpdir(), "runwield-mcp-home-"));
        const project = await fsMkdtemp(join(tmpdir(), "runwield-mcp-unsafe-"));
        try {
            process.env["HOME"] = home;
            await git(project, ["init"]);
            await fsMkdir(join(home, ".wld"), { recursive: true, mode: 0o700 });
            await writeMode(join(home, ".wld", "mcp.json"), JSON.stringify({ mcpServers: {} }));
            await fsMkdir(join(project, ".wld"), { recursive: true });
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
            if (oldHome) process.env["HOME"] = oldHome;
            else delete process.env["HOME"];
            await fsRm(home, { recursive: true });
            await fsRm(project, { recursive: true });
        }
    });
});

test("MCP config redacts parse and schema errors", async () => {
    await withProcessGlobalTestLock(async () => {
        const oldHome = process.env["HOME"];
        const home = await fsMkdtemp(join(tmpdir(), "runwield-mcp-home-"));
        const project = await makeGitProject();
        try {
            process.env["HOME"] = home;
            await fsMkdir(join(home, ".wld"), { recursive: true, mode: 0o700 });
            await writeMode(
                join(home, ".wld", "mcp.json"),
                '{"mcpServers":{"bad":{"command":"raw-global-secret","args":[}',
            );
            await fsMkdir(join(project, ".wld"), { recursive: true });
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
            assertEquals(
                result.warnings.map((item) => item.stage),
                ["parse", "parse"],
            );
            const warningText = result.warnings.map((item) => item.message).join("\n");
            assertEquals(warningText.includes("raw-global-secret"), false);
            assertEquals(warningText.includes("raw-project-secret"), false);
            assertEquals(warningText.includes("raw-token-secret"), false);
        } finally {
            if (oldHome) process.env["HOME"] = oldHome;
            else delete process.env["HOME"];
            await fsRm(home, { recursive: true });
            await fsRm(project, { recursive: true });
        }
    });
});

test("MCP config rejects committed, staged, intent-to-add, symlink, and broad-mode project files", async () => {
    await withProcessGlobalTestLock(async () => {
        const oldHome = process.env["HOME"];
        const home = await fsMkdtemp(join(tmpdir(), "runwield-mcp-home-"));
        try {
            process.env["HOME"] = home;
            await fsMkdir(join(home, ".wld"), { recursive: true, mode: 0o700 });
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

                await fsMkdir(join(symlinkProject, ".wld"), { recursive: true });
                const symlinkTarget = join(symlinkProject, "outside-mcp.json");
                await fsWriteFile(symlinkTarget, configText);
                await fsSymlink(symlinkTarget, join(symlinkProject, ".wld", "mcp.json"));
                const symlink = await resolveMcpConfig({ cwd: symlinkProject });
                assertEquals(symlink.servers, []);
                assertStringIncludes(symlink.warnings[0].message, "regular file");

                if (process.platform !== "win32") {
                    await writeMode(join(modeProject, ".wld", "mcp.json"), configText, 0o644);
                    const broadMode = await resolveMcpConfig({ cwd: modeProject });
                    assertEquals(broadMode.servers, []);
                    assertStringIncludes(broadMode.warnings[0].message, "mode 0600");
                }
            } finally {
                await fsRm(committedProject, { recursive: true });
                await fsRm(stagedProject, { recursive: true });
                await fsRm(intentProject, { recursive: true });
                await fsRm(symlinkProject, { recursive: true });
                await fsRm(modeProject, { recursive: true });
            }
        } finally {
            if (oldHome) process.env["HOME"] = oldHome;
            else delete process.env["HOME"];
            await fsRm(home, { recursive: true });
        }
    });
});

test("MCP config resolves project file from the primary checkout for execution worktrees", async () => {
    await withProcessGlobalTestLock(async () => {
        const oldHome = process.env["HOME"];
        const home = await fsMkdtemp(join(tmpdir(), "runwield-mcp-home-"));
        const primary = await makeGitProject();
        const worktree = join(dirname(primary), "runwield-mcp-execution-worktree");
        try {
            process.env["HOME"] = home;
            await fsMkdir(join(home, ".wld"), { recursive: true, mode: 0o700 });
            await writeMode(join(home, ".wld", "mcp.json"), JSON.stringify({ mcpServers: {} }));
            await fsMkdir(join(primary, ".wld"), { recursive: true });
            await writeMode(
                join(primary, ".wld", "mcp.json"),
                JSON.stringify({ mcpServers: { primaryOnly: { command: "primary", args: [], env: {} } } }),
            );
            await git(primary, ["worktree", "add", "-b", "fixture-worktree", worktree]);
            await fsMkdir(join(worktree, ".wld"), { recursive: true });
            await writeMode(
                join(worktree, ".wld", "mcp.json"),
                JSON.stringify({ mcpServers: { localOnly: { command: "local", args: [], env: {} } } }),
            );

            const result = await resolveMcpConfig({ cwd: worktree });

            assertEquals(result.warnings, []);
            assertEquals(
                result.servers.map((server) => [server.name, server.command, server.source]),
                [["primaryOnly", "primary", "project"]],
            );
        } finally {
            if (oldHome) process.env["HOME"] = oldHome;
            else delete process.env["HOME"];
            await fsRm(home, { recursive: true });
            await fsRm(worktree, { recursive: true }).catch(() => {});
            await fsRm(primary, { recursive: true });
        }
    });
});
