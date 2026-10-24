import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { withMetricsExportFixture } from "../../testing/metrics-export-fixture.ts";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { configureRemotePersonalResources } from "../../shared/remote/personal-resources.ts";
import { createOwnerWorkspaceApp } from "./server.js";

// Remote resources activate once for a process. Keep this contract in its own isolated file.
test("remote-backed usage settings explain unavailability and reject every mutation without writes", async () => {
    await withMetricsExportFixture(async ({ home, project }) => {
        const store = openOwnerCoordinationStore({ dbPath: join(home, "owner.sqlite3") });
        store.registerProject({ root: project, displayName: "A" });
        const pairing = store.createPairingRequest();
        store.approvePairingRequest(pairing.code);
        const device = store.claimPairingRequest(pairing.proof);
        const origin = "http://127.0.0.1:8787";
        const headers = {
            cookie: `rw_owner_device=${encodeURIComponent(device.credential)}; rw_owner_csrf=${encodeURIComponent(device.csrf)}`,
            "x-runwield-csrf": device.csrf,
            origin,
            "content-type": "application/json",
        };
        const globalRoot = join(home, ".wld");
        const before = await readFile(join(globalRoot, "settings.json"), "utf8");
        configureRemotePersonalResources({ globalRoot });
        const app = createOwnerWorkspaceApp({ mode: "owner", publicOrigin: origin, store });
        try {
            const get = await app.handler()(new Request(`${origin}/api/owner/usage/settings`, { headers }));
            assertEquals(get.status, 200);
            const view = await get.json();
            assertEquals(view.exportAvailable, false);
            assertStringIncludes(view.unavailableReason, "remote-backed");
            assertEquals(view.exporters, []);
            assertEquals(view.destinations, []);
            for (const action of ["recording", "create", "destination", "projects", "credentials", "revoke", "clear"]) {
                const response = await app.handler()(
                    new Request(`${origin}/api/owner/usage/${action === "clear" ? "clear" : `settings/${action}`}`, {
                        method: "POST",
                        headers,
                        body: "{}",
                    }),
                );
                assertEquals(response.status, 409);
                assertEquals((await response.json()).error, view.unavailableReason);
            }
            assertEquals(await readFile(join(globalRoot, "settings.json"), "utf8"), before);
        } finally {
            await app.close();
            store.close();
        }
    });
});
