/** Executable external-boundary fixtures, including native Windows launchers. */
import { chmod, copyFile, link, mkdtemp, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process, { execPath, platform, versions } from "node:process";
import { captureForegroundProcess } from "../shared/captured-process.ts";
import { runtimeSourceArgs } from "./runtime-source-args.ts";

const compiled = new Map<string, Promise<string>>();

/** Windows may briefly retain an exited executable; Bun does not honor fs.rm retry options. */
export async function removeExecutableFixtureDirectory(path: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
        try {
            await rm(path, { recursive: true });
            return;
        } catch (error) {
            if (
                platform !== "win32" ||
                attempt >= 10 ||
                !(error instanceof Error) ||
                !("code" in error) ||
                !["EBUSY", "EPERM", "ENOTEMPTY"].includes(String(error.code))
            )
                throw error;
            await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        }
    }
}

async function compileFixture(source: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "native-fixture-"));
    process.once("exit", () => rmSync(root, { recursive: true, force: true }));
    const executable = join(root, "fixture.exe");
    const args = versions.bun
        ? [
              "build",
              "--compile",
              "--no-compile-autoload-dotenv",
              "--no-compile-autoload-bunfig",
              source,
              "--outfile",
              executable,
          ]
        : ["compile", "-A", "--no-check", "--output", executable, source];
    const result = await captureForegroundProcess(execPath, { args, cwd: dirname(source), timeoutMs: 60_000 });
    if (!result.success) throw new Error(`Fixture compilation failed: ${new TextDecoder().decode(result.stderr)}`);
    return executable;
}

/** Source fixtures are immutable for the lifetime of an isolated test file. */
export async function writeRuntimeExecutableFixture(path: string, source: string): Promise<string> {
    if (platform === "win32") {
        const executable = path.endsWith(".exe") ? path : `${path}.exe`;
        if (!compiled.has(source)) compiled.set(source, compileFixture(source));
        const binary = await compiled.get(source)!;
        try {
            await link(binary, executable);
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "EXDEV")) throw error;
            await copyFile(binary, executable);
        }
        return executable;
    }
    const command = [execPath, ...runtimeSourceArgs(["run", "-A", source])]
        .map((value) => `'${value.replaceAll("'", "'\"'\"'")}'`)
        .join(" ");
    await writeFile(path, `#!/bin/sh\nexec ${command} "$@"\n`);
    await chmod(path, 0o755);
    return path;
}
