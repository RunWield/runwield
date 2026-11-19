import { test } from "node:test";
import { ok as assert, deepStrictEqual as equal, throws } from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { runAcceptance } from "./driver.ts";
import { parseAcceptanceArgs } from "../../../../scripts/connect-claude-acceptance.ts";
import { withExternalClaude, CHECKOUT, UNAUTHENTICATED_CLAUDE } from "./runtime-test-fixture.ts";

test("CLI parses only the explicit opt-in host, output directory, and retention options", () => {
    equal(parseAcceptanceArgs(["--claude", "/test/claude", "--out", "/test/evidence", "--keep"]), {
        claude: "/test/claude",
        out: "/test/evidence",
        keep: true,
    });
    throws(() => parseAcceptanceArgs(["--claude"]), /requires a value/);
    throws(() => parseAcceptanceArgs(["--out", "--keep"]), /requires a value/);
    throws(() => parseAcceptanceArgs(["--unrecognized"]), /Unrecognized/);
});

test("missing authentication produces blocked, privacy-safe evidence without model calls", async () => {
    await withExternalClaude(UNAUTHENTICATED_CLAUDE, async (root, claude) => {
        const summary = await runAcceptance({ root, checkout: CHECKOUT, claude, keep: false });
        equal(summary.outcome, "blocked");
        equal(summary.blockedPrerequisite, "claude-authentication");
        equal(summary.proposedMatrixEntry, null);
        const saved = await readFile(join(root, "summary.json"), "utf8");
        equal(JSON.parse(saved), summary);
        equal(saved.includes(root), false);
        equal(await readdir(join(root, "logs/claude")), []);
        equal(await readFile(join(root, "shim-argv.jsonl"), "utf8"), "");
        assert((await readdir(root)).includes("fixture"));
    });
});

test("an unreported executable version cannot start the acceptance journey", async () => {
    await withExternalClaude("console.log('unreported');", async (root, claude) => {
        const summary = await runAcceptance({ root, checkout: CHECKOUT, claude, keep: true });
        equal(summary.outcome, "blocked");
        equal(summary.blockedPrerequisite, "claude-version");
        equal(summary.proposedMatrixEntry, null);
        equal(await readdir(join(root, "logs/claude")), []);
    });
});

for (const output of ["", "not-json"])
    test(`unreadable auth result ${JSON.stringify(output)} cannot mean authenticated`, async () => {
        await withExternalClaude(
            `if(process.argv.includes('--version')) console.log('2.1.303 (Claude Code)'); else console.log(${JSON.stringify(output)});`,
            async (root, claude) => {
                const summary = await runAcceptance({ root, checkout: CHECKOUT, claude, keep: true });
                equal(summary.outcome, "blocked");
                equal(summary.blockedPrerequisite, "claude-authentication");
                equal(summary.proposedMatrixEntry, null);
                equal(await readdir(join(root, "logs/claude")), []);
            },
        );
    });

test("an unavailable host is blocked and leaves evidence rather than pretending to pass", async () => {
    await withExternalClaude(UNAUTHENTICATED_CLAUDE, async (root, claude) => {
        const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
        const summary = await runAcceptance({ root, checkout: CHECKOUT, claude: claude + "-missing", keep: true });
        equal(summary.outcome, "blocked");
        equal(summary.blockedPrerequisite, "claude-executable");
        equal(summary.proposedMatrixEntry, null);
        equal([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], before);
    });
});
