import { test } from "node:test";
import { deepEqual, equal, match, ok } from "node:assert/strict";
import { mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeSessionProcessFixture } from "../../acp/client/testing/session-process-fixture.ts";
import type { DesktopProjectClient } from "../workspace/client/project-client.ts";
import type { SessionClientView, WorkspaceSessionClient } from "../workspace/client/session-client.ts";
import { launchDesktop } from "./testing/desktop-fixture.ts";

type Desktop = Awaited<ReturnType<typeof launchDesktop>>;
interface DesktopGlobals {
    runwieldProjects: DesktopProjectClient;
    runwieldSession: WorkspaceSessionClient;
}
type DesktopWindow = typeof globalThis & DesktopGlobals;
function list(desktop: Desktop) {
    return desktop.page.evaluate(() => (globalThis as DesktopWindow).runwieldProjects.listProjects());
}
async function picker(desktop: Desktop, path: string | null) {
    // Native directory selection is an external OS boundary. Core writes remain real.
    await desktop.application.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = () =>
            Promise.resolve({ canceled: path === null, filePaths: path === null ? [] : [path] });
    }, path);
}
async function link(desktop: Desktop, root: string) {
    await picker(desktop, root);
    await desktop.page.getByRole("button", { name: "Open Project", exact: true }).click();
    await desktop.page.getByRole("button", { name: "Link Project", exact: true }).click();
    await desktop.page.getByRole("button", { name: "Settings", exact: true }).waitFor();
}
function view(desktop: Desktop) {
    return desktop.page.evaluate(
        () =>
            new Promise<SessionClientView>((resolve) => {
                const stop = (globalThis as DesktopWindow).runwieldSession.observe((value) => {
                    resolve(value);
                    queueMicrotask(stop);
                });
            }),
    );
}

test(
    "no-argument native entry retries registration and manages real roots without deleting files",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        let desktop: Desktop | undefined;
        const moved = fixture.project + " moved ; literal";
        try {
            const trap = join(fixture.home, "trap");
            await mkdir(trap);
            await writeFile(join(trap, "wld"), "#!/bin/sh\necho PATH_RUNTIME_EXECUTED >&2\nexit 99\n", { mode: 0o700 });
            fixture.env.PATH = `${trap}:${fixture.env.PATH}`;
            const evidence = join(fixture.project, "preserved.txt");
            await writeFile(evidence, "Project data stays intact.");
            desktop = await launchDesktop(fixture, { entry: true });
            const { page } = desktop;
            equal(page.url(), "runwield://app/");
            deepEqual((await list(desktop)).projects, []);
            await picker(desktop, null);
            await page.getByRole("button", { name: "Open Project", exact: true }).click();
            await page.getByRole("button", { name: "Open Project", exact: true }).isEnabled();
            equal(await page.getByRole("button", { name: "Link Project", exact: true }).count(), 0);
            deepEqual((await list(desktop)).projects, []);
            await picker(desktop, fixture.project + "/does-not-exist");
            await page.getByRole("button", { name: "Open Project", exact: true }).click();
            await page.getByLabel("Display name", { exact: true }).fill("Native entry Project");
            await page.getByRole("button", { name: "Link Project", exact: true }).click();
            await page.getByText(/Project operation failed/).waitFor();
            equal(await page.getByLabel("Display name", { exact: true }).inputValue(), "Native entry Project");
            deepEqual((await list(desktop)).projects, []);
            await page.getByLabel("Project root", { exact: true }).fill(fixture.project);
            await page.getByRole("button", { name: "Link Project", exact: true }).click();
            await page.getByRole("button", { name: "Settings", exact: true }).click();
            const original = (await list(desktop)).projects[0];
            equal(original.displayName, "Native entry Project");
            await page.getByRole("button", { name: "Disable", exact: true }).click();
            await page.getByRole("button", { name: "Enable", exact: true }).waitFor();
            equal((await list(desktop)).projects[0].lifecycle, "disabled");
            equal(await page.getByRole("button", { name: "Full Session rescan", exact: true }).isDisabled(), true);
            await rename(fixture.project, moved);
            await page.getByRole("button", { name: "Refresh Projects", exact: true }).click();
            await page.getByRole("button", { name: "Enable", exact: true }).click();
            await page.getByRole("button", { name: "Disable", exact: true }).waitFor();
            equal((await list(desktop)).projects[0].enabled, false);
            await picker(desktop, moved);
            await page.getByRole("button", { name: "Choose folder", exact: true }).click();
            await page.getByRole("button", { name: "Relink", exact: true }).click();
            await page.getByRole("button", { name: "Full Session rescan", exact: true }).click();
            await page.getByText("0 Sessions cataloged.", { exact: true }).waitFor();
            const relinked = (await list(desktop)).projects[0];
            equal(relinked.projectId, original.projectId);
            equal(relinked.enabled, true);
            await page.getByRole("button", { name: "Remove", exact: true }).click();
            await page
                .getByText("Project files and saved Sessions stay intact. Only this registration is removed.")
                .waitFor();
            equal(await page.evaluate(() => document.activeElement?.textContent), "Quit");
            await page.keyboard.press("Escape");
            equal(await page.getByRole("dialog").count(), 0);
            equal(await page.evaluate(() => document.activeElement?.textContent), "Remove");
            await page.getByRole("button", { name: "Remove", exact: true }).click();
            await page.getByRole("button", { name: "Continue", exact: true }).click();
            await page.getByText("No Projects linked. Open a folder to get started.").waitFor();
            deepEqual((await list(desktop)).projects, []);
            equal(await readFile(join(moved, "preserved.txt"), "utf8"), "Project data stays intact.");
            await link(desktop, moved);
            ok((await list(desktop)).projects[0].projectId !== original.projectId);
            equal(fixture.provider.requests.length, 0);
            const storage = await page.evaluate(() =>
                JSON.stringify({
                    local: { ...localStorage },
                    session: { ...sessionStorage },
                    dom: document.body.innerText,
                }),
            );
            ok(!storage.includes("fixture-key"));
            ok(!desktop.diagnostics().includes("fixture-key"));
            ok(!desktop.diagnostics().includes("PATH_RUNTIME_EXECUTED"));
            deepEqual(desktop.errors, []);
        } finally {
            try {
                await desktop?.close();
            } finally {
                await rm(moved, { recursive: true, force: true });
                await fixture.cleanup();
            }
        }
    },
);

test(
    "native home confirmation keeps Quit focus, traps Tab, cancels without writes, and binds consent",
    { timeout: 40000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        let desktop: Desktop | undefined;
        try {
            desktop = await launchDesktop(fixture, { entry: true });
            await picker(desktop, fixture.home);
            const { page } = desktop;
            await page.getByRole("button", { name: "Open Project", exact: true }).click();
            await page.getByRole("button", { name: "Link Project", exact: true }).click();
            await page.getByRole("dialog").waitFor();
            equal(await page.evaluate(() => document.activeElement?.textContent), "Quit");
            deepEqual((await list(desktop)).projects, []);
            await page.keyboard.press("Tab");
            equal(await page.evaluate(() => document.activeElement?.textContent), "Continue");
            await page.keyboard.press("Shift+Tab");
            equal(await page.evaluate(() => document.activeElement?.textContent), "Quit");
            await page.keyboard.press("Escape");
            equal(await page.getByLabel("Project root", { exact: true }).inputValue(), fixture.home);
            equal(await page.evaluate(() => document.activeElement?.textContent), "Link Project");
            await page.getByRole("button", { name: "Link Project", exact: true }).click();
            await page.getByRole("button", { name: "Continue", exact: true }).click();
            await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
            equal((await list(desktop)).projects.length, 1);
            equal(fixture.provider.requests.length, 0);
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
    "missing provider setup leaves native Projects usable and reports the Core wld prerequisite",
    { timeout: 40000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        let desktop: Desktop | undefined;
        try {
            const settingsPath = join(fixture.home, ".wld", "settings.json");
            const authPath = join(fixture.home, ".wld", "auth.json");
            const settingsBefore = await readFile(settingsPath, "utf8");
            const authBefore = await readFile(authPath, "utf8");
            await writeFile(settingsPath, JSON.stringify({ notifications: { enabled: false } }));
            await rm(join(fixture.home, ".wld", "auth.json"));
            desktop = await launchDesktop(fixture, { entry: true });
            await link(desktop, fixture.project);
            await desktop.page.getByRole("button", { name: "Open", exact: true }).click();
            await desktop.page.getByRole("button", { name: "New Session", exact: true }).click();
            await desktop.page
                .getByText(/wld login/)
                .first()
                .waitFor();
            const prerequisite = await desktop.page.getByRole("alert").innerText();
            match(prerequisite, /restart/i);
            ok(!prerequisite.includes("Error invoking remote method"));
            equal((await view(desktop)).sessionId, "");
            equal(fixture.provider.requests.length, 0);
            await desktop.page.getByRole("button", { name: "Projects", exact: true }).click();
            await desktop.page.getByRole("button", { name: "Settings", exact: true }).click();
            await desktop.page.getByRole("button", { name: "Disable", exact: true }).click();
            await desktop.page.getByRole("button", { name: "Enable", exact: true }).waitFor();
            equal((await list(desktop)).projects[0].lifecycle, "disabled");
            await desktop.page.getByRole("button", { name: "Enable", exact: true }).click();
            await desktop.page.getByRole("button", { name: "Disable", exact: true }).waitFor();
            await desktop.close();
            // External wld configuration uses the same canonical stores; restart reads it in place.
            await writeFile(settingsPath, settingsBefore);
            await writeFile(authPath, authBefore);
            fixture.provider.enqueue({ text: "Configured after restart." });
            desktop = await launchDesktop(fixture);
            await desktop.page.getByRole("button", { name: "New Session", exact: true }).click();
            await desktop.page.getByText("Ready", { exact: true }).waitFor();
            await desktop.page.getByLabel("Message", { exact: true }).fill("Use existing configuration.");
            await desktop.page.getByRole("button", { name: "Send", exact: true }).click();
            await desktop.page.getByText("Configured after restart.", { exact: true }).waitFor();
            await desktop.page.getByText("Ready", { exact: true }).waitFor();
            equal(fixture.provider.requests.length, 1);
            equal(fixture.provider.requests[0].authorization, "Bearer fixture-key");
            const saved = await view(desktop);
            ok(saved.durableSessionId);
            ok(!JSON.stringify(saved).includes("fixture-key"));
            await desktop.page.getByRole("button", { name: "Close Session", exact: true }).click();
            await desktop.page.getByText("No Session open", { exact: true }).waitFor();
            await desktop.page.getByRole("button", { name: "Projects", exact: true }).click();
            await desktop.page.getByRole("button", { name: "Settings", exact: true }).click();
            await desktop.page.getByRole("button", { name: "Full Session rescan", exact: true }).click();
            await desktop.page.getByText("1 Sessions cataloged.", { exact: true }).waitFor();
            equal(await readFile(settingsPath, "utf8"), settingsBefore);
            equal(await readFile(authPath, "utf8"), authBefore);
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
    "another Project cannot retarget an open streaming Session on the persistent connection",
    { timeout: 50000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        const second = join(fixture.home, "second project ; literal");
        let desktop: Desktop | undefined;
        try {
            await mkdir(second);
            fixture.provider.enqueue({ text: "Held entry turn.", hold: true });
            desktop = await launchDesktop(fixture);
            const { page } = desktop;
            await page.getByRole("button", { name: "New Session", exact: true }).click();
            await page.getByText("Ready", { exact: true }).waitFor();
            await page.getByLabel("Message", { exact: true }).fill("Keep this binding.");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.getByText("Held entry turn.", { exact: true }).waitFor();
            const before = await view(desktop);
            await page.getByRole("button", { name: "Projects", exact: true }).click();
            await picker(desktop, second);
            await page.getByRole("button", { name: "Open Project", exact: true }).click();
            await page.getByRole("button", { name: "Link Project", exact: true }).click();
            await page.getByRole("button", { name: "Open", exact: true }).nth(1).click();
            await page.getByRole("alert").filter({ hasText: "Close the current Session" }).waitFor();
            const after = await view(desktop);
            equal(after.connectionId, before.connectionId);
            equal(after.sessionId, before.sessionId);
            equal(after.project, before.project);
            equal(fixture.provider.requests.length, 1);
            await page.getByRole("button", { name: "Settings", exact: true }).nth(1).click();
            await page.getByRole("button", { name: "Full Session rescan", exact: true }).waitFor();
            await page.getByRole("button", { name: "Session", exact: true }).click();
            await page.getByRole("button", { name: "Stop", exact: true }).click();
            await page.getByText("Ready", { exact: true }).waitFor();
            await page.getByRole("button", { name: "Close Session", exact: true }).click();
            await page.getByText("No Session open", { exact: true }).waitFor();
            await page.getByRole("button", { name: "Projects", exact: true }).click();
            await page.getByRole("button", { name: "Open", exact: true }).nth(1).click();
            await page.getByText("No Session open", { exact: true }).waitFor();
            const next = await view(desktop);
            equal(next.connectionId, before.connectionId);
            equal(next.project, await realpath(second));
            equal(next.sessionId, "");
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
    "named native Project operations reject invalid payloads before registration effects",
    { timeout: 40000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        let desktop: Desktop | undefined;
        try {
            desktop = await launchDesktop(fixture, { entry: true });
            await link(desktop, fixture.project);
            const before = await list(desktop);
            const projectId = before.projects[0].projectId;
            const errors = await desktop.page.evaluate(async (projectId) => {
                const client = (globalThis as DesktopWindow).runwieldProjects;
                const operations = [
                    () => Reflect.apply(client.registerProject, client, [{ root: 42 }]),
                    () => client.registerProject({ root: "x".repeat(4097) }),
                    () => client.registerProject({ root: "/valid\0invalid" }),
                    () => Reflect.apply(client.registerProject, client, [{ root: "/tmp", action: "remove" }]),
                    () => client.openProject({ projectId: "" }),
                    () => client.openProject({ projectId: "x".repeat(129) }),
                    () => Reflect.apply(client.relinkProject, client, [{ projectId, newRoot: false }]),
                    () => Reflect.apply(client.setProjectEnabled, client, [{ projectId, enabled: "false" }]),
                    () => Reflect.apply(client.removeProject, client, [{ projectId, root: "/unexpected" }]),
                    () => Reflect.apply(client.rescanProject, client, [{ projectId, extra: true }]),
                    () => client.registerProject({ root: "/tmp", displayName: "x".repeat(201) }),
                    () => client.registerProject({ root: "/tmp", directoryConfirmation: "x".repeat(129) }),
                ];
                const results: string[] = [];
                for (const operation of operations) {
                    try {
                        await operation();
                        results.push("ACCEPTED");
                    } catch (error) {
                        results.push(String(error));
                    }
                }
                return results;
            }, projectId);
            equal(errors.length, 12);
            ok(errors.every((error) => error !== "ACCEPTED"));
            deepEqual(await list(desktop), before);
            equal(fixture.provider.requests.length, 0);
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
    "native Continue failure restores focus after settlement and retains explicit retry",
    { timeout: 40000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        let desktop: Desktop | undefined;
        const alias = join(fixture.home, "home-alias");
        await symlink(fixture.home, alias);
        try {
            desktop = await launchDesktop(fixture, { entry: true });
            const { page } = desktop;
            await picker(desktop, alias);
            await page.getByRole("button", { name: "Open Project", exact: true }).click();
            await page.getByLabel("Display name", { exact: true }).fill("Retained retry name");
            await page.getByRole("button", { name: "Link Project", exact: true }).click();
            await page.getByRole("dialog").waitFor();
            await rm(alias);
            await writeFile(alias, "Not a directory anymore");
            try {
                await page.getByRole("button", { name: "Continue", exact: true }).click();
                await page.getByText(/Project operation failed/).waitFor();
                equal(await page.getByRole("dialog").count(), 0);
                equal(await page.getByRole("button", { name: "Link Project", exact: true }).isEnabled(), true);
                equal(await page.evaluate(() => document.activeElement?.textContent), "Link Project");
                equal(await page.getByLabel("Project root", { exact: true }).inputValue(), alias);
                equal(await page.getByLabel("Display name", { exact: true }).inputValue(), "Retained retry name");
            } finally {
                await rm(alias);
                await symlink(fixture.home, alias);
            }
            deepEqual((await list(desktop)).projects, []);
            await page.getByRole("button", { name: "Link Project", exact: true }).click();
            await page.getByRole("button", { name: "Continue", exact: true }).click();
            await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
            equal((await list(desktop)).projects[0].displayName, "Retained retry name");
        } finally {
            await desktop?.close();
            await fixture.cleanup();
        }
    },
);

test("native relink display name crosses preload main and Core", { timeout: 40000 }, async () => {
    const fixture = await makeSessionProcessFixture();
    let desktop: Desktop | undefined;
    try {
        desktop = await launchDesktop(fixture, { entry: true });
        await link(desktop, fixture.project);
        const projectId = (await list(desktop)).projects[0].projectId;
        await desktop.page.evaluate(
            async ({ projectId, root }) => {
                await (globalThis as DesktopWindow).runwieldProjects.relinkProject({
                    projectId,
                    newRoot: root,
                    displayName: "Renamed across boundary",
                });
            },
            { projectId, root: fixture.project },
        );
        equal((await list(desktop)).projects[0].displayName, "Renamed across boundary");
    } finally {
        await desktop?.close();
        await fixture.cleanup();
    }
});

for (const failure of ["credentials", "network", "optional-cli"]) {
    test(
        `native ${failure} failure keeps the actual provider error and Project management`,
        { timeout: 60000 },
        async () => {
            const fixture = await makeSessionProcessFixture();
            let desktop: Desktop | undefined;
            try {
                if (failure === "credentials") {
                    await writeFile(
                        join(fixture.home, ".wld", "auth.json"),
                        JSON.stringify({ fixture: { type: "api_key", key: "invalid-key" } }),
                    );
                } else if (failure === "network") {
                    // Stop the real provider listener. No Core code is replaced.
                    await fixture.provider.close();
                } else {
                    fixture.env.PATH = "/usr/bin:/bin";
                    await writeFile(
                        join(fixture.home, ".wld", "settings.json"),
                        JSON.stringify({
                            defaultProvider: "claude-cli",
                            defaultModel: "sonnet",
                            notifications: { enabled: false },
                            onboardingTutorialOfferHandled: true,
                        }),
                    );
                }
                desktop = await launchDesktop(fixture, { entry: true });
                await link(desktop, fixture.project);
                const { page } = desktop;
                await page.getByRole("button", { name: "Open", exact: true }).click();
                await page.getByRole("button", { name: "New Session", exact: true }).click();
                await page.getByText("Ready", { exact: true }).waitFor();
                await page.getByLabel("Message", { exact: true }).fill("Report the real provider failure.");
                await page.getByRole("button", { name: "Send", exact: true }).click();
                const expected =
                    failure === "credentials"
                        ? /model service could not verify your access/
                        : failure === "network"
                          ? /model service stopped responding/
                          : /Claude Code is not available/;
                await page.getByText(expected).first().waitFor();
                const message = await page.getByText(expected).first().innerText();
                match(message, expected);
                ok(!/Workspace.*(sign.in|account)|wld login|default.model.*required/i.test(message));
                await page.getByRole("button", { name: "Projects", exact: true }).click();
                await page.getByRole("button", { name: "Settings", exact: true }).click();
                await page.getByRole("button", { name: "Disable", exact: true }).click();
                await page.getByRole("button", { name: "Enable", exact: true }).waitFor();
                equal((await list(desktop)).projects[0].lifecycle, "disabled");
                await page.getByRole("button", { name: "Enable", exact: true }).click();
                await page.getByRole("button", { name: "Disable", exact: true }).waitFor();
                equal((await list(desktop)).projects[0].enabled, true);
                if (failure === "credentials") {
                    ok(fixture.provider.requests.length > 0);
                    ok(fixture.provider.requests.every((request) => request.authorization === "Bearer invalid-key"));
                } else equal(fixture.provider.requests.length, 0);
            } finally {
                await desktop?.close();
                await fixture.cleanup();
            }
        },
    );
}
