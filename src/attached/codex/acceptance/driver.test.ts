import { test } from "node:test";
import { deepStrictEqual as equal, throws, rejects } from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCodexAcceptanceArgs } from "../../../../scripts/connect-codex-acceptance.ts";
import { runAcceptance } from "./driver.ts";
import { runLiveAcceptance } from "./live.ts";
import { AcceptanceWorld } from "./world.ts";
import { resolveValidationCommand } from "../../../shared/workflow/validation-local-ci.ts";

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
test("fixture tracks its approved project command before the inactive source baseline", async () => {
    const parent = await mkdtemp(join(tmpdir(), "codex-command-baseline-"));
    const world = new AcceptanceWorld({ root: join(parent, "world"), codex: "unused", checkout: parent });
    try {
        await world.create();
        const expected = JSON.stringify({ verification_command: "sh ./check.sh" }, null, 2);
        equal(world.git(["show", "HEAD:.wld/settings.json"]), expected);
        equal(world.git(["status", "--porcelain=v1", "--untracked-files=all"]), "");
        equal(await resolveValidationCommand(world.fixture, "exact-project"), "sh ./check.sh");
        equal(await resolveValidationCommand(world.fixture, "ordinary-project"), "sh ./check.sh");
        equal(await readFile(join(world.fixture, ".wld/settings.json"), "utf8"), expected);
        equal(world.git(["status", "--porcelain=v1", "--untracked-files=all"]), "");
    } finally {
        await world.close();
        await rm(parent, { recursive: true, force: true });
    }
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
for (const missing of [true, false]) {
    test(`live ${missing ? "absent" : "rejected"} host authentication is blocked and unproven without private error text`, async () => {
        const parent = await mkdtemp(join(tmpdir(), "codex-auth-test-"));
        const executable = join(parent, "codex");
        const root = join(parent, "evidence");
        try {
            await writeFile(
                executable,
                `#!${process.execPath}
if(process.argv.includes("--version")){console.log("codex-cli 0.164.0-alpha.11.1");process.exit(0);}
let buffer="";process.stdin.on("data",bytes=>{buffer+=bytes;let n;while((n=buffer.indexOf("\\n"))>=0){const q=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);if(!q.id)continue;
if(q.method==="initialize")console.log(JSON.stringify({id:q.id,result:{}}));
else if(q.method==="account/read")console.log(JSON.stringify({id:q.id,${missing ? "result:{requiresOpenaiAuth:true,account:null}" : 'error:{code:401,message:"PRIVATE-CREDENTIAL"}'}}));
else process.exit(1);
}});
`,
                { mode: 0o755 },
            );
            const result = await runLiveAcceptance({
                root,
                codex: executable,
                checkout: fileURLToPath(new URL("../../../../", import.meta.url)),
                keep: true,
            });
            equal(result.outcome, "blocked");
            equal(result.blockedPrerequisite, "codex-host-authentication");
            equal(result.checks.at(-1)?.outcome, "unproven");
            equal(result.proposedMatrixEntry, null);
            const saved = await readFile(join(root, "summary.json"), "utf8");
            equal(JSON.parse(saved), result);
            equal(saved.includes("PRIVATE-"), false);
        } finally {
            await rm(parent, { recursive: true, force: true });
        }
    });
}
