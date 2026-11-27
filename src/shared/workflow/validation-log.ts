/** Complete checkout-local validation logs and their bounded output summary. */
import { mkdir, open, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveProjectRuntimeLayout } from "@runwield/project-runtime/layout";
import { trimProcessOutputLines, type CapturedProcessStream } from "./process-output.ts";

export const VALIDATION_OUTPUT_LIMIT_BYTES = 16_384;
const VALIDATION_OUTPUT_LIMIT_LINES = 200;

export interface ValidationLog {
    path: string;
    failureReason: string | null;
    append(chunk: Uint8Array): Promise<void>;
    close(): Promise<void>;
}

/** Log failures are reported in the summary; they never replace the command's result. */
export async function openValidationLog(cwd: string): Promise<ValidationLog> {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    let pending = Promise.resolve();
    const log: ValidationLog = {
        path: "",
        failureReason: null,
        append(chunk) {
            pending = pending.then(async () => {
                if (!file || log.failureReason) return;
                try {
                    let offset = 0;
                    while (offset < chunk.byteLength) {
                        const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
                        if (bytesWritten === 0) throw new Error("Log write made no progress");
                        offset += bytesWritten;
                    }
                } catch (error) {
                    log.failureReason = error instanceof Error ? error.message : String(error);
                }
            });
            return pending;
        },
        async close() {
            await pending;
            try {
                await file?.close();
            } catch (error) {
                log.failureReason ??= error instanceof Error ? error.message : String(error);
            }
        },
    };
    try {
        const dir = resolveProjectRuntimeLayout(cwd).selected.validationLogsDir;
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const entries = await readdir(dir, { withFileTypes: true });
        const logs = await Promise.all(
            entries
                .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
                .map(async (entry) => ({
                    path: join(dir, entry.name),
                    modified: (await stat(join(dir, entry.name))).mtimeMs,
                })),
        );
        logs.sort((a, b) => b.modified - a.modified || b.path.localeCompare(a.path));
        for (const old of logs.slice(19)) await unlink(old.path);
        const timestamp = new Date()
            .toISOString()
            .replace(/[-:]/g, "")
            .replace(/\.\d{3}Z$/, "Z");
        log.path = join(dir, `${timestamp}-${randomUUID()}.log`);
        file = await open(log.path, "wx", 0o600);
    } catch (error) {
        log.failureReason = error instanceof Error ? error.message : String(error);
    }
    return log;
}

export function formatValidationOutput(captured: CapturedProcessStream, log: ValidationLog): string {
    const tail = trimProcessOutputLines(captured, VALIDATION_OUTPUT_LIMIT_LINES);
    const notices: string[] = [];
    if (tail.truncated) {
        const bytes = new TextEncoder().encode(tail.text).byteLength;
        notices.push(
            `[RunWield] Output truncated; showing the last ${VALIDATION_OUTPUT_LIMIT_LINES} lines (${bytes} of ${tail.totalBytes} bytes).`,
        );
    }
    notices.push(
        log.failureReason
            ? `[RunWield] Full validation output could not be saved: ${log.failureReason}.`
            : `[RunWield] Full validation output saved to ${log.path}.\nRead it from the start to find the first failure.`,
    );
    return `${tail.text}${tail.text.endsWith("\n") || !tail.text ? "" : "\n"}${notices.join("\n")}`;
}
