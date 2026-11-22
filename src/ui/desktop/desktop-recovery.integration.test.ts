import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DesktopDraftStore } from "./draft-store.ts";
import { openFileSessionStore } from "../../shared/session/file-session-store.ts";
import { join } from "node:path";
import { makeSessionProcessFixture } from "../../acp/client/testing/session-process-fixture.ts";
import { launchDesktop } from "./testing/desktop-fixture.ts";
import type { SessionClientView, WorkspaceSessionClient } from "../workspace/client/session-client.ts";
import type { DesktopProjectClient } from "../workspace/client/project-client.ts";
import type { DesktopWorkbenchClient } from "../workspace/client/desktop-workbench.ts";

interface DesktopGlobals {
    runwieldSession: WorkspaceSessionClient;
    runwieldProjects: DesktopProjectClient;
    runwieldWorkbench: DesktopWorkbenchClient;
}
type DesktopWindow = typeof globalThis & DesktopGlobals;
type Desktop = Awaited<ReturnType<typeof launchDesktop>>;
function view(page: Desktop["page"]) {
    return page.evaluate(
        () =>
            new Promise<SessionClientView>((resolve) => {
                const stop = (globalThis as DesktopWindow).runwieldSession.observe((next) => {
                    resolve(next);
                    queueMicrotask(() => stop());
                });
            }),
    );
}
async function waitForExit(pid: number) {
    for (let attempt = 0; attempt < 100; attempt++) {
        try {
            process.kill(pid, 0);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
            throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Runtime ${pid} survived its main-process owner.`);
}

test(
    "main SIGKILL restores every binding, private navigation and bounds without replay or orphan runtime",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        let desktop: Desktop | undefined;
        const old: Desktop[] = [];
        try {
            fixture.provider.enqueue(
                { text: "Saved binding without unsent drafts." },
                { text: "Deliberately submitted restored composer." },
            );
            desktop = await launchDesktop(fixture);
            let page = desktop.page;
            await page.getByRole("button", { name: "New Session", exact: true }).click();
            await page.getByText("Ready", { exact: true }).waitFor();
            await page.getByLabel("Message", { exact: true }).fill("Keep this history binding even without a draft.");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.getByText("Saved binding without unsent drafts.", { exact: true }).waitFor();
            await page.getByText("Ready", { exact: true }).waitFor();
            const first = await view(page);
            const projectId = first.bindings![0].projectId;
            equal(
                await page.evaluate(async () => {
                    const preferences = (globalThis as DesktopWindow).runwieldWorkbench;
                    const navigation = await preferences.read();
                    try {
                        await preferences.write({
                            ...navigation,
                            selectedProjectId: "not-registered",
                            showSession: false,
                        });
                        return false;
                    } catch {
                        return true;
                    }
                }),
                true,
                "renderer preferences cannot grant Project access",
            );
            await desktop.application.evaluate(({ Menu }) => {
                const item = Menu.getApplicationMenu()!
                    .items.find((entry) => entry.label === "File")!
                    .submenu!.items.find((entry) => entry.label === "New Session")!;
                if (item.accelerator !== "CmdOrCtrl+N") throw new Error("New Session must have its platform shortcut.");
                item.click();
            });
            await page.waitForFunction(
                () => document.querySelector<HTMLInputElement>("#saved-session-id")?.value === "",
            );
            const second = await view(page);
            equal(second.bindings?.length, 2);
            await page
                .getByLabel("Message", { exact: true })
                .fill("Restore this new composer without saving a Session.");
            await page.evaluate(async (id) => {
                const preferences = (globalThis as DesktopWindow).runwieldWorkbench;
                const navigation = await preferences.read();
                await preferences.write({ ...navigation, expandedProjects: [id], collapsed: true });
                // Browser storage is not desktop authority.
                localStorage.setItem("runwield:owner:sidebar-collapsed", "false");
                localStorage.setItem("runwield:desktop:expanded-projects", "[]");
            }, projectId);
            const bounds = await desktop.application.evaluate(({ BrowserWindow }) => {
                const window = BrowserWindow.getAllWindows()[0];
                window.setBounds({ x: 45, y: 55, width: 1080, height: 760 });
                return window.getBounds();
            });
            // Wait for public main-owned stores to commit before simulating abrupt power loss.
            const profile = join(fixture.home, "electron-profile");
            for (let attempt = 0; attempt < 100; attempt++) {
                const data = await readFile(join(profile, "desktop-intent", "drafts.json"), "utf8");
                const preferences = await readFile(join(profile, "desktop-preferences", "preferences.json"), "utf8");
                if (
                    data.includes("Restore this new composer") &&
                    preferences.includes('"collapsed":true') &&
                    preferences.includes('"width":1080')
                )
                    break;
                if (attempt === 99) throw new Error("Private desktop stores did not commit.");
                await new Promise((resolve) => setTimeout(resolve, 30));
            }
            const runtimePid = desktop.runtimePid;
            old.push(desktop);
            await desktop.crashMain();
            await waitForExit(runtimePid);
            desktop = await launchDesktop(fixture);
            page = desktop.page;
            equal(
                await page.getByLabel("Message", { exact: true }).inputValue(),
                "Restore this new composer without saving a Session.",
            );
            const restored = await view(page);
            equal(restored.durableSessionId, "");
            equal(restored.bindings?.length, 2, "bindings without unsent drafts are recovered too");
            ok(restored.bindings?.some((binding) => binding.durableSessionId === first.durableSessionId));
            const navigation = await page.evaluate(() => (globalThis as DesktopWindow).runwieldWorkbench.read());
            equal(navigation.collapsed, true);
            deepEqual(navigation.expandedProjects, [projectId]);
            equal(navigation.showSession, true);
            deepEqual(
                await desktop.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds()),
                bounds,
            );
            if (process.platform !== "win32") {
                equal((await stat(join(profile, "desktop-preferences"))).mode & 0o777, 0o700);
                equal((await stat(join(profile, "desktop-preferences", "preferences.json"))).mode & 0o777, 0o600);
            }
            equal(fixture.provider.requests.length, 1);
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.getByText("Deliberately submitted restored composer.", { exact: true }).waitFor();
            await page.getByText("Ready", { exact: true }).waitFor();
            await page.evaluate(
                async ({ projectId, sessionId }) => {
                    const desktop = globalThis as DesktopWindow;
                    await desktop.runwieldProjects.openProject({ projectId });
                    await desktop.runwieldSession.load(sessionId);
                },
                { projectId, sessionId: first.durableSessionId },
            );
            await page.getByText("Saved binding without unsent drafts.", { exact: true }).waitFor();
            equal(fixture.provider.requests.length, 2);
            deepEqual(fixture.provider.failures, []);
        } finally {
            try {
                await desktop?.close();
            } finally {
                for (const previous of old) await previous.close();
                await fixture.cleanup();
            }
        }
    },
);

test(
    "renderer SIGKILL replaces only the view while a real provider operation continues",
    { timeout: 40000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        let desktop: Desktop | undefined;
        try {
            fixture.provider.enqueue({ text: "Live output before renderer death.", hold: true });
            desktop = await launchDesktop(fixture);
            const { page, application, runtimePid } = desktop;
            const mainPid = application.process().pid;
            await page.getByRole("button", { name: "New Session", exact: true }).click();
            await page.getByText("Ready", { exact: true }).waitFor();
            await page
                .getByLabel("Message", { exact: true })
                .fill("Do not restart this live operation with its renderer.");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.getByText("Live output before renderer death.", { exact: true }).waitFor();
            const before = await view(page);
            ok(before.operationId);
            const replacement = application.waitForEvent("window");
            await application.evaluate(({ BrowserWindow }) =>
                process.kill(BrowserWindow.getAllWindows()[0].webContents.getOSProcessId(), "SIGKILL"),
            );
            const next = await replacement;
            fixture.provider.emit("The same operation survived renderer death.");
            await next.getByText("The same operation survived renderer death.", { exact: false }).waitFor();
            const current = await view(next);
            equal(current.operationId, before.operationId);
            equal(current.durableSessionId, before.durableSessionId);
            equal(current.phase, "streaming");
            equal(application.process().pid, mainPid);
            process.kill(runtimePid, 0);
            equal(fixture.provider.requests.length, 1);
            fixture.provider.release();
            await next.getByText("Ready", { exact: true }).waitFor();
            equal(await next.getByText("The same operation survived renderer death.", { exact: false }).count(), 1);
            await application.evaluate(
                ({ BrowserWindow }) =>
                    new Promise<void>((resolve) => {
                        const window = BrowserWindow.getAllWindows()[0];
                        window.once("closed", resolve);
                        window.close();
                    }),
            );
            const reopened = application.waitForEvent("window");
            await application.evaluate(({ Menu }) => {
                Menu.getApplicationMenu()!
                    .items.find((item) => item.label === "File")!
                    .submenu!.items.find((item) => item.label === "New Session")!
                    .click();
            });
            const composer = await reopened;
            await composer.waitForFunction(
                async () =>
                    new Promise<boolean>((resolve) => {
                        const stop = (globalThis as DesktopWindow).runwieldSession.observe((next) => {
                            resolve(next.bindings?.length === 2 && next.durableSessionId === "");
                            queueMicrotask(() => stop());
                        });
                    }),
            );
            await composer.getByText("Ready", { exact: true }).waitFor();
            const newView = await view(composer);
            equal(newView.bindings?.length, 2, "native New Session recreates a view before creating its composer");
            equal(newView.durableSessionId, "");
            equal(fixture.provider.requests.length, 1);
            deepEqual(fixture.provider.failures, []);
        } finally {
            fixture.provider.release();
            try {
                await desktop?.close();
            } finally {
                await fixture.cleanup();
            }
        }
    },
);

test(
    "an unknown native receipt retains exact intent and requires new input instead of replay",
    { timeout: 40000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        let desktop: Desktop | undefined;
        try {
            fixture.provider.enqueue({ text: "Canonical history before uncertain input." });
            desktop = await launchDesktop(fixture);
            await desktop.page.getByRole("button", { name: "New Session", exact: true }).click();
            await desktop.page.getByText("Ready", { exact: true }).waitFor();
            await desktop.page.getByLabel("Message", { exact: true }).fill("Create canonical baseline.");
            await desktop.page.getByRole("button", { name: "Send", exact: true }).click();
            await desktop.page.getByText("Canonical history before uncertain input.", { exact: true }).waitFor();
            await desktop.page.getByText("Ready", { exact: true }).waitFor();
            const saved = await view(desktop.page);
            const projectId = saved.bindings!.find((binding) => binding.sessionId === saved.sessionId)!.projectId;
            await desktop.close();
            const canonical = openFileSessionStore({ baseDir: join(fixture.home, ".wld", "sessions") });
            let generation: number;
            try {
                generation = canonical.inspectSessionActivation(saved.durableSessionId).generation!.generation;
            } finally {
                canonical.close();
            }
            // A real process leaves a running receipt without a live owner. No runtime or receipt seam.
            const orphan = spawnSync(
                fixture.bunExecutable,
                [
                    "run",
                    fileURLToPath(new URL("../../shared/session/testing/history-runtime-process.ts", import.meta.url)),
                    "orphan-receipt",
                    saved.durableSessionId,
                ],
                { cwd: fixture.project, env: fixture.env, encoding: "utf8", timeout: 10000 },
            );
            equal(orphan.status, 0, orphan.stderr);
            const drafts = await DesktopDraftStore.open(join(fixture.home, "electron-profile"));
            const location = { projectId, durableSessionId: saved.durableSessionId, composerKey: saved.sessionId };
            const composer = { requestId: "lost-receipt", text: "Keep uncertain draft.", images: [] };
            await drafts.write(location, composer);
            await drafts.submit(location, { ...composer, expectedGeneration: generation, kind: "prompt" });
            desktop = await launchDesktop(fixture);
            const { page } = desktop;
            await page.getByText(/previous input outcome is uncertain/).waitFor();
            equal((await view(page)).phase, "interrupted");
            equal(await page.getByLabel("Message", { exact: true }).inputValue(), composer.text);
            equal(fixture.provider.requests.length, 1);
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.getByRole("alert").filter({ hasText: "original input outcome is uncertain" }).waitFor();
            equal(fixture.provider.requests.length, 1, "deliberate Send cannot replay an unknown receipt");
            equal(await page.getByLabel("Message", { exact: true }).inputValue(), composer.text);
            fixture.provider.enqueue({ text: "New deliberate continuation accepted." });
            await page.getByLabel("Message", { exact: true }).fill("New input after inspecting the saved history.");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.getByText("New deliberate continuation accepted.", { exact: true }).waitFor();
            await page.getByText("Ready", { exact: true }).waitFor();
            equal(fixture.provider.requests.length, 2);
            deepEqual(fixture.provider.failures, []);
        } finally {
            try {
                await desktop?.close();
            } finally {
                await fixture.cleanup();
            }
        }
    },
);

test(
    "runtime SIGKILL restores parallel bindings, image draft and queue without automatic dispatch",
    { timeout: 40000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        let desktop: Desktop | undefined;
        try {
            fixture.provider.enqueue({ text: "Held operation before runtime loss.", hold: true });
            desktop = await launchDesktop(fixture);
            const { page } = desktop;
            await page.getByRole("button", { name: "New Session", exact: true }).click();
            await page.getByText("Ready", { exact: true }).waitFor();
            await page.getByLabel("Message", { exact: true }).fill("Do not automatically repeat this operation.");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.getByText("Held operation before runtime loss.", { exact: true }).waitFor();
            const first = await view(page);
            await page.getByLabel("Message", { exact: true }).fill("Queued input needs deliberate Send after restart.");
            await page.getByRole("button", { name: "Queue", exact: true }).click();
            await page
                .getByRole("list", { name: "Unsent follow-ups" })
                .getByText("Queued input needs deliberate Send after restart.", { exact: true })
                .waitFor();
            await page.getByRole("button", { name: "New Session", exact: true }).click();
            await page.getByText("Ready", { exact: true }).waitFor();
            const text = "  Exact private composer in another binding\n  ";
            await page.getByLabel("Message", { exact: true }).fill(text);
            const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
            await page.locator('input[type="file"]').setInputFiles({
                name: "runtime-private.png",
                mimeType: "image/png",
                buffer: Buffer.from(png, "base64"),
            });
            await page.getByRole("img", { name: "runtime-private.png", exact: true }).waitFor();
            const profile = join(fixture.home, "electron-profile");
            for (let attempt = 0; attempt < 100; attempt++) {
                const entries = await (await DesktopDraftStore.open(profile)).list();
                if (entries.some((entry) => entry.composer?.text === text && entry.composer.images[0]?.base64 === png))
                    break;
                if (attempt === 99) throw new Error("Image draft did not commit before runtime loss.");
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            process.kill(desktop.runtimePid, "SIGKILL");
            await page.getByRole("button", { name: "Restart runtime", exact: true }).click();
            await page.evaluate(() => (globalThis as DesktopWindow).runwieldWorkbench.read());
            await page.waitForFunction(
                (text) => document.querySelector<HTMLTextAreaElement>("#session-message")?.value === text,
                text,
            );
            await page.getByRole("img", { name: "runtime-private.png", exact: true }).waitFor();
            equal(
                await page.getByRole("img", { name: "runtime-private.png", exact: true }).getAttribute("src"),
                `data:image/png;base64,${png}`,
            );
            const restored = await view(page);
            equal(restored.bindings?.length, 2);
            equal(restored.durableSessionId, "", "the new composer selection survives runtime replacement");
            const bound = restored.bindings!.find((binding) => binding.durableSessionId === first.durableSessionId)!;
            ok(bound);
            await page
                .getByRole("complementary", { name: "Workspace navigation" })
                .getByTitle(bound.sessionId, { exact: true })
                .click();
            await page.getByRole("button", { name: "Send queued message", exact: true }).waitFor();
            await new Promise((resolve) => setTimeout(resolve, 600));
            equal(fixture.provider.requests.length, 1, "neither the lost operation nor queue may dispatch on restart");
            fixture.provider.release();
            fixture.provider.enqueue({ text: "Deliberate restored queue accepted once." });
            await page.getByRole("button", { name: "Send queued message", exact: true }).click();
            await page.getByText("Deliberate restored queue accepted once.", { exact: true }).waitFor();
            await page.getByText("Ready", { exact: true }).waitFor();
            equal(fixture.provider.requests.length, 2);
            ok(
                JSON.stringify(fixture.provider.requests[1].messages).includes(
                    "Queued input needs deliberate Send after restart.",
                ),
            );
            deepEqual(fixture.provider.failures, []);
        } finally {
            fixture.provider.release();
            try {
                await desktop?.close();
            } finally {
                await fixture.cleanup();
            }
        }
    },
);
