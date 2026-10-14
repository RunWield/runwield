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
): ClipboardSystemPort & { calls: Array<{ command: string; args: string[] }>; removed: string[] } {
    const calls: Array<{ command: string; args: string[] }> = [];
    const removed: string[] = [];
    return {
        os,
        calls,
        removed,
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
        makeTempFile: () => Promise.resolve("/fixture/runwield-clip.png"),
        remove(path) {
            removed.push(path);
            return Promise.resolve();
        },
    };
}

test("clipboard images are unavailable outside macOS", async () => {
    const port = makeClipboardPort([], "linux");
    const reader = createClipboardReader(port);
    assertEquals(await reader.hasClipboardImage(), false);
    assertEquals(await reader.readClipboardImage(), null);
    assertEquals(port.calls, []);
});

test("clipboard image detection reflects the AppleScript result", async () => {
    const imagePort = makeClipboardPort([{ success: true, stdout: "image\n" }]);
    assertEquals(await createClipboardReader(imagePort).hasClipboardImage(), true);
    assertEquals(imagePort.calls.map(({ command }) => command), ["osascript"]);

    const emptyPort = makeClipboardPort([{ success: true, stdout: "none\n" }]);
    assertEquals(await createClipboardReader(emptyPort).hasClipboardImage(), false);
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
    assertEquals(port.calls.map(({ command }) => command), ["osascript", "osascript", "base64"]);
    assertEquals(port.removed, ["/fixture/runwield-clip.png"]);
});

test("clipboard image reads clean up after extraction and encoding failures", async () => {
    const extractFailure = makeClipboardPort([
        { success: true, stdout: "image\n" },
        { success: false },
    ]);
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
