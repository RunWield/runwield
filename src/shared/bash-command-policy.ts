/* Best-effort filtering of RunWield-owned shell starts. This is not a sandbox. */
import { commandWords, type BashAllowedCommands } from "@runwield/parsing/shell-selectors";
export { normalizeBashAllowedCommands, type BashAllowedCommands } from "@runwield/parsing/shell-selectors";

export function intersectBashAllowedCommands(
    parent: BashAllowedCommands,
    child: BashAllowedCommands,
): BashAllowedCommands {
    if (parent === undefined) return child;
    if (child === undefined) return parent;
    const intersection: string[] = [];
    for (const a of parent) {
        for (const b of child) {
            const left = a.split(" ");
            const right = b.split(" ");
            const shorter = left.length < right.length ? left : right;
            if (shorter.every((word, index) => word === left[index] && word === right[index])) {
                const specific = left.length > right.length ? a : b;
                if (!intersection.includes(specific)) intersection.push(specific);
            }
        }
    }
    return intersection;
}

export function describeBashAllowedCommands(allowed: BashAllowedCommands): string {
    if (allowed === undefined) return "";
    return `Only single inspection commands are allowed. Allowed commands: ${
        allowed.length ? allowed.join(", ") : "(none)"
    }. Use an allowed command. If you cannot complete the brief with these commands, report a blocker in your final handoff. Do not work around the restriction.`;
}

function deniedOption(words: string[]): string | undefined {
    const [exe, subcommand, ...args] = words;
    if (exe === "git") {
        if (args.some((arg) => /^(--output(?:=|$)|--ext-diff$|--textconv$)/.test(arg))) {
            return "Git output or external execution option";
        }
        if (
            subcommand === "grep" &&
            args.some((arg) => /^-[a-zA-Z]*O/.test(arg) || arg.startsWith("--open-files-in-pager"))
        )
            return "Git pager execution option";
        if (
            subcommand === "branch" &&
            (!args.includes("--list") ||
                args.some(
                    (arg) =>
                        arg.startsWith("-") &&
                        !["--list", "-a", "--all", "-r", "--remotes", "-v", "--verbose", "--no-color"].includes(arg),
                ))
        )
            return "Git branch requires bounded --list options";
        if (subcommand === "remote" && (args[0] !== "-v" || args.length !== 1)) return "Git remote requires -v";
        if (
            subcommand === "worktree" &&
            (args[0] !== "list" || args.slice(1).some((arg) => !["--porcelain", "-z", "-v", "--verbose"].includes(arg)))
        )
            return "Git worktree requires bounded list options";
    }
    if (
        exe === "find" &&
        words.slice(1).some((arg) => /^-(?:exec(?:dir)?|ok(?:dir)?|delete|fprint(?:0|f)?|fprintf|fls)$/.test(arg))
    )
        return "Find execution or file mutation action";
    if (exe === "rg" && words.slice(1).some((arg) => /^--(?:pre|hostname-bin)(?:=|$)/.test(arg))) {
        return "ripgrep external execution option";
    }
    if (exe === "file" && words.slice(1).some((arg) => /^-[a-zA-Z]*C/.test(arg) || arg.startsWith("--compile"))) {
        return "file compilation option";
    }
    return undefined;
}

export function checkBashCommand(command: string, allowed: BashAllowedCommands): void {
    if (allowed === undefined) return;
    try {
        const words = commandWords(command);
        const match = allowed.some((selector) => {
            const parts = selector.split(" ");
            return parts.every((word, index) => words[index] === word);
        });
        if (!match) throw new Error("Command is not in the allowed list");
        const option = deniedOption(words);
        if (option) throw new Error(option);
    } catch (error) {
        throw new Error(
            `${error instanceof Error ? error.message : String(error)}. ${describeBashAllowedCommands(allowed)}`,
        );
    }
}
