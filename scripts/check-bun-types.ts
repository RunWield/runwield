import ts from "typescript";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { requirePinnedBun } from "./check-bun-runtime.ts";
import { walkSourceFiles } from "./source-files.ts";

requirePinnedBun();
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const configPath = resolve(root, "tsconfig.bun.json");
const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
const config = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root);
// Native host and renderer use desktop:check without Bun ambient types. Tests retain the isolated Bun gate.
const desktop = resolve(root, "src/ui/desktop") + sep;
const rootNames = [
    ...new Set([...config.fileNames, ...(await walkSourceFiles()).map((file) => resolve(root, file))]),
].filter((file) => !file.startsWith(desktop) || file.endsWith(".test.ts") || file.includes(`${sep}testing${sep}`));
const program = ts.createProgram({ rootNames, options: config.options });
const diagnostics = [...(loaded.error ? [loaded.error] : []), ...config.errors, ...ts.getPreEmitDiagnostics(program)];
if (diagnostics.length) {
    console.error(
        ts.formatDiagnosticsWithColorAndContext(diagnostics, {
            getCanonicalFileName: (file) => file,
            getCurrentDirectory: () => root,
            getNewLine: () => "\n",
        }),
    );
} else console.log(`Type-checked ${rootNames.length} first-party source and test entries.`);
process.exitCode = diagnostics.length ? 1 : 0;
