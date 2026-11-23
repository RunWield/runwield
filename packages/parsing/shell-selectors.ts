export type BashAllowedCommands = readonly string[] | undefined;

interface Token {
    text: string;
    quoted: boolean;
}

function tokens(input: string): Token[] {
    const result: Token[] = [];
    let text = "";
    let quoted = false;
    let quote = "";
    let active = false;
    for (let i = 0; i < input.length; i++) {
        const char = input[i];
        if (quote) {
            if (char === quote) {
                quote = "";
                continue;
            }
            if (quote === '"' && (char === "$" || char === "`")) throw new Error("Shell expansion is not allowed");
            if (char === "\\" && quote === '"' && i + 1 < input.length) {
                const next = input[i + 1];
                if ('"\\$`'.includes(next)) {
                    text += next;
                    i++;
                    continue;
                }
            }
            text += char;
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
            quoted = true;
            active = true;
            continue;
        }
        if (char === "\\") {
            if (i + 1 >= input.length || input[i + 1] === "\n") throw new Error("Unsupported shell escape");
            text += input[++i];
            active = true;
            continue;
        }
        if (/\s/.test(char)) {
            if (char === "\n" || char === "\r") throw new Error("Only a single command is allowed");
            if (active) {
                result.push({ text, quoted });
                text = "";
                active = false;
                quoted = false;
            }
            continue;
        }
        if (";|&<>(){}$`".includes(char) || (char === "#" && !active)) {
            throw new Error("Only a single command without shell operators or expansion is allowed");
        }
        text += char;
        active = true;
    }
    if (quote) throw new Error("Unclosed shell quote");
    if (active) result.push({ text, quoted });
    return result;
}

export function commandWords(input: string): string[] {
    const parsed = tokens(input.trim());
    if (!parsed.length) throw new Error("Command is empty");
    if (
        parsed[0].quoted ||
        parsed[0].text.includes("/") ||
        ["env", "sudo", "command", "exec", "nohup", "nice", "time", "snip"].includes(parsed[0].text) ||
        /^[A-Za-z_][A-Za-z_0-9]*=/.test(parsed[0].text)
    ) {
        throw new Error("Executable paths, wrappers, and environment assignments are not allowed");
    }
    const words = parsed.map((token) => token.text);
    if (words[0] === "git") {
        let index = 1;
        while (words[index] === "--no-pager" || words[index] === "-C") {
            if (words[index] === "-C") {
                if (!words[index + 1] || words[index + 1].startsWith("-")) {
                    throw new Error("git -C requires a directory");
                }
                index += 2;
            } else index++;
        }
        if (words[index]?.startsWith("-")) throw new Error("Unsupported Git global option");
        return ["git", ...words.slice(index)];
    }
    return words;
}

export function normalizeBashAllowedCommands(
    value: readonly string[] | null | undefined,
    source: string,
): BashAllowedCommands {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value)) throw new Error(`${source}: bashAllowedCommands must be a list or null`);
    return value.map((selector) => {
        if (typeof selector !== "string" || !selector.trim()) {
            throw new Error(`${source}: bashAllowedCommands contains an empty or non-string selector`);
        }
        try {
            const words = commandWords(selector);
            if (words.join(" ") !== selector.trim() || words.some((word) => /[*?\[\]]/.test(word))) {
                throw new Error("Selectors must be literal command tokens");
            }
        } catch (error) {
            throw new Error(
                `${source}: bashAllowedCommands: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        return selector.trim();
    });
}
