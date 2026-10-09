import { assertEquals, assertStringIncludes } from "@std/assert";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { createWorkRecordMnemotecaFixture } from "../../shared/work-records/test-fixtures/mnemoteca-port.ts";
import { resolveSelectedThemeJson } from "../theme/theme.js";
import { renderRunWieldThemeCss } from "../design-system/theme-bridge.ts";
import { createWorkspaceApp } from "./server.js";
import { GET } from "./pages/theme.css.ts";

Deno.test("production and dev browser themes stay dark when a light TUI theme is selected", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = Deno.env.get("HOME");
        const previousSandboxHome = Deno.env.get("WLD_TEST_SANDBOX_HOME");
        const previousCwd = Deno.cwd();
        const root = await Deno.makeTempDir({ prefix: "workspace-browser-theme-" });
        const home = `${root}/home`;
        const project = `${root}/project`;
        const themePackage = `${root}/theme-package`;
        try {
            await Deno.mkdir(`${home}/.wld`, { recursive: true });
            await Deno.mkdir(project);
            await Deno.mkdir(`${themePackage}/themes`, { recursive: true });
            await Deno.writeTextFile(
                `${themePackage}/package.json`,
                JSON.stringify({
                    name: "workspace-test-light-theme",
                    version: "1.0.0",
                    pi: { themes: ["themes/*.json"] },
                }),
            );
            await Deno.writeTextFile(
                `${themePackage}/themes/light.json`,
                JSON.stringify({
                    name: "test-light-terminal",
                    vars: { text: "#123456" },
                    export: { pageBg: "#ffffff", cardBg: "#eeeeee" },
                }),
            );
            await Deno.writeTextFile(
                `${home}/.wld/settings.json`,
                JSON.stringify({
                    theme: "test-light-terminal",
                    packages: [themePackage],
                }),
            );
            Deno.env.set("HOME", home);
            Deno.env.set("WLD_TEST_SANDBOX_HOME", home);
            Deno.chdir(project);
            const terminalTheme = await resolveSelectedThemeJson();
            assertEquals(terminalTheme.name, "test-light-terminal");
            assertEquals(terminalTheme.export?.pageBg, "#ffffff");

            const handler = createWorkspaceApp({
                cwd: project,
                token: "secret",
                mnemotecaPort: createWorkRecordMnemotecaFixture(),
            }).handler();
            const production = await handler(new Request("http://localhost/theme.css"));
            const dev = GET();
            for (const response of [production, dev]) {
                assertEquals(response.status, 200);
                assertEquals(response.headers.get("content-type"), "text/css; charset=utf-8");
                assertEquals(response.headers.get("cache-control"), "no-store");
                const css = await response.text();
                assertEquals(css, renderRunWieldThemeCss());
                assertStringIncludes(css, "color-scheme: dark;");
                assertStringIncludes(css, "--rw-page-bg: #0b1020;");
                assertEquals(css.includes("test-light-terminal"), false);
            }
            assertEquals((await resolveSelectedThemeJson()).name, "test-light-terminal");
        } finally {
            Deno.chdir(previousCwd);
            if (previousHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", previousHome);
            if (previousSandboxHome === undefined) Deno.env.delete("WLD_TEST_SANDBOX_HOME");
            else Deno.env.set("WLD_TEST_SANDBOX_HOME", previousSandboxHome);
            await Deno.remove(root, { recursive: true });
        }
    });
});
