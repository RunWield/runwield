import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { withProcessGlobalTestLock } from "../testing/process-global-lock.ts";
import { ensureCymbalBinary, ensureKetchBinary, ensureMnemotecaBinary, hasSnipBinary } from "./runtime-preflight.ts";

async function writeAvailableBinary(directory: string, name: string): Promise<string> {
    const path = join(directory, name);
    await Deno.writeTextFile(path, "#!/bin/sh\nexit 0\n");
    await Deno.chmod(path, 0o755);
    return path;
}

function runtimePreflightTest(name: string, run: (binaryDirectory: string) => Promise<void>): void {
    Deno.test(name, () =>
        withProcessGlobalTestLock(async () => {
            const previousPath = Deno.env.get("PATH");
            const binaryDirectory = await Deno.makeTempDir({ prefix: "runwield-runtime-binaries-" });
            Deno.env.set("PATH", binaryDirectory);
            try {
                await run(binaryDirectory);
            } finally {
                if (previousPath === undefined) Deno.env.delete("PATH");
                else Deno.env.set("PATH", previousPath);
                await Deno.remove(binaryDirectory, { recursive: true }).catch(() => {});
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

        await Deno.remove(mnemoteca);
        await Deno.remove(cymbal);
        await Deno.remove(ketch);
        await Deno.remove(snip);

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
