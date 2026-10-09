import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Load a browser test bundle as explicit ESM under each supported runtime. */
export async function importTestBundle(source: string) {
    const directory = await mkdtemp(join(tmpdir(), "runwield-test-bundle-"));
    try {
        const path = join(directory, "bundle.mjs");
        await writeFile(path, source, { mode: 0o600 });
        return await import(pathToFileURL(path).href);
    } finally {
        await rm(directory, { recursive: true });
    }
}
