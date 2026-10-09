import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";

import { RUNWIELD_ROOT } from "../../../runtime-root.js";
import { workspaceMetadata as _workspaceMetadata } from "./server/plan-adapter.js";

import {
    parseMaxRequestBytes,
    parsePort,
    parseRetentionDays,
    readRemoteServerConfig,
    REMOTE_CLEANUP_INTERVAL_MS,
    runRemoteWorkspaceServer,
} from "./remote-server.ts";
import { handleRemoteSpaceApi } from "./server/remote-dev-api.js";
import { isRemoteDevelopmentModeEnabled } from "./server/remote-mode.ts";

import { createWorkspaceApp } from "./server.js";

import { createTestApiContext, createTestEnv } from "./workspace-test-helpers.js";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";

Deno.test("remote Shared Space development gate requires both development and remote mode", () => {
    assertEquals(isRemoteDevelopmentModeEnabled({ isDevelopment: true, workspaceMode: "remote" }), true);
    assertEquals(isRemoteDevelopmentModeEnabled({ isDevelopment: true, workspaceMode: "local" }), false);
    assertEquals(isRemoteDevelopmentModeEnabled({ isDevelopment: true, workspaceMode: undefined }), false);
    assertEquals(isRemoteDevelopmentModeEnabled({ isDevelopment: false, workspaceMode: "remote" }), false);
});

Deno.test("remote development API and page share the central gate", async () => {
    const apiSource = await Deno.readTextFile(join(RUNWIELD_ROOT, "src/ui/workspace/server/remote-dev-api.js"));
    const pageSource = await Deno.readTextFile(join(RUNWIELD_ROOT, "src/ui/workspace/pages/p/[spaceId].astro"));
    assertStringIncludes(apiSource, "isRemoteDevelopmentModeEnabled");
    assertStringIncludes(pageSource, "isRemoteDevelopmentModeEnabled");
});

Deno.test("remote development API rejects non-development and non-remote requests", async () => {
    // RUNWIELD_WORKSPACE_MODE is process-global; without the lock this window is
    // visible to every other test file running concurrently.
    await withProcessGlobalTestLock(async () => {
        const originalMode = Deno.env.get("RUNWIELD_WORKSPACE_MODE");
        try {
            Deno.env.set("RUNWIELD_WORKSPACE_MODE", "remote");
            const nonDevelopment = await handleRemoteSpaceApi(
                createTestApiContext(new Request("http://localhost/api/spaces")),
            );
            assertEquals(nonDevelopment.status, 404);
            assertEquals(await nonDevelopment.json(), { error: "Not found" });

            Deno.env.set("RUNWIELD_WORKSPACE_MODE", "local");
            const nonRemote = await handleRemoteSpaceApi(
                createTestApiContext(new Request("http://localhost/api/spaces")),
            );
            assertEquals(nonRemote.status, 404);
            assertEquals(await nonRemote.json(), { error: "Not found" });
        } finally {
            if (originalMode === undefined) Deno.env.delete("RUNWIELD_WORKSPACE_MODE");
            else Deno.env.set("RUNWIELD_WORKSPACE_MODE", originalMode);
        }
    });
});

Deno.test("remote Shared Space review route is isolated to remote mode", async () => {
    const localApp = createWorkspaceApp({ cwd: Deno.cwd(), token: "secret" }).handler();
    const localResponse = await localApp(new Request("http://localhost/p/space-1?token=secret"));
    assertEquals(localResponse.status, 404);

    const remoteApp = createWorkspaceApp({ mode: "remote" }).handler();
    const remoteResponse = await remoteApp(new Request("http://localhost/p/space-1"));
    assertEquals(remoteResponse.status === 200 || remoteResponse.status === 503, true);
});

Deno.test("remote Workspace health and readiness endpoints are remote-only and non-secret", async () => {
    const localApp = createWorkspaceApp({ cwd: Deno.cwd(), token: "secret" }).handler();
    assertEquals((await localApp(new Request("http://localhost/healthz?token=secret"))).status, 404);
    assertEquals((await localApp(new Request("http://localhost/readyz?token=secret"))).status, 404);

    const remoteApp = createWorkspaceApp({ mode: "remote" }).handler();
    const remoteResponse = await remoteApp(new Request("http://localhost/healthz"));
    assertEquals(remoteResponse.status, 200);
    assertEquals(remoteResponse.headers.get("cache-control"), "no-store");
    assertEquals(await remoteResponse.json(), { ok: true, mode: "remote" });

    const readyResponse = await remoteApp(new Request("http://localhost/readyz"));
    assertEquals(readyResponse.status, 200);
    assertEquals(await readyResponse.json(), { ok: true, mode: "remote" });
});

Deno.test("remote server entry reads env defaults and validates ports", () => {
    assertEquals(
        readRemoteServerConfig(createTestEnv({
            RUNWIELD_REMOTE_HOST: "127.0.0.1",
            RUNWIELD_REMOTE_PORT: "9001",
            RUNWIELD_REMOTE_DB_PATH: "/tmp/runwield.sqlite",
            RUNWIELD_REMOTE_MAX_REQUEST_BYTES: "2048",
            RUNWIELD_REMOTE_RETENTION_DAYS: "7",
        })),
        {
            host: "127.0.0.1",
            port: 9001,
            dbPath: "/tmp/runwield.sqlite",
            maxRequestBytes: 2048,
            retentionDays: 7,
        },
    );
    assertEquals(parsePort(undefined), 8080);
    assertEquals(parsePort("65535"), 65535);
    assertEquals(parseMaxRequestBytes(undefined), 5 * 1024 * 1024);
    assertEquals(parseRetentionDays("0"), undefined);
});

Deno.test("remote server entry runs the real adapter, HTTP server, and cleanup lifecycle", async () => {
    const cwd = await Deno.makeTempDir({ prefix: "runwield-remote-server-main-" });
    const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const port = listener.addr.port;
    listener.close();
    const controller = new AbortController();
    /** @type {(() => void) | undefined} */
    let cleanupCallback;
    let clearedTimer;
    try {
        const dbPath = `${cwd}/test-remote-server.sqlite`;
        const run = runRemoteWorkspaceServer(
            {
                host: "127.0.0.1",
                port,
                dbPath,
                maxRequestBytes: 2048,
                retentionDays: 7,
            },
            controller.signal,
            {
                setInterval(callback, delay) {
                    assertEquals(delay, REMOTE_CLEANUP_INTERVAL_MS);
                    cleanupCallback = callback;
                    return 73;
                },
                clearInterval(timer) {
                    clearedTimer = timer;
                },
            },
            () => {},
        );

        let healthResponse;
        for (let attempt = 0; attempt < 50; attempt += 1) {
            healthResponse = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined);
            if (healthResponse) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assertEquals(await healthResponse?.json(), { ok: true, mode: "remote" });
        assertEquals(typeof cleanupCallback, "function");
        if (!cleanupCallback) throw new Error("Cleanup interval was not scheduled.");
        cleanupCallback();
        assertEquals((await Deno.stat(dbPath)).isFile, true);

        controller.abort();
        await run;
        assertEquals(clearedTimer, 73);
    } finally {
        controller.abort();
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("remote Shared Space review route SSR smoke keeps fragments out of rendered shell", async () => {
    const remoteApp = createWorkspaceApp({ mode: "remote" }).handler();
    const response = await remoteApp(new Request("http://localhost/p/smoke-space#key=secret-key&cap=secret-cap"));
    assertEquals(response.status === 200 || response.status === 503, true);
    if (response.status === 200) {
        const html = await response.text();
        assertStringIncludes(html, "Remote Plan Review");
        assertEquals(html.includes("secret-key"), false);
        assertEquals(html.includes("secret-cap"), false);
    }
});
