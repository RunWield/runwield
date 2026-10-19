import { assertEquals } from "../src/testing/assertions.ts";
import { test } from "node:test";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readdir as fsReaddir,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retainTestEvidence } from "./retain-test-evidence.ts";

test("test cleanup retains Golden failure diagnostics but not sandbox HOME or caches", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-fixture-"));
    try {
        const sandbox = join(root, "sandbox");
        const destination = join(root, "evidence");
        for (const path of [
            "home-slot",
            "deno-dir",
            "slot/tmp/unrelated",
            "slot/tmp/runwield-golden-tui-timeout-123",
            "slot/tmp/runwield-golden-tui-child-failure-456",
            "tmp-legacy/runwield-golden-tui-timeout-789",
            "slot/.cache/runwield-golden-tui-timeout-private",
        ]) {
            await fsMkdir(join(sandbox, path), { recursive: true });
            await fsWriteFile(join(sandbox, path, "data.json"), path);
        }
        await retainTestEvidence(sandbox, destination);
        await fsRm(sandbox, { recursive: true });
        assertEquals(
            await fsReadFile(join(destination, "runwield-golden-tui-timeout-123/data.json"), "utf8"),
            "slot/tmp/runwield-golden-tui-timeout-123",
        );
        assertEquals(
            await fsReadFile(join(destination, "runwield-golden-tui-child-failure-456/data.json"), "utf8"),
            "slot/tmp/runwield-golden-tui-child-failure-456",
        );
        assertEquals(
            await fsReadFile(join(destination, "runwield-golden-tui-timeout-789/data.json"), "utf8"),
            "tmp-legacy/runwield-golden-tui-timeout-789",
        );
        assertEquals(
            (
                await Array.fromAsync(await fsReaddir(destination, { withFileTypes: true }), (entry) => entry.name)
            ).sort(),
            [
                "runwield-golden-tui-child-failure-456",
                "runwield-golden-tui-timeout-123",
                "runwield-golden-tui-timeout-789",
            ],
        );
    } finally {
        await fsRm(root, { recursive: true });
    }
});
