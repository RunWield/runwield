import { test } from "node:test";
import { equal } from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";
import { captureForegroundProcess } from "./captured-process.ts";

for (const { route, sandboxed } of [
    { route: "/plan-review", sandboxed: true },
    { route: "/code-review", sandboxed: true },
    { route: "/read", sandboxed: true },
    { route: "/read", sandboxed: false },
]) {
    test(
        `${sandboxed ? "sandboxed" : "normal"} browser launch ${sandboxed ? "blocks" : "opens"} fixture ${route}`,
        { skip: process.platform === "win32" },
        async () => {
            const root = await mkdtemp(join(tmpdir(), "browser-port-"));
            try {
                const log = join(root, "opened");
                await writeFile(log, "");
                for (const name of ["open", "xdg-open"]) {
                    await writeFile(join(root, name), '#!/bin/sh\nprintf "%s\\n" "$1" >> "$BROWSER_OPEN_LOG"\n', {
                        mode: 0o755,
                    });
                }
                const moduleUrl = new URL("./browser-port.ts", import.meta.url).href;
                const result = await captureForegroundProcess(process.execPath, {
                    cwd: root,
                    args: [
                        "--eval",
                        `import { SYSTEM_BROWSER_PORT } from ${JSON.stringify(moduleUrl)};
                     console.log(await SYSTEM_BROWSER_PORT.open(${JSON.stringify(`http://localhost:12345${route}`)}));`,
                    ],
                    env: {
                        PATH: `${root}${delimiter}${process.env.PATH}`,
                        BROWSER_OPEN_LOG: log,
                        WLD_TEST_SANDBOX_HOME: sandboxed ? process.env.WLD_TEST_SANDBOX_HOME! : "",
                    },
                });
                equal(result.code, 0, new TextDecoder().decode(result.stderr));
                equal(await readFile(log, "utf8"), sandboxed ? "" : `http://localhost:12345${route}\n`);
                equal(new TextDecoder().decode(result.stdout).trim(), String(!sandboxed));
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        },
    );
}
