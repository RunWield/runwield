import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DENO_CONFIG = fileURLToPath(new URL("../../deno.json", import.meta.url));
const BUN_CONFIG = fileURLToPath(new URL("../../tsconfig.json", import.meta.url));

/** Run the same fixture source with the active runtime, never silently dropping a permission boundary. */
export function runtimeSourceArgs(denoArgs: string[]): string[] {
    const [command, ...args] = denoArgs;
    if (command !== "run" && command !== "eval") throw new Error(`Unsupported fixture command: ${command}`);
    let offset = 0;
    while (offset < args.length && args[offset].startsWith("-") && args[offset] !== "-") {
        const flag = args[offset++];
        if (["-A", "--quiet", "--no-check", "--unstable-no-legacy-abort", "--node-modules-dir=manual"].includes(flag)) {
            continue;
        }
        if (flag === "--config") {
            const config = args[offset++];
            if (!config || resolve(config) !== DENO_CONFIG) {
                throw new Error("Custom fixture aliases require an explicit Bun configuration");
            }
            continue;
        }
        throw new Error(`Unsupported fixture runtime flag: ${flag}`);
    }
    return command === "eval"
        ? [
              "--no-install",
              "--tsconfig-override",
              BUN_CONFIG,
              "--eval",
              args[offset],
              "[eval]",
              ...args.slice(offset + 1),
          ]
        : ["run", "--no-install", "--tsconfig-override", BUN_CONFIG, ...args.slice(offset)];
}
