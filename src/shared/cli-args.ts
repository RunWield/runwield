import parser from "yargs-parser";

export interface CliArgumentOptions {
    boolean?: string[];
    string?: string[];
    alias?: Record<string, string | string[]>;
    stopEarly?: boolean;
}

/** Preserve RunWield's literal flag names, last-value wins and command-tail handling. */
export function parseArgs(args: string[], options: CliArgumentOptions = {}) {
    return parser(args, {
        boolean: options.boolean,
        string: options.string,
        alias: options.alias,
        default: Object.fromEntries((options.boolean ?? []).map((name) => [name, false])),
        configuration: {
            "boolean-negation": false,
            "camel-case-expansion": false,
            "duplicate-arguments-array": false,
            "halt-at-non-option": options.stopEarly ?? false,
        },
    });
}
