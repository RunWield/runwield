import { stdinStream } from "../../testing/stdin-stream.ts";
import { openNativeFileLock } from "../native-file-lock.ts";
import { getCwd } from "../../constants.js";
import { captureForegroundProcess } from "../captured-process.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { openFileSessionStore } from "./file-session-store.ts";
import { customEntry } from "../remote/session-save-test-fixture.ts";
import { sessionDigest } from "../remote/session-protocol.ts";
import { dirname } from "node:path";
import { manifestPath } from "./file-session-storage.ts";
import process from "node:process";

interface ProcessInput {
    baseDir: string;
    runwieldSessionId: string;
    projectId: string;
    expectedGeneration: number | null;
    mode: "contend" | "owner" | "monitor" | "migration-refusal";
    lockFile?: string;
    effectPath: string;
}
async function main(): Promise<void> {
    const input: ProcessInput = JSON.parse(process.argv.slice(2)[0]);
    const store = openFileSessionStore({ baseDir: input.baseDir });
    try {
        if (input.mode === "monitor") {
            if (!input.lockFile) throw new Error("Missing native lock path");
            const file = openNativeFileLock(input.lockFile, false);
            let excludedSamples = 0;
            let idleSamples = 0;
            let violations = 0;
            let running = true;
            const stop = stdinStream()
                .getReader()
                .read()
                .then(() => {
                    running = false;
                });
            console.log(JSON.stringify({ monitoring: true }));
            try {
                while (running) {
                    if (!file.tryLockSync(true)) excludedSamples++;
                    else {
                        try {
                            const state = store.inspectSessionActivation(input.runwieldSessionId);
                            if (state.activation?.state === "idle" && state.generation?.generation === 0) idleSamples++;
                            else violations++;
                        } finally {
                            file.unlockSync();
                        }
                    }
                    await new Promise((resolve) => setTimeout(resolve, 1));
                }
                await stop;
                console.log(JSON.stringify({ excludedSamples, idleSamples, violations }));
            } finally {
                file.close();
            }
        } else {
            try {
                const proof = store.acquireSessionActivation({
                    runwieldSessionId: input.runwieldSessionId,
                    projectId: input.projectId,
                    ownerInstanceId: `os-process-${process.pid}`,
                    ownerProcessKind: "test",
                    phase: "preparing",
                    expectedGeneration: input.expectedGeneration,
                });
                if (input.mode === "migration-refusal") {
                    const segment = store.getCurrentSessionSegment(input.runwieldSessionId);
                    if (!segment) throw new Error("Missing Session segment");
                    const before = store.readActiveSessionTranscript(proof);
                    const path = manifestPath(dirname(segment.transcriptPath), input.runwieldSessionId);
                    const locked = await captureForegroundProcess("chflags", { args: ["uchg", path], cwd: getCwd() });
                    if (!locked.success) throw new Error(new TextDecoder().decode(locked.stderr));
                    let refused = false;
                    let unlockFailure: string | null = null;
                    try {
                        store.migrateActiveSessionTranscript(proof, before.trimEnd() + " \n", sessionDigest(before));
                    } catch {
                        refused = true;
                    } finally {
                        const unlocked = await captureForegroundProcess("chflags", {
                            args: ["nouchg", path],
                            cwd: getCwd(),
                        });
                        if (!unlocked.success) unlockFailure = new TextDecoder().decode(unlocked.stderr);
                    }
                    if (unlockFailure !== null) throw new Error(unlockFailure);
                    console.log(
                        JSON.stringify({
                            migrationRefused: refused,
                            originalUnchanged: readFileSync(segment.transcriptPath, "utf8") === before,
                        }),
                    );
                } else if (input.mode === "contend") {
                    store.releaseUnchangedActivation(proof);
                    console.log(JSON.stringify({ excluded: false }));
                } else {
                    const owner = store.createRemoteSessionOwner(proof);
                    owner.handle({ operation: owner.operation, sequence: 0, kind: "hydrate", contents: "" });
                    // A real owned external-effect marker must remain single after laptop recovery.
                    writeFileSync(input.effectPath, "effect\n", { flag: "a" });
                    owner.handle({
                        operation: owner.operation,
                        sequence: 1,
                        kind: "append",
                        contents: customEntry("saved-before-death"),
                    });
                    console.log(
                        JSON.stringify({
                            pid: process.pid,
                            operation: owner.operation,
                            saved: owner.inspect().contents,
                        }),
                    );
                    await stdinStream().getReader().read();
                }
            } catch (error) {
                if (input.mode !== "contend") throw error;
                console.log(
                    JSON.stringify({ excluded: true, reason: error instanceof Error ? error.message : String(error) }),
                );
            }
        }
    } finally {
        store.close();
    }
}

await main();
