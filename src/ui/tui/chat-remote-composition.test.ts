import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { NO_OPEN_BROWSER_PORT } from "../../shared/browser-port.ts";
import { openFileSessionStore } from "../../shared/session/file-session-store.ts";
import { listProjectsFromDisk } from "../../shared/session/file-session-storage.ts";
import { getRunWieldSessionsBaseDir } from "../../shared/session/root-session.js";
import { startRemoteControlService } from "../../shared/remote/control.ts";
import { RemoteSessionControl } from "../../shared/remote/session-control-client.ts";
import { createInteractiveTuiComposition } from "./interactive-tui-composition.ts";
import { VirtualTerminal } from "./testing/virtual-terminal.js";

Deno.test("remote TUI composition stays dormant with a normal composer and creates no laptop Session", async () => {
    await withRuntimeCommandFixture("remote-tui-composition-", async ({ projectRoot }) => {
        Deno.chdir(projectRoot);
        const baseDir = join(projectRoot, "laptop-history");
        const store = openFileSessionStore({ baseDir });
        const identity = { buildId: "a".repeat(64), protocol: 1 };
        const service = startRemoteControlService(identity, {
            store,
            targetLabel: `remote:${projectRoot}`,
            target: {
                cwd: projectRoot,
                home: projectRoot,
                os: "Linux",
                arch: "x86_64",
                gitRoot: projectRoot,
                primaryRoot: projectRoot,
                gitDir: join(projectRoot, ".git"),
                gitCommonDir: join(projectRoot, ".git"),
                isWorktree: false,
                host: { hostname: "remote.example", user: "tester", port: 22, hostKeyFingerprint: "SHA256:fixture" },
            },
        });
        const control = new RemoteSessionControl({ port: service.port, credential: service.credential });
        try {
            for (const [path, body] of [["handshake", JSON.stringify(identity)], ["readiness", ""]]) {
                const response = await fetch(`http://127.0.0.1:${service.port}/${path}`, {
                    method: "POST",
                    headers: { Authorization: `Bearer ${service.credential}` },
                    body,
                });
                await response.text();
                assertEquals(response.ok, true);
            }
            const terminal = new VirtualTerminal({ columns: 120, rows: 30 });
            const composition = await createInteractiveTuiComposition(null, {
                browser: NO_OPEN_BROWSER_PORT,
                terminal,
                skipModelWelcome: true,
                remoteSessionControl: control,
            });
            try {
                await composition.waitForIdle();
                terminal.typeText("Unsubmitted remote question");
                await composition.waitForIdle();
                await terminal.flush();
                assertStringIncludes(terminal.getScreenText(), "Unsubmitted remote question");
                assertEquals(await composition.runtime.listResumableSessions(projectRoot), []);
                assertEquals(await control.list(), []);
                assertEquals(listProjectsFromDisk(baseDir), []);
                assertEquals(await Deno.stat(getRunWieldSessionsBaseDir()).then(() => true, () => false), false);
                assertEquals(Array.from(Deno.readDirSync(baseDir)), []);
            } finally {
                await composition.dispose();
            }
        } finally {
            await service.close();
            store.close();
        }
    });
});
