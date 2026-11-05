import { test } from "node:test";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import process from "node:process";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { writeRuntimeExecutableFixture } from "../../testing/runtime-executable-fixture.ts";
import { setCustomSetting } from "../../shared/settings.js";
import { installAgyCliMcpSetup } from "../../shared/session/backends/agy-cli/mcp-setup.ts";
import { NO_OPEN_BROWSER_PORT } from "../../shared/browser-port.ts";
import { createInteractiveTuiComposition } from "./interactive-tui-composition.ts";
import { VirtualTerminal } from "./testing/virtual-terminal.ts";

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

for (const backend of ["claude", "agy", "unapproved Agy setup"] as const) {
    test(`composed TUI restores the draft and keeps the actionable ${backend} failure`, async () => {
        await withRuntimeCommandFixture("tui-real-backend-failure-", async ({ homeDir, alternateRoot }) => {
            const bin = join(homeDir, "backend-bin");
            await mkdir(bin);
            const launchLog = join(homeDir, "backend-launches.txt");
            const source = join(bin, "failing-cli.ts");
            await writeFile(
                source,
                `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(launchLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
console.error("Fixture backend refused this request");
process.exit(1);
`,
            );
            const command = backend === "claude" ? "claude" : "agy";
            await writeRuntimeExecutableFixture(join(bin, command), source);
            // The setup inspector requires a native executable named wld. This
            // specimen is never run: refusal occurs before any MCP invocation.
            if (backend !== "claude")
                await copyFile(process.execPath, join(bin, process.platform === "win32" ? "wld.exe" : "wld"));
            const previousPath = process.env.PATH;
            process.env.PATH = `${bin}${delimiter}${previousPath || ""}`;
            const model = backend === "claude" ? "claude-cli/sonnet" : "agy-cli/gemini-3.8-flash";
            await setCustomSetting("agents", { operator: { model }, router: { model } }, "project", alternateRoot);
            const terminal = new VirtualTerminal({ columns: 160, rows: 45 });
            let composition: Awaited<ReturnType<typeof createInteractiveTuiComposition>> | undefined;
            const previousConsoleError = console.error;
            let loggedErrors = 0;
            try {
                if (backend === "agy") await installAgyCliMcpSetup();
                composition = await createInteractiveTuiComposition(null, {
                    browser: NO_OPEN_BROWSER_PORT,
                    terminal,
                    initialAgentName: "operator",
                });
                await composition.waitForIdle();
                console.error = () => {
                    loggedErrors++;
                };
                terminal.typeText("keep this draft");
                terminal.pressEnter();
                await terminal.flush();
                const message =
                    backend === "unapproved Agy setup"
                        ? "Antigravity MCP setup needs approval"
                        : backend === "agy"
                          ? "did not load RunWield's temporary Agent"
                          : "Fixture backend refused this request";
                await waitFor(() => terminal.getScrollbackText().includes(message), `${backend} actionable failure`);
                await composition.waitForIdle();
                terminal.typeText(" retry");
                await terminal.flush();
                await waitFor(
                    () => terminal.getScreenText().includes("keep this draft retry"),
                    "editable restored draft",
                );
                assertEquals(terminal.getScrollbackText().includes("RunWield could not send that message"), false);
                assertEquals(terminal.getScrollbackText().includes("at async"), false);
                assertEquals(loggedErrors, 0);
                if (backend === "unapproved Agy setup") {
                    assertStringIncludes(terminal.getScrollbackText(), "mcp agy-cli --setup");
                    await assertRejects(() => readFile(launchLog), Error, "ENOENT");
                    await assertRejects(
                        () => readFile(join(homeDir, ".gemini", "config", "mcp_config.json")),
                        Error,
                        "ENOENT",
                    );
                } else {
                    assertEquals((await readFile(launchLog, "utf8")).length > 0, true);
                }
            } finally {
                console.error = previousConsoleError;
                terminal.pressEscape();
                await composition?.dispose();
                if (previousPath === undefined) delete process.env.PATH;
                else process.env.PATH = previousPath;
            }
        });
    });
}
