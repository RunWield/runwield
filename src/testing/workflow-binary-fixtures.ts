import { copyFile, link, mkdir as fsMkdir, mkdtemp, readFile as fsReadFile, symlink } from "node:fs/promises";
import { rmSync } from "node:fs";
import process, { execPath, platform, versions } from "node:process";
import { tmpdir } from "node:os";
import { fileURLToPath as fromFileUrl } from "node:url";
import { join } from "node:path";
import { captureForegroundProcess } from "../shared/captured-process.ts";

// Only the executable contents are shared. Every fixture has its own command
// paths and logs; PATH still changes so production availability checks run.
const EXECUTABLE = fromFileUrl(new URL("./workflow-binary-fixture.sh", import.meta.url));
const BINARIES = ["mnemoteca", "cymbal", "ketch", "osascript"];

interface WorkflowBinaryFixtureOptions {
    githubUnavailable?: boolean;
}

/** Install only external boundaries used by the default workflow scenarios. */
export async function writeWorkflowBinaryFixtures(
    root: string,
    options: WorkflowBinaryFixtureOptions = {},
): Promise<string> {
    const binDir = join(root, "bin");
    await fsMkdir(binDir, { recursive: true });
    const names = options.githubUnavailable ? [...BINARIES, "gh"] : BINARIES;
    const native = platform === "win32" ? await nativeFixture() : null;
    await Promise.all(names.map(async (name) => {
        const path = join(binDir, native ? `${name}.exe` : name);
        if (native) {
            try {
                await link(native, path);
            } catch (error) {
                if (!(error instanceof Error && "code" in error && error.code === "EXDEV")) throw error;
                await copyFile(native, path);
            }
        } else {
            await symlink(EXECUTABLE, path);
        }
    }));
    return binDir;
}

let nativeCompilation: Promise<string> | undefined;
function nativeFixture(): Promise<string> {
    return nativeCompilation ??= (async () => {
        const root = await mkdtemp(join(tmpdir(), "workflow-native-fixture-"));
        const binary = join(root, "helper.exe");
        process.once("exit", () => rmSync(root, { recursive: true, force: true }));
        const source = fromFileUrl(new URL("./workflow-binary-fixture.ts", import.meta.url));
        const args = versions.bun
            ? ["build", "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", source, "--outfile", binary]
            : ["compile", "-A", "--no-check", "--output", binary, source];
        const result = await captureForegroundProcess(execPath, { args, cwd: root, timeoutMs: 60_000 });
        if (result.code !== 0) {
            throw new Error(`Native workflow fixture compilation failed: ${new TextDecoder().decode(result.stderr)}`);
        }
        return binary;
    })();
}

/** Fail even if an optional external-call error was caught by the application. */
export async function assertWorkflowBinaryCallsSupported(root: string): Promise<void> {
    let unexpected = "";
    try {
        unexpected = await fsReadFile(join(root, "bin", "unexpected.log"), "utf8");
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (unexpected) throw new Error(unexpected.trim());
}
