import type { ProjectStoreBinding, ProjectStoreCommand, ProjectStoreReply } from "../../plan-store/index.ts";
export const PROJECT_STORE_MAX_BYTES = 1024 * 1024;
export interface ProjectStoreRequest {
    binding: ProjectStoreBinding;
    command: ProjectStoreCommand;
}
const identity = (value: string) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
function fields(value: ProjectStoreBinding | ProjectStoreRequest, allowed: string[]) {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== [...allowed].sort().join(",")
    )
        throw new Error("Unsupported request fields.");
}
export function validateProjectStoreBinding(binding: ProjectStoreBinding): void {
    fields(binding, ["projectId", "repositoryId", "ownerId"]);
    if (!identity(binding.projectId) || !identity(binding.repositoryId) || !/^[a-f0-9]{64}$/.test(binding.ownerId))
        throw new Error("Invalid Project owner binding.");
}
export function validateProjectStoreRequest(request: ProjectStoreRequest): void {
    fields(request, ["binding", "command"]);
    validateProjectStoreBinding(request.binding);
    const command = request.command;
    if (!command || !identity(command.planId)) throw new Error("Invalid Plan identity.");
    const common = ["kind", "planId", "operationId", "expectedRevision"];
    const commandFields = {
        read: ["kind", "planId", "resource"],
        "read-collaboration": ["kind", "planId"],
        "read-record": ["kind", "planId", "recordId"],
        "search-records": ["kind", "planId", "query", "limit"],
        "save-record": [...common, "title", "summary"],
        "reconcile-record-index": [...common, "recordId"],
        "read-frozen": ["kind", "planId", "resource", "snapshotId", "snapshotDigest", "attemptId"],
        "seal-publication": [...common, "attemptId", "validatedCommit", "targetBranch"],
        reconcile: ["kind", "planId", "operationId"],
        "save-document": [...common, "resource", "body"],
        "save-prose": [...common, "body"],
        "save-definition": [...common, "changes"],
        "record-event": [...common, "event"],
    };
    const exact = Object.hasOwn(commandFields, command.kind) ? commandFields[command.kind] : [];
    if (!exact.length || Object.keys(command).sort().join(",") !== exact.sort().join(","))
        throw new Error("Unsupported store operation or fields.");
    if ("operationId" in command && !/^[a-f0-9-]{36}$/.test(command.operationId))
        throw new Error("Invalid operation identity.");
    if ("expectedRevision" in command && !/^[a-f0-9]{64}$/.test(command.expectedRevision))
        throw new Error("Expected revision is required.");
    if (
        "resource" in command &&
        !["context.md", "validation.md", "manual-qa.md", "integration-report.md"].includes(command.resource)
    )
        throw new Error("Unsupported document resource.");
    if ("recordId" in command && !identity(command.recordId)) throw new Error("Invalid record identity.");
    if (
        command.kind === "search-records" &&
        (typeof command.query !== "string" ||
            command.query.length > 1024 ||
            !Number.isInteger(command.limit) ||
            command.limit < 1 ||
            command.limit > 20)
    )
        throw new Error("Invalid record search.");
    if (
        command.kind === "save-record" &&
        (typeof command.title !== "string" || typeof command.summary !== "string" || command.title.length > 240)
    )
        throw new Error("Invalid record content.");
    if (
        command.kind === "read-frozen" &&
        (!/^[a-f0-9-]{36}$/.test(command.snapshotId) ||
            !/^[a-f0-9]{64}$/.test(command.snapshotDigest) ||
            !identity(command.attemptId))
    )
        throw new Error("Invalid snapshot identity.");
    if (
        command.kind === "seal-publication" &&
        (!identity(command.attemptId) ||
            !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(command.validatedCommit) ||
            typeof command.targetBranch !== "string" ||
            command.targetBranch.length > 255 ||
            command.targetBranch.includes(".."))
    )
        throw new Error("Invalid publication input.");
    if ("body" in command && typeof command.body !== "string") throw new Error("Invalid document body.");
    if (
        command.kind === "record-event" &&
        !["review_approved", "review_feedback", "hold_reset_to_draft"].includes(command.event)
    )
        throw new Error("Unsupported lifecycle event.");
    if (
        command.kind === "save-definition" &&
        (!command.changes || typeof command.changes !== "object" || Array.isArray(command.changes))
    )
        throw new Error("Invalid definition.");
    if (new TextEncoder().encode(JSON.stringify(request)).length > PROJECT_STORE_MAX_BYTES)
        throw new Error("Store request too large.");
}
export async function readProjectStoreBody(source: Request | Response): Promise<string> {
    const reader = source.body?.getReader();
    if (!reader) throw new Error("Missing store body.");
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > PROJECT_STORE_MAX_BYTES) {
                await reader.cancel();
                throw new Error("Store body too large.");
            }
            parts.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
export function sameProjectStoreBinding(left: ProjectStoreBinding, right: ProjectStoreBinding): boolean {
    return (
        left.projectId === right.projectId && left.repositoryId === right.repositoryId && left.ownerId === right.ownerId
    );
}
export function validateProjectStoreReply(reply: ProjectStoreReply, request: ProjectStoreRequest): void {
    validateProjectStoreBinding(reply.binding);
    if (!sameProjectStoreBinding(reply.binding, request.binding)) throw new Error("Reply owner mismatch.");
    if (Object.keys(reply).sort().join(",") !== "binding,result") throw new Error("Unsupported reply fields.");
    const result = reply.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid store reply.");
    const allowed =
        "records" in result
            ? ["records"]
            : "spaceId" in result
              ? ["planId", "spaceId", "latestRevision"]
              : "resource" in result
                ? ["planId", "resource", "revision", "body", "writable"]
                : ["operationId", "status", "revision", "snapshotId", "snapshotDigest", "attemptId", "recordId"];
    if (Object.keys(result).some((key) => !allowed.includes(key))) throw new Error("Unsupported reply result fields.");
    if (request.command.kind === "read-collaboration") {
        if (
            !("spaceId" in result) ||
            result.planId !== request.command.planId ||
            !identity(result.spaceId) ||
            !Number.isSafeInteger(result.latestRevision) ||
            result.latestRevision < 1
        )
            throw new Error("Invalid collaboration reply.");
    } else if (request.command.kind === "read-record" || request.command.kind === "search-records") {
        if (
            !("records" in result) ||
            !Array.isArray(result.records) ||
            result.records.length > 20 ||
            result.records.some((record) => !identity(record.recordId) || typeof record.markdown !== "string")
        )
            throw new Error("Invalid record reply.");
    } else if (request.command.kind === "read" || request.command.kind === "read-frozen") {
        if (
            !("resource" in result) ||
            result.planId !== request.command.planId ||
            result.resource !== request.command.resource ||
            typeof result.body !== "string" ||
            !/^[a-f0-9]{64}$/.test(result.revision) ||
            typeof result.writable !== "boolean"
        )
            throw new Error("Invalid document reply.");
    } else if (
        !("operationId" in result) ||
        result.operationId !== request.command.operationId ||
        !["completed", "unstarted", "pending", "unavailable"].includes(result.status) ||
        (result.status === "completed" && !/^[a-f0-9]{64}$/.test(result.revision || ""))
    )
        throw new Error("Invalid operation reply.");
}
