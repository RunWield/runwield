/**
 * @module cmd/export
 * Export the complete Session to HTML (default) or JSON.
 */

import { dirname, isAbsolute, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { renderSessionExportHtml } from "../../ui/session-export/session-export-html.ts";
import type { CommandContext } from "../registry.js";

type ExportCommandOptions = Pick<CommandContext, "sessionRuntime" | "sessionId" | "sessionStartedAt"> & {
    uiAPI?: Pick<NonNullable<CommandContext["uiAPI"]>, "appendSystemMessage">;
    editor?: Pick<NonNullable<CommandContext["editor"]>, "setText" | "disableSubmit">;
};

function sanitizeFilenameSegment(value: string): string {
    return value.replace(/[\\/:*?"<>|]/g, "-");
}

function buildDefaultExportPath(projectRoot: string, sessionStartIso: string): string {
    const safeIso = sanitizeFilenameSegment(sessionStartIso).replace(/\.\d{3}Z$/, "");
    return join(projectRoot, `session-${safeIso}.html`);
}

/**
 * Handle `/export` command (slash-only).
 */
export async function runExportCommand(argv: string[], options: ExportCommandOptions = {}): Promise<void | "failed"> {
    const { uiAPI, editor, sessionRuntime, sessionId, sessionStartedAt } = options;
    if (!uiAPI || !sessionRuntime || !sessionId) {
        return "failed";
    }

    uiAPI.appendSystemMessage("");

    const requestedPath = argv.join(" ").trim();
    try {
        if (requestedPath.toLowerCase().endsWith(".jsonl")) {
            throw new Error("JSONL export is retired. Use a .json path to export the complete Session.");
        }
        const exported = await sessionRuntime.readSessionExport(sessionId);
        const projectRoot = exported.document.session.cwd;
        const outputPath = requestedPath
            ? isAbsolute(requestedPath)
                ? requestedPath
                : join(projectRoot, requestedPath)
            : buildDefaultExportPath(projectRoot, sessionStartedAt || new Date().toISOString());
        const content = outputPath.toLowerCase().endsWith(".json")
            ? JSON.stringify(exported.document, null, 2)
            : renderSessionExportHtml(exported);
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, content, { mode: 0o600 });
        uiAPI.appendSystemMessage(`Session exported to: ${outputPath}`);
    } catch (error) {
        uiAPI.appendSystemMessage(
            `Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`,
            true,
        );
        return "failed";
    } finally {
        if (editor) {
            editor.setText("");
            editor.disableSubmit = false;
        }
    }
}
