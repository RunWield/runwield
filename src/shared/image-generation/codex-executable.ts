import process from "node:process";
import { stat as fsStat } from "node:fs/promises";
import { delimiter as DELIMITER, join, resolve } from "node:path";
import { getCwd, getHomeDir } from "../../constants.js";

async function isExecutableFile(path: string): Promise<boolean> {
    try {
        const info = await fsStat(path);
        return info.isFile() && (process.platform === "win32" || (info.mode !== null && (info.mode & 0o111) !== 0));
    } catch (error) {
        if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
            return false;
        }
        // Permission failures are not absence: report them rather than bypassing them with another installation.
        throw error;
    }
}

/** Resolve without starting Codex, changing PATH, or reading its credentials. */
export async function resolveCodexExecutable(): Promise<string> {
    const filenames = process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex.bat", "codex"] : ["codex"];
    const path = process.env["PATH"];
    for (const directory of path === undefined ? [] : path.split(DELIMITER)) {
        for (const filename of filenames) {
            const candidate = resolve(getCwd(), directory, filename);
            if (await isExecutableFile(candidate)) return candidate;
        }
    }
    const bundledPaths = process.platform === "darwin"
        ? [join(getHomeDir(), "Applications"), "/Applications"].map((directory) =>
            join(
                directory,
                "ChatGPT.app",
                "Contents",
                "Resources",
                "codex-cli",
                "CodexCLI.app",
                "Contents",
                "MacOS",
                "codex",
            )
        )
        : [];
    for (const candidate of bundledPaths) {
        if (await isExecutableFile(candidate)) return candidate;
    }
    throw new Error(
        `Codex executable not found: checked PATH${
            bundledPaths.length ? " and ChatGPT.app in ~/Applications and /Applications" : ""
        }. Install the Codex CLI on PATH${
            bundledPaths.length ? " or the ChatGPT desktop app in one of those locations" : ""
        }. No image generation was started.`,
    );
}
