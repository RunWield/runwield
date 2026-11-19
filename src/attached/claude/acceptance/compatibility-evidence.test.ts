import { test } from "node:test";
import { ok as assert, deepStrictEqual as equal, match } from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assessCompatibility, CLAUDE_COMPATIBILITY_MATRIX as matrix } from "../../../shared/attached/compatibility.ts";
import type { AcceptanceSummary } from "./evidence.ts";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const RESULTS = fileURLToPath(new URL("./results/", import.meta.url));
// Required evidence for the version-1 Preview journey, including all safety and provenance gates.
const REQUIRED_CHECKS = [
    "evidence-readable",
    "core-source",
    "run-identity",
    "stale-adapter",
    "step-01-install",
    "inactive-before",
    "step-02-uninitialized-activation",
    "step-03-explicit-request",
    "step-04-triage",
    "step-05-plan",
    "step-06-plan-review-and-chat",
    "step-07-plan-approval",
    "step-08-isolated-execution",
    "step-09-implementation",
    "disable",
    "uninstall",
    "reinstall",
    "step-10-ci-and-resume",
    "step-11-finding-repair-rereview",
    "step-12-code-review-and-chat",
    "step-13-publication",
    "step-14-work-record",
    "step-15-interruptions",
    "step-16-inactive-after",
    "lifecycle-events",
    "invoking-branch",
    "workflow-identity",
    "operation-provenance",
    "host-version",
    "read-only-driver",
    "no-core-model-calls",
    "sentinel-absence",
];

test("every tested Claude version has exactly one saved live result and no result is orphaned", async () => {
    assert(matrix.testedVersions.length > 0);
    equal(new Set(matrix.testedVersions.map((entry) => entry.version)).size, matrix.testedVersions.length);
    equal(
        (await readdir(RESULTS)).sort(),
        matrix.testedVersions.map((entry) => `claude-code-${entry.version}.json`).sort(),
    );
    assert(matrix.testedVersions.some((entry) => entry.version === matrix.oldestTestedVersion));
});

for (const entry of matrix.testedVersions) {
    test(`Claude ${entry.version} matrix entry matches passing live evidence and source identity`, async () => {
        equal(entry.evidenceSource, `src/attached/claude/acceptance/results/claude-code-${entry.version}.json`);
        const result: AcceptanceSummary = JSON.parse(await readFile(join(ROOT, entry.evidenceSource), "utf8"));
        equal(result.schemaVersion, 1);
        equal(result.outcome, "pass");
        equal(result.claudeVersion, entry.version);
        for (const key of [
            "testDate",
            "coreVersion",
            "coreCommit",
            "coreSourceDigest",
            "coreSourceDirty",
            "adapterContract",
        ] as const)
            equal(result[key], entry[key]);
        equal(result.proposedMatrixEntry, entry);
        match(entry.version, /^\d+(?:\.\d+)+$/);
        match(entry.coreCommit, /^[a-f0-9]{40}$/);
        match(entry.coreSourceDigest, /^[a-f0-9]{64}$/);
        assert(Number.isFinite(Date.parse(entry.testDate)));
        equal(typeof entry.coreSourceDirty, "boolean");
        assert(matrix.supportedAdapterContracts.includes(entry.adapterContract));
        assert(result.checks.length >= 16 && result.checks.every((check) => check.outcome === "pass"));
        equal(new Set(result.checks.map((check) => check.id)).size, result.checks.length);
        equal(
            result.checks.filter((check) => check.id.startsWith("step-")).map((check) => check.id),
            entry.capabilities,
        );
        equal(entry.capabilities.length, 16);
        equal(result.provenance.acceptedOperations, result.provenance.matchedOperations);
        assert(result.provenance.acceptedOperations > 0);
        assert(result.adapterVersion);
        assert(result.activationAssessment === "compatible" || result.activationAssessment === "untested_newer");
        equal(result.permissions, "bypass-in-throwaway");
        assert(entry.limits.includes("Headless permissions bypassed only in the throwaway world"));
        // Every proven version must remain usable; with a proven floor this also checks the minimum.
        equal(
            assessCompatibility({
                host: matrix.host,
                hostVersion: entry.version,
                adapterVersion: result.adapterVersion,
                adapterContract: entry.adapterContract,
            }).status,
            "compatible",
        );
    });

    test(`Claude ${entry.version} live result retains every required journey, safety, and provenance check`, async () => {
        const result: AcceptanceSummary = JSON.parse(await readFile(join(ROOT, entry.evidenceSource), "utf8"));
        for (const id of REQUIRED_CHECKS)
            assert(
                result.checks.some((check) => check.id === id),
                `Missing required acceptance check: ${id}`,
            );
    });

    test(`Claude ${entry.version} result contains only public summary fields and relative evidence pointers`, async () => {
        const result: AcceptanceSummary = JSON.parse(await readFile(join(ROOT, entry.evidenceSource), "utf8"));
        equal(
            Object.keys(result).sort(),
            [
                "schemaVersion",
                "outcome",
                "testDate",
                "claudeVersion",
                "coreVersion",
                "coreCommit",
                "coreSourceDigest",
                "coreSourceDirty",
                "adapterContract",
                "adapterVersion",
                "activationAssessment",
                "permissions",
                "checks",
                "provenance",
                "proposedMatrixEntry",
            ].sort(),
        );
        for (const check of result.checks) {
            equal(Object.keys(check).sort(), ["id", "outcome", "evidence"].sort());
            assert(check.evidence.length > 0);
            for (const pointer of check.evidence) {
                assert(!isAbsolute(pointer) && !pointer.split(/[\\/]/).includes(".."));
                assert(!pointer.includes("\\"));
            }
        }
        assert(
            !JSON.stringify(result).match(
                /ordinary-(before|attached|disabled|uninstalled|after)-|\/Users\/|\/home\/|sk-ant-/,
            ),
        );
    });
}
