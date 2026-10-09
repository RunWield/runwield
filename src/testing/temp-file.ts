import { randomUUID } from "node:crypto";
import { mkdtemp, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface TempFileOptions {
    dir?: string;
    prefix?: string;
    suffix?: string;
}

/** Create an empty, exclusively owned fixture file; callers retain cleanup ownership. */
export async function makeTempFile(options: TempFileOptions = {}): Promise<string> {
    const path = join(options.dir ?? tmpdir(), `${options.prefix ?? ""}${randomUUID()}${options.suffix ?? ""}`);
    const file = await open(path, "wx", 0o600);
    await file.close();
    return path;
}

/** Create a disposable fixture directory under the isolated runner's temporary root. */
export async function makeTempDirectory(options: TempFileOptions = {}): Promise<string> {
    return await mkdtemp(join(options.dir ?? tmpdir(), options.prefix ?? "runwield-fixture-"));
}
