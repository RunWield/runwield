import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { DesktopDraftStore } from "./draft-store.ts";
import { openFileSessionStore } from "../../shared/session/file-session-store.ts";
import { makeSessionProcessFixture, waitForSession } from "../../acp/client/testing/session-process-fixture.ts";
import type {
    SessionClientView,
    WorkspaceSessionClient,
    WorkspaceSavedSessionClient,
} from "../workspace/client/session-client.ts";
import type { WorkspaceDraftClient } from "../workspace/client/session-drafts.ts";
import { launchDesktop } from "./testing/desktop-fixture.ts";

interface DesktopGlobals {
    runwieldSession: WorkspaceSessionClient;
}
type DesktopWindow = typeof globalThis & DesktopGlobals;

function readView(page: Awaited<ReturnType<typeof launchDesktop>>["page"]) {
    return page.evaluate(
        () =>
            new Promise<SessionClientView>((resolve) => {
                const stop = (globalThis as DesktopWindow).runwieldSession.observe((view) => {
                    resolve(view);
                    queueMicrotask(() => stop());
                });
            }),
    );
}

for (const reopen of ["activate", "second launch"] as const) {
    test(
        `window close preserves live work and ${reopen} attaches to the same runtime`,
        { timeout: 60000 },
        async () => {
            const fixture = await makeSessionProcessFixture();
            let desktop: Awaited<ReturnType<typeof launchDesktop>> | undefined;
            try {
                fixture.provider.enqueue({ text: "Output before view detaches.", hold: true });
                desktop = await launchDesktop(fixture);
                const { application, page, runtimePid } = desktop;
                const mainPid = application.process().pid;
                await page.getByRole("button", { name: "New Session", exact: true }).click();
                await page.getByText("Ready", { exact: true }).waitFor();
                await page.getByLabel("Message", { exact: true }).fill("Keep this operation running without a window.");
                await page.getByRole("button", { name: "Send", exact: true }).click();
                await page.getByText("Output before view detaches.", { exact: true }).waitFor();
                const before = await readView(page);
                const savedId = await page.getByLabel("Saved Session ID").inputValue();
                ok(savedId);
                const identity = await application.evaluate(({ BrowserWindow }) => {
                    const window = BrowserWindow.getAllWindows()[0];
                    const id = window.webContents.id;
                    return new Promise<number>((resolve) => {
                        window.once("closed", () => resolve(id));
                        window.close();
                    });
                });
                equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 0);
                process.kill(mainPid!, 0);
                process.kill(runtimePid, 0);
                fixture.provider.emit("Output while no window exists.");
                const replacement = application.waitForEvent("window");
                if (reopen === "activate") await application.evaluate(({ app }) => app.emit("activate"));
                else equal(await desktop.secondLaunch(), 0);
                const next = await replacement;
                await next.getByRole("button", { name: "Session", exact: true }).click();
                await next.getByText("Output while no window exists.", { exact: false }).waitFor();
                equal(await next.getByLabel("Saved Session ID").inputValue(), savedId);
                const current = await readView(next);
                equal(current.phase, "streaming");
                ok(before.operationId);
                equal(current.operationId, before.operationId);
                ok(
                    await application.evaluate(
                        ({ BrowserWindow }, oldId) => BrowserWindow.getAllWindows()[0].webContents.id !== oldId,
                        identity,
                    ),
                );
                equal(application.process().pid, mainPid);
                process.kill(runtimePid, 0);
                equal(fixture.provider.requests.length, 1);
                fixture.provider.release();
                await next.getByText("Ready", { exact: true }).waitFor();
                equal(await next.getByText("Output while no window exists.", { exact: false }).count(), 1);
                deepEqual(desktop.errors, []);
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
}

interface DraftDesktopGlobals extends DesktopGlobals {
    runwieldSession: WorkspaceSavedSessionClient & WorkspaceDraftClient;
}
type DraftDesktopWindow = typeof globalThis & DraftDesktopGlobals;

for (const loss of ["window close", "renderer loss", "Quit", "main loss"] as const) {
    test(`private text and image draft survives ${loss} without dispatch`, { timeout: 60000 }, async () => {
        const fixture = await makeSessionProcessFixture();
        let desktop: Awaited<ReturnType<typeof launchDesktop>> | undefined;
        try {
            fixture.provider.enqueue(
                { text: "Accepted baseline for durable draft identity." },
                { text: "Explicit restored send accepted." },
            );
            desktop = await launchDesktop(fixture);
            let page = desktop.page;
            await page.getByRole("button", { name: "New Session", exact: true }).click();
            await page.getByText("Ready", { exact: true }).waitFor();
            await page.getByLabel("Message", { exact: true }).fill("Create durable identity first.");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.getByText("Accepted baseline for durable draft identity.", { exact: true }).waitFor();
            await page.getByText("Ready", { exact: true }).waitFor();
            const savedId = await page.getByLabel("Saved Session ID").inputValue();
            const text = "  Keep exact private text\nwith trailing space  ";
            const image = Buffer.from("YWJj", "base64");
            await page.getByLabel("Message", { exact: true }).fill(text);
            await page
                .locator('.session-composer input[type="file"]')
                .setInputFiles({ name: "private.png", mimeType: "image/png", buffer: image });
            await page.getByRole("list", { name: "Attached images", exact: true }).getByRole("img").waitFor();
            await page.waitForFunction(async (expected) => {
                const client = (globalThis as DraftDesktopWindow).runwieldSession;
                const view = await new Promise<SessionClientView>((resolve) => {
                    const stop = client.observe((next) => {
                        resolve(next);
                        queueMicrotask(() => stop());
                    });
                });
                const snapshot = await client.readDraft({
                    connectionId: view.connectionId,
                    project: view.project,
                    sessionId: view.sessionId,
                });
                return snapshot.composer?.text === expected && snapshot.composer.images[0]?.base64 === "YWJj";
            }, text);
            const before = await page.evaluate(async () => {
                const client = (globalThis as DraftDesktopWindow).runwieldSession;
                const view = await new Promise<SessionClientView>((resolve) => {
                    const stop = client.observe((next) => {
                        resolve(next);
                        queueMicrotask(() => stop());
                    });
                });
                return client.readDraft({
                    connectionId: view.connectionId,
                    project: view.project,
                    sessionId: view.sessionId,
                });
            });
            if (loss === "renderer loss") {
                const replacement = desktop.application.waitForEvent("window");
                await desktop.application.evaluate(({ BrowserWindow }) =>
                    process.kill(BrowserWindow.getAllWindows()[0].webContents.getOSProcessId(), "SIGKILL"),
                );
                page = await replacement;
                process.kill(desktop.application.process().pid!, 0);
                process.kill(desktop.runtimePid, 0);
            } else if (loss === "window close") {
                await desktop.application.evaluate(({ BrowserWindow }) => {
                    const window = BrowserWindow.getAllWindows()[0];
                    return new Promise<void>((resolve) => {
                        window.once("closed", resolve);
                        window.close();
                    });
                });
                const replacement = desktop.application.waitForEvent("window");
                await desktop.application.evaluate(({ app }) => app.emit("activate"));
                page = await replacement;
            } else {
                if (loss === "main loss") await desktop.crashMain();
                else await desktop.close();
                desktop = await launchDesktop(fixture);
                page = desktop.page;
            }
            await page.getByLabel("Saved Session ID").waitFor();
            equal(await page.getByLabel("Saved Session ID").inputValue(), savedId);
            await page.waitForFunction(
                (expected) => document.querySelector<HTMLTextAreaElement>("#session-message")?.value === expected,
                text,
            );
            const restored = await page.evaluate(async () => {
                const client = (globalThis as DraftDesktopWindow).runwieldSession;
                const view = await new Promise<SessionClientView>((resolve) => {
                    const stop = client.observe((next) => {
                        resolve(next);
                        queueMicrotask(() => stop());
                    });
                });
                return client.readDraft({
                    connectionId: view.connectionId,
                    project: view.project,
                    sessionId: view.sessionId,
                });
            });
            deepEqual(restored.composer, before.composer);
            equal(fixture.provider.requests.length, 1);
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.getByText("Explicit restored send accepted.", { exact: true }).waitFor();
            await page.getByText("Ready", { exact: true }).waitFor();
            await page.waitForFunction(
                () => document.querySelector<HTMLTextAreaElement>("#session-message")?.value === "",
            );
            equal(fixture.provider.requests.length, 2);
            deepEqual(fixture.provider.failures, []);
        } finally {
            try {
                await desktop?.close();
            } finally {
                await fixture.cleanup();
            }
        }
    });
}

test(
    "replacement native view restores queued follow-up as explicit intent and keeps its composer separate",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        let desktop: Awaited<ReturnType<typeof launchDesktop>> | undefined;
        try {
            fixture.provider.enqueue(
                { question: { type: "text", prompt: "Keep this question during replacement" } },
                { text: "The first operation settled." },
                { text: "The restored follow-up ran once." },
            );
            desktop = await launchDesktop(fixture);
            const { application, page } = desktop;
            await page.getByRole("button", { name: "New Session", exact: true }).click();
            await page.getByText("Ready", { exact: true }).waitFor();
            await page.getByLabel("Message", { exact: true }).fill("Ask a question.");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.getByRole("heading", { name: "Keep this question during replacement", exact: true }).waitFor();
            await page.getByLabel("Message", { exact: true }).fill("Preserved queued intent.");
            await page.getByRole("button", { name: "Queue", exact: true }).click();
            await page
                .getByRole("list", { name: "Unsent follow-ups", exact: true })
                .getByText("Preserved queued intent.", { exact: true })
                .waitFor();
            await page.waitForFunction(
                () => document.querySelector<HTMLTextAreaElement>("#session-message")?.value === "",
            );
            await page.getByLabel("Message", { exact: true }).fill("Different unsent composer.");
            await page.waitForFunction(async () => {
                const client = (globalThis as DraftDesktopWindow).runwieldSession;
                const view = await new Promise<SessionClientView>((resolve) => {
                    const stop = client.observe((next) => {
                        resolve(next);
                        queueMicrotask(() => stop());
                    });
                });
                return (
                    (
                        await client.readDraft({
                            connectionId: view.connectionId,
                            project: view.project,
                            sessionId: view.sessionId,
                        })
                    ).composer?.text === "Different unsent composer."
                );
            });
            await application.evaluate(({ BrowserWindow }) => {
                const window = BrowserWindow.getAllWindows()[0];
                return new Promise<void>((resolve) => {
                    window.once("closed", () => resolve());
                    window.close();
                });
            });
            const replacement = application.waitForEvent("window");
            await application.evaluate(({ app }) => app.emit("activate"));
            const next = await replacement;
            await next.getByRole("button", { name: "Session", exact: true }).click();
            await next.getByRole("button", { name: "Send queued message", exact: true }).waitFor();
            await next.waitForFunction(
                () =>
                    document.querySelector<HTMLTextAreaElement>("#session-message")?.value ===
                    "Different unsent composer.",
            );
            await next.getByRole("textbox", { name: "Answer", exact: true }).fill("Deliberate answer.");
            await next.getByRole("button", { name: "Submit answer", exact: true }).click();
            await next.getByText("The first operation settled.", { exact: true }).waitFor();
            await next.getByText("Ready", { exact: true }).waitFor();
            await new Promise((resolve) => setTimeout(resolve, 600));
            equal(fixture.provider.requests.length, 2, "restoring a queued draft cannot dispatch it at idle");
            await next.getByRole("button", { name: "Send queued message", exact: true }).click();
            await next.getByText("The restored follow-up ran once.", { exact: true }).waitFor();
            await next.getByText("Ready", { exact: true }).waitFor();
            equal(fixture.provider.requests.length, 3);
            equal(await next.getByLabel("Message", { exact: true }).inputValue(), "Different unsent composer.");
            await next.getByRole("list", { name: "Unsent follow-ups", exact: true }).waitFor({ state: "hidden" });
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
    "main loss retains submitted input and explicit receipt replay does not create a second provider effect",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        let desktop: Awaited<ReturnType<typeof launchDesktop>> | undefined;
        try {
            fixture.provider.enqueue(
                { text: "Receipt baseline." },
                { text: "Accepted held continuation.", hold: true },
            );
            desktop = await launchDesktop(fixture);
            let page = desktop.page;
            await page.getByRole("button", { name: "New Session", exact: true }).click();
            await page.getByText("Ready", { exact: true }).waitFor();
            await page.getByLabel("Message", { exact: true }).fill("Create receipt baseline.");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.getByText("Receipt baseline.", { exact: true }).waitFor();
            await page.getByText("Ready", { exact: true }).waitFor();
            const savedId = await page.getByLabel("Saved Session ID").inputValue();
            await page
                .getByLabel("Message", { exact: true })
                .fill("Keep this submitted continuation until receipt resolution.");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.getByText("Accepted held continuation.", { exact: true }).waitFor();
            equal(fixture.provider.requests.length, 2);
            await desktop.crashMain();
            fixture.provider.release();
            desktop = await launchDesktop(fixture);
            page = desktop.page;
            equal(await page.getByLabel("Saved Session ID").inputValue(), savedId);
            await page.getByText("Receipt baseline.", { exact: true }).waitFor();
            equal(fixture.provider.requests.length, 2, "restart cannot resubmit saved input");
            const restored = await readView(page);
            if (restored.recoveryNotice) {
                await page.getByText(/previous input outcome is uncertain/).waitFor();
                const composer = await page.getByLabel("Message", { exact: true }).inputValue();
                if (composer) {
                    await page.getByRole("button", { name: "Send", exact: true }).click();
                    await page.getByRole("alert").filter({ hasText: "original input outcome is uncertain" }).waitFor();
                } else equal(await page.getByRole("button", { name: "Send", exact: true }).isDisabled(), true);
            } else {
                equal(await page.getByLabel("Message", { exact: true }).inputValue(), "");
            }
            await new Promise((resolve) => setTimeout(resolve, 600));
            equal(fixture.provider.requests.length, 2, "saved receipt identity cannot start another provider effect");
            equal(
                await page.getByRole("alert").filter({ hasText: "different input" }).count(),
                0,
                "replay preserves the original receipt generation",
            );
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
    "native bridge sends to its named background binding without moving the selected draft",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        let desktop: Awaited<ReturnType<typeof launchDesktop>> | undefined;
        try {
            fixture.provider.enqueue({ text: "Named background binding accepted." });
            desktop = await launchDesktop(fixture);
            const { page } = desktop;
            await page.getByRole("button", { name: "New Session", exact: true }).click();
            await page.getByText("Ready", { exact: true }).waitFor();
            const { connectionId, project, sessionId } = await readView(page);
            const binding = { connectionId, project, sessionId };
            await page.getByLabel("Message", { exact: true }).fill("Background binding private input.");
            await page.getByRole("button", { name: "New Session", exact: true }).click();
            await page.getByText("Ready", { exact: true }).waitFor();
            await page.getByLabel("Message", { exact: true }).fill("Selected binding must keep this exact draft.");
            const firstDraft = await page.evaluate(
                (binding) => (globalThis as DraftDesktopWindow).runwieldSession.readDraft(binding),
                binding,
            );
            const firstComposer = firstDraft.composer;
            ok(firstComposer);
            await page.evaluate(
                async ({ binding, composer }) => {
                    const client = (globalThis as DraftDesktopWindow).runwieldSession;
                    await client.sendImages(
                        binding,
                        composer.text,
                        composer.images.map(({ mimeType, base64 }) => ({ mimeType, base64 })),
                        composer.requestId,
                    );
                },
                { binding, composer: firstComposer },
            );
            equal((await readView(page)).sessionId === binding.sessionId, false);
            equal(
                await page.getByLabel("Message", { exact: true }).inputValue(),
                "Selected binding must keep this exact draft.",
            );
            const accepted = await page.evaluate(
                (binding) => (globalThis as DraftDesktopWindow).runwieldSession.readDraft(binding),
                binding,
            );
            equal(accepted.composer, null);
            equal(fixture.provider.requests.length, 1);
            ok(JSON.stringify(fixture.provider.requests[0].messages).includes(firstComposer.text));
            ok(!JSON.stringify(fixture.provider.requests[0].messages).includes("Selected binding must keep"));
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
    "native submission commits original receipt metadata before send and removes it only after acceptance",
    { timeout: 40000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        let desktop: Awaited<ReturnType<typeof launchDesktop>> | undefined;
        let obstructed = false;
        const profile = join(fixture.home, "electron-profile");
        const path = join(profile, "desktop-intent", "drafts.json");
        const preserved = `${path}.preserved`;
        try {
            desktop = await launchDesktop(fixture);
            const { page } = desktop;
            await page.getByRole("button", { name: "New Session", exact: true }).click();
            await page.getByText("Ready", { exact: true }).waitFor();
            const text = "Keep this input until Core accepts its original receipt.";
            await page.getByLabel("Message", { exact: true }).fill(text);
            await page.waitForFunction(async (text) => {
                const client = (globalThis as DraftDesktopWindow).runwieldSession;
                const current = await new Promise<SessionClientView>((resolve) => {
                    const stop = client.observe((next) => {
                        resolve(next);
                        queueMicrotask(() => stop());
                    });
                });
                return (
                    (
                        await client.readDraft({
                            connectionId: current.connectionId,
                            project: current.project,
                            sessionId: current.sessionId,
                        })
                    ).composer?.text === text
                );
            }, text);
            const before = await readView(page);
            const [entry] = await (await DesktopDraftStore.open(profile)).list();
            ok(entry.composer);
            // Real storage failure, not a replacement for the persistence or submission machinery.
            await rename(path, preserved);
            await mkdir(path);
            obstructed = true;
            const failure = await page.evaluate(
                async ({ binding, text }) => {
                    try {
                        await (globalThis as DesktopWindow).runwieldSession.send(binding, text);
                        return "Input crossed the wire without durable preparation.";
                    } catch (error) {
                        return error instanceof Error ? error.message : String(error);
                    }
                },
                {
                    binding: {
                        connectionId: before.connectionId,
                        project: before.project,
                        sessionId: before.sessionId,
                    },
                    text,
                },
            );
            ok(/EISDIR|ENOTDIR|directory/i.test(failure), failure);
            equal(fixture.provider.requests.length, 0, "failed durable preparation must prevent dispatch");
            equal(await page.getByLabel("Message", { exact: true }).inputValue(), text);
            await rm(path, { recursive: true });
            await rename(preserved, path);
            obstructed = false;
            fixture.provider.enqueue({ text: "Prepared input accepted once.", hold: true });
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.getByText("Prepared input accepted once.", { exact: true }).waitFor();
            const [committed] = await (await DesktopDraftStore.open(profile)).list();
            const [submitted] = committed.submitted;
            ok(submitted, "Core cannot receive input before its receipt metadata is durable");
            equal(submitted.requestId, entry.composer.requestId);
            equal(submitted.text, text);
            equal(submitted.kind, "bootstrap");
            equal(submitted.expectedGeneration, 0);
            equal(fixture.provider.requests.length, 1);
            fixture.provider.release();
            await page.getByText("Ready", { exact: true }).waitFor();
            equal(await page.getByLabel("Message", { exact: true }).inputValue(), "");
            deepEqual(await (await DesktopDraftStore.open(profile)).list(), []);
            deepEqual(fixture.provider.failures, []);
        } finally {
            if (obstructed) {
                await rm(path, { recursive: true, force: true });
                await rename(preserved, path);
            }
            fixture.provider.release();
            try {
                await desktop?.close();
            } finally {
                await fixture.cleanup();
            }
        }
    },
);

test("queue waits for deliberate Send when the first turn settles with no window", { timeout: 60000 }, async () => {
    const fixture = await makeSessionProcessFixture();
    let desktop: Awaited<ReturnType<typeof launchDesktop>> | undefined;
    try {
        fixture.provider.enqueue({ text: "Held before detach", hold: true }, { text: "Deliberate follow-up only" });
        desktop = await launchDesktop(fixture);
        const { application, page } = desktop;
        await page.getByRole("button", { name: "New Session", exact: true }).click();
        await page.getByText("Ready", { exact: true }).waitFor();
        await page.getByLabel("Message", { exact: true }).fill("First held turn");
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await page.getByText("Held before detach", { exact: true }).waitFor();
        const savedId = await page.getByLabel("Saved Session ID").inputValue();
        await page.getByLabel("Message", { exact: true }).fill("Follow-up must wait for me");
        await page.getByRole("button", { name: "Queue", exact: true }).click();
        await page.getByRole("list", { name: "Unsent follow-ups", exact: true }).waitFor();
        await application.evaluate(({ BrowserWindow }) => {
            const window = BrowserWindow.getAllWindows()[0];
            return new Promise<void>((resolve) => {
                window.once("closed", resolve);
                window.close();
            });
        });
        fixture.provider.release();
        const canonical = openFileSessionStore({ baseDir: join(fixture.home, ".wld", "sessions") });
        try {
            await waitForSession(() => canonical.inspectSessionActivation(savedId).activation?.state === "idle");
            await new Promise((resolve) => setTimeout(resolve, 750));
            equal(fixture.provider.requests.length, 1, "idle polling with no view cannot dispatch retained intent");
        } finally {
            canonical.close();
        }
        const replacement = application.waitForEvent("window");
        await application.evaluate(({ app }) => app.emit("activate"));
        const next = await replacement;
        await next.getByRole("button", { name: "Send queued message", exact: true }).click();
        await next.getByText("Deliberate follow-up only", { exact: true }).waitFor();
        await next.getByText("Ready", { exact: true }).waitFor();
        equal(fixture.provider.requests.length, 2);
        deepEqual(fixture.provider.failures, []);
    } finally {
        fixture.provider.release();
        try {
            await desktop?.close();
        } finally {
            await fixture.cleanup();
        }
    }
});

test(
    "discard composer preserves a separate image follow-up and request identity after native restart",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        let desktop: Awaited<ReturnType<typeof launchDesktop>> | undefined;
        try {
            fixture.provider.enqueue(
                { text: "Discard baseline", hold: true },
                { text: "Preserved follow-up accepted" },
            );
            desktop = await launchDesktop(fixture);
            let page = desktop.page;
            await page.getByRole("button", { name: "New Session", exact: true }).click();
            await page.getByText("Ready", { exact: true }).waitFor();
            await page.getByLabel("Message", { exact: true }).fill("Create saved identity");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.getByText("Discard baseline", { exact: true }).waitFor();
            const current = await readView(page);
            const binding = {
                connectionId: current.connectionId,
                project: current.project,
                sessionId: current.sessionId,
            };
            const queued = {
                requestId: "native-preserved-image-queue",
                text: "Separate queued image",
                images: [{ mimeType: "image/png", base64: "YWJj" }],
            };
            await page.evaluate(
                async ({ binding, queued }) => {
                    const client = (globalThis as DesktopWindow)
                        .runwieldSession as import("../workspace/client/session-client.ts").WorkspaceSavedSessionClient;
                    await client.queue(binding, queued);
                },
                { binding, queued },
            );
            await page.getByRole("list", { name: "Unsent follow-ups", exact: true }).waitFor();
            await page.getByLabel("Message", { exact: true }).fill("Discard only this private composer");
            await page
                .locator('.session-composer input[type="file"]')
                .setInputFiles({ name: "composer.png", mimeType: "image/png", buffer: Buffer.from("ZGVm", "base64") });
            await page.waitForFunction(async () => {
                const client = (globalThis as DraftDesktopWindow).runwieldSession;
                const view = await new Promise<SessionClientView>((resolve) => {
                    const stop = client.observe((v) => {
                        resolve(v);
                        queueMicrotask(() => stop());
                    });
                });
                return (
                    (
                        await client.readDraft({
                            connectionId: view.connectionId,
                            project: view.project,
                            sessionId: view.sessionId,
                        })
                    ).composer?.images[0]?.base64 === "ZGVm"
                );
            });
            const before = await page.evaluate(
                (binding) => (globalThis as DraftDesktopWindow).runwieldSession.readDraft(binding),
                binding,
            );
            ok(before.composer);
            await desktop.application.evaluate(({ BrowserWindow }) => {
                const window = BrowserWindow.getAllWindows()[0];
                return new Promise<void>((resolve) => {
                    window.once("closed", resolve);
                    window.close();
                });
            });
            fixture.provider.release();
            const canonical = openFileSessionStore({ baseDir: join(fixture.home, ".wld", "sessions") });
            try {
                await waitForSession(
                    () => canonical.inspectSessionActivation(current.durableSessionId).activation?.state === "idle",
                );
            } finally {
                canonical.close();
            }
            const replacement = desktop.application.waitForEvent("window");
            await desktop.application.evaluate(({ app }) => app.emit("activate"));
            page = await replacement;
            await page.getByRole("button", { name: "Session", exact: true }).click();
            await page.getByText("Ready", { exact: true }).waitFor();
            await page.getByRole("button", { name: "Discard draft", exact: true }).click();
            await page.waitForFunction(
                () => document.querySelector<HTMLTextAreaElement>("#session-message")?.value === "",
            );
            const failure = await page.evaluate(
                async ({ binding, composer }) => {
                    try {
                        await (
                            (globalThis as DesktopWindow)
                                .runwieldSession as import("../workspace/client/session-client.ts").WorkspaceSavedSessionClient
                        ).sendImages(
                            binding,
                            composer.text,
                            composer.images.map(({ mimeType, base64 }) => ({ mimeType, base64 })),
                            composer.requestId,
                        );
                        return "Retired request crossed the wire";
                    } catch (error) {
                        return error instanceof Error ? error.message : String(error);
                    }
                },
                { binding, composer: before.composer },
            );
            ok(/accepted or discarded/.test(failure), failure);
            equal(fixture.provider.requests.length, 1);
            const profile = join(fixture.home, "electron-profile");
            const [stored] = await (await DesktopDraftStore.open(profile)).list();
            deepEqual(stored.queued, [queued]);
            equal(stored.composer, null);
            await desktop.close();
            desktop = await launchDesktop(fixture);
            page = desktop.page;
            await page.getByRole("button", { name: "Send queued message", exact: true }).waitFor();
            const restored = await readView(page);
            deepEqual(restored.queued, [{ ...queued, restored: true }]);
            equal(fixture.provider.requests.length, 1);
            await page.getByRole("button", { name: "Send queued message", exact: true }).click();
            await page.getByText("Preserved follow-up accepted", { exact: true }).waitFor();
            await page.getByText("Ready", { exact: true }).waitFor();
            equal(fixture.provider.requests.length, 2);
            ok(JSON.stringify(fixture.provider.requests[1].messages).includes(queued.text));
            deepEqual(await (await DesktopDraftStore.open(profile)).list(), []);
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
