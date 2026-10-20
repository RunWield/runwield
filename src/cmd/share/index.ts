import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { renderSessionExportHtml } from "../../ui/session-export/session-export-html.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getCwd } from "../../constants.js";
import { captureForegroundProcess } from "../../shared/captured-process.ts";
import { rm as fsRm } from "node:fs/promises";
/**
 * @module cmd/share
 * Share the complete Session as HTML and JSON in one secret GitHub Gist.
 */

import { theme } from "../../ui/theme/theme.js";
import type { SessionRuntime } from "../../shared/session/session-runtime.ts";

interface CommandResult {
    success: boolean;
    stdout: string;
    stderr: string;
}

export interface GitHubCliPort {
    run(args: string[]): Promise<CommandResult>;
}

export interface ShareCommandOptions {
    uiAPI?: Pick<import("../../ui/tui/types.js").UiAPI, "appendSystemMessage">;
    sessionRuntime?: SessionRuntime;
    sessionId?: string;
    githubCli: GitHubCliPort;
}

/**
 * Run a command and return success + stdout.
 */
async function runGitHubCli(args: string[]): Promise<CommandResult> {
    const command = captureForegroundProcess("gh", { args, cwd: getCwd() });
    const { success, stdout, stderr } = await command;
    return {
        success,
        stdout: new TextDecoder().decode(stdout),
        stderr: new TextDecoder().decode(stderr),
    };
}

export const SYSTEM_GITHUB_CLI_PORT: GitHubCliPort = { run: runGitHubCli };

/**
 * Run the share command.
 */
export async function runShareCommand(_argv: string[], options: ShareCommandOptions): Promise<void | "failed"> {
    const { uiAPI, sessionRuntime, sessionId: runtimeSessionId } = options;

    if (!uiAPI) {
        throw new Error("UI API is required for the share command.");
    }

    if (!sessionRuntime || !runtimeSessionId) {
        uiAPI.appendSystemMessage("Error: No active session found.", true);
        return "failed";
    }

    let tempDirectory = "";
    try {
        if (!sessionRuntime.getSessionProjectRoot(runtimeSessionId)) {
            uiAPI.appendSystemMessage("Error: No active session found.", true);
            return "failed";
        }
        // 1. Check if gh is installed
        const githubCli = options.githubCli;
        const ghVersion = await githubCli.run(["--version"]);
        if (!ghVersion.success) {
            uiAPI.appendSystemMessage("Error: GitHub CLI ('gh') is not installed. Please install it first.", true);
            return "failed";
        }

        // 2. Check if gh is authenticated
        const ghAuth = await githubCli.run(["auth", "status"]);
        if (!ghAuth.success) {
            uiAPI.appendSystemMessage("Error: GitHub CLI is not authenticated. Please run 'gh auth login'.", true);
            return "failed";
        }

        const exported = await sessionRuntime.readSessionExport(runtimeSessionId);
        tempDirectory = await mkdtemp(join(tmpdir(), "runwield-session-"));
        await chmod(tempDirectory, 0o700);
        const htmlPath = join(tempDirectory, "runwield-session.html");
        const jsonPath = join(tempDirectory, "runwield-session.json");
        await writeFile(htmlPath, renderSessionExportHtml(exported), { mode: 0o600 });
        await writeFile(jsonPath, JSON.stringify(exported.document, null, 2), { mode: 0o600 });

        const ghGist = await githubCli.run([
            "gist",
            "create",
            "--public=false",
            "--desc",
            `${exported.document.session.name || "RunWield Session"} — RunWield Session`,
            htmlPath,
            jsonPath,
        ]);
        if (!ghGist.success) {
            throw new Error(`gh gist create failed: ${ghGist.stderr}`);
        }
        const url = ghGist.stdout.trim();

        if (!/^https:\/\/gist\.github\.com\/(?:[^/\s]+\/)?[^/\s?#]+$/.test(url)) {
            throw new Error("Failed to get Gist URL from gh output.");
        }
        const gistId = new URL(url).pathname.split("/").at(-1);
        const previewUrl = `https://gistpreview.github.io/?${gistId}/runwield-session.html`;
        uiAPI.appendSystemMessage(`${theme.fg("success", "Session shared successfully!")}\n${url}\n${previewUrl}`);
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        uiAPI.appendSystemMessage(`Unexpected error while sharing session: ${msg}`, true);
        return "failed";
    } finally {
        if (tempDirectory) await fsRm(tempDirectory, { recursive: true, force: true });
    }
}
