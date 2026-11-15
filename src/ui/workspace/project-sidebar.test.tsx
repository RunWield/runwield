import { test } from "node:test";
import { equal, ok, deepEqual } from "node:assert/strict";
import { rm, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeSessionProcessFixture } from "../../acp/client/testing/session-process-fixture.ts";
import { defineGitFixture, git } from "../../shared/git-test-fixture.ts";
import { launchDesktop } from "../desktop/testing/desktop-fixture.ts";
import type { WorkspaceSavedSessionClient } from "./client/session-client.ts";
import type { DesktopProjectClient } from "./client/project-client.ts";
const gitProject = defineGitFixture(async (root) => {
    await writeFile(join(root, "README.md"), "Sidebar second Project");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "Initial fixture"]);
});
interface SidebarGlobals {
    runwieldSession: WorkspaceSavedSessionClient;
    runwieldProjects: DesktopProjectClient;
}
type SidebarWindow = typeof globalThis & SidebarGlobals;

test(
    "persistent Project navigation pages independently, preserves selection and restores archived work without a provider",
    { timeout: 90000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        const secondRoot = await gitProject.checkout();
        let desktop: Awaited<ReturnType<typeof launchDesktop>> | undefined;
        try {
            const runtime = fixture.launch(true);
            const a = await runtime.client.registerProject({ root: fixture.project, displayName: "Project A" });
            const b = await runtime.client.registerProject({ root: secondRoot, displayName: "Project B" });
            ok(a.status === "ok" && b.status === "ok");
            const { context } = await runtime.client.openProject({ projectId: a.project.projectId });
            const ids: string[] = [];
            for (let index = 0; index < 12; index++) {
                await runtime.client.create();
                fixture.provider.enqueue({ text: `Saved answer ${index}.` });
                await runtime.client.send(
                    runtime.binding(),
                    index < 2 ? "Duplicate title" : `Saved ${index} ${"long-name ".repeat(index === 11 ? 30 : 0)}`,
                );
                ids.push(runtime.view().durableSessionId);
                if (index === 0) await runtime.client.archive({ context, sessionId: ids[0] });
                await runtime.client.close(runtime.binding());
            }
            await runtime.shutdown();
            await writeFile(join(fixture.home, ".wld", "auth.json"), "{}");
            await writeFile(join(fixture.home, ".wld", "models.json"), "{}");
            await writeFile(
                join(fixture.home, ".wld", "settings.json"),
                JSON.stringify({ onboardingTutorialOfferHandled: true }),
            );
            await rename(secondRoot, `${secondRoot}-unavailable`);
            desktop = await launchDesktop(fixture, { entry: true });
            const { page } = desktop;
            const sidebar = page.getByRole("complementary", { name: "Workspace navigation" });
            await sidebar.getByRole("button", { name: "Project A", exact: true }).click();
            await sidebar.getByRole("button", { name: "Project B", exact: true }).click();
            const first = sidebar.getByRole("region", { name: "Project A recent Sessions" });
            const second = sidebar.getByRole("region", { name: "Project B recent Sessions" });
            await first.locator(".session-list-item").nth(4).waitFor();
            equal(await first.locator(".session-list-item").count(), 5);
            await first.getByRole("button", { name: "Show more…" }).click();
            await first.locator(".session-list-item").nth(9).waitFor();
            equal(await first.locator(".session-list-item").count(), 10);
            await first.getByRole("button", { name: "Show more…" }).click();
            await first.locator(".session-list-item").nth(10).waitFor();
            equal(await first.locator(".session-list-item").count(), 11);
            await second.getByRole("button", { name: "Retry", exact: true }).waitFor();
            await rename(`${secondRoot}-unavailable`, secondRoot);
            await second.getByRole("button", { name: "Retry", exact: true }).click();
            await second.getByText("No saved Sessions", { exact: true }).waitFor();
            equal(await first.locator(".session-list-item").count(), 11, "another Project retry must not reset paging");
            await first.locator(".session-list-item").first().click();
            await page
                .getByRole("region", { name: "Conversation", exact: true })
                .getByText("Saved answer 11.", { exact: true })
                .waitFor();
            const selected = await page.evaluate(async () => {
                const client = (globalThis as SidebarWindow).runwieldSession;
                return new Promise<string>((resolve) => {
                    const off = client.observe((view) => {
                        resolve(view.durableSessionId);
                        queueMicrotask(() => off());
                    });
                });
            });
            equal(selected, ids[11]);
            await page.waitForFunction(() => Boolean(document.querySelector('select[aria-label="Model"] option')));
            equal(
                await page.getByRole("combobox", { name: "Model", exact: true }).inputValue(),
                "fixture\u001ffixture",
            );
            await page.getByLabel("Message", { exact: true }).fill("Draft stays on Project A");
            await sidebar.getByRole("button", { name: "Project B settings", exact: true }).click();
            await page.getByRole("button", { name: "Session", exact: true }).click();
            equal(await page.getByLabel("Message", { exact: true }).inputValue(), "Draft stays on Project A");
            await sidebar.getByRole("button", { name: "+ New Session", exact: true }).click();
            await page.getByRole("alert").filter({ hasText: "Close the current Session" }).waitFor();
            equal(await page.getByLabel("Message", { exact: true }).inputValue(), "Draft stays on Project A");
            await page.getByRole("button", { name: "Close Session", exact: true }).click();
            await page.getByText("No Session open", { exact: true }).waitFor();
            await sidebar.getByRole("button", { name: "Project A settings", exact: true }).click();
            await page.getByRole("tab", { name: "Archived Sessions", exact: true }).click();
            const archived = page
                .getByRole("tabpanel", { name: "Archived Sessions", exact: true })
                .getByRole("region", { name: "Project A archived Sessions" });
            await archived.getByRole("button", { name: "Duplicate title", exact: true }).click();
            await page
                .getByRole("region", { name: "Conversation", exact: true })
                .getByText("Saved answer 0.", { exact: true })
                .waitFor();
            await page.getByRole("button", { name: "Session context", exact: true }).click();
            await page
                .getByRole("complementary", { name: "Session context" })
                .getByText("Archived", { exact: true })
                .waitFor();
            await sidebar.getByRole("button", { name: "Project A settings", exact: true }).click();
            await page.getByRole("tab", { name: "Archived Sessions", exact: true }).click();
            await archived.getByRole("button", { name: "Unarchive Duplicate title", exact: true }).click();
            await archived.getByText("No archived Sessions", { exact: true }).waitFor();
            const restored = await page.evaluate(async (projectId) => {
                const client = (globalThis as SidebarWindow).runwieldSession;
                const admitted = await client.readProject({ projectId });
                return client.listSessions({ context: admitted.context, archiveState: "all", limit: 100 });
            }, a.project.projectId);
            equal(restored.sessions.length, 12);
            equal(restored.sessions.find((row) => row.sessionId === ids[0])?.archivedAt, null);
            equal(fixture.provider.requests.length, 12, "navigation and archive reads must not call a model");
            deepEqual(desktop.errors, []);
            await sidebar.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
            await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
            equal(
                await sidebar.getByRole("button", { name: "Project A", exact: true }).getAttribute("aria-expanded"),
                "true",
            );
            const resizer = sidebar.getByRole("separator", { name: "Sidebar width", exact: true });
            await resizer.focus();
            await page.keyboard.press("ArrowRight");
            await page.waitForFunction(
                () =>
                    localStorage.getItem("runwield:owner:sidebar-width") ===
                    document.querySelector('[aria-label="Sidebar width"]')?.getAttribute("aria-valuenow"),
            );
            const savedWidth = await resizer.getAttribute("aria-valuenow");
            equal(await page.evaluate(() => localStorage.getItem("runwield:owner:sidebar-width")), savedWidth);
            await page.setViewportSize({ width: 760, height: 700 });
            await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
            await sidebar.getByRole("button", { name: "RunWield", exact: true }).focus();
            await page.keyboard.press("Escape");
            await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Show sidebar");
            await page.setViewportSize({ width: 1200, height: 800 });
            await sidebar.waitFor();
            equal(await resizer.getAttribute("aria-valuenow"), savedWidth);
            equal(
                await sidebar.getByRole("button", { name: "Project A", exact: true }).getAttribute("aria-expanded"),
                "true",
            );
        } finally {
            try {
                await desktop?.close();
            } finally {
                await fixture.cleanup();
                await rm(secondRoot, { recursive: true, force: true });
                await rm(`${secondRoot}-unavailable`, { recursive: true, force: true });
            }
        }
    },
);

test("busy archive uses an accessible confirmation and restores focus after decline", { timeout: 60000 }, async () => {
    const fixture = await makeSessionProcessFixture();
    let desktop: Awaited<ReturnType<typeof launchDesktop>> | undefined;
    try {
        const runtime = fixture.launch(true);
        const registered = await runtime.client.registerProject({
            root: fixture.project,
            displayName: "Archive Project",
        });
        ok(registered.status === "ok");
        await runtime.client.openProject({ projectId: registered.project.projectId });
        await runtime.client.create();
        fixture.provider.enqueue({ text: "Saved before archive." });
        await runtime.client.send(runtime.binding(), "Busy archive conversation");
        await runtime.client.close(runtime.binding());
        await runtime.shutdown();
        desktop = await launchDesktop(fixture, { entry: true });
        const { page } = desktop;
        const sidebar = page.getByRole("complementary", { name: "Workspace navigation" });
        await sidebar.getByRole("button", { name: "Archive Project", exact: true }).click();
        await sidebar.getByRole("button", { name: "Busy archive conversation", exact: true }).click();
        await page.getByText("Saved before archive.", { exact: true }).waitFor();
        fixture.provider.enqueue({ question: { type: "text", prompt: "Keep this pending answer" } });
        await page.getByLabel("Message", { exact: true }).fill("Ask before archive.");
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await page.getByRole("heading", { name: "Keep this pending answer", exact: true }).waitFor();
        const archive = sidebar.getByRole("button", { name: "Archive Busy archive conversation", exact: true });
        await archive.click();
        const dialog = page.getByRole("dialog", { name: "Stop work and archive Session?", exact: true });
        await dialog.waitFor();
        await dialog.getByRole("button", { name: "Cancel", exact: true }).waitFor({ timeout: 2000 });
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });
        await page.waitForFunction(
            () => document.activeElement?.getAttribute("aria-label") === "Archive Busy archive conversation",
        );
        await page.getByRole("heading", { name: "Keep this pending answer", exact: true }).waitFor();
        await archive.click();
        await dialog.getByRole("button", { name: "Stop and archive", exact: true }).click();
        await archive.waitFor({ state: "hidden" });
        equal(fixture.provider.requests.length, 2);
        deepEqual(desktop.errors, []);
    } finally {
        try {
            await desktop?.close();
        } finally {
            await fixture.cleanup();
        }
    }
});
