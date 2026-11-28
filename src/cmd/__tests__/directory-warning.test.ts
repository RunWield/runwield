import { readdirSync } from "node:fs";
import { mkdtemp, rm, mkdir, writeFile, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defineCommittedGitFixture, git } from "../../shared/git-test-fixture.ts";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { getCliCommandDefinitions, requiresProjectDirectoryConsent } from "../registry.ts";

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
                    .then((entries) =>
                        entries.some((entry) =>
                            ["sessions", "projects", "project-identity-locks"].includes(entry.name),
                        ),
                    )
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
            if (args[0] === "--allow-system-directory")
                assertStringIncludes(decode(output.stdout), "Use wld plans import <file-or-folder>");
        }
    } finally {
        await rm(home, { recursive: true });
    }
});

test("Plan import explains how to recover a disconnected Git worktree and can be retried", async () => {
    const fixture = defineCommittedGitFixture({ "plan.md": "# Import fixture\n" });
    const root = await fixture.checkout();
    const linked = await mkdtemp(join(tmpdir(), "plans-import-disconnected-"));
    const runPlans = (...args: string[]) =>
        collectOutput(
            Bun.spawn({
                cmd: [process.execPath, "--no-env-file", "--no-install", cli, "plans", ...args],
                cwd: root,
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
            }),
        );
    try {
        await git(root, ["worktree", "add", "--detach", linked]);
        await rm(join(linked, ".git"));

        const blocked = await runPlans("import", "plan.md");
        const error = decode(blocked.stderr);
        assertEquals(blocked.code, 1);
        assertStringIncludes(error, "Preparing project storage for Plan import");
        assertStringIncludes(error, "Could not prepare project storage");
        assertStringIncludes(error, await realpath(linked));
        assertStringIncludes(error, "git worktree prune --dry-run --verbose");
        assertStringIncludes(error, "git worktree prune --verbose");
        assertEquals(error.includes("Fatal error"), false);
        assertEquals(error.includes("To reopen your last saved Session"), false);
        assertEquals((await readdir(linked)).sort(), ["plan.md"]);
        assertStringIncludes(await git(root, ["worktree", "list", "--porcelain"]), "prunable");

        await git(root, ["worktree", "prune"]);
        const imported = await runPlans("import", "plan.md");
        assertEquals(imported.code, 0, decode(imported.stderr));
        assertStringIncludes(decode(imported.stdout), "Imported 1 Plans");

        const archived = join(root, "docs", "plans", "archived");
        await mkdir(archived, { recursive: true });
        const incomplete = join(archived, "incomplete.md");
        await writeFile(incomplete, "# Archived fixture without archive metadata\n");
        const recovered = await runPlans("import", await realpath(incomplete));
        assertEquals(recovered.code, 0, decode(recovered.stderr));
        const archives = await runPlans("archive");
        assertEquals(archives.code, 0, decode(archives.stderr));
        assertStringIncludes(decode(archives.stdout), "incomplete");
        assertStringIncludes(decode(archives.stdout), "Archive date: unknown");
    } finally {
        await rm(linked, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
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
