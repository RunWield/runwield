import { collectProcessOutput } from "../../testing/subprocess-output.ts";
import { open as fsOpen } from "node:fs/promises";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { mkdir as fsMkdir, writeFile as fsWriteFile, stat as fsStat, truncate as fsTruncate } from "node:fs/promises";
import { getCwd } from "../../constants.js";
import { spawnNativeProcess } from "../foreground-process.ts";
import { test } from "node:test";
import { readdirSync } from "node:fs";
import { serveHttp } from "../http-server.ts";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects, assertThrows } from "../../testing/assertions.ts";
import { dirname, join } from "node:path";
import { makeControlFixture, makeSessionFixture, within } from "./session-save-test-fixture.ts";
import { MAX_SESSION_BYTES, type RemoteSessionResponse } from "./session-protocol.ts";
import { type ImageAttachment } from "../session/types.js";
import process from "node:process";

type Fixture = Awaited<ReturnType<typeof makeControlFixture>>;
interface ClientResult {
    attachment?: ImageAttachment;
    local?: ImageAttachment;
    images?: string[];
    pathDenied?: boolean;
    file?: string | null;
    failed?: boolean;
    stopped?: boolean;
    aborted?: boolean;
}
async function client(
    f: Fixture,
    mode: "upload" | "read" | "fault",
    ref?: string,
    baseUrl = f.baseUrl,
    operation = f.owner.operation,
): Promise<ClientResult> {
    await fsMkdir(f.mount, { recursive: true });
    const child = spawnNativeProcess(process.execPath, {
        args: runtimeSourceArgs([
            "run",
            "-A",
            "--node-modules-dir=manual",
            "--quiet",
            new URL("./session-attachment-read-test-client.ts", import.meta.url).pathname,
        ]),
        env: { HOME: f.home, MNEMOTECA_DB_PATH: join(f.home, "memory.sqlite3") },
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
        cwd: getCwd(),
    });
    const output = collectProcessOutput(child);
    try {
        const writer = child.stdin.getWriter();
        await writer.write(
            new TextEncoder().encode(
                JSON.stringify({
                    connection: { baseUrl, operation, credential: f.control.credential },
                    cwd: f.remoteProject,
                    mount: f.mount,
                    mode,
                    ref,
                }),
            ),
        );
        await writer.close();
        writer.releaseLock();
        const result = await within(output, 20_000);
        assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
        return JSON.parse(new TextDecoder().decode(result.stdout));
    } finally {
        try {
            child.kill("SIGKILL");
        } catch {
            /* Already exited. */
        }
        await output;
    }
}
function imageDirectory(f: Awaited<ReturnType<typeof makeSessionFixture>>): string {
    const segment = f.store.getCurrentSessionSegment(f.session.runwieldSessionId);
    assert(segment);
    return join(dirname(segment.transcriptPath), `${segment.piSessionId}_images`);
}

test("remote upload and fresh hydrated manager read laptop attachment bytes through see_image without a mount", async () => {
    const f = await makeControlFixture();
    await f.ready();
    await fsWriteFile(join(f.remoteProject, "project.png"), new Uint8Array([5, 6]));
    try {
        const first = await client(f, "upload");
        assert(first.attachment?.ref);
        const expected = { base64: "AQIDBA==", mimeType: "image/png", ref: first.attachment.ref };
        assertEquals(first.attachment, expected);
        assertEquals(first.local, { base64: "BQY=", mimeType: "image/png", ref: "project.png" });
        assertEquals(first.images, ["image/png:AQIDBA==", "image/png:BQY="]);
        assertEquals(first.pathDenied, true);
        assertEquals(first.file, null);
        await assertRejects(() => fsStat(f.mount), Error, "ENOENT");
        const state = f.store.inspectSessionActivation(f.session.runwieldSessionId);
        const fresh = f.store.createRemoteSessionOwner(
            f.store.acquireSessionActivation({
                runwieldSessionId: f.session.runwieldSessionId,
                projectId: f.session.projectId,
                ownerInstanceId: "fresh-attachment-owner",
                ownerProcessKind: "test",
                phase: "preparing",
                expectedGeneration: state.generation?.generation ?? null,
            }),
        );
        f.control.registerSessionOperation(fresh.operation);
        const second = await client(f, "read", first.attachment.ref, f.baseUrl, fresh.operation);
        assertEquals(second, first);
        await assertRejects(() => fsStat(f.mount), Error, "ENOENT");
        assertEquals(
            [...readdirSync(f.remoteProject, { withFileTypes: true })].map((entry) => entry.name),
            ["project.png"],
        );
        await assertRejects(() => fsStat(join(f.home, ".wld", "sessions")), Error, "ENOENT");
        assertEquals(fresh.inspect().contents, f.owner.inspect().contents);
    } finally {
        await f.close();
    }
});

test("attachment read requires credentials, current operation, hydration and native writer ownership", async () => {
    const f = await makeControlFixture();
    await f.ready();
    try {
        const input = f.request("attachment-read", 0, `attachment:${crypto.randomUUID()}`);
        const unauthorized = await f.post("/session/request", JSON.stringify(input), "wrong-credential");
        assertEquals(unauthorized.status, 401);
        await unauthorized.text();
        const stale = await f.post("/session/request", JSON.stringify({ ...input, operation: crypto.randomUUID() }));
        assertEquals(stale.status, 409);
        await stale.text();
        assertThrows(() => f.owner.handle(input), Error, "not been hydrated");
        f.owner.handle(f.request("hydrate", 0));
        f.store.close();
        assertThrows(() => f.owner.handle({ ...input, sequence: 1 }), Error);
    } finally {
        await f.close();
    }
});

test("attachment read retries return the same path-free receipt and reject conflicting identities", async () => {
    const f = await makeSessionFixture();
    try {
        f.owner.handle(f.request("hydrate", 0));
        const upload = f.owner.handle(
            f.request("attachment", 1, JSON.stringify({ base64: "AQIDBA==", mimeType: "image/jpeg" })),
        );
        const image: ImageAttachment = JSON.parse(upload.contents);
        const read = f.request("attachment-read", 2, image.ref);
        const first = f.owner.handle(read);
        assertEquals(JSON.parse(first.contents), image);
        assertEquals(first.evidence, upload.evidence);
        // A saved response remains stable even if the underlying file changes before a retry.
        await fsWriteFile(join(imageDirectory(f), `${image.ref?.slice(11)}.jpg`), new Uint8Array([9]));
        assertEquals(f.owner.handle(read), first);
        assertThrows(
            () => f.owner.handle({ ...read, contents: `attachment:${crypto.randomUUID()}` }),
            Error,
            "Conflicting",
        );
        f.owner.handle(f.request("checkpoint", 3));
        assertThrows(() => f.owner.handle(read), Error, "Stale");
    } finally {
        await f.close();
    }
});

for (const [label, ref] of [
    ["project path", "../outside.png"],
    ["invalid attachment ref", "attachment:../../outside"],
    ["missing attachment", "attachment:00000000-0000-0000-0000-000000000000"],
]) {
    test(`owner refuses ${label} without fallback and keeps read failure sticky`, async () => {
        const f = await makeSessionFixture();
        try {
            f.owner.handle(f.request("hydrate", 0));
            assertThrows(() => f.owner.handle(f.request("attachment-read", 1, ref)), Error);
            assertThrows(() => f.owner.handle(f.request("inspect", 1)), Error);
            assertEquals(f.owner.inspect().contents, f.initial);
        } finally {
            await f.close();
        }
    });
}

test("owner bounds attachment bytes at 16 MiB before returning base64", async () => {
    const f = await makeSessionFixture();
    try {
        f.owner.handle(f.request("hydrate", 0));
        const ref = `attachment:${crypto.randomUUID()}`;
        const directory = imageDirectory(f);
        await fsMkdir(directory);
        const path = join(directory, `${ref.slice(11)}.png`);
        const file = await fsOpen(path, "w");
        await file.truncate(MAX_SESSION_BYTES);
        await file.close();
        const response = f.owner.handle(f.request("attachment-read", 1, ref));
        const image: ImageAttachment = JSON.parse(response.contents);
        assertEquals(image.base64.length, Math.ceil(MAX_SESSION_BYTES / 3) * 4);
        assertEquals(Object.keys(image).sort(), ["base64", "mimeType", "ref"]);
        await fsTruncate(path, MAX_SESSION_BYTES + 1);
        assertThrows(() => f.owner.handle(f.request("attachment-read", 2, ref)), Error, "read limit");
    } finally {
        await f.close();
    }
});

test("Worker bounds an oversized attachment-read reply and stops the manager permanently", async () => {
    const f = await makeControlFixture();
    await f.ready();
    const ref = `attachment:${crypto.randomUUID()}`;
    const proxy = serveHttp({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
        const body = await request.text();
        const input = JSON.parse(body);
        if (input.kind === "attachment-read") {
            return new Response("x".repeat(Math.ceil(MAX_SESSION_BYTES / 3) * 4 + 4097));
        }
        return await fetch(`${f.baseUrl}/session/request`, { method: "POST", headers: request.headers, body });
    });
    assert(proxy.addr.transport === "tcp");
    try {
        assertEquals(await client(f, "fault", ref, `http://127.0.0.1:${proxy.addr.port}`), {
            failed: true,
            stopped: true,
            aborted: true,
        });
    } finally {
        await proxy.shutdown();
        await f.close();
    }
});

test("Worker carries attachment read payloads larger than a save acknowledgement", async () => {
    const f = await makeControlFixture();
    await f.ready();
    const ref = `attachment:${crypto.randomUUID()}`;
    const directory = imageDirectory(f);
    await fsMkdir(directory);
    await fsWriteFile(join(directory, `${ref.slice(11)}.webp`), new Uint8Array(64 * 1024).fill(7));
    await fsWriteFile(join(f.remoteProject, "project.png"), new Uint8Array([5, 6]));
    try {
        const result = await client(f, "read", ref);
        assertEquals(result.attachment, { base64: btoa("\x07".repeat(64 * 1024)), mimeType: "image/webp", ref });
    } finally {
        await f.close();
    }
});

for (const fault of ["path", "ref", "mime", "base64"] as const) {
    test(`invalid attachment ${fault} acknowledgement stops the remote manager`, async () => {
        const f = await makeControlFixture();
        await f.ready();
        const ref = `attachment:${crypto.randomUUID()}`;
        const directory = imageDirectory(f);
        await fsMkdir(directory);
        await fsWriteFile(join(directory, `${ref.slice(11)}.png`), new Uint8Array([1, 2, 3, 4]));
        const proxy = serveHttp({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
            const body = await request.text();
            const input = JSON.parse(body);
            const response = await fetch(`${f.baseUrl}/session/request`, {
                method: "POST",
                headers: request.headers,
                body,
            });
            if (input.kind !== "attachment-read") return response;
            const receipt: RemoteSessionResponse = await response.json();
            const image: ImageAttachment = JSON.parse(receipt.contents);
            if (fault === "path") image.path = f.transcriptPath;
            if (fault === "ref") image.ref = `attachment:${crypto.randomUUID()}`;
            if (fault === "mime") image.mimeType = "text/plain";
            if (fault === "base64") image.base64 = "not base64";
            return Response.json({ ...receipt, contents: JSON.stringify(image) });
        });
        assert(proxy.addr.transport === "tcp");
        try {
            assertEquals(await client(f, "fault", ref, `http://127.0.0.1:${proxy.addr.port}`), {
                failed: true,
                stopped: true,
                aborted: true,
            });
        } finally {
            await proxy.shutdown();
            await f.close();
        }
    });
}
