import { test } from "node:test";
import process from "node:process";
import { mkdtemp, mkdir, writeFile, chmod, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import { resolveRemoteTarget } from "./target.ts";
import { captureForegroundProcess } from "../captured-process.ts";
import { getCwd } from "../../constants.js";

for (const state of ["present", "absent", "unreadable"] as const) {
    test(
        `resolver reports ${state} host prerequisites from the real Python probe`,
        { skip: process.platform === "win32" },
        async () => {
            const root = await mkdtemp(join(tmpdir(), "remote-resolver-readiness-"));
            try {
                const bin = join(root, "bin");
                await mkdir(bin);
                const python = await captureForegroundProcess("/bin/sh", {
                    cwd: getCwd(),
                    args: ["-c", "command -v python3"],
                });
                assertEquals(python.code, 0);
                await symlink(new TextDecoder().decode(python.stdout).trim(), join(bin, "python3"));
                if (state === "present") {
                    for (const command of ["sshfs", "fusermount3"]) {
                        await writeFile(join(bin, command), "#!/bin/sh\nexit 0\n");
                        await chmod(join(bin, command), 0o700);
                    }
                }
                const osRelease = join(root, "os-release");
                if (state !== "unreadable") await writeFile(osRelease, 'ID=example\nID_LIKE="rhel fedora"\n');
                const regularDevice = join(root, "not-a-device");
                await writeFile(regularDevice, "not a FUSE character device");
                // Redirect only system-owned files into this fake server environment.
                const fusePath =
                    state === "present"
                        ? "/dev/null"
                        : state === "absent"
                          ? regularDevice
                          : join(root, "missing-device");
                await writeFile(
                    join(root, "sitecustomize.py"),
                    `
import builtins, os
original_open = builtins.open
builtins.open = lambda path, *args, **kwargs: original_open(${JSON.stringify(osRelease)} if path == '/etc/os-release' else path, *args, **kwargs)
original_stat = os.stat
os.stat = lambda path, *args, **kwargs: original_stat(${JSON.stringify(fusePath)} if path == '/dev/fuse' else path, *args, **kwargs)
`,
                );
                const ssh = join(root, "ssh");
                await writeFile(
                    ssh,
                    `#!/bin/sh
if [ "$1" = -G ]; then printf 'hostname example\\nuser tester\\nport 22\\n'; exit 0; fi
shift 4
[ "$1" = -T ] && [ "$2" = -- ] && [ "$3" = example ] || exit 42
echo 'debug1: Server host key: ssh-ed25519 SHA256:fixture' >&2
HOME=${JSON.stringify(root)} PYTHONPATH=${JSON.stringify(root)} PATH=${JSON.stringify(bin)} export HOME PYTHONPATH PATH
exec /bin/sh -c "$4"
`,
                );
                await chmod(ssh, 0o700);
                const target = await resolveRemoteTarget("example", null, ssh);
                assertEquals(
                    {
                        id: target.osReleaseId,
                        like: target.osReleaseIdLike,
                        sshfs: target.sshfs,
                        fusermount3: target.fusermount3,
                        fuseDevice: target.fuseDevice,
                    },
                    {
                        id: state === "unreadable" ? "" : "example",
                        like: state === "unreadable" ? "" : "rhel fedora",
                        sshfs: state === "present",
                        fusermount3: state === "present",
                        fuseDevice: state === "present",
                    },
                );
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        },
    );
}

for (const diagnostic of ["sh: python3: command not found", "zsh:1: command not found: python3"]) {
    test(`resolver explains missing python3: ${diagnostic}`, { skip: process.platform === "win32" }, async () => {
        const root = await mkdtemp(join(tmpdir(), "remote-resolver-python-"));
        try {
            const ssh = join(root, "ssh");
            await writeFile(
                ssh,
                `#!/bin/sh
if [ "$1" = -G ]; then printf 'hostname example\\nuser tester\\nport 22\\n'; exit 0; fi
while IFS= read -r line; do :; done
echo '${diagnostic}' >&2
exit 127
`,
            );
            await chmod(ssh, 0o700);
            const error = await assertRejects(() => resolveRemoteTarget("example", null, ssh));
            assertEquals(
                error.message,
                "Remote SSH requires python3 on the server. Install python3 with the server's package manager and reconnect.",
            );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
}
