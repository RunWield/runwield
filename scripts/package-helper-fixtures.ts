/** Install real external helper executables into a disposable package-check home. */
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execPath, platform } from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export async function installPackageHelperFixtures(bin: string, shellFixturePath: string): Promise<void> {
    await mkdir(bin, { recursive: true });
    if (platform === "win32") {
        const binary = join(bin, "mnemoteca.exe");
        const build = spawnSync(execPath, [
            "build",
            "--compile",
            "--no-compile-autoload-dotenv",
            "--no-compile-autoload-bunfig",
            join(ROOT, "src/testing/workflow-binary-fixture.ts"),
            "--outfile",
            binary,
        ], { encoding: "utf8", timeout: 60_000 });
        if (build.status !== 0) {
            throw new Error(`Native helper fixture compilation failed: ${build.stderr || build.error}`);
        }
        for (const name of ["cymbal", "ketch"]) await cp(binary, join(bin, `${name}.exe`));
        return;
    }
    const fixture = await readFile(shellFixturePath, "utf8");
    for (const name of ["mnemoteca", "cymbal", "ketch", "osascript"]) {
        await writeFile(join(bin, name), fixture, { mode: 0o755 });
    }
}
