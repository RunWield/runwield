/** Compiled-only launcher for owned qualification processes. Not a normal remote CLI. */
import { terminateOwnedLinuxGroup } from "../foreground-process.ts";

if (!Deno.build.standalone) throw new Error("Live verification requires the compiled client");
if (Deno.args[0] !== "--supervisor") {
    await import("./session-save-test-client.ts");
} else {
    const reader = Deno.stdin.readable.getReader();
    const privateBytes: number[] = [];
    while (!privateBytes.includes(10)) {
        const chunk = await reader.read();
        if (!chunk.value) throw new Error("Missing private supervisor input");
        privateBytes.push(...chunk.value);
        if (privateBytes.length > 65536) throw new Error("Private supervisor header too large");
    }
    if (privateBytes.indexOf(10) !== privateBytes.length - 1) throw new Error("Unexpected private supervisor input");
    const privateHeader = new Uint8Array(privateBytes);
    const child = new Deno.Command(Deno.execPath(), {
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
        detached: true,
    }).spawn();
    const writer = child.stdin.getWriter();
    let stopped = false;
    try {
        await writer.write(privateHeader);
        console.log(JSON.stringify({ supervisorPid: Deno.pid, childPid: child.pid }));
        const output = child.output();
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
