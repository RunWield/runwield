import { assertEquals, assertRejects } from "@std/assert";
import { createRemoteClipboardReader, MAX_CLIPBOARD_BODY_BYTES } from "./clipboard-bridge.ts";
import { clipboardImage, laptopClipboardFixture } from "./clipboard-test-fixture.ts";

const credential = "a".repeat(64);

function clipboardServer(reply: () => Response) {
    const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (request) => {
        if (
            request.method !== "GET" || new URL(request.url).pathname !== "/clipboard/image" ||
            request.headers.get("Authorization") !== `Bearer ${credential}`
        ) return new Response(null, { status: 401 });
        return reply();
    });
    return { server, reader: createRemoteClipboardReader({ port: server.addr.port, credential }) };
}

Deno.test("remote clipboard reads authenticated image input and no-image replies", async () => {
    let image = true;
    const { server, reader } = clipboardServer(() => Response.json(image ? clipboardImage : null));
    try {
        assertEquals(await reader.hasClipboardImage(), true);
        assertEquals(await reader.readClipboardImage(), clipboardImage);
        image = false;
        assertEquals(await reader.hasClipboardImage(), false);
        assertEquals(await reader.readClipboardImage(), null);
    } finally {
        reader.close();
        await server.shutdown();
    }
});

Deno.test("remote clipboard rejects invalid input replies, paths, and wrong MIME types", async () => {
    const replies = [
        {},
        [],
        "image",
        { ...clipboardImage, path: "/laptop/image.png" },
        { ...clipboardImage, mimeType: "image/jpeg" },
        { ...clipboardImage, base64: "not base64" },
        { ...clipboardImage, base64: "" },
        { ...clipboardImage, base64: "abc" },
    ];
    let current = replies[0];
    const { server, reader } = clipboardServer(() => Response.json(current));
    try {
        for (const reply of replies) {
            current = reply;
            await assertRejects(() => reader.readClipboardImage());
        }
    } finally {
        reader.close();
        await server.shutdown();
    }
});

Deno.test("remote clipboard rejects malformed JSON and non-JSON or unavailable replies", async () => {
    let current = new Response("{", { headers: { "Content-Type": "application/json" } });
    const { server, reader } = clipboardServer(() => current);
    try {
        await assertRejects(() => reader.readClipboardImage());
        current = new Response(JSON.stringify(clipboardImage));
        await assertRejects(() => reader.readClipboardImage());
        current = new Response(null, { status: 403 });
        await assertRejects(() => reader.readClipboardImage());
    } finally {
        reader.close();
        await server.shutdown();
    }
});

Deno.test("remote clipboard bounds streamed input without trusting Content-Length", async () => {
    const { server, reader } = clipboardServer(() =>
        new Response(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    const bytes = new Uint8Array(MAX_CLIPBOARD_BODY_BYTES + 1);
                    bytes.fill(32);
                    controller.enqueue(bytes);
                    controller.close();
                },
            }),
            { headers: { "Content-Type": "application/json" } },
        )
    );
    try {
        await assertRejects(() => reader.readClipboardImage(), Error, "too large");
    } finally {
        reader.close();
        await server.shutdown();
    }
});

Deno.test("closing remote clipboard aborts in-flight input and prevents later local fallback", async () => {
    let received = () => {};
    const started = new Promise<void>((resolve) => received = resolve);
    let finish = () => {};
    const done = new Promise<void>((resolve) => finish = resolve);
    const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async () => {
        received();
        await done;
        return Response.json(clipboardImage);
    });
    const reader = createRemoteClipboardReader({ port: server.addr.port, credential });
    try {
        const pending = assertRejects(() => reader.readClipboardImage(), DOMException);
        await started;
        reader.close();
        assertEquals((await pending).name, "AbortError");
        await assertRejects(() => reader.readClipboardImage(), Error, "closed");
        await assertRejects(() => reader.hasClipboardImage(), Error, "closed");
    } finally {
        finish();
        await server.shutdown();
    }
});

Deno.test({
    name: "configured remote process public clipboard reads laptop bytes and stays fail-closed on cleanup",
    ignore: Deno.build.os !== "darwin",
    async fn() {
        const fixture = await laptopClipboardFixture();
        try {
            await fixture.ready();
            const emptyClipboard = `${fixture.root}/remote-clipboard`;
            await Deno.writeTextFile(emptyClipboard, "none");
            const output = await new Deno.Command(Deno.execPath(), {
                env: {
                    PATH: `${fixture.root}:${Deno.env.get("PATH")}`,
                    CLIPBOARD_MODE_PATH: emptyClipboard,
                    CLIPBOARD_PNG_PATH: `${fixture.root}/clipboard.png`,
                },
                args: [
                    "eval",
                    "--config",
                    new URL("../../../deno.json", import.meta.url).pathname,
                    `
import { configureRemoteClipboardConnection, readClipboardImage, hasClipboardImage } from ${
                        JSON.stringify(new URL("../../ui/tui/clipboard.ts", import.meta.url).href)
                    };
const close = configureRemoteClipboardConnection(${JSON.stringify(fixture.connection)});
const image = await readClipboardImage();
const available = await hasClipboardImage();
close();
let closed = false;
try { await readClipboardImage(); } catch { closed = true; }
console.log(JSON.stringify({ image, available, closed }));
`,
                ],
            }).output();
            assertEquals(output.success, true, new TextDecoder().decode(output.stderr));
            assertEquals(JSON.parse(new TextDecoder().decode(output.stdout)), {
                image: clipboardImage,
                available: true,
                closed: true,
            });
        } finally {
            await fixture.close();
        }
    },
});
