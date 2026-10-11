import { defineCommittedGitFixture, git } from "../../shared/git-test-fixture.ts";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { getCliCommandDefinitions, requiresProjectDirectoryConsent } from "../registry.js";

const cli = fromFileUrl(new URL("../../cli.ts", import.meta.url));
const config = fromFileUrl(new URL("../../../deno.json", import.meta.url));
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

for (const command of ["init", "initialize", "plans", "wr", "guided-review"]) {
    Deno.test(`noninteractive ${command} refuses home before project work`, async () => {
        const home = await Deno.makeTempDir();
        try {
            const child = new Deno.Command(Deno.execPath(), {
                args: ["run", "-A", "--config", config, cli, command],
                cwd: home,
                env: { HOME: home, WLD_TEST_SANDBOX_HOME: home, MNEMOTECA_DB_PATH: join(home, "memory.sqlite") },
                stdin: "piped",
                stdout: "piped",
                stderr: "piped",
            }).spawn();
            const writer = child.stdin.getWriter();
            await writer.write(new TextEncoder().encode("piped request\n"));
            await writer.close();
            const output = await child.output();
            assertEquals(output.code, 1);
            assertStringIncludes(decode(output.stderr), "wld --allow-system-directory <command>");
            assertEquals([...Deno.readDirSync(home)].filter((entry) => entry.name !== ".wld").length, 0);
            assertEquals(
                await Array.fromAsync(Deno.readDir(join(home, ".wld"))).then((entries) =>
                    entries.some((entry) => entry.name === "sessions")
                ).catch((error) => {
                    if (error instanceof Deno.errors.NotFound) return false;
                    throw error;
                }),
                false,
            );
        } finally {
            await Deno.remove(home, { recursive: true });
        }
    });
}
Deno.test("leading acknowledgement reaches real plans listing and help is exempt", async () => {
    const home = await Deno.makeTempDir();
    try {
        await Deno.mkdir(join(home, "docs", "plans"), { recursive: true });
        await Deno.writeTextFile(
            join(home, "docs", "plans", "fixture.md"),
            "---\nplanId: fixture-plan\nstatus: draft\nsummary: Consent fixture\n---\n# Consent fixture\n",
        );
        for (const args of [["--allow-system-directory", "plans"], ["plans", "--help"], ["--help"], ["--version"]]) {
            const output = await new Deno.Command(Deno.execPath(), {
                args: ["run", "-A", "--config", config, cli, ...args],
                cwd: home,
                env: { HOME: home, WLD_TEST_SANDBOX_HOME: home },
                stdout: "piped",
                stderr: "piped",
            }).output();
            assertEquals(output.code, 0, decode(output.stderr));
            if (args[0] === "--allow-system-directory") assertStringIncludes(decode(output.stdout), "Consent fixture");
        }
    } finally {
        await Deno.remove(home, { recursive: true });
    }
});
Deno.test("registry policy covers every CLI command and aliases", () => {
    const guarded = ["router", "onboard", "load-plan", "resume", "plans", "wr", "sleep", "init"];
    for (const command of getCliCommandDefinitions()) {
        for (const name of [command.name, ...(command.aliases || [])]) {
            assertEquals(requiresProjectDirectoryConsent(name, []), guarded.includes(command.name), name);
        }
    }
    assertEquals(requiresProjectDirectoryConsent("agents", ["engineer"]), true);
    assertEquals(requiresProjectDirectoryConsent("guided-review", []), true);
    assertEquals(requiresProjectDirectoryConsent(undefined, []), true);
});

for (
    const args of [["plans", "--allow-system-directory"], ["--", "--allow-system-directory"], [
        "request with --allow-system-directory inside",
    ]]
) {
    Deno.test(`acknowledgement text outside the leading prefix does not bypass consent: ${args.join(" ")}`, async () => {
        const home = await Deno.makeTempDir();
        try {
            const output = await new Deno.Command(Deno.execPath(), {
                args: ["run", "-A", "--config", config, cli, ...args],
                cwd: home,
                env: { HOME: home, WLD_TEST_SANDBOX_HOME: home },
                stdout: "piped",
                stderr: "piped",
            }).output();
            assertEquals(output.code, 1);
            assertStringIncludes(decode(output.stderr), "System or home folder detected. Continue?");
        } finally {
            await Deno.remove(home, { recursive: true });
        }
    });
}

Deno.test({
    name: "guided-review refusal leaves the piped request unread",
    ignore: Deno.build.os === "windows",
    async fn() {
        const home = await Deno.makeTempDir();
        try {
            await Deno.writeTextFile(join(home, "input.txt"), "Unread guided review request\n");
            const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
            const command = `exec 3< input.txt; ${
                [Deno.execPath(), "run", "-A", "--config", config, cli, "guided-review"].map(quoted).join(" ")
            } <&3; result=$?; cat <&3; exit $result`;
            const output = await new Deno.Command("bash", {
                args: ["-c", command],
                cwd: home,
                env: { HOME: home, WLD_TEST_SANDBOX_HOME: home },
                stdout: "piped",
                stderr: "piped",
            }).output();
            assertEquals(output.code, 1);
            assertStringIncludes(decode(output.stdout), "Unread guided review request");
            assertStringIncludes(decode(output.stderr), "--allow-system-directory");
        } finally {
            await Deno.remove(home, { recursive: true });
        }
    },
});

const homeGitFixture = defineCommittedGitFixture();
Deno.test("a linked worktree does not authorize project work in its classified primary root", async () => {
    const home = await homeGitFixture.checkout();
    const trees = await Deno.makeTempDir();
    const tree = join(trees, "linked");
    try {
        await git(home, ["worktree", "add", "-b", "folder-warning-linked", tree]);
        const output = await new Deno.Command(Deno.execPath(), {
            args: ["run", "-A", "--config", config, cli, "plans"],
            cwd: tree,
            env: { HOME: home, WLD_TEST_SANDBOX_HOME: home },
            stdout: "piped",
            stderr: "piped",
        }).output();
        assertEquals(output.code, 1);
        assertStringIncludes(decode(output.stderr), "System or home folder detected. Continue?");
        assertEquals([...Deno.readDirSync(tree)].some((entry) => entry.name === "docs"), false);
    } finally {
        await Deno.remove(trees, { recursive: true });
        await Deno.remove(home, { recursive: true });
    }
});
