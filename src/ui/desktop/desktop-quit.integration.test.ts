import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { join } from "node:path";
import { makeSessionProcessFixture } from "../../acp/client/testing/session-process-fixture.ts";
import { openFileSessionStore } from "../../shared/session/file-session-store.ts";
import { launchDesktop } from "./testing/desktop-fixture.ts";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
                dialog.showMessageBox = async (first, second?) => {
                    const options = second || first;
                    if (
                        !("buttons" in options) ||
                        JSON.stringify(options.buttons) !== JSON.stringify(["Stay open", "Stop and quit"])
                    )
                        throw new Error("Quit must offer Stay open and Stop and quit at the native dialog boundary.");
                    return { response: 0, checkboxChecked: false };
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
                dialog.showMessageBox = async () => {
                    process.kill(pid, "SIGSTOP");
                    return { response: 1, checkboxChecked: false };
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
            if (suspended && desktop) {
                try {
                    process.kill(desktop.runtimePid, "SIGCONT");
                } catch {}
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
