import { parseProjectId } from "@runwield/projects";
import { test } from "node:test";
import { throws, rejects } from "node:assert/strict";
import {
    validateProjectStoreRequest,
    readProjectStoreBody,
    PROJECT_STORE_MAX_BYTES,
} from "./project-store-protocol.ts";
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
