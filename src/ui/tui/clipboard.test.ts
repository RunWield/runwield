import { assertEquals } from "../../testing/assertions.ts";
import process from "node:process";
import { test } from "node:test";
import { type ClipboardSystemPort, createClipboardReader } from "./clipboard.ts";

interface FixtureOutput {
    success: boolean;
    stdout?: string;
}

function makeClipboardPort(
    outputs: Array<FixtureOutput | Error>,
    os: typeof process.platform = "darwin",
): ClipboardSystemPort & { calls: Array<{ command: string; args: string[] }>; removed: string[]; created: string[] } {
    const calls: Array<{ command: string; args: string[] }> = [];
    const removed: string[] = [];
    const created: string[] = [];
    return {
        os,
        calls,
        removed,
        created,
        runCommand(command, args) {
            calls.push({ command, args });
            const next = outputs.shift();
            if (next instanceof Error) throw next;
            if (!next) throw new Error("missing fixture output");
            return Promise.resolve({
                success: next.success,
                stdout: new TextEncoder().encode(next.stdout ?? ""),
            });
        },
        makeTempFile(options) {
            created.push(`${options.prefix}${options.suffix}`);
            return Promise.resolve("/fixture/runwield-clip.png");
        },
        remove(path) {
            removed.push(path);
            return Promise.resolve();
        },
    };
}

test("clipboard images are unavailable outside macOS", async () => {
    const port = makeClipboardPort([], "linux");
    const reader = createClipboardReader(port);
    assertEquals(await reader.readClipboardImage(), null);
    assertEquals(port.calls, []);
});

test("clipboard image reads stop after an empty or non-image probe", async () => {
    for (const stdout of ["none\n", "", "unrecognized"]) {
        const port = makeClipboardPort([{ success: true, stdout }]);
        assertEquals(await createClipboardReader(port).readClipboardImage(), null);
        assertEquals(
            port.calls.map(({ command }) => command),
            ["osascript"],
        );
        assertEquals(port.removed, []);
        assertEquals(port.created, []);
    }
});

test("clipboard image reads extract, encode, and clean up the png", async () => {
    const port = makeClipboardPort([
        { success: true, stdout: "image\n" },
        { success: true },
        { success: true, stdout: "YWJj\nZA==\n" },
    ]);
    assertEquals(await createClipboardReader(port).readClipboardImage(), {
        base64: "YWJjZA==",
        mimeType: "image/png",
    });
    assertEquals(
        port.calls.map(({ command }) => command),
        ["osascript", "osascript", "base64"],
    );
    assertEquals(port.removed, ["/fixture/runwield-clip.png"]);
});

test("clipboard image reads clean up after extraction and encoding failures", async () => {
    const extractFailure = makeClipboardPort([{ success: true, stdout: "image\n" }, { success: false }]);
    assertEquals(await createClipboardReader(extractFailure).readClipboardImage(), null);
    assertEquals(extractFailure.removed, ["/fixture/runwield-clip.png"]);

    const encodingFailure = makeClipboardPort([
        { success: true, stdout: "image\n" },
        { success: true },
        new Error("base64 unavailable"),
    ]);
    assertEquals(await createClipboardReader(encodingFailure).readClipboardImage(), null);
    assertEquals(encodingFailure.removed, ["/fixture/runwield-clip.png"]);
});

test("clipboard image reads clean up after an extraction exception or failed encoder exit", async () => {
    for (const outputs of [
        [{ success: true, stdout: "image" }, new Error("extract unavailable")],
        [{ success: true, stdout: "image" }, { success: true }, { success: false }],
    ]) {
        const port = makeClipboardPort(outputs);
        assertEquals(await createClipboardReader(port).readClipboardImage(), null);
        assertEquals(port.removed, ["/fixture/runwield-clip.png"]);
    }
});

test("clipboard image reads stop safely when the probe fails", async () => {
    for (const output of [{ success: false, stdout: "image" }, new Error("osascript unavailable")]) {
        const port = makeClipboardPort([output]);
        assertEquals(await createClipboardReader(port).readClipboardImage(), null);
        assertEquals(
            port.calls.map(({ command }) => command),
            ["osascript"],
        );
        assertEquals(port.created, []);
    }
});
