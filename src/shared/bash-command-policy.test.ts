import { test } from "node:test";
import { assertEquals, assertStringIncludes, assertThrows } from "../testing/assertions.ts";
import {
    checkBashCommand,
    describeBashAllowedCommands,
    intersectBashAllowedCommands,
    normalizeBashAllowedCommands,
} from "./bash-command-policy.ts";

const inspection = [
    "git status",
    "git diff",
    "git log",
    "git show",
    "git blame",
    "git grep",
    "git ls-files",
    "git ls-tree",
    "git rev-parse",
    "git rev-list",
    "git show-ref",
    "git branch --list",
    "git remote -v",
    "git worktree list",
    "ls",
    "pwd",
    "cat",
    "head",
    "tail",
    "wc",
    "grep",
    "rg",
    "find",
    "stat",
    "file",
    "du",
    "readlink",
];

test("inspection selectors match whole command tokens and execute forms", () => {
    for (const selector of inspection) checkBashCommand(selector, inspection);
    checkBashCommand("git -C 'directory with spaces' --no-pager status --short", inspection);
    checkBashCommand("grep 'literal ; && $HOME # comment' *.md", inspection);
    checkBashCommand("cat 'a file.txt'", inspection);
    for (
        const command of [
            "git status-other",
            "list",
            "git branch unwanted",
            "git add .",
            "git remote add origin path",
            "git worktree add x",
            "env git status",
            "/bin/git status",
        ]
    ) {
        assertThrows(() => checkBashCommand(command, inspection), Error, "Allowed commands:");
    }
});

test("single-command filter rejects shell starts that could bypass inspection", () => {
    for (
        const command of [
            "ls | cat",
            "git status && touch sentinel",
            "ls; pwd",
            "ls > sentinel",
            "ls &",
            "ls # ignored second command",
            "ls\npwd",
            "ls $(touch sentinel)",
            "ls `pwd`",
            "ls $HOME",
            "X=1 ls",
            "git -c alias.status='!touch sentinel' status",
            "ls 'unfinished",
            "git status --output=sentinel",
            "git diff --output sentinel",
            "git diff --ext-diff",
            "git show --textconv",
            "git grep -Ovi pattern",
            "find . -delete",
            "find . -exec touch sentinel \\;",
            "rg --pre=touch x",
            "rg --hostname-bin touch",
            "file -C x",
            "file --compile x",
        ]
    ) {
        assertThrows(() => checkBashCommand(command, inspection), Error, "Allowed commands:", command);
    }
});

test("parent Git selector loads and intersects with a child subcommand", () => {
    const parent = normalizeBashAllowedCommands(["git"], "parent");
    const child = normalizeBashAllowedCommands(["git status"], "child");
    assertEquals(intersectBashAllowedCommands(parent, child), ["git status"]);
    checkBashCommand("git status --short", intersectBashAllowedCommands(parent, child));
    assertThrows(() => checkBashCommand("git log", intersectBashAllowedCommands(parent, child)));
});

test("listing forms reject unbounded options and accept supported inspection options", () => {
    const allowed = ["git branch --list", "git remote -v", "git worktree list"];
    for (const command of ["git branch --list -a", "git remote -v", "git worktree list --porcelain"]) {
        checkBashCommand(command, allowed);
    }
    for (
        const command of [
            "git branch --list --set-upstream-to=origin/main",
            "git branch --list --format=%(refname)",
            "git remote -v --foo",
            "git worktree list --foo",
        ]
    ) assertThrows(() => checkBashCommand(command, allowed), Error, "Allowed commands:");
});

test("combined short options and configured executable wrappers are denied", () => {
    for (const command of ["git grep -nOvi pattern", "file -bC -m rules"]) {
        assertThrows(() => checkBashCommand(command, ["git grep", "file"]), Error, "Allowed commands:");
    }
    for (const wrapper of ["env", "sudo", "command", "exec", "nohup", "nice", "time", "snip"]) {
        assertThrows(() => normalizeBashAllowedCommands([wrapper], "fixture"), Error, "bashAllowedCommands");
        assertThrows(
            () => checkBashCommand(`${wrapper} sh -c 'touch sentinel'`, [wrapper]),
            Error,
            "Allowed commands:",
        );
    }
    assertThrows(() => normalizeBashAllowedCommands(["snip run"], "fixture"), Error, "bashAllowedCommands");
    assertThrows(
        () => checkBashCommand("snip run -- sh -c 'touch sentinel'", ["snip run"]),
        Error,
        "Allowed commands:",
    );
});

test("metadata reset and delegation intersection retain parent authority", () => {
    assertEquals(normalizeBashAllowedCommands(null, "test"), undefined);
    assertEquals(normalizeBashAllowedCommands([], "test"), []);
    assertEquals(intersectBashAllowedCommands(["git"], ["git status"]), ["git status"]);
    assertEquals(intersectBashAllowedCommands(["git status"], ["git"]), ["git status"]);
    assertEquals(intersectBashAllowedCommands(["pwd"], ["git status"]), []);
    assertEquals(intersectBashAllowedCommands(["pwd"], undefined), ["pwd"]);
    assertEquals(intersectBashAllowedCommands([], undefined), []);
    assertStringIncludes(describeBashAllowedCommands([]), "report a blocker");
    for (const value of [42, "pwd", ["pwd", 3], [""], ["git status && touch x"], ["git *"]]) {
        assertThrows(() => normalizeBashAllowedCommands(value as string[], "fixture.md"), Error, "bashAllowedCommands");
    }
});
