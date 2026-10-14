import { decodeTextStream } from "../../testing/decode-text-stream.ts";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { tmpdir } from "node:os";
import { mkdtemp as fsMkdtemp, writeFile as fsWriteFile, chmod as fsChmod, rm as fsRm } from "node:fs/promises";
import { join } from "node:path";
import { getCwd } from "../../constants.js";
import { spawnNativeProcess } from "../foreground-process.ts";
import { type RemoteControlService } from "./control.ts";
import process from "node:process";

export const clipboardIdentity = { buildId: "c".repeat(64), protocol: 1 };
export const clipboardImage = {
    base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
    mimeType: "image/png",
};

export async function controlRequest(service: RemoteControlService, path: string, method = "GET", body?: string) {
    return await fetch(`http://127.0.0.1:${service.port}${path}`, {
        method,
        headers: { Authorization: `Bearer ${service.credential}` },
        body,
    });
}

export async function readyClipboardService(service: RemoteControlService) {
    await (await controlRequest(service, "/handshake", "POST", JSON.stringify(clipboardIdentity))).text();
    await (await controlRequest(service, "/readiness", "POST")).text();
}

/** A real service in a separate laptop process, with only osascript hardware replaced. */
export async function laptopClipboardFixture(mode = "image", selectRemote = false) {
    const root = await fsMkdtemp(join(tmpdir(), "laptop-clipboard-"));
    const modePath = join(root, "mode");
    const pngPath = join(root, "clipboard.png");
    await fsWriteFile(modePath, mode);
    await fsWriteFile(
        pngPath,
        Uint8Array.from(atob(clipboardImage.base64), (char) => char.charCodeAt(0)),
    );
    await fsWriteFile(
        join(root, "osascript"),
        String.raw`#!/bin/sh
[ "$1" = "-e" ] || exit 1
mode=$(cat "$CLIPBOARD_MODE_PATH")
case "$2" in
  *'return "image"'*)
    [ "$mode" = "error" ] && exit 1
    [ "$mode" = "none" ] && echo none || echo image
    ;;
  *'write theImage to theFile'*)
    [ "$mode" = "extract-error" ] && exit 1
    if [ "$mode" = "wait" ]; then
      touch "$CLIPBOARD_MODE_PATH.started"
      while [ "$(cat "$CLIPBOARD_MODE_PATH")" = "wait" ]; do sleep 0.02; done
    fi
    target=$(printf '%s' "$2" | sed -n 's/^set tempFile to "\(.*\)"$/\1/p')
    [ -n "$target" ] || exit 1
    [ "$mode" = "large" ] && dd if=/dev/zero of="$target" bs=1048576 count=21 2>/dev/null || cp "$CLIPBOARD_PNG_PATH" "$target"
    ;;
  *) exit 1 ;;
esac
`,
    );
    await fsChmod(join(root, "osascript"), 0o755);
    const script = join(root, "service.ts");
    await fsWriteFile(
        script,
        `
import { startRemoteControlService } from ${JSON.stringify(new URL("./control.ts", import.meta.url).href)};
const service = startRemoteControlService(${JSON.stringify(clipboardIdentity)});
if (${selectRemote}) {
    const { configureRemoteClipboardConnection } = await import(${JSON.stringify(
        new URL("../../ui/tui/clipboard.ts", import.meta.url).href,
    )});
    configureRemoteClipboardConnection({ port: 1, credential: "a".repeat(64) });
}
console.log(JSON.stringify({ port: service.port, credential: service.credential }));
await new Promise((resolve) => { process.stdin.once("data", resolve); process.stdin.once("end", resolve); });
await service.close();
`,
    );
    const child = spawnNativeProcess(process.execPath, {
        args: runtimeSourceArgs([
            "run",
            "-A",
            "--quiet",
            "--config",
            new URL("../../../deno.json", import.meta.url).pathname,
            script,
        ]),
        env: {
            PATH: `${root}:${process.env["PATH"]}`,
            CLIPBOARD_MODE_PATH: modePath,
            CLIPBOARD_PNG_PATH: pngPath,
        },
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
        cwd: getCwd(),
    });
    const stderr = new Response(child.stderr).text();
    const reader = child.stdout.pipeThrough(decodeTextStream()).getReader();
    const line = await reader.read();
    const connection: { port: number; credential: string } = JSON.parse(line.value ?? "{}");
    return {
        root,
        modePath,
        connection,
        async ready() {
            for (const [path, body] of [
                ["/handshake", JSON.stringify(clipboardIdentity)],
                ["/readiness", undefined],
            ]) {
                await (
                    await fetch(`http://127.0.0.1:${connection.port}${path}`, {
                        method: "POST",
                        headers: { Authorization: `Bearer ${connection.credential}` },
                        body,
                    })
                ).text();
            }
        },
        async close() {
            await fsWriteFile(modePath, "none");
            await child.stdin.close();
            while (!(await reader.read()).done) {
                /* Drain. */
            }
            reader.releaseLock();
            const status = await child.status;
            if (!status.success) throw new Error(await stderr);
            await stderr;
            await fsRm(root, { recursive: true });
        },
    };
}
