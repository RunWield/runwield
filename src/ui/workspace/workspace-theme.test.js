import { getCwd } from "../../constants.js";
import process from "node:process";
import { mkdir as fsMkdir, mkdtemp as fsMkdtemp, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { createWorkRecordMnemotecaFixture } from "../../shared/work-records/test-fixtures/mnemoteca-port.ts";
import { resolveSelectedThemeJson } from "../theme/theme.js";
import { renderRunWieldThemeCss } from "../design-system/theme-bridge.ts";
import { createWorkspaceApp } from "./server.js";
import { GET } from "./pages/theme.css.ts";

test("production and dev browser themes stay dark when a light TUI theme is selected", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = process.env["HOME"];
        const previousSandboxHome = process.env["WLD_TEST_SANDBOX_HOME"];
        const previousCwd = getCwd();
        const root = await fsMkdtemp(join(tmpdir(), "workspace-browser-theme-"));
        const home = `${root}/home`;
        const project = `${root}/project`;
        const themePackage = `${root}/theme-package`;
        try {
            await fsMkdir(`${home}/.wld`, { recursive: true });
            await fsMkdir(project);
            await fsMkdir(`${themePackage}/themes`, { recursive: true });
            await fsWriteFile(
                `${themePackage}/package.json`,
                JSON.stringify({
                    name: "workspace-test-light-theme",
                    version: "1.0.0",
                    pi: { themes: ["themes/*.json"] },
                }),
            );
            await fsWriteFile(
                `${themePackage}/themes/light.json`,
                JSON.stringify({
                    name: "test-light-terminal",
                    vars: { text: "#123456" },
                    export: { pageBg: "#ffffff", cardBg: "#eeeeee" },
                }),
            );
            await fsWriteFile(
                `${home}/.wld/settings.json`,
                JSON.stringify({
                    theme: "test-light-terminal",
                    packages: [themePackage],
                }),
            );
            process.env["HOME"] = home;
            process.env["WLD_TEST_SANDBOX_HOME"] = home;
            process.chdir(project);
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
            process.chdir(previousCwd);
            if (previousHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = previousHome;
            if (previousSandboxHome === undefined) delete process.env["WLD_TEST_SANDBOX_HOME"];
            else process.env["WLD_TEST_SANDBOX_HOME"] = previousSandboxHome;
            await fsRm(root, { recursive: true });
        }
    });
});
