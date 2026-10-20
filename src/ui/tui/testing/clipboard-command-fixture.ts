import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

export interface ClipboardInvocation {
    command: string;
    operation: string;
    tempPath: string;
}

/** Fake only the clipboard/encoder subprocess boundary, with an auditable invocation log. */
export async function installFakeClipboardCommands(projectRoot: string) {
    const previousPath = process.env["PATH"];
    const binDir = join(projectRoot, "clipboard-bin");
    const logPath = join(binDir, "calls");
    const imageStatePath = join(binDir, "has-image");
    const imageReadMarkerPath = join(binDir, "image-read");
    await mkdir(binDir, { recursive: true });
    await writeFile(logPath, "");
    await writeFile(imageStatePath, "image");
    // Single-quote paths for shell literals, including temporary roots with spaces or apostrophes.
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const scripts = {
        osascript: [
            "#!/bin/sh",
            'script="$2"',
            "if printf '%s' \"$script\" | grep -q 'return \"image\"'; then",
            `  printf 'osascript\\tprobe\\t\\n' >> ${quote(logPath)}`,
            `  cat ${quote(imageStatePath)}`,
            "  exit 0",
            "fi",
            "temp_file=$(printf '%s' \"$script\" | sed -n 's/^[[:space:]]*set tempFile to \"\\(.*\\)\"$/\\1/p')",
            `printf 'osascript\\textract\\t%s\\n' "$temp_file" >> ${quote(logPath)}`,
            'printf fixture-png > "$temp_file"',
        ],
        base64: [
            "#!/bin/sh",
            `printf 'base64\\tencode\\t%s\\n' "$2" >> ${quote(logPath)}`,
            "echo iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            `touch ${quote(imageReadMarkerPath)}`,
            // The marker precedes process completion so tests can submit during the read.
            "sleep 0.2",
        ],
    };
    for (const [name, lines] of Object.entries(scripts)) {
        const path = join(binDir, name);
        await writeFile(path, lines.join("\n") + "\n");
        await chmod(path, 0o755);
    }
    process.env["PATH"] = `${binDir}${delimiter}${previousPath || ""}`;
    return {
        imageReadMarkerPath,
        async invocations(): Promise<ClipboardInvocation[]> {
            const log = await readFile(logPath, "utf8");
            return log
                .split("\n")
                .filter(Boolean)
                .map((line) => {
                    const [command = "", operation = "", tempPath = ""] = line.split("\t");
                    return { command, operation, tempPath };
                });
        },
        setHasImage: (hasImage: boolean) => writeFile(imageStatePath, hasImage ? "image" : "none"),
        restore() {
            if (previousPath === undefined) delete process.env["PATH"];
            else process.env["PATH"] = previousPath;
        },
    };
}
