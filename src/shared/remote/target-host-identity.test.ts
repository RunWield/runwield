import { tmpdir } from "node:os";
import {
    mkdtemp as fsMkdtemp,
    realpath as fsRealpath,
    writeFile as fsWriteFile,
    chmod as fsChmod,
    rm as fsRm,
} from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import { resolveRemoteTarget } from "./target.ts";

async function withSsh(test: (ssh: string, root: string) => Promise<void>): Promise<void> {
    const root = await fsRealpath(await fsMkdtemp(join(tmpdir(), "runwield-")));
    try {
        const ssh = join(root, "ssh");
        await fsWriteFile(
            ssh,
            `#!/bin/sh
if [ "$1" = -G ]; then
  [ "$2" = -- ] || exit 42
  case "$3" in
    bad-config) exit 1;;
    bad-port) port=0;;
    port) port=2222;;
    *) port=22;;
  esac
  case "$3" in user) user=other;; *) user=tester;; esac
  case "$3" in hostname) hostname=other.example;; *) hostname=remote.example;; esac
  printf 'hostname %s\\nuser %s\\nport %s\\n' "$hostname" "$user" "$port"
  exit 0
fi
[ "$1" = -v ] && [ "$2" = -o ] && [ "$3" = ControlPath=none ] && [ "$4" = -oFingerprintHash=sha256 ] || exit 42
shift 4
[ "$1" = -T ] && [ "$2" = -- ] || exit 42
case "$3" in
  jump*)
    case "$3" in
      jump-rotated) echo 'debug1: Server host key: ssh-ed25519 SHA256:rotatedJump' >&2;;
      *) echo 'debug1: Server host key: ssh-ed25519 SHA256:jump' >&2;;
    esac
    case "$3" in
      jump-target-rotated) echo 'debug1: Server host key: ssh-ed25519 SHA256:changed' >&2;;
      jump-certificate) echo 'debug1: Server host certificate: ssh-ed25519-cert-v01@openssh.com SHA256:certificate' >&2;;
      *) echo 'debug1: Server host key: ssh-ed25519 SHA256:verified' >&2;;
    esac;;
  failed) echo 'Host key verification failed' >&2; exit 1;;
  no-key) ;;
  certificate) echo 'debug1: Server host certificate: ssh-ed25519-cert-v01@openssh.com SHA256:certificate' >&2;;
  key) echo 'debug1: Server host key: ssh-ed25519 SHA256:changed' >&2;;
  *) echo 'debug1: Server host key: ssh-ed25519 SHA256:verified' >&2;;
esac
HOME=${JSON.stringify(root)} export HOME
exec sh -c "$4"
`,
        );
        await fsChmod(ssh, 0o700);
        await test(ssh, root);
    } finally {
        await fsRm(root, { recursive: true });
    }
}

test("SSH aliases use effective host configuration and the verified key", async () => {
    await withSsh(async (ssh) => {
        const first = await resolveRemoteTarget("alias-one", null, ssh);
        const second = await resolveRemoteTarget("alias-two", null, ssh);
        assertEquals(first.host, {
            hostname: "remote.example",
            user: "tester",
            port: 22,
            hostKeyFingerprint: "SHA256:verified",
        });
        assertEquals(first.host, second.host);
        for (const alias of ["hostname", "user", "port", "key"]) {
            const changed = await resolveRemoteTarget(alias, null, ssh);
            assertEquals(JSON.stringify(first.host) === JSON.stringify(changed.host), false);
        }
    });
});

test("SSH target key rotation changes identity behind a jump host", async () => {
    await withSsh(async (ssh) => {
        const first = await resolveRemoteTarget("jump", null, ssh);
        const changed = await resolveRemoteTarget("jump-target-rotated", null, ssh);
        assertEquals(first.host.hostKeyFingerprint, "SHA256:verified");
        assertEquals(changed.host.hostKeyFingerprint, "SHA256:changed");
    });
});

test("SSH jump host key rotation does not change target identity", async () => {
    await withSsh(async (ssh) => {
        const first = await resolveRemoteTarget("jump", null, ssh);
        const changed = await resolveRemoteTarget("jump-rotated", null, ssh);
        assertEquals(first.host, changed.host);
    });
});

test("SSH target certificates do not use a jump host fingerprint", async () => {
    await withSsh(async (ssh) => {
        assertEquals((await resolveRemoteTarget("jump-certificate", null, ssh)).host.hostKeyFingerprint, null);
    });
});

test("SSH certificates retain effective identity without a host key fingerprint", async () => {
    await withSsh(async (ssh) => {
        assertEquals((await resolveRemoteTarget("certificate", null, ssh)).host.hostKeyFingerprint, null);
    });
});

test("missing key evidence and failed host verification cannot establish identity", async () => {
    await withSsh(async (ssh) => {
        await assertRejects(() => resolveRemoteTarget("no-key", null, ssh), Error, "did not report");
        await assertRejects(() => resolveRemoteTarget("failed", null, ssh), Error, "Host key verification failed");
    });
});

test("failed or invalid effective SSH configuration cannot establish identity", async () => {
    await withSsh(async (ssh) => {
        await assertRejects(() => resolveRemoteTarget("bad-config", null, ssh), Error, "Cannot resolve");
        await assertRejects(() => resolveRemoteTarget("bad-port", null, ssh), Error, "Invalid SSH host configuration");
    });
});

test("failed host verification keeps SSH diagnostics when the request pipe closes early", async () => {
    await withSsh(async (ssh) => {
        // Exceed the pipe buffer so SSH's early exit also rejects the request write.
        await assertRejects(
            () => resolveRemoteTarget("failed", "x".repeat(1024 * 1024), ssh),
            Error,
            "Host key verification failed",
        );
    });
});
