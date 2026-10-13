import { mkdtemp as fsMkdtemp, rm as fsRm } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { createOwnerWorkspaceApp } from "./server.js";

test("paired app leaves a restored pairing page, survives server restart, and respects revocation", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "workspace-pairing-persistence-"));
    const dbPath = `${dir}/owner.sqlite3`;
    const publicOrigin = "https://workspace.example.test";
    let store = openOwnerCoordinationStore({ dbPath });
    let workspace = createOwnerWorkspaceApp({ mode: "owner", store, publicOrigin });
    try {
        let app = workspace.handler();
        const pairing = store.createPairingRequest({ deviceLabel: "Installed phone app" });
        store.approvePairingRequest(pairing.code);
        const claim: Response = await app(
            new Request(`${publicOrigin}/api/owner/pairing/claim`, {
                method: "POST",
                headers: { origin: publicOrigin, cookie: `rw_pairing_proof=${pairing.proof}` },
            }),
        );
        assertEquals(claim.status, 201);
        const cookies = claim.headers.getSetCookie();
        const credentialCookie = cookies.find((cookie) => cookie.startsWith("rw_owner_device="))!;
        const csrfCookie = cookies.find((cookie) => cookie.startsWith("rw_owner_csrf="))!;
        assertStringIncludes(credentialCookie, "SameSite=Lax");
        assertStringIncludes(credentialCookie, "HttpOnly");
        assertStringIncludes(credentialCookie, "Secure");
        assertStringIncludes(credentialCookie, "Max-Age=31536000");
        assertStringIncludes(csrfCookie, "SameSite=Strict");
        const cookie = [credentialCookie, csrfCookie].map((value) => value.split(";")[0]).join("; ");
        const claimed = await claim.json();

        await workspace.close();
        store.close();
        store = openOwnerCoordinationStore({ dbPath });
        workspace = createOwnerWorkspaceApp({ mode: "owner", store, publicOrigin });
        app = workspace.handler();
        const revisit = await app(new Request(`${publicOrigin}/pair`, { headers: { cookie } }));
        assertEquals(revisit.status, 302);
        assertEquals(revisit.headers.get("location"), "/");
        assertStringIncludes(revisit.headers.get("cache-control") || "", "no-store");
        assertEquals(revisit.headers.getSetCookie(), [credentialCookie, csrfCookie]);

        // A legacy Strict cookie omitted on initial navigation can still be
        // recognized by the pairing page's subsequent same-site status request.
        const status = await app(new Request(`${publicOrigin}/api/owner/pairing/status`, { headers: { cookie } }));
        assertEquals(await status.json(), { state: "paired" });
        assertEquals(store.listDevices().length, 1);

        const unpairedStatus = await app(new Request(`${publicOrigin}/api/owner/pairing/status`));
        assertEquals(unpairedStatus.status, 404);
        const badCsrf = await app(
            new Request(`${publicOrigin}/api/owner/projects`, {
                method: "POST",
                headers: { cookie, origin: publicOrigin },
                body: "{}",
            }),
        );
        assertEquals(badCsrf.status, 403);
        const badOrigin = await app(
            new Request(`${publicOrigin}/api/owner/projects`, {
                method: "POST",
                headers: {
                    cookie,
                    origin: "https://other.example.test",
                    "x-runwield-csrf": csrfCookie.split(";")[0].split("=")[1],
                },
                body: "{}",
            }),
        );
        assertEquals(badOrigin.status, 403);

        store.revokeDevice(claimed.device.deviceId);
        const revoked = await app(new Request(`${publicOrigin}/api/owner/pairing/status`, { headers: { cookie } }));
        assertEquals(revoked.status, 404);
        const protectedPage = await app(new Request(`${publicOrigin}/`, { headers: { cookie } }));
        assertEquals(protectedPage.headers.get("location"), "/pair");
        assertEquals(protectedPage.headers.getSetCookie(), []);
    } finally {
        await workspace.close();
        store.close();
        await fsRm(dir, { recursive: true });
    }
});
