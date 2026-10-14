import { equal } from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import { test } from "node:test";
import { SYSTEM_INSTALLER_PROCESS_PORT } from "./index.ts";

test("installer process preserves literal arguments, environment and normal exit status", {
    skip: platform === "win32",
}, async () => {
    const directory = await mkdtemp(join(tmpdir(), "runwield-installer-process-"));
    try {
        const path = join(directory, "fixture.sh");
        await writeFile(
            path,
            'test "$1" = "literal; tag" || exit 90\ntest "$WLD_INSTALLER_FIXTURE" = "expected" || exit 91\nexit 7\n',
        );
        equal(await SYSTEM_INSTALLER_PROCESS_PORT.run(path, "literal; tag", { WLD_INSTALLER_FIXTURE: "expected" }), 7);
    } finally {
        await rm(directory, { recursive: true });
    }
});

for (const [signal, code] of [["TERM", 143], ["INT", 130]] as const) {
    test(`installer process preserves ${signal} exit status`, { skip: platform === "win32" }, async () => {
        const directory = await mkdtemp(join(tmpdir(), "runwield-installer-signal-"));
        try {
            const path = join(directory, "fixture.sh");
            await writeFile(path, `kill -${signal} $$\n`);
            equal(await SYSTEM_INSTALLER_PROCESS_PORT.run(path, "fixture", {}), code);
        } finally {
            await rm(directory, { recursive: true });
        }
    });
}
