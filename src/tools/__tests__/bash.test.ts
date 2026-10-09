import { bashFixtureExecutable } from "../../../scripts/bash-fixture.ts";
import { captureForegroundProcess } from "../../shared/captured-process.ts";
import { test } from "node:test";
import {
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { createRunWieldBashToolDefinition } from "../bash.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";

test("restricted Pi bash executes inspection and rejects mutations before shell launch", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-bash-policy-"));
    try {
        const git = async (args: string[]) => {
            const result = await captureForegroundProcess("git", { cwd, args });
            if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
        };
        await git(["init", "-b", "main"]);
        await git([
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--allow-empty",
            "-m",
            "inspection marker",
        ]);
        await fsWriteFile(join(cwd, "file with spaces.txt"), "inspection content\n");
        await git(["add", "file with spaces.txt"]);
        await git([
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-m",
            "tracked inspection content",
        ]);
        await fsWriteFile(join(cwd, "file with spaces.txt"), "inspection content\nunstaged marker\n");
        await fsWriteFile(join(cwd, "staged.txt"), "staged marker\n");
        await git(["add", "staged.txt"]);
        const tool = createRunWieldBashToolDefinition(cwd, [
            "git status",
            "git diff",
            "git log",
            "git show",
            "git branch --list",
            "git remote -v",
            "git worktree list",
            "cat",
            "ls",
        ]);
        const execute = (command: string) =>
            tool.execute("call", { command }, new AbortController().signal, () => {}, {
                sessionManager: SessionManager.inMemory(cwd),
            } as never);
        const log = await execute("git log -2 --oneline");
        assertStringIncludes(
            log.content
                .filter((item) => item.type === "text")
                .map((item) => item.text)
                .join("\n"),
            "inspection marker",
        );
        for (const [command, marker] of [
            ["git show HEAD:'file with spaces.txt'", "inspection content"],
            ["git diff -- 'file with spaces.txt'", "unstaged marker"],
            ["git diff --cached -- staged.txt", "staged marker"],
            ["git -C . status --short", "staged.txt"],
            ["git branch --list", "main"],
            ["git worktree list", "main"],
            ["ls", "file with spaces.txt"],
        ]) {
            const result = await execute(command);
            assertStringIncludes(
                result.content
                    .filter((item) => item.type === "text")
                    .map((item) => item.text)
                    .join("\n"),
                marker,
            );
        }
        await execute("git remote -v");
        const cat = await execute("cat 'file with spaces.txt'");
        assertStringIncludes(
            cat.content
                .filter((item) => item.type === "text")
                .map((item) => item.text)
                .join("\n"),
            "inspection content",
        );
        const status = await execute("git status --short");
        assertStringIncludes(
            status.content
                .filter((item) => item.type === "text")
                .map((item) => item.text)
                .join("\n"),
            "file with spaces.txt",
        );
        const denied = await assertRejects(() => execute("git status && touch sentinel"), Error, "report a blocker");
        assertStringIncludes(denied.message, "git status");
        await assertRejects(() => execute("ls > sentinel"), Error, "single inspection commands");
        await assertRejects(() => execute("git branch unwanted"), Error, "Allowed commands");
        await assertRejects(() => execute("git add ."), Error, "Allowed commands");
        await assertRejects(() => execute("git diff --output=sentinel"), Error, "Git output");
        await assertRejects(() => execute("find . -delete"), Error, "Allowed commands");
        await assertRejects(() => execute("find . -exec touch sentinel \\;"), Error, "Allowed commands");
        assertEquals((await fsReadFile(join(cwd, "file with spaces.txt"), "utf8")).includes("unstaged marker"), true);
        const index = await captureForegroundProcess("git", { cwd, args: ["diff", "--cached", "--name-only"] });
        assertEquals(new TextDecoder().decode(index.stdout).trim(), "staged.txt");
        assertEquals(
            await fsStat(join(cwd, "sentinel")).then(
                () => true,
                () => false,
            ),
            false,
        );
        assertEquals(
            await captureForegroundProcess("git", { cwd, args: ["branch", "--list", "unwanted"] }).then((result) =>
                new TextDecoder().decode(result.stdout).trim(),
            ),
            "",
        );
    } finally {
        await fsRm(cwd, { recursive: true });
    }
});

test("custom bash retains configured shell path and command prefix when unrestricted", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-bash-settings-"));
    try {
        const tool = createRunWieldBashToolDefinition(cwd, undefined, {
            shellPath: bashFixtureExecutable(),
            commandPrefix: "printf 'prefix marker' > prefix.txt; ",
        });
        await tool.execute(
            "call",
            { command: "printf 'command marker' > command.txt" },
            new AbortController().signal,
            () => {},
            { sessionManager: SessionManager.inMemory(cwd) } as never,
        );
        assertEquals(await fsReadFile(join(cwd, "prefix.txt"), "utf8"), "prefix marker");
        assertEquals(await fsReadFile(join(cwd, "command.txt"), "utf8"), "command marker");
    } finally {
        await fsRm(cwd, { recursive: true });
    }
});

test("empty policy denies all while absent policy retains Pi shell", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-bash-policy-empty-"));
    try {
        const empty = createRunWieldBashToolDefinition(cwd, []);
        await assertRejects(
            () =>
                empty.execute("call", { command: "pwd" }, new AbortController().signal, () => {}, {
                    sessionManager: SessionManager.inMemory(cwd),
                } as never),
            Error,
            "(none)",
        );
        const unrestricted = createRunWieldBashToolDefinition(cwd);
        await unrestricted.execute(
            "call",
            { command: "touch unrestricted-file" },
            new AbortController().signal,
            () => {},
            { sessionManager: SessionManager.inMemory(cwd) } as never,
        );
        assertEquals((await fsStat(join(cwd, "unrestricted-file"))).isFile(), true);
    } finally {
        await fsRm(cwd, { recursive: true });
    }
});
