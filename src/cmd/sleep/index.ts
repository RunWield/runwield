/**
 * @module cmd/sleep
 * Sleep command: back up and conservatively optimize project memory.
 */

import { parseArgs } from "@std/cli/parse-args";
import { basename, dirname, join, resolve } from "@std/path";
import { AGENTS, SLEEP_PROMPT_PATH } from "../../constants.js";
import { ensureMnemotecaBinary } from "../../shared/runtime-preflight.ts";
import { printCommandHelp } from "../help/index.ts";
import { COMMAND_NAMES } from "../registry.js";
import type { SessionRuntime } from "../../shared/session/session-runtime.ts";

interface MnemotecaCommandResult {
    success: boolean;
    code: number;
    stdout: Uint8Array;
    stderr: Uint8Array;
}

export interface MnemotecaPort {
    ensureAvailable(): Promise<void>;
    run(args: string[]): Promise<MnemotecaCommandResult>;
}

export interface InteractiveSessionPort {
    startInteractiveSession(
        initialRequest: string | null,
        options: { initialAgentName?: string },
    ): Promise<import("../../ui/tui/types.js").UiAPI | void>;
}

export interface SleepCommandOptions {
    uiAPI?: Pick<import("../../ui/tui/types.js").UiAPI, "appendSystemMessage">;
    sessionId?: string;
    sessionRuntime?: SessionRuntime;
    mnemotecaPort: MnemotecaPort;
    sessionPort: InteractiveSessionPort;
}

export const SYSTEM_SLEEP_MNEMOTECA_PORT: MnemotecaPort = {
    ensureAvailable: ensureMnemotecaBinary,
    run: (args) =>
        new Deno.Command("mnemoteca", {
            args,
            stdout: "piped",
            stderr: "piped",
        }).output(),
};

/**
 * Export one Mnemoteca collection to an explicit recovery path and verify the file exists.
 */
export async function exportMnemotecaCollection(
    collectionName: string,
    outputPath: string,
    port: Pick<MnemotecaPort, "run">,
): Promise<void> {
    await Deno.mkdir(dirname(outputPath), { recursive: true });
    const result = await port.run([
        "export",
        "--name",
        collectionName,
        "--no-embeddings",
        "--output",
        outputPath,
    ]);
    if (!result.success) {
        const stderr = new TextDecoder().decode(result.stderr).trim();
        throw new Error(stderr || `mnemoteca export failed with exit code ${result.code}`);
    }

    let outputInfo;
    try {
        outputInfo = await Deno.stat(outputPath);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Mnemoteca reported success but did not create the backup: ${message}`);
    }
    if (!outputInfo.isFile) {
        throw new Error(`Mnemoteca backup output is not a file: ${outputPath}`);
    }
}

/**
 * Handle `sleep` command.
 */
export async function runSleepCommand(argv: string[], options: SleepCommandOptions): Promise<void> {
    const parsed = parseArgs(argv, {
        boolean: ["help"],
        alias: { h: "help" },
        stopEarly: true,
    });

    if (parsed.help) {
        printCommandHelp(COMMAND_NAMES.SLEEP);
        return;
    }

    if (!options.uiAPI) {
        await options.sessionPort.startInteractiveSession("/sleep", {
            initialAgentName: AGENTS.ENGINEER,
        });
        return;
    }

    const sessionRuntime = options.sessionRuntime;
    const runtimeSessionId = options.sessionId;
    if (!sessionRuntime || !runtimeSessionId) {
        throw new Error("Sleep mode requires an active runtime session.");
    }
    let snapshot = sessionRuntime.getSessionSnapshot(runtimeSessionId);
    if (!snapshot) throw new Error("Sleep mode requires an active runtime session.");
    if (!snapshot.sessionManagerId) {
        snapshot = await sessionRuntime.materializePromptReadySession(runtimeSessionId);
    }

    const sleepPrompt = await Deno.readTextFile(SLEEP_PROMPT_PATH);
    const mnemoteca = options.mnemotecaPort;
    await mnemoteca.ensureAvailable();

    const cwd = snapshot.cwd;
    const rawCollectionName = basename(cwd) || "default";
    const collectionName = rawCollectionName === "global" ? "default" : rawCollectionName;
    const artifactDir = resolve(sessionRuntime.getSessionMemoryBackupDir(runtimeSessionId));
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = join(
        artifactDir,
        `${collectionName}.sleep-backup-${timestamp}-${crypto.randomUUID()}.jsonl`,
    );

    await exportMnemotecaCollection(collectionName, backupPath, mnemoteca);
    options.uiAPI.appendSystemMessage(`[RunWield] Memory backup created before sleep mode: ${backupPath}`);

    await sessionRuntime.switchAgent(runtimeSessionId, { agentName: AGENTS.ENGINEER });

    const runContext = [
        sleepPrompt,
        "",
        "## Run-specific artifact context",
        "",
        `- Immutable pre-maintenance backup: ${backupPath}`,
        `- Session artifact directory: ${artifactDir}`,
        "- Do not modify or overwrite the pre-maintenance backup.",
        "- Keep the deletion manifest, post-maintenance export, and reports in the session artifact directory.",
    ].join("\n");

    await sessionRuntime.promptSession(runtimeSessionId, {
        initialRequest: runContext,
    });
}
