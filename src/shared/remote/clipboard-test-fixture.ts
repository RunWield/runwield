import { join } from "@std/path";
import type { RemoteControlService } from "./control.ts";

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
    const root = await Deno.makeTempDir({ prefix: "laptop-clipboard-" });
    const modePath = join(root, "mode");
    const pngPath = join(root, "clipboard.png");
    await Deno.writeTextFile(modePath, mode);
    await Deno.writeFile(pngPath, Uint8Array.from(atob(clipboardImage.base64), (char) => char.charCodeAt(0)));
    await Deno.writeTextFile(
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
    await Deno.chmod(join(root, "osascript"), 0o755);
    const script = join(root, "service.ts");
    await Deno.writeTextFile(
        script,
        `
import { startRemoteControlService } from ${JSON.stringify(new URL("./control.ts", import.meta.url).href)};
const service = startRemoteControlService(${JSON.stringify(clipboardIdentity)});
if (${selectRemote}) {
    const { configureRemoteClipboardConnection } = await import(${
            JSON.stringify(new URL("../../ui/tui/clipboard.ts", import.meta.url).href)
        });
    configureRemoteClipboardConnection({ port: 1, credential: "a".repeat(64) });
}
console.log(JSON.stringify({ port: service.port, credential: service.credential }));
await Deno.stdin.read(new Uint8Array(1));
await service.close();
`,
    );
    const child = new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--quiet", "--config", new URL("../../../deno.json", import.meta.url).pathname, script],
        env: {
            PATH: `${root}:${Deno.env.get("PATH")}`,
            CLIPBOARD_MODE_PATH: modePath,
            CLIPBOARD_PNG_PATH: pngPath,
        },
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
    }).spawn();
    const stderr = new Response(child.stderr).text();
    const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
    const line = await reader.read();
    const connection: { port: number; credential: string } = JSON.parse(line.value ?? "{}");
    return {
        root,
        modePath,
        connection,
        async ready() {
            for (const [path, body] of [["/handshake", JSON.stringify(clipboardIdentity)], ["/readiness", undefined]]) {
                await (await fetch(`http://127.0.0.1:${connection.port}${path}`, {
                    method: "POST",
                    headers: { Authorization: `Bearer ${connection.credential}` },
                    body,
                })).text();
            }
        },
        async close() {
            await Deno.writeTextFile(modePath, "none");
            await child.stdin.close();
            while (!(await reader.read()).done) { /* Drain. */ }
            reader.releaseLock();
            const status = await child.status;
            if (!status.success) throw new Error(await stderr);
            await stderr;
            await Deno.remove(root, { recursive: true });
        },
    };
}
