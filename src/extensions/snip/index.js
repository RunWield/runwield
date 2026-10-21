/**
 * @module extensions/snip
 * Optional Snip command prefix extension for RunWield agent invocations.
 */

import { parseLeadingSimpleCommand } from "./leading-simple-command.ts";

const SHELL_BUILTINS = new Set([
    ".",
    "alias",
    "bg",
    "break",
    "cd",
    "command",
    "continue",
    "eval",
    "exec",
    "exit",
    "export",
    "fg",
    "jobs",
    "popd",
    "pushd",
    "read",
    "return",
    "set",
    "shift",
    "source",
    "trap",
    "type",
    "ulimit",
    "umask",
    "unalias",
    "unset",
    "declare",
    "typeset",
    "local",
    "readonly",
    "let",
    "wait",
    "getopts",
    "shopt",
    "hash",
    "builtin",
    "enable",
    "mapfile",
    "readarray",
    "dirs",
    "disown",
    "kill",
    "times",
    "caller",
    "logout",
    "suspend",
    "bind",
    "fc",
    "history",
    "complete",
    "compgen",
    "compopt",
    "help",
    ":",
]);

/** Commands (by prefix) that should never be wrapped with `snip run --`. */
const NO_REWRITE_PREFIXES = [
    "git clone",
    "git submodule",
    "git worktree",
    "npm view",
    "npm info",
    "npm search",
    "yarn info",
    "yarn npm info",
    "yarn search",
    "pnpm view",
    "pnpm info",
    "pnpm search",
    "deno info",
    "deno doc",
    "bun pm view",
];

const SNIP_NO_FILTER_STDERR_PATTERN = '^snip: no filter for ".+", passing through -- you can run ".+" directly$';

/**
 * Wrap a Snip invocation so its optional "no filter" notice is removed without
 * relying on Bash process substitution. Agent subprocess sandboxes can reject the
 * resulting `/dev/fd/*` path even when the same shell supports the syntax.
 *
 * The subshell preserves the Snip invocation's exit status so `&&`, `||`, pipes,
 * and later command segments retain their original behavior.
 *
 * @param {string} command
 * @param {string | null} [failureLabel]
 * @returns {string}
 */
function withFilteredSnipStderr(command, failureLabel = null) {
    if (failureLabel) {
        const ignoredFailureLines = `^(Check .+|Checked [0-9]+ files?|running [0-9]+ tests? from .+|.+ \\.\\.\\. ok( \\(.+\\))?|ok \\| [0-9]+ passed \\| 0 failed.*|snip: tracking error:.*|snip: no filter for .*)$`;
        return (
            `( runwield_snip_stdout="$(mktemp -t runwield-snip-stdout.XXXXXX)" || exit 1; ` +
            `runwield_snip_stderr="$(mktemp -t runwield-snip-stderr.XXXXXX)" || exit 1; ` +
            `trap 'rm -f "$runwield_snip_stdout" "$runwield_snip_stderr"' EXIT; ` +
            `{ SNIP_TEE=0 ${command}; } >"$runwield_snip_stdout" 2>"$runwield_snip_stderr"; ` +
            `runwield_snip_status=$?; if [ "$runwield_snip_status" -eq 0 ]; then ` +
            `cat "$runwield_snip_stdout"; grep -vE '${SNIP_NO_FILTER_STDERR_PATTERN}' "$runwield_snip_stderr" >&2; ` +
            `else runwield_snip_log="$(mktemp -t runwield-${failureLabel.replaceAll(
                " ",
                "-",
            )}-failure.XXXXXX)" || exit 1; ` +
            `{ cat "$runwield_snip_stdout"; grep -vE '${SNIP_NO_FILTER_STDERR_PATTERN}' "$runwield_snip_stderr"; } | ` +
            `grep -vE '${ignoredFailureLines}' | ` +
            `sed -E 's/^FAILED \\| [0-9]+ passed \\| ([1-9][0-9]*) failed/FAILED | \\1 failed/' >"$runwield_snip_log"; ` +
            `if [ ! -s "$runwield_snip_log" ]; then printf '%s failed with exit code %s.\\n' '${failureLabel}' "$runwield_snip_status" >"$runwield_snip_log"; fi; ` +
            `printf '${failureLabel} failed, read the failure log here: %s\\n' "$runwield_snip_log" >&2; fi; ` +
            `exit "$runwield_snip_status" )`
        );
    }
    return (
        `( runwield_snip_stderr="$(mktemp -t runwield-snip-stderr.XXXXXX)" || exit 1; ` +
        `trap 'rm -f "$runwield_snip_stderr"' EXIT; ${command} 2>"$runwield_snip_stderr"; ` +
        `runwield_snip_status=$?; grep -vE '${SNIP_NO_FILTER_STDERR_PATTERN}' "$runwield_snip_stderr" >&2; ` +
        `exit "$runwield_snip_status" )`
    );
}

/**
 * @param {string[]} words
 * @returns {string | null}
 */
function getDenoValidationFailureLabel(words) {
    if (words.length < 2 || baseCommand(words[0]) !== "deno") return null;
    switch (words[1]) {
        case "test":
            return "tests";
        case "check":
            return "type checks";
        case "lint":
            return "lint";
        case "fmt":
            return "format checks";
        default:
            return null;
    }
}

/**
 * @param {string} word
 * @returns {string}
 */
function baseCommand(word) {
    const cleaned = word.replace(/^['"]|['"]$/g, "");
    return cleaned.split(/[\\/]/).pop() || cleaned;
}

const GIT_OPTIONS_WITH_VALUES = new Set([
    "-C",
    "-c",
    "--config-env",
    "--exec-path",
    "--git-dir",
    "--namespace",
    "--super-prefix",
    "--work-tree",
]);

/**
 * @param {string[]} words
 * @returns {boolean}
 */
function isGitDiffCommand(words) {
    if (words.length < 2 || baseCommand(words[0]) !== "git") return false;

    for (let index = 1; index < words.length; index++) {
        const word = words[index].replace(/^['"]|['"]$/g, "");
        if (word === "diff") return true;
        if (word === "--") return words[index + 1]?.replace(/^['"]|['"]$/g, "") === "diff";
        if (GIT_OPTIONS_WITH_VALUES.has(word)) {
            index++;
            continue;
        }
        if (word.startsWith("-")) continue;
        return false;
    }

    return false;
}

/**
 * @param {string} originalCommand
 * @returns {string | null}
 */
function rewriteCommand(originalCommand) {
    const parsed = parseLeadingSimpleCommand(originalCommand);
    if (!parsed) return null;
    if (parsed.commandName === "snip" || SHELL_BUILTINS.has(parsed.commandName)) return null;
    if (parsed.stderrRedirected) return null;
    if (isGitDiffCommand(parsed.words)) return null;
    if (NO_REWRITE_PREFIXES.some((prefix) => parsed.commandText.startsWith(prefix))) return null;

    const snipCommand = `${parsed.envPrefix}snip run -- ${parsed.commandText}`;
    return `${withFilteredSnipStderr(snipCommand, getDenoValidationFailureLabel(parsed.words))}${parsed.rest}`;
}

/**
 * Register Snip command prefixing for agent bash tool calls.
 *
 * @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi
 */
export default function snipExtension(pi) {
    pi.on("tool_call", (event, _ctx) => {
        if (event.toolName !== "bash") return;
        const input = event.input;
        if (!input || typeof input.command !== "string") return;

        const originalCommand = input.command;
        if (!originalCommand.trim()) return;

        try {
            const rewritten = rewriteCommand(originalCommand);
            if (!rewritten || rewritten === originalCommand) return;
            input.command = rewritten;
        } catch {
            // Snip is optional and fail-open. If rewriting fails, run the original command.
        }
    });
}

export const __testing = {
    getDenoValidationFailureLabel,
    rewriteCommand,
    withFilteredSnipStderr,
};
