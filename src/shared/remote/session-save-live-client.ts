import { stdinStream } from "../../testing/stdin-stream.ts";
import { isStandaloneExecutable } from "../runtime-identity.ts";
import { collectProcessOutput } from "../../testing/subprocess-output.ts";
import { getCwd } from "../../constants.js";
import { spawnNativeProcess, terminateOwnedLinuxGroup } from "../foreground-process.ts";
import process from "node:process";

/** Compiled-only launcher for owned qualification processes. Not a normal remote CLI. */

async function main(): Promise<void> {
    if (!isStandaloneExecutable()) throw new Error("Live verification requires the compiled client");
    if (process.argv.slice(2)[0] !== "--supervisor") {
        await import("./session-save-test-client.ts");
    } else {
        const reader = stdinStream().getReader();
        const privateBytes: number[] = [];
        while (!privateBytes.includes(10)) {
            const chunk = await reader.read();
            if (!chunk.value) throw new Error("Missing private supervisor input");
            privateBytes.push(...chunk.value);
            if (privateBytes.length > 65536) throw new Error("Private supervisor header too large");
        }
        if (privateBytes.indexOf(10) !== privateBytes.length - 1)
            throw new Error("Unexpected private supervisor input");
        const privateHeader = new Uint8Array(privateBytes);
        const child = spawnNativeProcess(process.execPath, {
            stdin: "piped",
            stdout: "piped",
            stderr: "piped",
            detached: true,
            cwd: getCwd(),
            args: [],
        });
        const writer = child.stdin.getWriter();
        let stopped = false;
        try {
            await writer.write(privateHeader);
            console.log(JSON.stringify({ supervisorPid: process.pid, childPid: child.pid }));
            const output = collectProcessOutput(child);
            const command = await Promise.race([reader.read(), child.status.then(() => null)]);
            if (command !== null) {
                const start = performance.now();
                stopped = await terminateOwnedLinuxGroup(child);
                console.log(JSON.stringify({ stopped, stopMs: performance.now() - start }));
            }
            const result = await output;
            console.log(
                JSON.stringify({
                    childCode: result.code,
                    stdout: new TextDecoder().decode(result.stdout),
                    stderr: new TextDecoder().decode(result.stderr),
                }),
            );
        } finally {
            if (!stopped) await terminateOwnedLinuxGroup(child);
            await writer.abort().catch(() => undefined);
            writer.releaseLock();
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
        }
    }
}

await main();
