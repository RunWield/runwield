import { PROJECT_STORE_MAX_BYTES, readProjectStoreBody } from "@runwield/plans/project-store-wire";
import { parseProjectId } from "@runwield/projects";
import { test } from "node:test";
import { equal, throws, rejects } from "node:assert/strict";
import { validateProjectStoreRequest, parseHistoryList } from "./project-store-protocol.ts";
const binding = {
    projectId: parseProjectId(crypto.randomUUID())!,
    repositoryId: "repository-one",
    ownerId: "a".repeat(64),
};
test("the protocol refuses paths, forged authority, unsupported operations and protected envelopes", () => {
    const valid = { binding, command: { kind: "read" as const, planId: "plan-one", resource: "context.md" } };
    validateProjectStoreRequest(valid);
    for (const command of [
        { ...valid.command, planId: "../outside" },
        { ...valid.command, resource: "../../file" },
        { ...valid.command, cwd: "/tmp" },
        { ...valid.command, packageSelection: {} },
        { kind: "sql", planId: "plan-one", query: "DELETE FROM plans" },
    ])
        throws(() => validateProjectStoreRequest(JSON.parse(JSON.stringify({ binding, command }))));
    throws(() => validateProjectStoreRequest({ ...valid, binding: { ...binding, ownerId: "foreign" } }));
});
test("streamed request bounds apply without Content-Length", async () => {
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new Uint8Array(PROJECT_STORE_MAX_BYTES));
            controller.enqueue(new Uint8Array(1));
            controller.close();
        },
    });
    await rejects(readProjectStoreBody(new Response(body)), /too large/);
});

test("history requires a version identifier and restore accepts only an observed package revision", () => {
    const command = {
        kind: "restore-history" as const,
        planId: "plan-one",
        operationId: crypto.randomUUID(),
        version: crypto.randomUUID(),
        expectedRevision: "f".repeat(64),
    };
    validateProjectStoreRequest({ binding, command });
    throws(() => validateProjectStoreRequest({ binding, command: { ...command, version: "../../other" } }), /version/);
    throws(() => validateProjectStoreRequest({ binding, command: { ...command, expectedRevision: "" } }), /revision/);
});

test("managed history can resolve a name to a legacy Plan ID and use it for exact reads and restores", () => {
    const revision = "b".repeat(64);
    const version = crypto.randomUUID();
    const planId = "plan.1";
    const page = JSON.stringify({ planId, revision, milestones: [] });
    validateProjectStoreRequest({
        binding,
        command: { kind: "list-history", reference: "proposal", offset: 0, snapshot: "" },
    });
    equal(parseHistoryList(page).planId, planId);
    equal(parseHistoryList(page, planId).planId, planId);
    throws(() => parseHistoryList(page, "proposal"), /Invalid Plan history reply/);
    validateProjectStoreRequest({ binding, command: { kind: "list-history", planId, offset: 0, snapshot: "" } });
    validateProjectStoreRequest({
        binding,
        command: { kind: "show-history", planId, version, offset: 0, snapshot: "" },
    });
    validateProjectStoreRequest({
        binding,
        command: {
            kind: "restore-history",
            planId,
            version,
            operationId: crypto.randomUUID(),
            expectedRevision: revision,
        },
    });
});

test("managed Epic artifact commands accept durable IDs and guard the exact family and resource", () => {
    const common = {
        planId: "epic.1",
        operationId: crypto.randomUUID(),
        expectedRevision: "c".repeat(64),
    };
    const qa = {
        ...common,
        kind: "append-epic-qa" as const,
        childPlanId: "child.2",
        childRevision: "d".repeat(64),
        childHeading: "Check",
        checklistMarkdown: "Manual verification steps for child\n\n- [ ] Check",
    };
    const save = {
        ...common,
        kind: "save-epic-artifact" as const,
        resource: "integration-report.md",
        body: "# Report",
    };
    validateProjectStoreRequest({ binding, command: qa });
    validateProjectStoreRequest({ binding, command: save });
    validateProjectStoreRequest({
        binding,
        command: { kind: "read-documents", planId: common.planId, resource: save.resource },
    });
    throws(() => validateProjectStoreRequest({ binding, command: { ...qa, childPlanId: qa.planId } }), /QA section/);
    throws(() => validateProjectStoreRequest({ binding, command: { ...qa, childRevision: "" } }), /QA section/);
    throws(
        () => validateProjectStoreRequest({ binding, command: { ...save, resource: "context.md" } }),
        /Epic artifact/,
    );
});
