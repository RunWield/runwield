import { deepEqual, equal, match, ok } from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { versions } from "node:process";
import { test } from "node:test";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { startWorkspaceServer } from "./server.js";

test("portable Workspace renders pairing, serves assets and enforces owner authentication over HTTP", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runwield-workspace-portable-"));
    const store = openOwnerCoordinationStore({ dbPath: join(directory, "owner.sqlite3") });
    const publicOrigin = "http://127.0.0.1:8787";
    const server = startWorkspaceServer({ mode: "owner", host: "127.0.0.1", port: 0, publicOrigin, store });
    const base = `http://127.0.0.1:${server.addr.port}`;
    // Explicit Host models the supported local reverse-proxy origin while the
    // test's actual listener uses a collision-free ephemeral port.
    function request(path: string, options: RequestInit = {}) {
        return new Promise<Response>((resolve, reject) => {
            const headers = new Headers(options.headers);
            if (!headers.has("host")) headers.set("host", "127.0.0.1:8787");
            const outgoing = httpRequest(`${base}${path}`, {
                method: options.method || "GET",
                headers: Object.fromEntries(headers),
                signal: AbortSignal.timeout(10_000),
            }, async (incoming) => {
                try {
                    const chunks: Uint8Array[] = [];
                    for await (const chunk of incoming) chunks.push(chunk);
                    const responseHeaders = new Headers();
                    for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
                        responseHeaders.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
                    }
                    resolve(
                        new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers: responseHeaders }),
                    );
                } catch (error) {
                    reject(error);
                }
            });
            outgoing.on("error", reject);
            outgoing.end(options.body);
        });
    }
    try {
        const redirect = await request("/");
        equal(redirect.status, 302);
        equal(redirect.headers.get("location"), "/pair");
        await redirect.text();
        const page = await request("/pair");
        equal(page.status, 200);
        equal(page.headers.get("x-frame-options"), "DENY");
        const html = await page.text();
        match(html, /Pair RunWield Workspace/);
        const assets = [...html.matchAll(/(?:src|href)="(\/_astro\/[^"?]+\.(?:js|css))"/g)].map((item) => item[1]);
        ok(assets.length > 0, "The real Astro page must reference built assets");
        for (const path of new Set(assets)) {
            const asset = await request(path);
            equal(asset.status, 200, path);
            match(
                asset.headers.get("content-type") || "",
                path.endsWith(".css") ? /text\/css/i : /(?:application|text)\/javascript/i,
            );
            const build = versions.bun ? "workspace-bun" : "workspace";
            const expected = await readFile(new URL(`../../../dist/${build}/client${path}`, import.meta.url));
            deepEqual(new Uint8Array(await asset.arrayBuffer()), new Uint8Array(expected), path);
        }
        const denied = await request("/api/owner/projects");
        equal(denied.status, 401);
        await denied.text();
        const foreign = await request("/api/owner/pairing/request", {
            method: "POST",
            headers: { origin: "https://foreign.example" },
            body: "{}",
        });
        equal(foreign.status, 403);
        await foreign.text();
        const pending = await request("/api/owner/pairing/request", {
            method: "POST",
            headers: { origin: publicOrigin, "content-type": "application/json" },
            body: JSON.stringify({ deviceLabel: "Fixture browser" }),
        });
        equal(pending.status, 201);
        const pairing = await pending.json();
        equal(pairing.state, "pending");
        const proofCookie = pending.headers.getSetCookie().find((value) => value.startsWith("rw_pairing_proof="))
            ?.split(";")[0];
        ok(proofCookie);
        store.approvePairingRequest(pairing.code);
        const claimed = await request("/api/owner/pairing/claim", {
            method: "POST",
            headers: { origin: publicOrigin, cookie: proofCookie },
        });
        equal(claimed.status, 201);
        equal((await claimed.json()).paired, true);
        const cookies = claimed.headers.getSetCookie();
        ok(cookies.some((value) => value.startsWith("rw_owner_device=") && value.includes("HttpOnly")));
        ok(cookies.some((value) => value.startsWith("rw_owner_csrf=")));
        const cookie = cookies.map((value) => value.split(";")[0]).join("; ");
        const projects = await request("/api/owner/projects", { headers: { cookie } });
        equal(projects.status, 200);
        equal((await projects.json()).projects.length, 0);
        const mutation = await request("/api/owner/projects", {
            method: "POST",
            headers: { origin: publicOrigin, cookie, "content-type": "application/json" },
            body: "{}",
        });
        equal(mutation.status, 403, "Owner mutation still requires CSRF proof");
        await mutation.text();
        const wrongHost = await request("/pair", { headers: { host: "foreign.example" } });
        equal(wrongHost.status, 403);
        await wrongHost.text();
    } finally {
        await server.shutdown();
        await server.finished;
        store.close();
        await rm(directory, { recursive: true });
    }
});
