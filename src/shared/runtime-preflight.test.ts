import { writeRuntimeExecutableFixture } from "../testing/runtime-executable-fixture.ts";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { env } from "node:process";
import { assertEquals, assertRejects, assertStringIncludes } from "../testing/assertions.ts";
import { join } from "node:path";
import { withProcessGlobalTestLock } from "../testing/process-global-lock.ts";
import { ensureCymbalBinary, ensureKetchBinary, ensureMnemotecaBinary, hasSnipBinary } from "./runtime-preflight.ts";

async function writeAvailableBinary(directory: string, name: string): Promise<string> {
    const path = join(directory, name);
    const source = join(directory, `${name}.ts`);
    await fsWriteFile(source, "process.exit(0);\n");
    return await writeRuntimeExecutableFixture(path, source);
}

function runtimePreflightTest(name: string, run: (binaryDirectory: string) => Promise<void>): void {
    test(name, () =>
        withProcessGlobalTestLock(async () => {
            const previousPath = env.PATH;
            const binaryDirectory = await mkdtemp(join(tmpdir(), "runwield-runtime-binaries-"));
            env.PATH = binaryDirectory;
            try {
                await run(binaryDirectory);
            } finally {
                if (previousPath === undefined) delete env.PATH;
                else env.PATH = previousPath;
                await fsRm(binaryDirectory, { recursive: true }).catch(() => {});
            }
        }));
}

runtimePreflightTest(
    "required runtime binaries cache real PATH probe results while optional Snip stays live",
    async (dir) => {
        const mnemoteca = await writeAvailableBinary(dir, "mnemoteca");
        const cymbal = await writeAvailableBinary(dir, "cymbal");
        const ketch = await writeAvailableBinary(dir, "ketch");
        const snip = await writeAvailableBinary(dir, "snip");

        await ensureMnemotecaBinary();
        await ensureCymbalBinary();
        await ensureKetchBinary();
        assertEquals(await hasSnipBinary(), true);

        await fsRm(mnemoteca);
        await fsRm(cymbal);
        await fsRm(ketch);
        await fsRm(snip);

        await ensureMnemotecaBinary();
        await ensureCymbalBinary();
        await ensureKetchBinary();
        assertEquals(await hasSnipBinary(), false);
    },
);

runtimePreflightTest("runtime preflight reports install guidance when fixture binaries are missing", async () => {
    const mnemotecaError = await assertRejects(
        () => ensureMnemotecaBinary(),
        Error,
        "Mnemoteca binary not found",
    );
    assertStringIncludes(mnemotecaError.message, "Rerun the RunWield installer");
    assertStringIncludes(mnemotecaError.message, "raw.githubusercontent.com/gandazgul/runwield/main/install.sh");

    const cymbalError = await assertRejects(
        () => ensureCymbalBinary(),
        Error,
        "Cymbal binary not found",
    );
    assertStringIncludes(cymbalError.message, "Rerun the RunWield installer");

    const ketchError = await assertRejects(
        () => ensureKetchBinary(),
        Error,
        "Ketch binary not found",
    );
    assertStringIncludes(ketchError.message, "Rerun the RunWield installer");
});

runtimePreflightTest("runtime preflight rejects a pre-rename compatibility executable", async (dir) => {
    const oldName = "mnemo" + "syne";
    await writeAvailableBinary(dir, oldName);

    const error = await assertRejects(
        () => ensureMnemotecaBinary(),
        Error,
        "Mnemoteca binary not found",
    );
    assertStringIncludes(error.message, "Rerun the RunWield installer");
});
