/** Recognize a literal leading simple command without parsing or re-emitting the rest of the shell program. */
interface Token {
    text: string;
    value: string;
    start: number;
    redirection: boolean;
}

export interface LeadingSimpleCommand {
    envPrefix: string;
    commandText: string;
    commandName: string;
    words: string[];
    stderrRedirected: boolean;
    stdoutRedirected: boolean;
    rest: string;
}

const RESERVED_WORDS = new Set([
    "!",
    "{",
    "}",
    "[[",
    "]]",
    "case",
    "coproc",
    "do",
    "done",
    "elif",
    "else",
    "esac",
    "fi",
    "for",
    "function",
    "if",
    "in",
    "select",
    "then",
    "time",
    "until",
    "while",
]);

/**
 * Accept only words, assignments, and ordinary redirections before a list/pipeline boundary.
 * Expansion, compound syntax, comments, continuations, and heredocs pass through unchanged.
 * Token offsets retain the original quoting and spacing; decoded words are only for policy checks.
 */
export function parseLeadingSimpleCommand(command: string): LeadingSimpleCommand | null {
    const tokens: Token[] = [];
    let start = -1;
    let value = "";
    let quote = "";
    let end = command.length;
    let stderrRedirected = false;
    let stdoutRedirected = false;
    const finishWord = (offset: number) => {
        if (start >= 0) tokens.push({ text: command.slice(start, offset), value, start, redirection: false });
        start = -1;
        value = "";
    };

    for (let i = 0; i < command.length; i++) {
        const char = command[i];
        if (quote === "'") {
            if (char === quote) quote = "";
            else value += char;
            continue;
        }
        if (char === "\\") {
            const next = command[i + 1];
            if (!next || next === "\n" || next === "\r") return null;
            if (start < 0) start = i;
            if (!quote || '\\"$`'.includes(next)) {
                value += next;
                i++;
            } else value += char;
            continue;
        }
        // Even parameter expansion can change shell state (${x:=...}) or depend on
        // the wrapper's status/subshell ($?, $!). Leave live expansion to the caller's shell.
        if (char === "$" || char === "`") return null;
        if (quote === '"') {
            if (char === quote) quote = "";
            else value += char;
            continue;
        }
        if (char === "'" || char === '"') {
            if (start < 0) start = i;
            quote = char;
            continue;
        }
        if ("(){}".includes(char) || (char === "#" && start < 0)) return null;
        if (char === "\n" || char === ";" || char === "|" || (char === "&" && command[i + 1] === "&")) {
            if (char === ";" && (command[i + 1] === ";" || command[i + 1] === "&")) return null;
            if (char === "|" && command[i + 1] === "&") stderrRedirected = true;
            finishWord(i);
            end = i;
            break;
        }
        if (char === "<" || char === ">" || (char === "&" && command[i + 1] === ">")) {
            let descriptor = "";
            let operatorStart = i;
            if (start >= 0 && /^\d+$/.test(command.slice(start, i))) {
                descriptor = value;
                operatorStart = start;
                start = -1;
                value = "";
            } else finishWord(i);
            const operator = command.slice(i).match(/^(<<<|<<|<>|<&|>>|>\||>&|&>>|&>|<|>)/)?.[0];
            if (!operator || operator === "<<") return null;
            tokens.push({
                text: descriptor + operator,
                value: descriptor + operator,
                start: operatorStart,
                redirection: true,
            });
            i += operator.length - 1;
            continue;
        }
        if (char === "&") return null;
        if (char === " " || char === "\t") {
            finishWord(i);
            continue;
        }
        if (start < 0) start = i;
        value += char;
    }
    if (quote) return null;
    finishWord(end);

    const words: Token[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (!token.redirection) {
            words.push(token);
            continue;
        }
        // Leading redirections and missing targets are outside the accepted grammar.
        if (!words.length) return null;
        const target = tokens[++i];
        if (!target || target.redirection) return null;
        const operator = token.value.replace(/^\d+/, "");
        const descriptor = token.value.match(/^\d+/)?.[0] ?? (operator.startsWith("<") ? "0" : "1");
        if (Number(descriptor) === 2 || operator.startsWith("&>")) stderrRedirected = true;
        if (Number(descriptor) === 1 && !operator.startsWith("<")) stdoutRedirected = true;
        if (
            (operator === ">&" && !/^(\d+|-)$/.test(target.value)) ||
            (operator.endsWith("&") && /^0*2-$/.test(target.value))
        )
            stderrRedirected = true;
    }
    let index = 0;
    while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index].text)) index++;
    const executable = words[index];
    if (!executable || RESERVED_WORDS.has(executable.value)) return null;
    // Do not turn a glob, dynamic command name, or assignment into an executable argument.
    if (!/^[A-Za-z0-9_./:+-]+$/.test(executable.value) && executable.value !== "[") return null;
    const commandName = executable.value.split(/[\\/]/).pop() || executable.value;
    return {
        envPrefix: command.slice(0, executable.start),
        commandText: command.slice(
            executable.start,
            tokens[tokens.length - 1].start + tokens[tokens.length - 1].text.length,
        ),
        commandName,
        words: words.slice(index).map((word) => word.value),
        stderrRedirected,
        stdoutRedirected,
        rest: command.slice(end),
    };
}
