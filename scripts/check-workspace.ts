import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import process from "node:process";
import { requirePinnedBun } from "./check-bun-runtime.ts";
import { captureScriptProcess } from "./script-process.ts";

requirePinnedBun();
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const { values } = parseArgs({
    args,
    options: { root: { type: "string", default: resolve(repositoryRoot, "src/ui/workspace") } },
    strict: false,
    allowPositionals: true,
});
const workspaceRoot = resolve(String(values.root));
const require = createRequire(import.meta.url);
const forwardedArgs: string[] = [];
for (let index = 0; index < args.length; index++) {
    if (args[index] === "--root") index++;
    else if (!args[index].startsWith("--root=")) forwardedArgs.push(args[index]);
}
const configArgs = args.some((arg) => arg === "--tsconfig" || arg.startsWith("--tsconfig="))
    ? []
    : ["--tsconfig", "tsconfig.json"];

try {
    // Astro's optional-package loader swallows import failures and can exit 0
    // without checking anything. Verify the same packages before invoking it.
    // Bun also requires absolute lookup paths for createRequire.resolve.
    for (const name of ["@astrojs/check", "typescript"]) {
        await import(pathToFileURL(require.resolve(name, { paths: [workspaceRoot] })).href);
    }
    const result = await captureScriptProcess(process.execPath, {
        args: [
            resolve(repositoryRoot, "node_modules/astro/bin/astro.mjs"),
            "check",
            ...configArgs,
            ...forwardedArgs,
            "--root",
            workspaceRoot,
        ],
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
    });
    process.exitCode = result.code;
} catch (error) {
    console.error("Workspace checking could not run. Run `bun run install:locked` and retry.");
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
