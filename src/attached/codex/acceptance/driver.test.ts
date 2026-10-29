import { test } from "node:test";
import { deepStrictEqual as equal, throws, rejects } from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCodexAcceptanceArgs } from "../../../../scripts/connect-codex-acceptance.ts";
import { runAcceptance } from "./driver.ts";

test("acceptance CLI admits only explicit executable, output, and retention options", () => {
    equal(parseCodexAcceptanceArgs(["--codex", "/test/codex", "--out", "/test/evidence", "--keep"]), {
        codex: "/test/codex",
        out: "/test/evidence",
        keep: true,
        live: false,
    });
    throws(() => parseCodexAcceptanceArgs(["--out"]), /requires/);
    throws(() => parseCodexAcceptanceArgs(["--unsupported"]), /Unrecognized/);
});
test("unavailable host leaves blocked evidence and no tested-version claim", async () => {
    const parent = await mkdtemp(join(tmpdir(), "codex-acceptance-test-"));
    const root = join(parent, "evidence");
    try {
        const result = await runAcceptance({
            root,
            codex: join(parent, "missing-codex"),
            checkout: fileURLToPath(new URL("../../../../", import.meta.url)),
            keep: false,
        });
        equal(result.outcome, "blocked");
        equal(result.blockedPrerequisite, "codex-executable");
        equal(result.proposedMatrixEntry, null);
        equal(JSON.parse(await readFile(join(root, "summary.json"), "utf8")), result);
        equal(await readFile(join(root, "handshakes.jsonl"), "utf8"), "");
    } finally {
        await rm(parent, { recursive: true, force: true });
    }
});
test("nonempty output directories are never overwritten", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-acceptance-existing-"));
    try {
        await writeFile(join(root, "precious"), "keep");
        await rejects(runAcceptance({ root, codex: "missing", checkout: root, keep: false }), /new or empty/);
        equal(await readFile(join(root, "precious"), "utf8"), "keep");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
