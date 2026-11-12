import { test } from "node:test";
import { deepEqual, equal, match, ok } from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeSessionProcessFixture } from "../../acp/client/testing/session-process-fixture.ts";
import { openFileSessionStore } from "../../shared/session/file-session-store.ts";
import type { SessionClientView, WorkspaceSessionClient } from "../workspace/client/session-client.ts";
import { launchDesktop } from "./testing/desktop-fixture.ts";

type Desktop = Awaited<ReturnType<typeof launchDesktop>>;
type DesktopWindow = typeof globalThis & DesktopGlobals;
interface DesktopGlobals {
    runwieldSession: WorkspaceSessionClient;
    runwieldLinks: { open(href: string): Promise<void> };
    injectionRan?: boolean;
}
function readView(desktop: Desktop): Promise<SessionClientView> {
    return desktop.page.evaluate(
        () =>
            new Promise<SessionClientView>((resolve) => {
                const stop = (globalThis as DesktopWindow).runwieldSession.observe((view) => {
                    resolve(view);
                    queueMicrotask(() => stop());
                });
            }),
    );
}

test(
    "native bridge rejects malformed, oversized and foreign requests without canonical mutation",
    { timeout: 40000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        let desktop: Desktop | undefined;
        try {
            desktop = await launchDesktop(fixture);
            await desktop.page.getByRole("button", { name: "New Session", exact: true }).click();
            await desktop.page.getByText("Ready", { exact: true }).waitFor();
            const before = await readView(desktop);
            const store = openFileSessionStore({ baseDir: join(fixture.home, ".wld", "sessions") });
            try {
                const saved = store.findSessionByLocator({ piSessionId: before.durableSessionId });
                ok(saved);
                const manifest = store.readSessionManifest(saved.runwieldSessionId, saved.projectId);
                ok(manifest);
                const refusals = await desktop.page.evaluate(async (view) => {
                    const client = (globalThis as DesktopWindow).runwieldSession;
                    const binding = {
                        connectionId: view.connectionId,
                        project: view.project,
                        sessionId: view.sessionId,
                    };
                    const unexpected = { ...binding, unexpected: "field" };
                    const operations = [
                        () => client.send({ ...binding, connectionId: "foreign" }, "Do not send"),
                        () => client.send({ ...binding, project: "/another/project" }, "Do not send"),
                        () => client.close({ ...binding, sessionId: "foreign" }),
                        () => client.send(binding, "x".repeat(65537)),
                        () => Reflect.apply(client.send, client, [binding, 42]),
                        () => Reflect.apply(client.cancel, client, [null]),
                        () => client.cancel(unexpected),
                        () => client.load("x".repeat(513)),
                        () => Reflect.apply(client.load, client, [42]),
                        () => client.answer(binding, { requestId: "stale", action: "accept", answer: "late" }),
                        () =>
                            client.answer(binding, { requestId: "stale", action: "accept", answer: "x".repeat(65537) }),
                        () =>
                            Reflect.apply(client.answer, client, [binding, { requestId: "stale", action: "invented" }]),
                    ];
                    const errors: string[] = [];
                    for (const operation of operations) {
                        try {
                            await operation();
                            errors.push("ACCEPTED");
                        } catch (error) {
                            errors.push(String(error));
                        }
                    }
                    return errors;
                }, before);
                equal(refusals.length, 12);
                ok(refusals.every((error) => error !== "ACCEPTED"));
                match(refusals[0], /does not belong/);
                match(refusals[3], /65,536/);
                match(refusals[5], /Invalid Session request/);
                match(refusals[6], /Unexpected Session request field/);
                match(refusals[9], /no longer waiting/);
                equal(fixture.provider.requests.length, 0);
                deepEqual(store.readSessionManifest(saved.runwieldSessionId, saved.projectId), manifest);
                equal((await readView(desktop)).sessionId, before.sessionId);
            } finally {
                store.close();
            }
        } finally {
            try {
                await desktop?.close();
            } finally {
                await fixture.cleanup();
            }
        }
    },
);

test("main refuses a real IPC request from another WebContents", { timeout: 40000 }, async () => {
    const fixture = await makeSessionProcessFixture();
    let desktop: Desktop | undefined;
    try {
        desktop = await launchDesktop(fixture);
        const view = await readView(desktop);
        const preload = join(fixture.home, "untrusted-probe.cjs");
        await writeFile(
            preload,
            `const {contextBridge,ipcRenderer}=require("electron");contextBridge.exposeInMainWorld("probe",{create:(payload)=>ipcRenderer.invoke("desktop:session:create",payload)});`,
        );
        const result = await desktop.application.evaluate(
            async ({ BrowserWindow }, { preload, view }) => {
                const untrusted = new BrowserWindow({
                    show: false,
                    webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
                });
                try {
                    await untrusted.loadURL("data:text/html,<title>Untrusted caller</title>");
                    return await untrusted.webContents.executeJavaScript(
                        `globalThis.probe.create(${JSON.stringify(view)}).then(()=>"ACCEPTED",error=>error.message)`,
                    );
                } finally {
                    untrusted.destroy();
                }
            },
            { preload, view: { connectionId: view.connectionId, project: view.project, sessionId: view.sessionId } },
        );
        match(result, /Untrusted desktop sender/);
        equal(fixture.provider.requests.length, 0);
        equal((await readView(desktop)).sessionId, "");
        const store = openFileSessionStore({ baseDir: join(fixture.home, ".wld", "sessions") });
        try {
            deepEqual(store.listSessionProjects(), []);
        } finally {
            store.close();
        }
    } finally {
        try {
            await desktop?.close();
        } finally {
            await fixture.cleanup();
        }
    }
});

test("main refuses requests after its own window leaves the allowed origin", { timeout: 40000 }, async () => {
    const fixture = await makeSessionProcessFixture();
    let desktop: Desktop | undefined;
    try {
        desktop = await launchDesktop(fixture);
        const view = await readView(desktop);
        await desktop.application.evaluate(async ({ BrowserWindow }) => {
            await BrowserWindow.getAllWindows()[0].loadURL("data:text/html,<title>Foreign origin</title>");
        });
        await desktop.page.waitForURL("data:text/html,<title>Foreign origin</title>");
        const result = await desktop.page.evaluate(async (view) => {
            try {
                await (globalThis as DesktopWindow).runwieldSession.cancel(view);
                return "ACCEPTED";
            } catch (error) {
                return String(error);
            }
        }, view);
        match(result, /Untrusted desktop sender/);
        equal(fixture.provider.requests.length, 0);
    } finally {
        try {
            await desktop?.close();
        } finally {
            await fixture.cleanup();
        }
    }
});

test(
    "model content cannot execute code, navigate, open popups or access local assets outside the renderer",
    { timeout: 40000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        let desktop: Desktop | undefined;
        try {
            fixture.provider.enqueue({
                text: `Hostile marker.\n\n<script data-attack>globalThis.injectionRan=true;globalThis.runwieldLinks.open('https://example.invalid/automatic')</script>\n\n<img src=x onerror="globalThis.injectionRan=true">\n\n[Unsafe](javascript:globalThis.injectionRan=true)\n\n[Safe site](https://example.invalid/deliberate)`,
            });
            desktop = await launchDesktop(fixture);
            // The operating-system browser launch is the external boundary, not the IPC handler under test.
            await desktop.application.evaluate(({ shell, BrowserWindow }) => {
                const navigation = Promise.withResolvers<boolean>();
                Reflect.set(globalThis, "navigationRefusal", navigation.promise);
                BrowserWindow.getAllWindows()[0].webContents.once("will-frame-navigate", (event) =>
                    navigation.resolve(event.defaultPrevented),
                );
                const opened: string[] = [];
                Reflect.set(globalThis, "openedLinks", opened);
                shell.openExternal = (href) => {
                    opened.push(href);
                    return Promise.resolve();
                };
            });
            const { page } = desktop;
            // Playwright's page.evaluate grants user activation; this probe must not grant it.
            const cdp = await page.context().newCDPSession(page);
            const automatic = await cdp.send("Runtime.evaluate", {
                expression: `new Promise(resolve => {
                    const deadline = Date.now() + 7000;
                    function probe() {
                        if (navigator.userActivation.isActive) {
                            if (Date.now() > deadline) return resolve("Activation did not settle");
                            return setTimeout(probe, 10);
                        }
                        globalThis.runwieldLinks.open("https://example.invalid/automatic").then(
                            () => resolve("ACCEPTED"), error => resolve(error.message));
                    }
                    probe();
                })`,
                userGesture: false,
                awaitPromise: true,
                returnByValue: true,
            });
            match(automatic.result.value, /Activate a link/);
            await page.getByRole("button", { name: "New Session", exact: true }).click();
            await page.getByText("Ready", { exact: true }).waitFor();
            await page.getByLabel("Message", { exact: true }).fill("Show hostile content safely.");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.getByText("Ready", { exact: true }).waitFor();
            await page.getByRole("link", { name: "Safe site", exact: true }).waitFor();
            equal(await page.locator("script[data-attack], img[onerror], a[href^='javascript:']").count(), 0);
            equal(await page.evaluate(() => Boolean((globalThis as DesktopWindow).injectionRan)), false);
            deepEqual(await desktop.application.evaluate(() => Reflect.get(globalThis, "openedLinks")), []);
            equal(await desktop.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
            await page.evaluate(() => {
                const probe = document.createElement("button");
                probe.textContent = "Probe unsafe link";
                probe.onclick = () => {
                    void (globalThis as DesktopWindow).runwieldLinks.open("file:///etc/passwd").then(
                        () => Reflect.set(globalThis, "linkRefusal", "ACCEPTED"),
                        (error: Error) => Reflect.set(globalThis, "linkRefusal", error.message),
                    );
                };
                document.body.append(probe);
            });
            await page.getByRole("button", { name: "Probe unsafe link", exact: true }).click();
            await page.waitForFunction(() => Boolean(Reflect.get(globalThis, "linkRefusal")));
            match(await page.evaluate(() => Reflect.get(globalThis, "linkRefusal")), /Only HTTP and HTTPS/);
            await page.getByRole("link", { name: "Safe site", exact: true }).click();
            deepEqual(await desktop.application.evaluate(() => Reflect.get(globalThis, "openedLinks")), [
                "https://example.invalid/deliberate",
            ]);
            equal(page.url(), "runwield://app/");
            const assets = await desktop.application.evaluate(async ({ net }) => {
                const responses = [];
                for (const path of [
                    "runwield://other/",
                    "runwield://app/%2e%2e%2fmain.mjs",
                    "runwield://app/../main.mjs",
                ]) {
                    const response = await net.fetch(path);
                    responses.push(response.status);
                }
                return responses;
            });
            ok(assets.every((status) => status === 403 || status === 404));
            const policy = await desktop.application.evaluate(async ({ net }) =>
                (await net.fetch("runwield://app/")).headers.get("Content-Security-Policy"),
            );
            ok(policy);
            match(policy, /script-src 'self'/);
            match(policy, /connect-src 'none'/);
            await page.evaluate(() => {
                const script = document.createElement("script");
                script.textContent = "globalThis.injectionRan=true";
                document.body.append(script);
            });
            equal(await page.evaluate(() => Boolean((globalThis as DesktopWindow).injectionRan)), false);
            await page.evaluate(() => {
                location.href = "https://example.invalid/navigation";
                globalThis.open("https://example.invalid/popup");
            });
            equal(await desktop.application.evaluate(() => Reflect.get(globalThis, "navigationRefusal")), true);
            equal(page.url(), "runwield://app/");
            equal(await desktop.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
            equal(fixture.provider.requests.length, 1);
            ok(
                desktop.errors.every((error) => /Content Security Policy|frame-ancestors/i.test(error)),
                desktop.errors.join("\n"),
            );
        } finally {
            try {
                await desktop?.close();
            } finally {
                await fixture.cleanup();
            }
        }
    },
);
