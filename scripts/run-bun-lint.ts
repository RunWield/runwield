import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { listCiFiles } from "./ci-files.ts";
import { lintSource } from "./bun-lint.ts";
import { requirePinnedBun } from "./check-bun-runtime.ts";
import { checkOwnedRuntime } from "./check-owned-runtime.ts";

requirePinnedBun();
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const files = (await listCiFiles(root)).filter(
    (file) => /\.(?:jsx?|tsx?|mjs|mts)$/.test(file) && !file.split("/").includes(".astro"),
);
const runtimeDiagnostics = await checkOwnedRuntime(root);
for (const diagnostic of runtimeDiagnostics)
    console.error(`${diagnostic.file}:${diagnostic.line}: ${diagnostic.message}`);
let failures = runtimeDiagnostics.length;
for (const file of files) {
    const messages = lintSource(await readFile(join(root, file), "utf8"), file);
    for (const message of messages) {
        console.error(`${file}:${message.line}:${message.column}: ${message.ruleId ?? "parser"}: ${message.message}`);
        failures += 1;
    }
}
console.log(`Checked ${files.length} files; ${failures} lint diagnostics.`);
process.exitCode = failures ? 1 : 0;
