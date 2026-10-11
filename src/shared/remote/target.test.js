import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { resolveRemoteTarget } from "./target.ts";

/** @param {(home: string, ssh: string) => Promise<void>} fn */
async function fixture(fn) {
    const root = await Deno.realPath(await Deno.makeTempDir());
    try {
        const ssh = join(root, "ssh");
        await Deno.writeTextFile(
            ssh,
            '#!/bin/sh\nif [ "$1" = -G ]; then printf "hostname example\\nuser tester\\nport 22\\n"; exit 0; fi\n[ "$1" = -v ] && [ "$2" = -o ] && [ "$3" = ControlPath=none ] || exit 42\nshift 4\n[ "$1" = -T ] && [ "$2" = -- ] && [ "$3" = example ] || exit 42\necho "debug1: Server host key: ssh-ed25519 SHA256:fixture" >&2\nexec sh -c "$4"\n',
        );
        await Deno.chmod(ssh, 0o700);
        await fn(root, ssh);
    } finally {
        await Deno.remove(root, { recursive: true });
    }
}

Deno.test("remote paths are resolved relative to remote home with shell characters kept literal", async () => {
    await fixture(async (home, ssh) => {
        const name = "space ' $(touch BAD); folder";
        await Deno.mkdir(join(home, name));
        // A child receives this HOME directly via the fixture wrapper below; do
        // not modify the test process HOME.
        const wrapper = join(home, "remote-ssh");
        await Deno.writeTextFile(
            wrapper,
            `#!/bin/sh\nHOME=${JSON.stringify(home)} export HOME\nexec ${JSON.stringify(ssh)} "$@"\n`,
        );
        await Deno.chmod(wrapper, 0o700);
        const result = await resolveRemoteTarget("example", name, wrapper);
        assertEquals(result.cwd, join(home, name));
        assertEquals(result.gitRoot, null);
        assertEquals(result.home, home);
        assertEquals(await Deno.stat(join(home, "BAD")).then(() => true).catch(() => false), false);
        const defaultTarget = await resolveRemoteTarget("example", null, wrapper);
        assertEquals(defaultTarget.cwd, home);
        await Deno.symlink(join(home, name), join(home, "shortcut"));
        assertEquals((await resolveRemoteTarget("example", "~/shortcut", wrapper)).cwd, result.cwd);
        assertEquals((await resolveRemoteTarget("example", join(home, name), wrapper)).cwd, result.cwd);
        await assertRejects(
            () => resolveRemoteTarget("example", "missing", wrapper),
            Error,
            "not an existing directory",
        );
        const denied = join(home, "denied");
        await Deno.mkdir(denied);
        await Deno.chmod(denied, 0o000);
        try {
            await assertRejects(() => resolveRemoteTarget("example", denied, wrapper), Error, "not accessible");
        } finally {
            await Deno.chmod(denied, 0o700);
        }
        await assertRejects(() => resolveRemoteTarget("-oDanger", null, wrapper), Error, "Invalid SSH destination");
    });
});

Deno.test("remote Git evidence distinguishes linked worktrees from primary checkout", async () => {
    await fixture(async (home, ssh) => {
        const wrapper = join(home, "remote-ssh");
        await Deno.writeTextFile(
            wrapper,
            `#!/bin/sh\nHOME=${JSON.stringify(home)} export HOME\nexec ${JSON.stringify(ssh)} "$@"\n`,
        );
        await Deno.chmod(wrapper, 0o700);
        const repo = join(home, "repo");
        /** @param {string[]} args */
        const git = async (args) => {
            const output = await new Deno.Command("git", { args, stdout: "piped", stderr: "piped" }).output();
            if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
        };
        await git(["init", repo]);
        await git([
            "-C",
            repo,
            "-c",
            "user.name=Test",
            "-c",
            "user.email=t@example.com",
            "commit",
            "--allow-empty",
            "-m",
            "initial",
        ]);
        const linked = join(home, "linked");
        await git(["-C", repo, "worktree", "add", "-b", "linked", linked]);
        const result = await resolveRemoteTarget("example", linked, wrapper);
        assertEquals(result.cwd, linked);
        assertEquals(result.gitRoot, linked);
        assertEquals(result.primaryRoot, repo);
        assertEquals(result.isWorktree, true);
        assertEquals((await resolveRemoteTarget("example", repo, wrapper)).isWorktree, false);
    });
});
