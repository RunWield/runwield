import { readableStdin } from "../../shared/stdin-stream.ts";
import { Writable } from "node:stream";
import process from "node:process";
/**
 * @module cmd/acp
 * ACP stdio command entrypoint.
 */

import { startRunWieldAcpServer } from "../../acp/server.js";

function writeDiagnostic(message: string): void {
    console.error(`[RunWield ACP] ${message}`);
}

/**
 * Run the ACP stdio adapter. stdout is reserved for ACP protocol frames only.
 */
export async function runAcpCommand(_argv: string[] = []): Promise<void> {
    const connection = startRunWieldAcpServer(readableStdin(), Writable.toWeb(process.stdout), {
        diagnostic: writeDiagnostic,
    });

    const abort = () => connection.close();
    const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGINT"] : ["SIGINT", "SIGTERM"];
    for (const signal of signals) process.on(signal, abort);

    try {
        await connection.closed;
    } catch (err) {
        writeDiagnostic(`fatal server error: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
    } finally {
        for (const signal of signals) process.off(signal, abort);
        connection.close();
    }
}
