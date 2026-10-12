import { test } from "node:test";
import { strict as assert } from "node:assert";
import { auditRuntimeSource, checkOwnedRuntime } from "./check-owned-runtime.ts";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { captureScriptProcess } from "./script-process.ts";
import { defineCommittedGitFixture } from "../src/shared/git-test-fixture.ts";

const missedRuntimePaths = defineCommittedGitFixture({
    "package.json": JSON.stringify({ scripts: { check: "deno check main.ts" } }),
    "docs-site/package.json": JSON.stringify({ scripts: { dev: "deno task dev" } }),
    ".wld/settings.json": JSON.stringify({ verification_command: "deno task ci" }),
    ".claude/settings.json": JSON.stringify({
        hooks: { PostToolUse: [{ hooks: [{ command: "deno task seams:check" }] }] },
    }),
    "brand/tool.ts": "Deno.writeTextFile('out', 'content');",
    "pages/review.astro": "---\nconst mode = globalThis.Deno.env.get('MODE');\n---\n<p>Review</p>",
});

test("owned-runtime discovery includes hidden command defaults, docs, brand and Astro code", async () => {
    const root = await missedRuntimePaths.checkout({ prefix: "runwield-runtime-audit-" });
    try {
        const diagnostics = await checkOwnedRuntime(root);
        assert.deepEqual([...new Set(diagnostics.map((diagnostic) => diagnostic.file))].sort(), [
            ".claude/settings.json",
            ".wld/settings.json",
            "brand/tool.ts",
            "docs-site/package.json",
            "package.json",
            "pages/review.astro",
        ]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("owned-runtime guard rejects executable APIs, concealed lookups, registry imports and runtime launches", () => {
    const regressions = [
        "Deno.readTextFile(path)",
        "runtime.Deno?.env?.get('MODE')",
        "globalThis['Deno'].cwd()",
        "Reflect.get(globalThis, String('Deno')).serve(handler)",
        "if (process.versions.deno) oldRuntime()",
        "import data from 'jsr:@std/fs'",
        "await import('npm:astro@7.3.3')",
        "spawn('deno', ['run', 'tool.ts'])",
        "#!/usr/bin/env deno\nconsole.log('tool')",
    ];
    for (const source of regressions) assert.ok(auditRuntimeSource(source, "brand/tool.ts").length, source);
    assert.ok(
        auditRuntimeSource("---\nconst mode = runtime.Deno?.env.get('MODE');\n---\n<p>Hello</p>", "page.astro").length,
    );
    assert.ok(auditRuntimeSource("<script>Deno.exit(1)</script>", "preview.html").length);
});

test("owned-runtime guard preserves inert examples and the one explicit legacy interoperability probe", () => {
    const source = "// Deno.readFile is historical\nconst example = 'Deno.test(\"sample\")';";
    assert.deepEqual(auditRuntimeSource(source, "src/example.ts"), []);
    assert.deepEqual(auditRuntimeSource("<p>Deno.readFile</p>", "preview.html"), []);
    assert.deepEqual(
        auditRuntimeSource("spawn('deno', ['eval', probe])", "scripts/check-lock-interoperability.ts"),
        [],
    );
    assert.deepEqual(auditRuntimeSource("import process from 'node:process'; process.cwd()", "src/runtime.ts"), []);
});

test("maintained mascot tools execute with Bun and an empty executable search path", async () => {
    const root = await mkdtemp(join(tmpdir(), "runwield-brand-runtime-"));
    const repository = fileURLToPath(new URL("../", import.meta.url));
    const files = [
        "brand/mascot/loops/build.ts",
        "brand/mascot/loops/terminal.ts",
        "brand/mascot/loops/sprites.ts",
        "brand/mascot/loops/preview.template.html",
        "brand/mascot/readme/build.ts",
        "brand/runwield-tui.png",
        "brand/runwield-tui-triage.png",
        "src/ui/mascot/frames.ts",
        "src/ui/design-system/theme-bridge.ts",
        "src/ui/design-system/themes/dark.ts",
    ];
    try {
        for (const file of files) {
            await mkdir(dirname(join(root, file)), { recursive: true });
            await cp(join(repository, file), join(root, file));
        }
        for (const args of [
            ["brand/mascot/loops/terminal.ts", "reviewer", "--snapshot"],
            ["brand/mascot/loops/build.ts"],
            ["brand/mascot/readme/build.ts"],
        ]) {
            const result = await captureScriptProcess(process.execPath, {
                args: ["--no-env-file", "--no-install", ...args],
                cwd: root,
                env: { PATH: "" },
                signal: AbortSignal.timeout(30_000),
            });
            assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
            if (args.includes("--snapshot"))
                assert.match(new TextDecoder().decode(result.stdout), /reviewer · 20 columns × 9 rows/);
        }
        assert.match(await readFile(join(root, "brand/mascot/readme/base.svg"), "utf8"), /<svg/);
        assert.match(await readFile(join(root, "brand/mascot/loops/preview.html"), "utf8"), /data:image\/png;base64,/);
        const frames = JSON.parse(await readFile(join(root, "brand/mascot/loops/exports/frames.json"), "utf8"));
        assert.equal(frames.animations.length, 8);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
