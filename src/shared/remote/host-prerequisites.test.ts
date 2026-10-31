import { test } from "node:test";
import { assertEquals, assertThrows } from "../../testing/assertions.ts";
import { assertRemoteHostReady, assertRemoteMountPrerequisites, parseOsRelease } from "./host-prerequisites.ts";
import { linuxTarget } from "./runtime.js";

const ready = { os: "Linux", arch: "x86_64", sshfs: true, fusermount3: true, fuseDevice: true };

for (const arch of ["x86_64", "aarch64"]) {
    test(`Remote SSH accepts a ready Linux ${arch} server`, () => {
        assertRemoteHostReady({ ...ready, arch });
        assertEquals(
            linuxTarget({ ...ready, arch }),
            arch === "x86_64" ? "x86_64-unknown-linux-gnu" : "aarch64-unknown-linux-gnu",
        );
    });
}

for (const target of [
    { os: "Darwin", arch: "x86_64", refusal: "the target runs macOS." },
    { os: "FreeBSD", arch: "x86_64", refusal: "the target runs FreeBSD." },
    { os: "Linux", arch: "armv7l", refusal: "the target CPU is armv7l." },
]) {
    test(`Remote SSH explains the supported systems for ${target.os}/${target.arch}`, () => {
        const expected = `Remote SSH supports Linux x86-64 and ARM64 servers; ${target.refusal}`;
        assertEquals(assertThrows(() => assertRemoteHostReady({ ...ready, ...target })).message, expected);
        assertEquals(assertThrows(() => linuxTarget(target)).message, expected);
    });
}

for (const distro of [
    { id: "fedora", like: "", install: "Run sudo dnf install sshfs fuse3 on the server." },
    { id: "rocky", like: "rhel centos fedora", install: "Run sudo dnf install sshfs fuse3 on the server." },
    { id: "ubuntu", like: "debian", install: "Run sudo apt install sshfs fuse3 on the server." },
    { id: "derivative", like: "ubuntu debian", install: "Run sudo apt install sshfs fuse3 on the server." },
    { id: "arch", like: "", install: "Run sudo pacman -S sshfs fuse3 on the server." },
    { id: "opensuse-tumbleweed", like: "suse opensuse", install: "Run sudo zypper install sshfs fuse3 on the server." },
    { id: "unlisted", like: "", install: "Install sshfs and fuse3 with the server's package manager." },
]) {
    test(`missing host prerequisites list all items and the ${distro.id} install command`, () => {
        const target = {
            ...ready,
            osReleaseId: distro.id,
            osReleaseIdLike: distro.like,
            sshfs: false,
            fusermount3: false,
            fuseDevice: false,
        };
        const expected = `Remote SSH server is missing: sshfs, fusermount3, /dev/fuse (character device). ${distro.install} Make /dev/fuse available as a character device (load the fuse module or enable FUSE on the host). Reconnect after the prerequisites are ready.`;
        assertEquals(assertThrows(() => assertRemoteHostReady(target)).message, expected);
        assertEquals(assertThrows(() => assertRemoteMountPrerequisites(target)).message, expected);
    });
}

for (const item of ["sshfs", "fusermount3", "fuseDevice"] as const) {
    for (const value of [false, undefined]) {
        test(`Remote SSH refuses ${item} when its presence is ${String(value)}`, () => {
            const missing = item === "fuseDevice" ? "/dev/fuse (character device)" : item;
            const fuse =
                item === "fuseDevice"
                    ? " Make /dev/fuse available as a character device (load the fuse module or enable FUSE on the host)."
                    : "";
            assertEquals(
                assertThrows(() => assertRemoteHostReady({ ...ready, osReleaseId: "debian", [item]: value })).message,
                `Remote SSH server is missing: ${missing}. Run sudo apt install sshfs fuse3 on the server.${fuse} Reconnect after the prerequisites are ready.`,
            );
        });
    }
}

test("package guidance reads quoted os-release values without running shell content", () => {
    assertEquals(parseOsRelease('NAME="Example Linux"\nID=example\nID_LIKE="rhel fedora"\n'), {
        osReleaseId: "example",
        osReleaseIdLike: "rhel fedora",
    });
    assertEquals(parseOsRelease("ID='arch'\nID_LIKE='$(touch /tmp/never)'\n"), {
        osReleaseId: "arch",
        osReleaseIdLike: "$(touch /tmp/never)",
    });
    assertEquals(parseOsRelease(""), { osReleaseId: "", osReleaseIdLike: "" });
});
