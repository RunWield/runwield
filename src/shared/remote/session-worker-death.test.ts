import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { test } from "node:test";
import { mkdir as fsMkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { getCwd } from "../../constants.js";
import { captureForegroundProcess } from "../captured-process.ts";
import { assertEquals } from "../../testing/assertions.ts";
import { join } from "node:path";
import { makeControlFixture, within } from "./session-save-test-fixture.ts";
import process from "node:process";

test("Worker startup death faults at the total deadline without a main-thread callback", async () => {
    const f = await makeControlFixture();
    await f.ready();
    const directory = join(f.root, "damaged-runtime");
    await fsMkdir(directory);
    try {
        for (const name of ["session-protocol.ts", "session-save-bridge.ts", "session-save-worker.ts"]) {
            const source = await fsReadFile(new URL(name, import.meta.url), "utf8");
            // Corrupt a disposable installed runtime, not the store, bridge, transport or test subject.
            const prefix = name === "session-save-worker.ts" ? 'throw new Error("Worker startup death");\n' : "";
            await fsWriteFile(join(directory, name), prefix + source);
        }
        const script = `const { RemoteSessionSaveBridge } = await import(process.argv[2]);
            const bridge = new RemoteSessionSaveBridge(JSON.parse(process.argv[3]));
            const started = performance.now();
            let failed = false;
            let sticky = false;
            try { bridge.request("hydrate"); } catch { failed = true; }
            const elapsed = performance.now() - started;
            try { bridge.request("checkpoint"); } catch { sticky = true; }
            bridge.close();
            console.log(JSON.stringify({ failed, sticky, bounded: elapsed < 3000 }));`;
        const entry = join(directory, "client.ts");
        await fsWriteFile(entry, script);
        const output = await within(
            captureForegroundProcess(process.execPath, {
                args: runtimeSourceArgs([
                    "run",
                    "-A",
                    "--no-check",
                    entry,
                    join(directory, "session-save-bridge.ts"),
                    JSON.stringify({
                        baseUrl: f.baseUrl,
                        credential: f.control.credential,
                        operation: f.owner.operation,
                        timeoutMs: 500,
                    }),
                ]),
                env: { HOME: f.home, MNEMOTECA_DB_PATH: join(f.home, "memory.sqlite3") },
                cwd: getCwd(),
            }),
        );
        assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
        assertEquals(JSON.parse(new TextDecoder().decode(output.stdout)), {
            failed: true,
            sticky: true,
            bounded: true,
        });
        assertEquals(f.owner.inspect().contents, f.initial);
        assertEquals(f.store.inspectSessionActivation(f.session.runwieldSessionId).generation, null);
    } finally {
        await f.close();
    }
});
