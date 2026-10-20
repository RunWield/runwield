import { readdirSync } from "node:fs";
import { mkdtemp, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defineCommittedGitFixture, git } from "../../shared/git-test-fixture.ts";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { getCliCommandDefinitions, requiresProjectDirectoryConsent } from "../registry.js";

const cli = fileURLToPath(new URL("../../cli.ts", import.meta.url));
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

for (const command of ["init", "initialize", "plans", "wr", "guided-review", "review"]) {
    test(`noninteractive ${command} refuses home before project work`, async () => {
        const home = await mkdtemp(join(tmpdir(), "directory-warning-"));
        try {
            const child = Bun.spawn({
                cmd: [process.execPath, "--no-env-file", "--no-install", cli, command],
                cwd: home,
                env: {
                    ...process.env,
                    HOME: home,
                    WLD_TEST_SANDBOX_HOME: home,
                    MNEMOTECA_DB_PATH: join(home, "memory.sqlite"),
                },
                stdin: "pipe",
                stdout: "pipe",
                stderr: "pipe",
            });
            child.stdin.write("piped request\n");
            child.stdin.end();
            const output = await collectOutput(child);
            assertEquals(output.code, 1);
            assertStringIncludes(decode(output.stderr), "wld --allow-system-directory <command>");
            assertEquals(
                [...readdirSync(home, { withFileTypes: true })].filter((entry) => entry.name !== ".wld").length,
                0,
            );
            assertEquals(
                await readdir(join(home, ".wld"), { withFileTypes: true })
                    .then((entries) => entries.some((entry) => entry.name === "sessions"))
                    .catch((error) => {
                        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
                        throw error;
                    }),
                false,
            );
        } finally {
            await rm(home, { recursive: true });
        }
    });
}
test("leading acknowledgement reaches real plans listing and help is exempt", async () => {
    const home = await mkdtemp(join(tmpdir(), "directory-warning-"));
    try {
        await mkdir(join(home, "docs", "plans"), { recursive: true });
        await writeFile(
            join(home, "docs", "plans", "fixture.md"),
            "---\nplanId: fixture-plan\nstatus: draft\nsummary: Consent fixture\n---\n# Consent fixture\n",
        );
        for (const args of [["--allow-system-directory", "plans"], ["plans", "--help"], ["--help"], ["--version"]]) {
            const output = await collectOutput(
                Bun.spawn({
                    cmd: [
                        process.execPath,
                        "--no-env-file",
                        "--no-install",
                        cli,
                        ...(args[0] === "--" ? ["--", ...args] : args),
                    ],
                    cwd: home,
                    env: { ...process.env, HOME: home, WLD_TEST_SANDBOX_HOME: home },
                    stdout: "pipe",
                    stderr: "pipe",
                }),
            );
            assertEquals(output.code, 0, decode(output.stderr));
            if (args[0] === "--allow-system-directory") assertStringIncludes(decode(output.stdout), "Consent fixture");
        }
    } finally {
        await rm(home, { recursive: true });
    }
});
test("registry policy covers every CLI command and aliases", () => {
    const guarded = ["router", "onboard", "load-plan", "review", "resume", "plans", "wr", "sleep", "init"];
    for (const command of getCliCommandDefinitions()) {
        for (const name of [command.name, ...(command.aliases || [])]) {
            assertEquals(requiresProjectDirectoryConsent(name, []), guarded.includes(command.name), name);
        }
    }
    assertEquals(requiresProjectDirectoryConsent("agents", ["engineer"]), true);
    assertEquals(requiresProjectDirectoryConsent("guided-review", []), true);
    assertEquals(requiresProjectDirectoryConsent(undefined, []), true);
});

for (const args of [
    ["plans", "--allow-system-directory"],
    ["--", "--allow-system-directory"],
    ["request with --allow-system-directory inside"],
]) {
    test(`acknowledgement text outside the leading prefix does not bypass consent: ${args.join(" ")}`, async () => {
        const home = await mkdtemp(join(tmpdir(), "directory-warning-"));
        try {
            const output = await collectOutput(
                Bun.spawn({
                    cmd: [
                        process.execPath,
                        "--no-env-file",
                        "--no-install",
                        cli,
                        ...(args[0] === "--" ? ["--", ...args] : args),
                    ],
                    cwd: home,
                    env: { ...process.env, HOME: home, WLD_TEST_SANDBOX_HOME: home },
                    stdout: "pipe",
                    stderr: "pipe",
                }),
            );
            assertEquals(output.code, 1);
            assertStringIncludes(decode(output.stderr), "System or home folder detected. Continue?");
        } finally {
            await rm(home, { recursive: true });
        }
    });
}

test("guided-review refusal leaves the piped request unread", { skip: process.platform === "win32" }, async () => {
    const home = await mkdtemp(join(tmpdir(), "directory-warning-"));
    try {
        await writeFile(join(home, "input.txt"), "Unread guided review request\n");
        const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        const command = `exec 3< input.txt; ${[process.execPath, "--no-env-file", "--no-install", cli, "guided-review"]
            .map(quoted)
            .join(" ")} <&3; result=$?; cat <&3; exit $result`;
        const output = await collectOutput(
            Bun.spawn({
                cmd: ["bash", "-c", command],
                cwd: home,
                env: { ...process.env, HOME: home, WLD_TEST_SANDBOX_HOME: home },
                stdout: "pipe",
                stderr: "pipe",
            }),
        );
        assertEquals(output.code, 1);
        assertStringIncludes(decode(output.stdout), "Unread guided review request");
        assertStringIncludes(decode(output.stderr), "--allow-system-directory");
    } finally {
        await rm(home, { recursive: true });
    }
});

const homeGitFixture = defineCommittedGitFixture();
test("a linked worktree does not authorize project work in its classified primary root", async () => {
    const home = await homeGitFixture.checkout();
    const trees = await mkdtemp(join(tmpdir(), "directory-warning-"));
    const tree = join(trees, "linked");
    try {
        await git(home, ["worktree", "add", "-b", "folder-warning-linked", tree]);
        const output = await collectOutput(
            Bun.spawn({
                cmd: [process.execPath, "--no-env-file", "--no-install", cli, "plans"],
                cwd: tree,
                env: { ...process.env, HOME: home, WLD_TEST_SANDBOX_HOME: home },
                stdout: "pipe",
                stderr: "pipe",
            }),
        );
        assertEquals(output.code, 1);
        assertStringIncludes(decode(output.stderr), "System or home folder detected. Continue?");
        assertEquals(
            [...readdirSync(tree, { withFileTypes: true })].some((entry) => entry.name === "docs"),
            false,
        );
    } finally {
        await rm(trees, { recursive: true });
        await rm(home, { recursive: true });
    }
});

async function collectOutput(child: Bun.Subprocess<"pipe" | "ignore" | "inherit", "pipe", "pipe">) {
    const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).bytes(),
        new Response(child.stderr).bytes(),
    ]);
    return { code, stdout, stderr };
}
