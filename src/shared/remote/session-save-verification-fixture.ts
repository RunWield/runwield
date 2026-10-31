import { collectProcessOutput } from "../../testing/subprocess-output.ts";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { getCwd } from "../../constants.js";
import { spawnNativeProcess } from "../foreground-process.ts";
import { serveHttp } from "../http-server.ts";
import { assertEquals } from "../../testing/assertions.ts";
import { join } from "node:path";
import { makeControlFixture, within } from "./session-save-test-fixture.ts";
import { type RemoteSessionRequest } from "./session-protocol.ts";
import process from "node:process";

export type SaveControlFixture = Awaited<ReturnType<typeof makeControlFixture>>;
export interface VerificationResult {
    failed?: boolean;
    allocationAttempted?: boolean;
    readStopped?: boolean;
    writeStopped?: boolean;
    checkpointStopped?: boolean;
    entries?: number;
    types?: string[];
    roles?: string[];
    effects?: number;
    summary?: string;
    file?: string | null;
    disposeFailed?: boolean;
    stopped?: boolean;
    nextPromptStopped?: boolean;
    modelRequests?: number;
    unhealthy?: boolean;
    base64?: string;
    mimeType?: string;
    ref?: string;
    path?: string;
}
export interface VerificationOptions {
    mode: "turn" | "agent-fault" | "attachment" | "oversized" | "allocation-fault";
    faultPoint?: "before-prompt" | "before-tool" | "after-tool" | "tool-hook";
    modelConnection?: import("./model-bridge.ts").RemoteModelConnection;
}
export function verificationClient(f: SaveControlFixture, baseUrl: string, options: VerificationOptions) {
    const child = spawnNativeProcess(process.execPath, {
        args: runtimeSourceArgs([
            "run",
            "-A",
            "--node-modules-dir=manual",
            "--quiet",
            new URL("./session-save-test-client.ts", import.meta.url).pathname,
        ]),
        env: { HOME: f.home, MNEMOTECA_DB_PATH: join(f.home, "mnemoteca.sqlite3") },
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
        cwd: getCwd(),
    });
    const output = collectProcessOutput(child);
    const writer = child.stdin.getWriter();
    const sent = writer
        .write(
            new TextEncoder().encode(
                JSON.stringify({
                    ...options,
                    connection: { baseUrl, credential: f.control.credential, operation: f.owner.operation },
                    cwd: f.remoteProject,
                    home: f.home,
                    mount: f.mount,
                    marker: join(f.remoteProject, "dependent-marker"),
                }) + "\n",
            ),
        )
        .then(() => writer.close())
        .finally(() => writer.releaseLock());
    return {
        async result(): Promise<VerificationResult> {
            await sent;
            const result = await within(output, 20_000);
            assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
            return JSON.parse(new TextDecoder().decode(result.stdout).trim());
        },
        async close() {
            try {
                child.kill("SIGKILL");
            } catch {
                /* Already exited. */
            }
            await output;
            await sent.catch(() => undefined);
        },
    };
}

/** Fault only the genuine network reply after the real owner accepts its bytes. */
export function verificationTransport(
    f: SaveControlFixture,
    reply: (input: RemoteSessionRequest, response: Response) => Promise<Response>,
) {
    const server = serveHttp({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
        const contents = await request.text();
        const input: RemoteSessionRequest = JSON.parse(contents);
        const response = await fetch(`${f.baseUrl}/session/request`, {
            method: "POST",
            headers: request.headers,
            body: contents,
        });
        return await reply(input, response);
    });
    if (server.addr.transport !== "tcp") throw new Error("Expected TCP");
    return { baseUrl: `http://127.0.0.1:${server.addr.port}`, close: () => server.shutdown() };
}
