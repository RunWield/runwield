/** @module cmd/workspace/pair */

import { CLI_BIN } from "../../constants.ts";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.ts";
import { normalizePairingCode } from "../../shared/owner-coordination/crypto.ts";
import { stripTerminalControlCharacters } from "../../shared/owner-coordination/pairing.ts";

export function printWorkspacePairHelp(): void {
    console.log(`Usage: ${CLI_BIN} workspace pair <code>`);
    console.log("Approves a pending browser-initiated owner Workspace pairing request on this machine.");
}

export function runWorkspacePairCommand(argv: string[]): void {
    if (argv.includes("--help") || argv.includes("-h")) {
        printWorkspacePairHelp();
        return;
    }
    const code = normalizePairingCode(argv[0] || "");
    if (!code) {
        console.error("[RunWield] Pairing code is required.");
        console.error(`Run '${CLI_BIN} workspace pair --help' for usage.`);
        return;
    }

    const store = openOwnerCoordinationStore();
    try {
        const approved = store.approvePairingRequest(code);
        const safeDeviceLabel = stripTerminalControlCharacters(approved.deviceLabel);
        console.log(`[RunWield] Approved Workspace pairing request for ${safeDeviceLabel}.`);
        console.log(`[RunWield] The browser can now finish pairing before ${approved.expiresAt}.`);
    } catch (error) {
        console.error(`[RunWield] ${error instanceof Error ? error.message : String(error)}`);
    } finally {
        store.close();
    }
}
