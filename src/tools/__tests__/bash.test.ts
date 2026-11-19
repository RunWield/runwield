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

test("restricted Pi bash inspects real staged and unstaged Git state without starting denied writes", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-bash-git-inspection-"));
    try {
        const git = async (...args: string[]) => {
            const output = await captureForegroundProcess("git", { cwd, args });
            if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
        };
        await git("init", "-b", "main");
        await fsWriteFile(join(cwd, "file with spaces.txt"), "original marker\n");
        await git("add", ".");
        await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "history marker");
        await fsWriteFile(join(cwd, "file with spaces.txt"), "staged marker\n");
        await git("add", ".");
        await fsWriteFile(join(cwd, "file with spaces.txt"), "staged marker\nunstaged marker\n");
        const fixture = join(cwd, "keep.txt");
        await fsWriteFile(fixture, "keep me\n");
        const sentinel = join(cwd, "sentinel.txt");
        const policy = [
            "git status",
            "git diff",
            "git log",
            "git show",
            "git branch --list",
            "git remote -v",
            "git worktree list",
            "ls",
            "cat",
            "find",
        ];
        const tool = createRunWieldBashToolDefinition(cwd, policy);
        const execute = async (command: string) => {
            const result = await tool.execute("call", { command }, new AbortController().signal, () => {}, {
                sessionManager: SessionManager.inMemory(cwd),
            } as never);
            return result.content
                .filter((item) => item.type === "text")
                .map((item) => item.text)
                .join("\n");
        };
        assertStringIncludes(await execute("git log -1 --oneline"), "history marker");
        assertStringIncludes(await execute("git show HEAD:'file with spaces.txt'"), "original marker");
        assertStringIncludes(await execute("git diff --cached"), "staged marker");
        assertStringIncludes(await execute("git diff"), "unstaged marker");
        assertStringIncludes(await execute("git status --short"), "file with spaces.txt");
        assertStringIncludes(await execute("git -C '" + cwd + "' --no-pager log -1"), "history marker");
        assertStringIncludes(await execute("git branch --list"), "main");
        assertStringIncludes(await execute("git worktree list"), "main");
        assertStringIncludes(await execute("ls 'file with spaces.txt'"), "file with spaces.txt");
        assertStringIncludes(await execute("cat 'file with spaces.txt'"), "unstaged marker");
        for (const command of [
            "git branch unwanted",
            "git add keep.txt",
            "git diff --output=" + sentinel,
            "find . -delete",
            "find . -exec touch sentinel.txt \\;",
            "ls > " + sentinel,
            "git status && touch " + sentinel,
        ]) {
            await assertRejects(() => execute(command), Error, "Allowed commands:");
        }
        assertEquals(await fsReadFile(fixture, "utf8"), "keep me\n");
        assertEquals(
            await fsStat(sentinel).then(
                () => true,
                () => false,
            ),
            false,
        );
        assertStringIncludes(await execute("git branch --list unwanted"), "(no output)");
        assertStringIncludes(await execute("git diff --cached"), "staged marker");
        assertStringIncludes(await execute("git status --short"), "keep.txt");
        // An approved command still reports Pi's real process error outside a repository.
        const outside = await fsMkdtemp(join(tmpdir(), "runwield-bash-outside-git-"));
        try {
            const outsideTool = createRunWieldBashToolDefinition(outside, ["git status"]);
            const result = await outsideTool.execute(
                "call",
                { command: "git status" },
                new AbortController().signal,
                () => {},
                { sessionManager: SessionManager.inMemory(outside) } as never,
            );
            assertEquals(result.isError, true);
            const output = result.content
                .filter((item) => item.type === "text")
                .map((item) => item.text)
                .join("\n");
            assertStringIncludes(output, "not a git repository");
            assertEquals(output.includes("Allowed commands:"), false);
        } finally {
            await fsRm(outside, { recursive: true });
        }
    } finally {
        await fsRm(cwd, { recursive: true });
    }
});
