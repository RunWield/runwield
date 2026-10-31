import {
    listProjectsFromDisk,
    recordRemoteHostAnswer,
    remoteProjectRoot,
    sameRemoteHost,
} from "../session/file-session-storage.ts";
import { getRunWieldSessionsBaseDir } from "../session/root-session.js";
import type { RemoteHostIdentity, ResolvedRemoteTarget } from "./target.ts";

function partialMatchReason(saved: RemoteHostIdentity, observed: RemoteHostIdentity): string | null {
    if (saved.user !== observed.user) return null;
    const sameAddress = saved.hostname === observed.hostname && saved.port === observed.port;
    if (!sameAddress && saved.hostKeyFingerprint !== null && saved.hostKeyFingerprint === observed.hostKeyFingerprint) {
        return `Same host key ${saved.hostKeyFingerprint}; hostname or port changed.`;
    }
    if (sameAddress && saved.hostKeyFingerprint !== observed.hostKeyFingerprint) {
        return (
            `Host key changed from ${saved.hostKeyFingerprint ?? "no stable fingerprint"} to ` +
            `${observed.hostKeyFingerprint ?? "no stable fingerprint"}.\n` +
            "   OpenSSH accepted the new key. Choose this only if you expect the change."
        );
    }
    return null;
}

/** Resolve consent once; downstream Session and Memory matching stays exact. */
export function confirmRemoteHost(
    target: ResolvedRemoteTarget,
    baseDir = getRunWieldSessionsBaseDir(),
): ResolvedRemoteTarget {
    const root = remoteProjectRoot(target);
    const projects = listProjectsFromDisk(baseDir)
        .filter((project) => project.remote?.root === root)
        .sort(
            (left, right) =>
                left.createdAt.localeCompare(right.createdAt) ||
                (left.remote?.targetLabel || left.projectId).localeCompare(
                    right.remote?.targetLabel || right.projectId,
                ),
        );
    if (projects.some((project) => sameRemoteHost(project.remote!.host, target.host))) return target;
    const accepted = projects.find((project) =>
        project.remote!.acceptedHosts?.some((host) => sameRemoteHost(host, target.host)),
    );
    if (accepted) return { ...target, host: { ...accepted.remote!.host } };
    const matches = projects.flatMap((project) => {
        const remote = project.remote!;
        if (remote.host.user !== target.host.user) return [];
        if (remote.refusedHosts?.some((host) => sameRemoteHost(host, target.host))) return [];
        const reason = [remote.host, ...(remote.acceptedHosts || [])]
            .map((host) => partialMatchReason(host, target.host))
            .find((reason) => reason !== null);
        return reason ? [{ project, reason }] : [];
    });
    if (!matches.length) return target;
    const question =
        `${target.host.user}@${target.host.hostname}:${target.host.port} ${root} partly matches saved remote history.\n` +
        matches
            .map(({ project, reason }, index) => {
                const remote = project.remote!;
                return (
                    `${index + 1}. ${remote.targetLabel || remote.root} — ` +
                    `${remote.host.user}@${remote.host.hostname}:${remote.host.port}. ${reason}`
                );
            })
            .join("\n") +
        `\n0. No: keep a separate history\nIs this the same server? Choose 0–${matches.length}:`;
    const answer = globalThis.prompt(question);
    if (answer === null) throw new Error("Remote host choice canceled");
    if (!/^\d+$/.test(answer.trim())) throw new Error("Invalid remote host choice");
    const choice = Number(answer.trim());
    if (choice > matches.length) throw new Error("Invalid remote host choice");
    if (choice === 0) {
        for (const { project } of matches) recordRemoteHostAnswer(baseDir, project, target.host, "refusedHosts");
        return target;
    }
    const project = matches[choice - 1].project;
    recordRemoteHostAnswer(baseDir, project, target.host, "acceptedHosts");
    return { ...target, host: { ...project.remote!.host } };
}
