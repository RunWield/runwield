/** Core-owned Connect compatibility policy. Tested entries require live acceptance evidence. */
import type { HostEvidence } from "./operations.ts";
import { attachedHost } from "./hosts.ts";

export interface TestedHostVersion {
    version: string;
    testDate: string;
    coreVersion: string;
    coreCommit: string;
    coreSourceDigest: string;
    coreSourceDirty: boolean;
    adapterContract: number;
    evidenceSource: string;
    capabilities: string[];
    limits: string[];
}

export interface CompatibilityAssessment {
    status:
        | "unsupported_host"
        | "compatible"
        | "untested_newer"
        | "version_not_reported"
        | "incompatible_adapter"
        | "unsupported_host_version";
    matrixVersion: number;
    message: string;
}

interface ParsedVersion {
    release: number[];
    prerelease: string[];
}

function parseVersion(value: string): ParsedVersion | null {
    const matched =
        /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
            value,
        );
    if (!matched) return null;
    const release = matched[1].split(".").map(Number);
    if (!release.every(Number.isSafeInteger)) return null;
    return { release, prerelease: matched[2]?.split(".") ?? [] };
}

function compareVersions(left: string, right: string): number {
    const a = parseVersion(left)!;
    const b = parseVersion(right)!;
    for (let index = 0; index < Math.max(a.release.length, b.release.length); index++) {
        const difference = (a.release[index] ?? 0) - (b.release[index] ?? 0);
        if (difference !== 0) return difference;
    }
    if (!a.prerelease.length || !b.prerelease.length)
        return Number(!a.prerelease.length) - Number(!b.prerelease.length);
    for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
        const x = a.prerelease[index],
            y = b.prerelease[index];
        if (x === undefined || y === undefined) return Number(x !== undefined) - Number(y !== undefined);
        if (x === y) continue;
        const numericX = /^\d+$/.test(x),
            numericY = /^\d+$/.test(y);
        if (numericX && numericY) return Number(x) - Number(y);
        if (numericX !== numericY) return numericX ? -1 : 1;
        return x < y ? -1 : 1;
    }
    return 0;
}

const testedVersions: TestedHostVersion[] = [
    {
        version: "2.1.303",
        testDate: "2026-10-21T18:10:26.292Z",
        coreVersion: "6cdb8218b",
        coreCommit: "6cdb8218b280328365a859fe18926cfcfb987a52",
        coreSourceDigest: "f20bdf99f618b15ea6b5d5693f7cd677fec623491df040329238cc1af82f5a42",
        coreSourceDirty: true,
        adapterContract: 1,
        evidenceSource: "src/attached/claude/acceptance/results/claude-code-2.1.303.json",
        capabilities: [
            "step-01-install",
            "step-02-uninitialized-activation",
            "step-03-explicit-request",
            "step-04-triage",
            "step-05-plan",
            "step-06-plan-review-and-chat",
            "step-07-plan-approval",
            "step-08-isolated-execution",
            "step-09-implementation",
            "step-10-ci-and-resume",
            "step-11-finding-repair-rereview",
            "step-12-code-review-and-chat",
            "step-13-publication",
            "step-14-work-record",
            "step-15-interruptions",
            "step-16-inactive-after",
        ],
        limits: [
            "Claude Code FEATURE Preview only",
            "MCP_TOOL_TIMEOUT=600000",
            "No /runwield:init",
            "No hooks or tool restrictions",
            "Role boundaries are instructions, not enforcement",
            "Headless permissions bypassed only in the throwaway world",
        ],
    },
];

export const CLAUDE_COMPATIBILITY_MATRIX = {
    host: "claude-code",
    matrixVersion: 1,
    supportedAdapterContracts: [1],
    oldestTestedVersion: testedVersions.map((entry) => entry.version).sort(compareVersions)[0] ?? null,
    testedVersions,
};

const codexTestedVersions: TestedHostVersion[] = [];

/** Codex is available for qualification; protocol probes are not live workflow acceptance. */
export const CODEX_COMPATIBILITY_MATRIX = {
    host: "codex",
    matrixVersion: 1,
    supportedAdapterContracts: [1],
    oldestTestedVersion: null,
    testedVersions: codexTestedVersions,
};

/** Assess host evidence before Core performs an operation. Unknown versions remain usable with a notice. */
export function assessCompatibility(evidence: HostEvidence): CompatibilityAssessment {
    const host = attachedHost(evidence.host);
    const matrix = evidence.host === "codex" ? CODEX_COMPATIBILITY_MATRIX : CLAUDE_COMPATIBILITY_MATRIX;
    if (!host) {
        return {
            status: "unsupported_host",
            matrixVersion: matrix.matrixVersion,
            message: `RunWield Connect supports Claude Code and Codex. ${evidence.host} is not a supported External Agent Host.`,
        };
    }
    const required = matrix.supportedAdapterContracts.join(", ");
    if (!matrix.supportedAdapterContracts.includes(evidence.adapterContract)) {
        return {
            status: "incompatible_adapter",
            matrixVersion: matrix.matrixVersion,
            message:
                `Plugin ${evidence.adapterVersion} uses adapter contract ${evidence.adapterContract}; Core supports ${required}. ` +
                (evidence.adapterContract < Math.min(...matrix.supportedAdapterContracts)
                    ? host.updatePlugin
                    : "Update RunWield Core with your installer or package manager: rerun install.sh, brew upgrade gandazgul/tap/wld, or winget upgrade --id Gandazgul.RunWield --exact."),
        };
    }
    if (!parseVersion(evidence.hostVersion)) {
        return {
            status: "version_not_reported",
            matrixVersion: matrix.matrixVersion,
            message: `${host.displayName} did not report a recognizable version. This host version is not yet tested; continuing.`,
        };
    }
    const floor = matrix.oldestTestedVersion;
    if (floor && compareVersions(evidence.hostVersion, floor) < 0) {
        return {
            status: "unsupported_host_version",
            matrixVersion: matrix.matrixVersion,
            message: `${host.displayName} ${evidence.hostVersion} is older than the oldest tested version ${floor}. ${host.updateHost}`,
        };
    }
    if (!matrix.testedVersions.some((entry) => compareVersions(entry.version, evidence.hostVersion) === 0)) {
        return {
            status: "untested_newer",
            matrixVersion: matrix.matrixVersion,
            message: `${host.displayName} ${evidence.hostVersion} is not yet tested with this Core version; continuing.`,
        };
    }
    return {
        status: "compatible",
        matrixVersion: matrix.matrixVersion,
        message: `${host.displayName} ${evidence.hostVersion} and adapter contract ${evidence.adapterContract} are tested with Core.`,
    };
}

interface BlockingCompatibilityAssessment extends CompatibilityAssessment {
    status: "unsupported_host" | "incompatible_adapter" | "unsupported_host_version";
}

/** Blocking assessments allow diagnostic status only, not host work or continuation. */
export function isBlockingCompatibility(
    assessment: CompatibilityAssessment,
): assessment is BlockingCompatibilityAssessment {
    return ["unsupported_host", "incompatible_adapter", "unsupported_host_version"].includes(assessment.status);
}
