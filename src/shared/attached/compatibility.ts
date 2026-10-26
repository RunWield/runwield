/** Core-owned Claude Connect compatibility policy. Entries require live acceptance evidence. */
import type { HostEvidence } from "./operations.ts";

export interface TestedClaudeVersion {
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

function compareVersions(left: string, right: string): number {
    const a = left.split(".").map(Number);
    const b = right.split(".").map(Number);
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
        const difference = (a[index] ?? 0) - (b[index] ?? 0);
        if (difference !== 0) return difference;
    }
    return 0;
}

const testedVersions: TestedClaudeVersion[] = [
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

/** Assess host evidence before Core performs an operation. Unknown versions remain usable with a notice. */
export function assessCompatibility(evidence: HostEvidence): CompatibilityAssessment {
    const matrix = CLAUDE_COMPATIBILITY_MATRIX;
    if (evidence.host !== matrix.host) {
        return {
            status: "unsupported_host",
            matrixVersion: matrix.matrixVersion,
            message: `RunWield Connect supports Claude Code only. ${evidence.host} is not a supported External Agent Host.`,
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
                    ? "Update the plugin in Claude Code: /plugin marketplace update runwield, then /plugin update runwield@runwield."
                    : "Update RunWield Core with your installer or package manager: rerun install.sh, brew upgrade gandazgul/tap/wld, or winget upgrade --id Gandazgul.RunWield --exact."),
        };
    }
    if (!/^\d+(?:\.\d+)*$/.test(evidence.hostVersion)) {
        return {
            status: "version_not_reported",
            matrixVersion: matrix.matrixVersion,
            message: "Claude Code did not report a numeric version. This host version is not yet tested; continuing.",
        };
    }
    const floor = matrix.oldestTestedVersion;
    if (floor && compareVersions(evidence.hostVersion, floor) < 0) {
        return {
            status: "unsupported_host_version",
            matrixVersion: matrix.matrixVersion,
            message: `Claude Code ${evidence.hostVersion} is older than the oldest tested version ${floor}. Update Claude Code with claude update.`,
        };
    }
    if (!matrix.testedVersions.some((entry) => compareVersions(entry.version, evidence.hostVersion) === 0)) {
        return {
            status: "untested_newer",
            matrixVersion: matrix.matrixVersion,
            message: `Claude Code ${evidence.hostVersion} is not yet tested with this Core version; continuing.`,
        };
    }
    return {
        status: "compatible",
        matrixVersion: matrix.matrixVersion,
        message: `Claude Code ${evidence.hostVersion} and adapter contract ${evidence.adapterContract} are tested with Core.`,
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
