export interface RemoteHostPlatform {
    os: string;
    arch: string;
}

export interface RemoteHostPrerequisites {
    osReleaseId?: string;
    osReleaseIdLike?: string;
    sshfs?: boolean;
    fusermount3?: boolean;
    fuseDevice?: boolean;
}

export const REMOTE_PYTHON_REQUIRED =
    "Remote SSH requires python3 on the server. Install python3 with the server's package manager and reconnect.";

/** Refuse unsupported hosts before reading or preparing any runtime artifact. */
export function assertRemoteHostSupported(target: RemoteHostPlatform): void {
    const supported = "Remote SSH supports Linux x86-64 and ARM64 servers";
    if (target.os !== "Linux") {
        throw new Error(`${supported}; the target runs ${target.os === "Darwin" ? "macOS" : target.os}.`);
    }
    if (target.arch !== "x86_64" && target.arch !== "aarch64") {
        throw new Error(`${supported}; the target CPU is ${target.arch}.`);
    }
}

function installGuidance(target: RemoteHostPrerequisites): string {
    const families = [target.osReleaseId ?? "", ...(target.osReleaseIdLike ?? "").split(/\s+/)];
    for (const family of families) {
        if (["fedora", "rhel", "centos"].includes(family)) return "Run sudo dnf install sshfs fuse3 on the server.";
        if (["debian", "ubuntu"].includes(family)) return "Run sudo apt install sshfs fuse3 on the server.";
        if (family === "arch") return "Run sudo pacman -S sshfs fuse3 on the server.";
        if (["opensuse", "opensuse-leap", "opensuse-tumbleweed", "suse", "sles"].includes(family)) {
            return "Run sudo zypper install sshfs fuse3 on the server.";
        }
    }
    return "Install sshfs and fuse3 with the server's package manager.";
}

/** The mount owner repeats this check because host state can change after resolution. */
export function assertRemoteMountPrerequisites(target: RemoteHostPrerequisites): void {
    const missing = [
        ...(target.sshfs === true ? [] : ["sshfs"]),
        ...(target.fusermount3 === true ? [] : ["fusermount3"]),
        ...(target.fuseDevice === true ? [] : ["/dev/fuse (character device)"]),
    ];
    if (!missing.length) return;
    const fuse =
        target.fuseDevice === true
            ? ""
            : " Make /dev/fuse available as a character device (load the fuse module or enable FUSE on the host).";
    throw new Error(
        `Remote SSH server is missing: ${missing.join(", ")}. ${installGuidance(target)}${fuse} Reconnect after the prerequisites are ready.`,
    );
}

export function assertRemoteHostReady(target: RemoteHostPlatform & RemoteHostPrerequisites): void {
    assertRemoteHostSupported(target);
    assertRemoteMountPrerequisites(target);
}

/** Read only os-release values used for package guidance, never execute shell content. */
export function parseOsRelease(source: string): Pick<RemoteHostPrerequisites, "osReleaseId" | "osReleaseIdLike"> {
    const values = new Map<string, string>();
    for (const line of source.split(/\r?\n/)) {
        const match = /^(ID|ID_LIKE)=(.*)$/.exec(line);
        if (!match) continue;
        const value = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
        values.set(match[1], value);
    }
    return { osReleaseId: values.get("ID") ?? "", osReleaseIdLike: values.get("ID_LIKE") ?? "" };
}
