import { doesNotMatch, equal, match } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env, execPath } from "node:process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

function invoke(args: string[]) {
    const directory = mkdtempSync(join(tmpdir(), "runwield-cli-startup-"));
    try {
        const result = spawnSync(
            execPath,
            [...["--no-env-file", "--no-install"], fileURLToPath(new URL("./cli.ts", import.meta.url)), ...args],
            {
                cwd: directory,
                env: {
                    PATH: env.PATH,
                    HOME: directory,
                    USERPROFILE: directory,
                    TMPDIR: directory,
                    DENO_DIR: env.DENO_DIR,
                    SystemRoot: env.SystemRoot,
                },
                timeout: 30_000,
                encoding: "utf8",
            },
        );
        if (result.error) throw result.error;
        equal(result.signal, null);
        // Help and version must not bootstrap personal state or a project.
        equal(
            readdirSync(directory).some((name) => name === ".wld" || name === ".agents"),
            false,
        );
        return result;
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

test("source CLI help loads bundled definitions from an unrelated cwd", () => {
    const result = invoke(["--help"]);
    equal(result.status, 0, result.stderr);
    match(result.stdout, /RunWield — Plan-by-Default Coding Harness/);
    match(result.stdout, /workspace\s+Serve the persistent multi-Project owner Workspace/);
    match(result.stdout, /Global flags:/);
    equal(result.stderr, "");
});

test("source CLI version reports version and architecture without starting a Session", () => {
    const result = invoke(["--version"]);
    equal(result.status, 0, result.stderr);
    match(result.stdout, /^runwield \S+ \([^)]+\)\s*$/);
    equal(result.stderr, "");
});

test("source CLI rejects an invalid option with its expected usage error", () => {
    const result = invoke(["--runwield-nonexistent-option"]);
    equal(result.status, 1);
    match(result.stderr, /Unknown option: --runwield-nonexistent-option/);
    doesNotMatch(result.stderr, /ReferenceError|Deno is not defined|Fatal error/);
});
