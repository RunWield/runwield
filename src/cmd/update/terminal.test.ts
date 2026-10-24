import type { TerminalRuntime } from "../../../scripts/terminal-fixture.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";

interface ConfirmationCase {
    name: string;
    input: string;
    accepts: boolean;
    bypass?: boolean;
}

const cases: ConfirmationCase[] = [
    { name: "Enter accepts the displayed default", input: "\n", accepts: true },
    { name: "Y accepts", input: "Y\n", accepts: true },
    { name: "yes accepts", input: "yes\n", accepts: true },
    { name: "n cancels", input: "n\n", accepts: false },
    { name: "NO cancels", input: "NO\n", accepts: false },
    { name: "unrecognized input cancels", input: "maybe\n", accepts: false },
    { name: "Ctrl-D cancels", input: "\x04", accepts: false },
    { name: "--yes bypasses the prompt", input: "", accepts: true, bypass: true },
];

for (const scenario of cases) {
    test(`RC update terminal: ${scenario.name}`, { skip: process.platform === "win32" }, async () => {
        const root = await mkdtemp(join(tmpdir(), "runwield-update-terminal-"));
        const fixture = join(root, "confirm.mjs");
        const moduleUrl = new URL("./index.ts", import.meta.url).href;
        // Only the network and installer subprocess are fixtures. The updater and
        // Bun prompt read real terminal input; no installer is ever executed.
        await writeFile(
            fixture,
            `import { runUpdateCommand } from ${JSON.stringify(moduleUrl)};
const requests = [];
const installs = [];
const exits = [];
await runUpdateCommand(${JSON.stringify(scenario.bypass ? ["--rc", "--yes"] : ["--rc"])}, {
    networkPort: { fetch: async (input) => {
        const url = String(input);
        requests.push(url);
        if (url === "https://api.github.com/repos/gandazgul/runwield/releases") {
            return new Response(JSON.stringify([{ tag_name: "v999.0.0-rc.3", prerelease: true, draft: false }]));
        }
        if (url === "https://raw.githubusercontent.com/gandazgul/runwield/v999.0.0-rc.3/install.sh") {
            return new Response("# terminal fixture; never execute");
        }
        throw new Error("Unexpected network request: " + url);
    }},
    installerPort: { run: async (_path, tag) => { installs.push(tag); return 0; } },
    exitPort: { exit: (code) => { exits.push(code); } },
});
console.log("RESULT " + JSON.stringify({ requests, installs, exits }));
`,
        );
        const bun: TerminalRuntime = Reflect.get(globalThis, String("Bun"));
        const decoder = new TextDecoder();
        let output = "";
        let answered = false;
        const child = bun.spawn([process.execPath, ...runtimeSourceArgs(["run", "-A", fixture])], {
            cwd: root,
            timeout: 15_000,
            terminal: {
                cols: 120,
                rows: 30,
                data(terminal, data) {
                    output += decoder.decode(data, { stream: true });
                    if (!scenario.bypass && !answered && output.includes("Continue? [Y/n]")) {
                        answered = true;
                        terminal.write(scenario.input);
                    }
                },
            },
        });
        try {
            assertEquals(await child.exited, 0, output);
            output += decoder.decode();
            assertEquals(answered, !scenario.bypass, output);
            assertEquals(output.includes("Continue? [Y/n]"), !scenario.bypass, output);
            assertEquals(output.includes("RunWield update cancelled."), !scenario.accepts, output);
            assertStringIncludes(
                output,
                "RESULT " +
                    JSON.stringify({
                        requests: [
                            "https://api.github.com/repos/gandazgul/runwield/releases",
                            ...(scenario.accepts
                                ? ["https://raw.githubusercontent.com/gandazgul/runwield/v999.0.0-rc.3/install.sh"]
                                : []),
                        ],
                        installs: scenario.accepts ? ["v999.0.0-rc.3"] : [],
                        exits: [],
                    }),
            );
        } finally {
            child.terminal.close();
            await rm(root, { recursive: true, force: true });
        }
    });
}
