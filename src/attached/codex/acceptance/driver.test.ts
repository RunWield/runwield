import { test } from "node:test";
import { deepStrictEqual as equal, throws, rejects } from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCodexAcceptanceArgs } from "../../../../scripts/connect-codex-acceptance.ts";
import { runAcceptance } from "./driver.ts";
import { runLiveAcceptance } from "./live.ts";
import { AcceptanceWorld } from "./world.ts";
import { resolveValidationCommand } from "../../../shared/workflow/validation-local-ci.ts";
import type { Snapshot } from "../../claude/acceptance/evidence.ts";
import { defineGitFixture, git } from "../../../shared/git-test-fixture.ts";

// Authentication qualification owns its source inputs; concurrent builds must not alter its baseline.
const authenticationSource = defineGitFixture(async (root) => {
    await mkdir(join(root, "src/attached/codex"), { recursive: true });
    await cp(new URL("../plugin", import.meta.url), join(root, "src/attached/codex/plugin"), { recursive: true });
    await mkdir(join(root, ".agents/plugins"), { recursive: true });
    await cp(
        new URL("../../../../.agents/plugins/marketplace.json", import.meta.url),
        join(root, ".agents/plugins/marketplace.json"),
    );
    await writeFile(join(root, "src/runtime.ts"), "export const runtime = 1;\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "Authentication source fixture"]);
});

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
test("Codex world snapshots capture invoking Claude config creation, edits and deletion with Git status", async () => {
    const parent = await mkdtemp(join(tmpdir(), "codex-config-snapshot-"));
    const world = new AcceptanceWorld({ root: join(parent, "world"), codex: "unused", checkout: parent });
    const path = "fixture/.claude/settings.local.json";
    const relative = ".claude/settings.local.json";
    const initial = JSON.stringify({ enabledPlugins: { "user-plugin": true } });
    const changed = JSON.stringify({ enabledPlugins: { "user-plugin": false } });
    const snapshot = async (name: string): Promise<Snapshot> => {
        await world.snapshot(name, null);
        return JSON.parse(await readFile(join(world.root, "snapshots", `${name}.json`), "utf8"));
    };
    try {
        await world.create();
        const before = await snapshot("before");
        equal(
            before.files.some((file) => file.path === path),
            false,
        );
        equal(before.git?.status, "");

        await mkdir(join(world.fixture, ".claude"));
        await writeFile(join(world.fixture, relative), initial);
        const created = await snapshot("created");
        equal(created.files.find((file) => file.path === path)?.text, initial);
        equal(created.git?.status, `?? ${relative}\n`);

        world.git(["add", relative]);
        world.git(["commit", "-m", "Track fixture user config"]);
        const tracked = await snapshot("tracked");
        equal(tracked.git?.status, "");
        await writeFile(join(world.fixture, relative), changed);
        const edited = await snapshot("edited");
        equal(edited.files.find((file) => file.path === path)?.text, changed);
        equal(
            edited.files.find((file) => file.path === path)?.sha256 ===
                tracked.files.find((file) => file.path === path)?.sha256,
            false,
        );
        equal(edited.git?.status, ` M ${relative}\n`);
        equal(edited.git?.head, tracked.git?.head);

        await rm(join(world.fixture, relative));
        const deleted = await snapshot("deleted");
        equal(
            deleted.files.some((file) => file.path === path),
            false,
        );
        equal(deleted.git?.status, ` D ${relative}\n`);
        equal(deleted.git?.head, tracked.git?.head);
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
for (const scenario of ["absent", "rejected", "source changes"]) {
    const missing = scenario !== "rejected";
    const changedSource = scenario === "source changes";
    const name = changedSource
        ? "live missing authentication cannot hide changed source evidence"
        : `live ${scenario} host authentication is blocked and unproven without private error text`;
    test(name, async () => {
        const parent = await mkdtemp(join(tmpdir(), "codex-auth-test-"));
        const checkout = await authenticationSource.checkout();
        const executable = join(parent, "codex");
        const root = join(parent, "evidence");
        try {
            await writeFile(
                executable,
                `#!${process.execPath}
import {writeFileSync} from "node:fs";
if(process.argv.includes("--version")){console.log("codex-cli 0.164.0-alpha.11.1");process.exit(0);}
let buffer="";process.stdin.on("data",bytes=>{buffer+=bytes;let n;while((n=buffer.indexOf("\\n"))>=0){const q=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);if(!q.id)continue;
if(q.method==="initialize")console.log(JSON.stringify({id:q.id,result:{}}));
else if(q.method==="account/read"){
${changedSource ? `writeFileSync(${JSON.stringify(join(checkout, "src/runtime.ts"))},"export const runtime = 2;\\n");` : ""}
console.log(JSON.stringify({id:q.id,${missing ? "result:{requiresOpenaiAuth:true,account:null}" : 'error:{code:401,message:"PRIVATE-CREDENTIAL"}'}}));
}
else process.exit(1);
}});
`,
                { mode: 0o755 },
            );
            const result = await runLiveAcceptance({
                root,
                codex: executable,
                checkout,
                keep: true,
            });
            equal(result.outcome, changedSource ? "fail" : "blocked", JSON.stringify(result));
            equal(result.blockedPrerequisite, "codex-host-authentication");
            equal(result.checks.find((check) => check.id === "live-journey")?.outcome, "unproven");
            equal(
                result.checks.find((check) => check.id === "source-stability")?.outcome,
                changedSource ? "fail" : undefined,
            );
            equal(result.proposedMatrixEntry, null);
            const saved = await readFile(join(root, "summary.json"), "utf8");
            equal(JSON.parse(saved), result);
            equal(saved.includes("PRIVATE-"), false);
        } finally {
            await rm(parent, { recursive: true, force: true });
            await rm(checkout, { recursive: true, force: true });
        }
    });
}
