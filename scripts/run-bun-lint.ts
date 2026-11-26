import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { listCiFiles } from "./ci-files.ts";
import { lintSource } from "./bun-lint.ts";
import { requireSupportedBun } from "./check-bun-runtime.ts";
import { checkOwnedRuntime } from "./check-owned-runtime.ts";
import { createPackageBoundaryLint, PACKAGE_SOURCE_PATTERN } from "./check-package-boundaries.ts";

requireSupportedBun();
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ciFiles = await listCiFiles(root);
const files = ciFiles.filter((file) => PACKAGE_SOURCE_PATTERN.test(file) && !file.split("/").includes(".astro"));
const [runtimeDiagnostics, packageBoundaries] = await Promise.all([
    checkOwnedRuntime(root),
    createPackageBoundaryLint(root, ciFiles),
]);
for (const diagnostic of runtimeDiagnostics)
    console.error(`${diagnostic.file}:${diagnostic.line}: ${diagnostic.message}`);
let failures = runtimeDiagnostics.length;
for (const file of files) {
    const source = await readFile(join(root, file), "utf8");
    for (const diagnostic of packageBoundaries.lint(source, file)) {
        console.error(`${file}:${diagnostic.line}: ${diagnostic.message}`);
        failures += 1;
    }
    if (/\.(?:astro|html)$/.test(file)) continue;
    const messages = lintSource(source, file);
    for (const message of messages) {
        console.error(`${file}:${message.line}:${message.column}: ${message.ruleId ?? "parser"}: ${message.message}`);
        failures += 1;
    }
}
for (const diagnostic of packageBoundaries.checkIndependence()) {
    console.error(`${diagnostic.file}:${diagnostic.line}: ${diagnostic.message}`);
    failures += 1;
}
console.log(`Checked ${files.length} files; ${failures} lint diagnostics.`);
process.exitCode = failures ? 1 : 0;
