import { test } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import process from "node:process";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { writeRuntimeExecutableFixture } from "../../testing/runtime-executable-fixture.ts";
import { setCustomSetting } from "../../shared/settings.ts";
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

for (const backend of ["claude", "agy"] as const) {
    test(`composed TUI restores the draft and keeps the actionable ${backend} failure`, async () => {
        await withRuntimeCommandFixture("tui-real-backend-failure-", async ({ homeDir, alternateRoot }) => {
            const bin = join(homeDir, "backend-bin");
            await mkdir(bin);
            const launchLog = join(homeDir, "backend-launches.txt");
            const source = join(bin, "failing-cli.ts");
            const refusal = "Fixture backend refused this request";
            const command = backend;
            await writeFile(
                source,
                `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(launchLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
console.error(${JSON.stringify(refusal)});
process.exit(1);
`,
            );
            await writeRuntimeExecutableFixture(join(bin, command), source);
            const previousPath = process.env.PATH;
            process.env.PATH = `${bin}${delimiter}${previousPath || ""}`;
            const model = backend === "claude" ? "claude-cli/sonnet" : "agy-cli/gemini-3.8-flash";
            await setCustomSetting("agents", { operator: { model }, router: { model } }, "project", alternateRoot);
            const terminal = new VirtualTerminal({ columns: 160, rows: 45 });
            let composition: Awaited<ReturnType<typeof createInteractiveTuiComposition>> | undefined;
            const previousConsoleError = console.error;
            let loggedErrors = 0;
            try {
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
                const message = backend === "agy" ? "Antigravity (agy-cli) was removed" : refusal;
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
                if (backend !== "claude") {
                    await assertRejects(() => readFile(launchLog), Error, "ENOENT");
                    assertEquals(terminal.getScrollbackText().includes("/model"), true);
                    await assertRejects(
                        () => readFile(join(homeDir, ".gemini", "config", "mcp_config.json")),
                        Error,
                        "ENOENT",
                    );
                } else {
                    assertEquals((await readFile(launchLog, "utf8")).trim().length > 0, true);
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
