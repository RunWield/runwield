import { test } from "node:test";
import { strict as assert } from "node:assert";
import { getCapabilities, setCapabilities } from "@earendil-works/pi-tui";
import { createRemoteBrowserPort } from "../../shared/remote/browser-bridge.ts";
import { createChatView } from "./chat-view.ts";
import { RunWieldTui } from "./tui.ts";
import { withSessionViewFixture } from "./testing/session-view-fixture.ts";
import { chmod, writeFile, readFile } from "node:fs/promises";
import { stat as fsStat } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { delimiter, join } from "node:path";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { NO_OPEN_BROWSER_PORT } from "../../shared/browser-port.ts";
import { openFileSessionStore } from "../../shared/session/file-session-store.ts";
import { listProjectsFromDisk } from "../../shared/session/file-session-storage.ts";
import { getRunWieldSessionsBaseDir } from "../../shared/session/root-session.js";
import { startRemoteControlService } from "../../shared/remote/control.ts";
import { RemoteSessionControl } from "../../shared/remote/session-control-client.ts";
import { createInteractiveTuiComposition } from "./interactive-tui-composition.ts";
import { VirtualTerminal } from "./testing/virtual-terminal.js";

import process from "node:process";

test("remote TUI composition stays dormant with a normal composer and creates no laptop Session", async () => {
    await withRuntimeCommandFixture("remote-tui-composition-", async ({ projectRoot }) => {
        process.chdir(projectRoot);
        const baseDir = join(projectRoot, "laptop-history");
        const store = openFileSessionStore({ baseDir });
        const identity = { buildId: "a".repeat(64), protocol: 1 };
        const service = startRemoteControlService(identity, {
            baseDir: store.path,
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
            for (const [path, body] of [
                ["handshake", JSON.stringify(identity)],
                ["readiness", ""],
            ]) {
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
                assertEquals(
                    await fsStat(getRunWieldSessionsBaseDir()).then(
                        () => true,
                        () => false,
                    ),
                    false,
                );
                assertEquals(Array.from(readdirSync(baseDir, { withFileTypes: true })), []);
            } finally {
                await composition.dispose();
            }
        } finally {
            await service.close();
            store.close();
        }
    });
});

/** Run only inside a fixture that holds the process-global test lock. */
interface BrowserExecutable {
    opened(): Promise<string[]>;
    restore(): void;
}

async function installBrowserExecutable(root: string): Promise<BrowserExecutable> {
    const log = join(root, "opened-browser-urls");
    const previousPath = process.env.PATH;
    const previousSandbox = process.env.WLD_TEST_SANDBOX_HOME;
    for (const command of ["open", "xdg-open"]) {
        const executable = join(root, command);
        await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${log}'\n`);
        await chmod(executable, 0o700);
    }
    process.env.PATH = `${root}${delimiter}${previousPath ?? ""}`;
    // PATH now contains disposable launchers, not the real desktop.
    delete process.env.WLD_TEST_SANDBOX_HOME;
    return {
        async opened() {
            return (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
        },
        restore() {
            if (previousSandbox === undefined) delete process.env.WLD_TEST_SANDBOX_HOME;
            else process.env.WLD_TEST_SANDBOX_HOME = previousSandbox;
            if (previousPath === undefined) delete process.env.PATH;
            else process.env.PATH = previousPath;
        },
    };
}

function clickText(terminal: VirtualTerminal, text: string): void {
    const lines = terminal.getViewportLines();
    const row = lines.findIndex((line) => line.includes(text));
    assert(row >= 0, `Missing clickable text: ${text}\n${terminal.getScreenText()}`);
    const column = lines[row].indexOf(text);
    terminal.input(`\x1b[<0;${column + 1};${row + 1}M`);
    terminal.input(`\x1b[<0;${column + 1};${row + 1}m`);
}

async function readyBrowserService(service: ReturnType<typeof startRemoteControlService>): Promise<void> {
    for (const route of ["handshake", "readiness"]) {
        const response = await fetch(`http://127.0.0.1:${service.port}/${route}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${service.credential}` },
            body: JSON.stringify({ buildId: "a".repeat(64), protocol: 1 }),
        });
        await response.text();
        assertEquals(response.status, 200);
    }
}

test(
    "composed TUI clicks use the authenticated remote browser and cannot open laptop-local links",
    {
        skip: process.platform === "win32",
    },
    async () => {
        await withRuntimeCommandFixture("remote-tui-browser-", async ({ projectRoot }) => {
            process.chdir(projectRoot);
            const executable = await installBrowserExecutable(projectRoot);
            const capabilities = getCapabilities();
            setCapabilities({ ...capabilities, hyperlinks: true });
            const service = startRemoteControlService(
                { buildId: "a".repeat(64), protocol: 1 },
                undefined,
                undefined,
                "http://127.0.0.1:43127",
            );
            try {
                await readyBrowserService(service);
                const terminal = new VirtualTerminal({ columns: 120, rows: 30 });
                const composition = await createInteractiveTuiComposition(null, {
                    browser: createRemoteBrowserPort({ port: service.port, credential: service.credential }),
                    terminal,
                    skipModelWelcome: true,
                });
                try {
                    const message = composition.uiAPI.appendAgentMessageStart("Guide");
                    message.appendText(
                        "[LaptopLocal](http://127.0.0.1:43128/private) and [PublicDocs](https://1.1.1.1/docs?q=remote)",
                    );
                    await composition.waitForIdle();
                    await terminal.flush();
                    clickText(terminal, "LaptopLocal");
                    await composition.waitForIdle();
                    clickText(terminal, "PublicDocs");
                    const deadline = performance.now() + 2000;
                    while ((await executable.opened()).length === 0 && performance.now() < deadline) {
                        await new Promise((resolve) => setTimeout(resolve, 10));
                    }
                    assertEquals(await executable.opened(), ["https://1.1.1.1/docs?q=remote"]);
                } finally {
                    await composition.dispose();
                }
            } finally {
                await service.close();
                executable.restore();
                setCapabilities(capabilities);
            }
        });
    },
);

test(
    "TUI artifact reader keeps its URL usable when the remote browser refuses the open",
    {
        skip: process.platform === "win32",
    },
    async () => {
        await withSessionViewFixture(async ({ projectRoot, runtime, sessionId, store }) => {
            process.chdir(projectRoot);
            const executable = await installBrowserExecutable(projectRoot);
            const service = startRemoteControlService({ buildId: "a".repeat(64), protocol: 1 });
            const terminal = new VirtualTerminal({ columns: 150, rows: 30 });
            const browser = createRemoteBrowserPort({ port: service.port, credential: service.credential });
            const tui = new RunWieldTui(terminal, browser);
            try {
                const managed = runtime.getSessionSnapshot(sessionId)?.managed;
                assert(managed);
                await writeFile(join(projectRoot, "reader.md"), "# Remote reader evidence\n");
                const proof = store.acquireSessionActivation({
                    runwieldSessionId: managed.runwieldSessionId,
                    projectId: managed.projectId,
                    ownerInstanceId: "remote-artifact-reader-fixture",
                    ownerProcessKind: "test",
                });
                try {
                    store.registerSessionArtifact(proof, {
                        kind: "prd",
                        title: "Remote reader",
                        path: "reader.md",
                        registeredBy: "Ideator",
                    });
                } finally {
                    store.releaseUnchangedActivation(proof);
                }
                const view = await createChatView({
                    browser,
                    tui,
                    documentLinks: null,
                    suppressStartupHeader: true,
                    getSessionId: () => sessionId,
                    sessionRuntime: runtime,
                    setActiveModel: () => Promise.resolve({ status: "active" }),
                });
                try {
                    tui.start();
                    view.editor.setText("Keep remote draft");
                    terminal.input("\x1b]");
                    tui.renderNow(true);
                    await terminal.flush();
                    terminal.pressEnter();
                    const deadline = performance.now() + 4000;
                    while (!terminal.getScreenText().includes("Open artifact: http") && performance.now() < deadline) {
                        tui.renderNow(true);
                        await terminal.flush();
                        await new Promise((resolve) => setTimeout(resolve, 10));
                    }
                    const screen = terminal.getScreenText();
                    assertStringIncludes(screen, "Open artifact: http");
                    const url = screen.match(/Open artifact: (http[^\s]+)/)?.[1];
                    assert(url);
                    const response = await fetch(url);
                    assertEquals(response.status, 200);
                    await response.text();
                    assertEquals(await executable.opened(), []);
                    assertEquals(view.editor.getText(), "Keep remote draft");
                } finally {
                    view.dispose();
                    tui.stop();
                }
            } finally {
                await service.close();
                executable.restore();
            }
        });
    },
);
