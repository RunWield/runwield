/** @module cmd/workspace */

import { CLI_BIN } from "../../constants.ts";
import { runWorkspacePairCommand } from "./pair.ts";
import { runWorkspaceServeCommand } from "./serve.ts";

export function printWorkspaceHelp(): void {
    console.log(`Usage: ${CLI_BIN} workspace <command>`);
    console.log("");
    console.log("Commands:");
    console.log("  serve           Start the persistent owner Workspace");
    console.log("  pair <code>     Approve a browser pairing request");
}

export async function runWorkspaceCommand(argv: string[]): Promise<void> {
    const command = argv[0];
    if (!command || command === "--help" || command === "-h") {
        printWorkspaceHelp();
        return;
    }
    if (command === "serve") {
        await runWorkspaceServeCommand(argv.slice(1));
        return;
    }
    if (command === "pair") {
        runWorkspacePairCommand(argv.slice(1));
        return;
    }
    console.error(`[RunWield] Unknown workspace command: ${command}`);
    console.error(`Run '${CLI_BIN} workspace --help' for usage.`);
}
