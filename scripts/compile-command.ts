/** Preserve the named development compile arguments while using the pinned Bun builder. */
import { compileBun, bunArtifactTarget } from "./compile-bun.ts";

interface CompileCommandOptions {
    output: string;
    target?: string;
    expectBuildId?: string;
}

const TARGETS = [
    "bun-darwin-arm64",
    "bun-darwin-x64",
    "bun-linux-arm64",
    "bun-linux-x64",
    "bun-windows-arm64",
    "bun-windows-x64",
];

export function parseCompileCommand(args: string[]): CompileCommandOptions {
    const options: CompileCommandOptions = { output: process.platform === "win32" ? "bin/wld.exe" : "bin/wld" };
    for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        if (argument === "--reload") {
            throw new Error(
                "compile --reload is Deno-specific and has no frozen-install equivalent. " +
                    "Run bun run install:locked before bun run compile; dependency refresh requires an explicit lockfile update.",
            );
        }
        const separator = argument.indexOf("=");
        const name = separator < 0 ? argument : argument.slice(0, separator);
        if (!["--output", "--target", "--expect-build-id"].includes(name)) {
            throw new Error(
                `Unknown compile option: ${name}. Dependencies must be installed with bun run install:locked.`,
            );
        }
        const value = separator < 0 ? args[++index] : argument.slice(separator + 1);
        if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
        if (name === "--output") options.output = value;
        else if (name === "--expect-build-id") options.expectBuildId = value;
        else {
            const target = TARGETS.find((candidate) => candidate === value || bunArtifactTarget(candidate) === value);
            if (!target) throw new Error(`Unsupported compile target: ${value}`);
            options.target = target;
        }
    }
    return options;
}

if (import.meta.main) {
    const options = parseCompileCommand(process.argv.slice(2));
    await compileBun(options.output, options.target, undefined, options.expectBuildId);
}
