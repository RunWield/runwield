import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { getWorktreeRegistryPath } from "../worktree-registry.js";
import {
    ATTACHED_OPERATIONS,
    type AttachedJsonObject,
    isAttachedReadOperation,
    type AttachedLifecycleOperationName,
} from "./operations.ts";
import { locateAttachedWorkflows, loadAttachedWorkflowRecord, writeAttachedWorkflowRecord } from "./record-store.ts";
import { activateInput, EVIDENCE, runOperation, withProject } from "./attached-test-fixture.ts";
import { compactStatus } from "./presentation.ts";
import { assessCompatibility, CODEX_COMPATIBILITY_MATRIX } from "./compatibility.ts";
import { attachedValidationFixture } from "./validation-test-fixture.ts";

test("Codex prereleases are recognized without claiming uncollected live acceptance", async () => {
    assertEquals(CODEX_COMPATIBILITY_MATRIX.testedVersions, []);
    assertEquals(CODEX_COMPATIBILITY_MATRIX.oldestTestedVersion, null);
    await withProject(async (root) => {
        for (const hostVersion of ["0.164.0-alpha.11.1", "0.164.0", "0.164.0+build.1"]) {
            const result = await runOperation("activate", root, {
                ...activateInput(`codex-${hostVersion.replaceAll("+", "-")}`),
                evidence: { ...EVIDENCE, host: "codex", hostVersion },
            });
            assert(result.ok);
            assertEquals(result.compatibility?.status, "untested_newer");
            assertStringIncludes(result.compatibility?.message ?? "", "not yet tested");
        }
    });
});

test("a prerelease of the Claude floor is older than its tested stable release", () => {
    assertEquals(assessCompatibility({ ...EVIDENCE, hostVersion: "2.1.303-rc.1" }).status, "unsupported_host_version");
    assertEquals(assessCompatibility({ ...EVIDENCE, hostVersion: "2.1.304-rc.1" }).status, "untested_newer");
});

for (const adapterContract of [0, 2]) {
    test(`adapter contract ${adapterContract} rejects activation without creating a record`, async () => {
        await withProject(async (root) => {
            const result = await runOperation("activate", root, {
                ...activateInput(),
                evidence: { ...EVIDENCE, adapterContract },
            });
            assert(!result.ok);
            assertEquals(result.rejection.code, "incompatible_adapter");
            assertStringIncludes(result.rejection.message, `contract ${adapterContract}`);
            assertStringIncludes(
                result.rejection.message,
                adapterContract === 0 ? "/plugin update runwield@runwield" : "Update RunWield Core",
            );
            const files = await readdir(locateAttachedWorkflows(root).workflowsDir).catch((error) => {
                if (error.code === "ENOENT") return [];
                throw error;
            });
            assertEquals(files, []);
        });
    });
}

for (const hostVersion of ["999.0.0", "2.1.304", "2.1.1000", "not-reported", "unparseable"]) {
    test(`activation discloses host version ${hostVersion} and saves its assessment`, async () => {
        await withProject(async (root) => {
            const result = await runOperation("activate", root, {
                ...activateInput(),
                evidence: { ...EVIDENCE, hostVersion },
            });
            assert(result.ok);
            assertEquals(
                result.compatibility?.status,
                ["not-reported", "unparseable"].includes(hostVersion) ? "version_not_reported" : "untested_newer",
            );
            assertStringIncludes(result.compatibility?.message ?? "", "not yet tested");
            const loaded = await loadAttachedWorkflowRecord(locateAttachedWorkflows(root), result.workflow.workflowId);
            assert(loaded.status === "found");
            assertEquals(loaded.record.evidence.compatibility, result.compatibility);
            const status = await runOperation("status", root, { workflowId: result.workflow.workflowId });
            assert(status.ok);
            assertEquals(status.workflow, result.workflow);
        });
    });
}

for (const hostVersion of ["2.1.302", "2.1.99"]) {
    test(`below-floor host ${hostVersion} rejects activation without creating a record`, async () => {
        await withProject(async (root) => {
            const result = await runOperation("activate", root, {
                ...activateInput(),
                evidence: { ...EVIDENCE, hostVersion },
            });
            assert(!result.ok);
            assertEquals(result.rejection.code, "unsupported_host_version");
            assertStringIncludes(result.rejection.message, hostVersion);
            assertStringIncludes(result.rejection.message, "2.1.303");
            assertStringIncludes(result.rejection.message, "claude update");
            const files = await readdir(locateAttachedWorkflows(root).workflowsDir).catch((error) => {
                if (error.code === "ENOENT") return [];
                throw error;
            });
            assertEquals(files, []);
        });
    });
}
for (const hostVersion of ["2.1.303", "2.1.303.0"]) {
    test(`tested host ${hostVersion} activates with its compatible assessment saved`, async () => {
        await withProject(async (root) => {
            const result = await runOperation("activate", root, {
                ...activateInput(),
                evidence: { ...EVIDENCE, hostVersion },
            });
            assert(result.ok);
            assertEquals(result.compatibility?.status, "compatible");
            const loaded = await loadAttachedWorkflowRecord(locateAttachedWorkflows(root), result.workflow.workflowId);
            assert(loaded.status === "found");
            assertEquals(loaded.record.evidence.compatibility, result.compatibility);
        });
    });
}

for (const adapterContract of [undefined, -1, 1.5, "1"]) {
    test(`invalid adapter contract ${String(adapterContract)} is rejected as input`, async () => {
        await withProject(async (root) => {
            const evidence: AttachedJsonObject = { ...EVIDENCE };
            if (adapterContract === undefined) delete evidence.adapterContract;
            else evidence.adapterContract = adapterContract;
            const result = await runOperation("activate", root, { ...activateInput(), evidence });
            assert(!result.ok);
            assertEquals(result.rejection.code, "invalid_input");
            assertEquals(result.rejection.field, "evidence.adapterContract");
        });
    });
}

const payloads: Record<AttachedLifecycleOperationName, AttachedJsonObject> = {
    activate: { requestText: "Add value", hostRequestId: "host-request" },
    triage_report: {
        actionId: "pending",
        outcome: { routingIntent: "PLANNED_CHANGE", complexity: "LOW", summary: "Add value", workKind: "FEATURE" },
    },
    plan_written: { actionId: "pending", planName: "p" },
    start_execution: {},
    task_completed: { actionId: "pending", message: "- Implemented the requested value and checked the result." },
    start_validation: {},
    review_diff: { actionId: "pending", command: "list" },
    review_complete: { actionId: "pending", approved: true },
    review_reply: { turnId: "pending", text: "The change adds the value." },
    validation_decision: { actionId: "pending", answer: { outcome: "proceed" } },
    work_record_completed: { actionId: "pending", title: "Add value", summary: "Added the value." },
    status: {},
};

for (const refusal of [
    { reason: "an unsupported host", code: "unsupported_host", evidence: { ...EVIDENCE, host: "opencode" } },
    { reason: "a stale contract", code: "incompatible_adapter", evidence: { ...EVIDENCE, adapterContract: 0 } },
    {
        reason: "a host below the tested floor",
        code: "unsupported_host_version",
        evidence: { ...EVIDENCE, hostVersion: "2.1.302" },
    },
]) {
    for (const name of ["get_instructions", "get_artifact", "get_pending_chat"] as const) {
        test(`${name} rejects ${refusal.reason} without returning content or changing the record`, async () => {
            await withProject(async (root) => {
                const activated = await runOperation("activate", root, activateInput());
                assert(activated.ok && activated.workflow.nextAction.kind === "triage");
                const location = locateAttachedWorkflows(root);
                const path = join(location.workflowsDir, `${activated.workflow.workflowId}.json`);
                const before = await readFile(path, "utf8");
                const result = await runOperation(name, root, {
                    workflowId: activated.workflow.workflowId,
                    actionId: activated.workflow.nextAction.actionId,
                    evidence: refusal.evidence,
                    ...(name === "get_artifact" && { artifact: "prompt" }),
                });
                assert(!result.ok);
                assertEquals(result.rejection.code, refusal.code);
                for (const key of ["instructions", "context", "content", "chat", "request"]) {
                    assertEquals(key in result, false);
                }
                assertEquals(await readFile(path, "utf8"), before);
            });
        });
    }
    test(`status reports ${refusal.reason} without continuing a reviewed workflow`, async () => {
        const fixture = await attachedValidationFixture({ attrs: { status: "reviewed" } });
        try {
            const location = locateAttachedWorkflows(fixture.root);
            const loaded = await loadAttachedWorkflowRecord(location, fixture.workflowId);
            assert(loaded.status === "found");
            assertEquals(
                (
                    await writeAttachedWorkflowRecord(
                        location,
                        {
                            ...loaded.record,
                            state: "reviewed",
                            revision: loaded.record.revision + 1,
                        },
                        loaded.record.revision,
                    )
                ).status,
                "written",
            );
            const path = join(location.workflowsDir, `${fixture.workflowId}.json`);
            const before = await readFile(path, "utf8");
            const count = await fixture.ciCount();
            const result = await runOperation("status", fixture.root, {
                workflowId: fixture.workflowId,
                evidence: refusal.evidence,
            });
            assert(result.ok, JSON.stringify(result));
            assertEquals(result.compatibility?.status, refusal.code);
            const compact = compactStatus(result, null);
            assert("compatibility" in compact);
            assertEquals(compact.compatibility, result.compatibility);
            assertEquals(result.workflow.revision, loaded.record.revision + 1);
            assertEquals(await fixture.ciCount(), count);
            assertEquals(await readFile(path, "utf8"), before);
        } finally {
            await fixture.close();
        }
    });
    for (const operation of ATTACHED_OPERATIONS.filter((entry) => entry.inputSchema.required.includes("evidence"))) {
        if (isAttachedReadOperation(operation.name)) continue;
        const name = operation.name;
        test(`${operation.name} rejects ${refusal.reason} before changing workflow, Plan, worktree, or registry`, async () => {
            const fixture = await attachedValidationFixture();
            try {
                const location = locateAttachedWorkflows(fixture.root);
                const recordPath = join(location.workflowsDir, `${fixture.workflowId}.json`);
                const paths = [
                    recordPath,
                    join(fixture.cwd, "docs/plans/p.md"),
                    join(fixture.root, "docs/plans/p.md"),
                    join(fixture.cwd, "implementation.ts"),
                    getWorktreeRegistryPath(fixture.root),
                ];
                const before = await Promise.all(paths.map((path) => readFile(path, "utf8")));
                const workflowFiles = await readdir(location.workflowsDir);
                const input: AttachedJsonObject = {
                    operationId: `stale-${operation.name}`,
                    evidence: refusal.evidence,
                    payload: payloads[name],
                    ...(operation.name !== "activate" && { workflowId: fixture.workflowId, expectedRevision: 2 }),
                };
                const result = await runOperation(operation.name, fixture.root, input);
                assert(!result.ok);
                assertEquals(result.rejection.code, refusal.code);
                assertEquals(await Promise.all(paths.map((path) => readFile(path, "utf8"))), before);
                assertEquals(await readdir(location.workflowsDir), workflowFiles);
                const status = await runOperation("status", fixture.root, { workflowId: fixture.workflowId });
                assert(status.ok);
            } finally {
                await fixture.close();
            }
        });
    }
}

test("compatibility checks host identity before adapter and version support", () => {
    assertEquals(
        assessCompatibility({ ...EVIDENCE, host: "opencode", hostVersion: "2.1.303" }).status,
        "unsupported_host",
    );
    assertEquals(assessCompatibility({ ...EVIDENCE, host: "opencode", adapterContract: 0 }).status, "unsupported_host");
    assertEquals(
        assessCompatibility({ ...EVIDENCE, host: "claude-code", hostVersion: "2.1.303" }).status,
        "compatible",
    );
});

for (const hostVersion of ["2.1.303", "999.0.0", "not-reported", undefined]) {
    test(`reviewed status continues with ${hostVersion ?? "saved activation"} evidence`, async () => {
        const fixture = await attachedValidationFixture();
        try {
            const location = locateAttachedWorkflows(fixture.root);
            const loaded = await loadAttachedWorkflowRecord(location, fixture.workflowId);
            assert(loaded.status === "found");
            assertEquals(
                (
                    await writeAttachedWorkflowRecord(
                        location,
                        {
                            ...loaded.record,
                            state: "reviewed",
                            revision: loaded.record.revision + 1,
                        },
                        loaded.record.revision,
                    )
                ).status,
                "written",
            );
            const evidence = hostVersion ? { ...EVIDENCE, hostVersion } : undefined;
            const result = await runOperation("status", fixture.root, {
                workflowId: fixture.workflowId,
                ...(evidence && { evidence }),
            });
            assert(result.ok, JSON.stringify(result));
            assertEquals(result.compatibility, evidence ? assessCompatibility(evidence) : undefined);
            assertEquals(await fixture.ciCount(), 1);
            const after = await loadAttachedWorkflowRecord(location, fixture.workflowId);
            assert(after.status === "found");
            const receipts = Object.values(after.record.acceptedOperations).filter(
                (entry) => entry.result.operation === "start_validation",
            );
            assertEquals(receipts.length, 1);
            assertEquals(receipts[0].evidence.hostVersion, hostVersion ?? EVIDENCE.hostVersion);
        } finally {
            await fixture.close();
        }
    });
}
