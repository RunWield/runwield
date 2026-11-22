import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { join } from "node:path";
import { makeSessionProcessFixture } from "../../acp/client/testing/session-process-fixture.ts";
import { openFileSessionStore } from "../../shared/session/file-session-store.ts";
import { launchDesktop } from "./testing/desktop-fixture.ts";
import { DesktopDraftStore, type DesktopDraftEntry } from "./draft-store.ts";
import type { DesktopWorkbenchClient } from "../workspace/client/desktop-workbench.ts";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function resumeRuntime(pid: number) {
    try {
        process.kill(pid, "SIGCONT");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
}

test(
    "native Stay open leaves work and queued intent unchanged; Stop waits for acknowledged settlement",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        let desktop: Awaited<ReturnType<typeof launchDesktop>> | undefined;
        let suspended = false;
        let exited = false;
        try {
            fixture.provider.enqueue({ text: "Quit must not lose this running work.", hold: true });
            desktop = await launchDesktop(fixture);
            const { application, page, runtimePid } = desktop;
            const mainPid = application.process().pid!;
            await page.getByRole("button", { name: "New Session", exact: true }).click();
            await page.getByText("Ready", { exact: true }).waitFor();
            await page.getByLabel("Message", { exact: true }).fill("Keep work until deliberate Quit.");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.getByText("Quit must not lose this running work.", { exact: true }).waitFor();
            const savedId = await page.getByLabel("Saved Session ID").inputValue();
            ok(savedId);
            await page.getByLabel("Message", { exact: true }).fill("Never automatically send this queue after Quit.");
            await page.getByRole("button", { name: "Queue", exact: true }).click();
            await page
                .getByRole("list", { name: "Unsent follow-ups" })
                .getByText("Never automatically send this queue after Quit.", { exact: true })
                .waitFor();
            await application.evaluate(({ dialog }) => {
                dialog.showMessageBox = (first, second?) => {
                    const options = second || first;
                    if (
                        typeof options !== "object" ||
                        options === null ||
                        !("buttons" in options) ||
                        JSON.stringify(options.buttons) !== JSON.stringify(["Stay open", "Stop and quit"])
                    )
                        return Promise.reject(
                            new Error("Quit must offer Stay open and Stop and quit at the native dialog boundary."),
                        );
                    return Promise.resolve({ response: 0, checkboxChecked: false });
                };
            });
            await application.evaluate(({ app }) => app.quit());
            await pause(400);
            process.kill(mainPid, 0);
            process.kill(runtimePid, 0);
            fixture.provider.emit("Stay open preserved the stream.");
            await page.getByText("Stay open preserved the stream.", { exact: false }).waitFor();
            equal(fixture.provider.requests.length, 1);
            equal(
                await page
                    .getByRole("list", { name: "Unsent follow-ups" })
                    .getByText("Never automatically send this queue after Quit.", { exact: true })
                    .count(),
                1,
            );
            await page.getByLabel("Message", { exact: true }).fill("Flush the final unsent composer before exit.");
            await application.evaluate(({ dialog }, pid) => {
                dialog.showMessageBox = () => {
                    process.kill(pid, "SIGSTOP");
                    return Promise.resolve({ response: 1, checkboxChecked: false });
                };
            }, runtimePid);
            const closed = application.waitForEvent("close").then(() => {
                exited = true;
            });
            await application.evaluate(({ app }) => app.quit());
            suspended = true;
            // Longer than the removed ten-second disposal timeout. No overlapping stop may bypass Core.
            await pause(10500);
            equal(exited, false, "main must wait for Core settlement, not a disposal timeout");
            process.kill(mainPid, 0);
            await application.evaluate(({ app }) => {
                app.quit();
                app.quit();
            });
            equal(fixture.provider.requests.length, 1);
            const refused = await page.evaluate(async () => {
                const client = (
                    globalThis as typeof globalThis & {
                        runwieldSession: import("../workspace/client/session-client.ts").WorkspaceSessionClient;
                    }
                ).runwieldSession;
                try {
                    await client.create();
                    return false;
                } catch {
                    return true;
                }
            });
            equal(refused, true, "Stop blocks dispatch while the real runtime is suspended");
            process.kill(runtimePid, "SIGCONT");
            suspended = false;
            await closed;
            const canonical = openFileSessionStore({ baseDir: join(fixture.home, ".wld", "sessions") });
            try {
                const activation = canonical.inspectSessionActivation(savedId);
                equal(activation.activation?.state, "idle");
                ok(activation.generation);
            } finally {
                canonical.close();
            }
            fixture.provider.release();
            await desktop.close();
            desktop = await launchDesktop(fixture);
            await desktop.page.getByText("Keep work until deliberate Quit.", { exact: true }).last().waitFor();
            equal(
                await desktop.page.getByLabel("Message", { exact: true }).inputValue(),
                "Flush the final unsent composer before exit.",
            );
            await desktop.page.getByRole("button", { name: "Send queued message", exact: true }).waitFor();
            equal(fixture.provider.requests.length, 1);
            deepEqual(fixture.provider.failures, []);
        } finally {
            try {
                if (suspended && desktop) resumeRuntime(desktop.runtimePid);
            } finally {
                fixture.provider.release();
                try {
                    await desktop?.close();
                } finally {
                    await fixture.cleanup();
                }
            }
        }
    },
);

test("Stop and quit preserves a queue whose preparation completes during shutdown", { timeout: 40000 }, async () => {
    const fixture = await makeSessionProcessFixture();
    let desktop: Awaited<ReturnType<typeof launchDesktop>> | undefined;
    const flushing = Promise.withResolvers<void>();
    const releaseFlush = Promise.withResolvers<void>();
    const queuedText = "Keep this prepared follow-up unsent.";
    const unexpected = "Follow-up reached the provider during shutdown.";
    try {
        fixture.provider.enqueue({ text: "Hold the turn before queue dispatch.", hold: true }, { text: unexpected });
        desktop = await launchDesktop(fixture);
        const { application, page } = desktop;
        await page.getByRole("button", { name: "New Session", exact: true }).click();
        await page.getByText("Ready", { exact: true }).waitFor();
        await page.getByLabel("Message", { exact: true }).fill("First turn before Quit.");
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await page.getByText("Hold the turn before queue dispatch.", { exact: true }).waitFor();
        await page.getByLabel("Message", { exact: true }).fill(queuedText);
        await page.getByRole("button", { name: "Queue", exact: true }).click();
        await page.getByRole("list", { name: "Unsent follow-ups" }).getByText(queuedText, { exact: true }).waitFor();

        // Delay the atomic filesystem write, not the draft store or submission machinery.
        await application.evaluate(
            (_, { text, draftFile }) => {
                const fs = process.getBuiltinModule("node:fs/promises")!;
                const { syncBuiltinESMExports } = process.getBuiltinModule("node:module")!;
                const rename = fs.rename;
                const committing = Promise.withResolvers<void>();
                const resume = new Promise<void>((resolve) => process.once("test:resume-draft-commit", resolve));
                process.once("test:await-draft-commit", (done: () => void) => void committing.promise.then(done));
                fs.rename = async (source, destination) => {
                    if (String(destination).endsWith(draftFile)) {
                        const { entries } = JSON.parse(await fs.readFile(source, "utf8")) as {
                            entries: DesktopDraftEntry[];
                        };
                        if (entries.some((entry) => entry.submitted.some((draft) => draft.text === text))) {
                            fs.rename = rename;
                            syncBuiltinESMExports();
                            committing.resolve();
                            await resume;
                        }
                    }
                    await rename(source, destination);
                };
                syncBuiltinESMExports();
            },
            { text: queuedText, draftFile: join("desktop-intent", "drafts.json") },
        );
        await page.exposeFunction("holdQuitDraftFlush", () => {
            flushing.resolve();
            return releaseFlush.promise;
        });
        await page.evaluate(() => {
            const host = globalThis as typeof globalThis & {
                runwieldWorkbench: DesktopWorkbenchClient;
                holdQuitDraftFlush: () => Promise<void>;
            };
            host.runwieldWorkbench.flushDrafts(() => host.holdQuitDraftFlush());
        });

        fixture.provider.release();
        await application.evaluate(
            () => new Promise<void>((resolve) => process.emit("test:await-draft-commit", resolve)),
        );
        await application.evaluate(({ app, dialog }) => {
            dialog.showMessageBox = () => Promise.resolve({ response: 1, checkboxChecked: false });
            app.quit();
        });
        await flushing.promise;
        await application.evaluate(() => process.emit("test:resume-draft-commit"));
        await page
            .getByText("RunWield is stopping. Input was not sent.", { exact: true })
            .or(page.getByText(unexpected, { exact: true }))
            .first()
            .waitFor();
        equal(fixture.provider.requests.length, 1, "prepared follow-up must not reach the provider before drain");

        const closed = application.waitForEvent("close");
        releaseFlush.resolve();
        await closed;
        const [entry] = await (await DesktopDraftStore.open(join(fixture.home, "electron-profile"))).list();
        const [queued] = entry.queued;
        equal(queued.text, queuedText);
        equal(entry.submitted[0]?.requestId, queued.requestId);
        deepEqual(fixture.provider.failures, []);
    } finally {
        releaseFlush.resolve();
        fixture.provider.release();
        await desktop?.application.evaluate(() => process.emit("test:resume-draft-commit")).catch(() => {});
        try {
            await desktop?.close();
        } finally {
            await fixture.cleanup();
        }
    }
});
