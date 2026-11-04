import { test } from "node:test";
import { ok as assert, deepStrictEqual as equal } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CLAUDE_COMPATIBILITY_MATRIX as matrix } from "../../../shared/attached/compatibility.ts";

const guide = new URL("../../../../docs/user-documentation/connect-claude-code.md", import.meta.url);

test("the Claude guide lists exactly the tested versions, contracts, and saved evidence", async () => {
    const markdown = await readFile(guide, "utf8");
    const section = markdown.split("## Tested scope\n")[1]?.split("### Permissions")[0];
    assert(section, "The guide must disclose tested scope before installation");
    const rows = [...section.matchAll(/^\|\s*(\d+(?:\.\d+)+)\s*\|\s*(\d+)\s*\|[^\n]*\]\(([^)]+)\)\s*\|/gm)];
    equal(
        rows
            .map((row) => ({ version: row[1], contract: Number(row[2]), source: row[3] }))
            .sort((a, b) => a.version.localeCompare(b.version)),
        matrix.testedVersions
            .map((entry) => ({
                version: entry.version,
                contract: entry.adapterContract,
                source: `../../${entry.evidenceSource}`,
            }))
            .sort((a, b) => a.version.localeCompare(b.version)),
    );
});
