import { readableStdin } from "../../shared/stdin-stream.ts";
import { Writable } from "node:stream";
import process from "node:process";
/**
 * @module cmd/acp
 * ACP stdio command entrypoint.
 */

import { startRunWieldAcpServer } from "./server.ts";

function writeDiagnostic(message: string): void {
    console.error(`[RunWield ACP] ${message}`);
}

/**
 * Run the ACP stdio adapter. stdout is reserved for ACP protocol frames only.
 */
export async function runAcpCommand(_argv: string[] = []): Promise<void> {
    const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGINT"] : ["SIGINT", "SIGTERM"];
    let abort: (() => void) | undefined;
    try {
        const connection = startRunWieldAcpServer(
            { readable: readableStdin(), writable: Writable.toWeb(process.stdout) },
            { diagnostic: writeDiagnostic },
        );
        abort = () => connection.close();
        for (const signal of signals) process.on(signal, abort);
        await connection.closed;
    } catch (err) {
        writeDiagnostic(`fatal server error: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
    } finally {
        if (abort) {
            for (const signal of signals) process.off(signal, abort);
            abort();
        }
    }
}
