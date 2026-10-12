import { isMissingExecutableError, spawnForegroundProcess } from "../../../foreground-process.ts";
import type { PreparedClaudeCliCommand } from "./command.ts";
import { ClaudeCliBackendError } from "./failure.ts";

export interface ClaudeCliProcessStatus {
    success: boolean;
    code: number;
    signal: null;
}

export interface ClaudeCliControlReply {
    requestId: string;
    cancelled: boolean;
    error?: string;
}

interface PendingRecall {
    resolve: (cancelled: boolean) => void;
    reject: (error: Error) => void;
}

export interface ClaudeCliProcessResult {
    success: boolean;
    code: number;
    stdout: ReadableStream<Uint8Array>;
    stderrText: Promise<string>;
    completed: Promise<ClaudeCliProcessStatus>;
    sendUserMessage(text: string, id?: string): Promise<void>;
    closeInput(): Promise<void>;
    cancelUserMessage(id: string): Promise<boolean>;
    handleControlReply(reply: ClaudeCliControlReply): void;
    kill(): void;
}

export class DenoClaudeCliProcessPort {
    run(command: PreparedClaudeCliCommand, cwd: string, signal?: AbortSignal): ClaudeCliProcessResult {
        let process: ReturnType<typeof spawnForegroundProcess>;
        try {
            process = spawnForegroundProcess({
                command: command.command,
                args: command.args,
                cwd,
                env: command.env,
                stdin: "piped",
                signal,
            });
        } catch (error) {
            if (error instanceof Error && isMissingExecutableError(error)) {
                throw new ClaudeCliBackendError("missing_executable");
            }
            throw error;
        }
        const writer = process.stdin!.getWriter();
        const recalls = new Map<string, PendingRecall>();
        void process.done.then(() => {
            for (const pending of recalls.values())
                pending.reject(new Error("Claude CLI exited during message recall"));
            recalls.clear();
        });
        return {
            sendUserMessage(text, id) {
                return writer.write(
                    new TextEncoder().encode(
                        JSON.stringify({
                            type: "user",
                            message: { role: "user", content: text },
                            parent_tool_use_id: null,
                            ...(id ? { uuid: id } : {}),
                        }) + "\n",
                    ),
                );
            },
            closeInput: () => writer.close(),
            async cancelUserMessage(id) {
                const requestId = crypto.randomUUID();
                let timer: ReturnType<typeof setTimeout>;
                const reply = new Promise<boolean>((resolve, reject) => {
                    recalls.set(requestId, { resolve, reject });
                    timer = setTimeout(() => reject(new Error("Claude CLI message recall timed out")), 10000);
                });
                try {
                    void writer
                        .write(
                            new TextEncoder().encode(
                                JSON.stringify({
                                    type: "control_request",
                                    request_id: requestId,
                                    request: { subtype: "cancel_async_message", message_uuid: id },
                                }) + "\n",
                            ),
                        )
                        .catch((error: Error) => recalls.get(requestId)?.reject(error));
                    return await reply;
                } finally {
                    clearTimeout(timer!);
                    recalls.delete(requestId);
                }
            },
            handleControlReply(reply) {
                const pending = recalls.get(reply.requestId);
                if (reply.error) pending?.reject(new Error(reply.error));
                else pending?.resolve(reply.cancelled);
            },
            success: true,
            code: 0,
            stdout: process.stdout,
            stderrText: new Response(process.stderr).text(),
            completed: process.done.then((outcome) => ({
                success: outcome.terminatedBy === null && outcome.exitCode === 0,
                code: outcome.exitCode ?? 1,
                signal: null,
            })),
            kill() {
                process.kill();
            },
        };
    }
}
