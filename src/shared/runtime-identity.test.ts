import { equal } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath, platform } from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isStandaloneExecutable } from "./runtime-identity.ts";

test("runtime identity distinguishes source from a real relocated compiled executable", () => {
    equal(isStandaloneExecutable(), false);
    const directory = mkdtempSync(join(tmpdir(), "runtime identity λ-"));
    try {
        const source = join(directory, "identity.ts");
        const binary = join(directory, platform === "win32" ? "identity.exe" : "identity");
        writeFileSync(
            source,
            `import { isStandaloneExecutable } from ${JSON.stringify(
                fileURLToPath(new URL("./runtime-identity.ts", import.meta.url)).replaceAll("\\", "/"),
            )}; console.log(isStandaloneExecutable());`,
        );
        const compile = spawnSync(execPath, ["build", "--compile", source, "--outfile", binary], {
            encoding: "utf8",
            timeout: 90_000,
        });
        equal(compile.status, 0, compile.stderr || String(compile.error));
        const result = spawnSync(binary, [], { cwd: directory, encoding: "utf8", timeout: 10_000 });
        equal(result.status, 0, result.stderr || String(result.error));
        equal(result.stdout.trim(), "true");
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
