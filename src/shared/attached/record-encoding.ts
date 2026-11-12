import { closeSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { JSONParser, type JsonTypes } from "@streamparser/json";
import type { ValidationHostRequest } from "../workflow/validation-host-contract.ts";
import type { AttachedNextAction, AttachedOperationResult, AttachedWorkflowView } from "./operations.ts";
import type { AcceptedOperation, AttachedValidationCheckpoint, AttachedWorkflowRecord } from "./record-store.ts";

type RequestedAction = Extract<AttachedNextAction, { request: ValidationHostRequest }>;
type OrdinaryAction = Exclude<AttachedNextAction, RequestedAction>;
type StoredRequestedAction = Omit<RequestedAction, "request"> & { requestId: string };
type StoredAction = OrdinaryAction | StoredRequestedAction;
interface StoredView extends Omit<AttachedWorkflowView, "nextAction"> {
    nextAction: StoredAction;
}
type Success = Extract<AttachedOperationResult, { ok: true }>;
type Failure = Extract<AttachedOperationResult, { ok: false }>;
interface StoredSuccess extends Omit<Success, "workflow"> {
    workflow: StoredView;
}
interface StoredFailure extends Omit<Failure, "workflow"> {
    workflow?: StoredView;
}
type StoredResult = StoredSuccess | StoredFailure;
interface StoredOperation extends Omit<AcceptedOperation, "result"> {
    result: StoredResult;
}
interface StoredCheckpoint extends Omit<AttachedValidationCheckpoint, "request"> {
    requestId?: string;
}
interface StoredRecord extends Omit<AttachedWorkflowRecord, "schemaVersion" | "validation" | "acceptedOperations"> {
    schemaVersion: 2;
    validation?: StoredCheckpoint | null;
    acceptedOperations: Record<string, StoredOperation>;
    validationRequests: Record<string, ValidationHostRequest>;
}
type DiskRecord = AttachedWorkflowRecord | StoredRecord;
type ParsedRecord = JsonTypes.JsonObject & DiskRecord;
type ParsedOperation = JsonTypes.JsonObject & (AcceptedOperation | StoredOperation);
interface RecordHeader {
    schemaVersion?: number;
    projectRoot?: string;
}

/** A request is immutable evidence. Replays reference the same exact request, not a new snapshot of its diff. */
class Requests {
    readonly values: Record<string, ValidationHostRequest> = {};
    private readonly identities = new WeakMap<ValidationHostRequest, string>();

    add(request: ValidationHostRequest): string {
        const known = this.identities.get(request);
        if (known) return known;
        const id = createHash("sha256").update(JSON.stringify(request)).digest("hex");
        this.values[id] ??= request;
        this.identities.set(request, id);
        return id;
    }

    intern(request: ValidationHostRequest): ValidationHostRequest {
        return this.values[this.add(request)];
    }
}

function encodeView(view: AttachedWorkflowView, requests: Requests): StoredView {
    const action = view.nextAction;
    if (!("request" in action)) return { ...view, nextAction: action };
    const { request, ...rest } = action;
    return { ...view, nextAction: { ...rest, requestId: requests.add(request) } };
}

function encodeResult(result: AttachedOperationResult, requests: Requests): StoredResult {
    if (result.ok) return { ...result, workflow: encodeView(result.workflow, requests) };
    const { workflow, ...rest } = result;
    return { ...rest, ...(workflow && { workflow: encodeView(workflow, requests) }) };
}

function encodeCheckpoint(
    checkpoint: AttachedValidationCheckpoint | null | undefined,
    requests: Requests,
): StoredCheckpoint | null | undefined {
    if (!checkpoint) return checkpoint;
    const { request, ...rest } = checkpoint;
    return { ...rest, ...(request && { requestId: requests.add(request) }) };
}

function decodeCheckpoint(
    checkpoint: StoredCheckpoint | null | undefined,
    requestFor: (id: string) => ValidationHostRequest,
): AttachedValidationCheckpoint | null | undefined {
    if (!checkpoint) return checkpoint;
    const { requestId, ...rest } = checkpoint;
    return { ...rest, ...(requestId && { request: requestFor(requestId) }) };
}

/** Operation identifiers include names such as __proto__; preserve them as own data properties. */
function setEntry<Value>(entries: Record<string, Value>, key: string, value: Value): void {
    Object.defineProperty(entries, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Only the storage representation changes. In-memory operations and replay responses keep their existing contract. */
export function encodeAttachedRecord(record: AttachedWorkflowRecord): DiskRecord {
    const requests = new Requests();
    const validation = encodeCheckpoint(record.validation, requests);
    const acceptedOperations: Record<string, StoredOperation> = {};
    for (const [id, operation] of Object.entries(record.acceptedOperations)) {
        setEntry(acceptedOperations, id, { ...operation, result: encodeResult(operation.result, requests) });
    }
    if (Object.keys(requests.values).length === 0) return record;
    return {
        ...record,
        schemaVersion: 2,
        validation,
        acceptedOperations,
        validationRequests: requests.values,
    };
}

function decodeView(view: StoredView, requestFor: (id: string) => ValidationHostRequest): AttachedWorkflowView {
    const action = view.nextAction;
    if (!("requestId" in action)) return { ...view, nextAction: action };
    const { requestId, ...rest } = action;
    const request = requestFor(requestId);
    if (rest.kind === "validation") return { ...view, nextAction: { ...rest, kind: "validation", request } };
    if (rest.kind === "code_review" && request.kind === "decision")
        return { ...view, nextAction: { ...rest, kind: "code_review", request } };
    if (rest.kind === "recorder" && request.kind === "recorder")
        return { ...view, nextAction: { ...rest, kind: "recorder", request } };
    throw new Error("Attached replay request does not match its action.");
}

function decodeResult(
    result: StoredResult,
    requestFor: (id: string) => ValidationHostRequest,
): AttachedOperationResult {
    if (result.ok) return { ...result, workflow: decodeView(result.workflow, requestFor) };
    const { workflow, ...rest } = result;
    return { ...rest, ...(workflow && { workflow: decodeView(workflow, requestFor) }) };
}

function decodeRecord(record: DiskRecord): AttachedWorkflowRecord {
    if (record.schemaVersion === 1) return record;
    const verified = new Set<string>();
    const requestFor = (id: string): ValidationHostRequest => {
        if (!/^[a-f0-9]{64}$/.test(id) || !Object.hasOwn(record.validationRequests ?? {}, id))
            throw new Error("Attached replay request is missing.");
        const request = record.validationRequests[id];
        if (!verified.has(id)) {
            if (createHash("sha256").update(JSON.stringify(request)).digest("hex") !== id)
                throw new Error("Attached replay request has changed.");
            verified.add(id);
        }
        return request;
    };
    const { validationRequests: _requests, validation, acceptedOperations, ...rest } = record;
    const operations: Record<string, AcceptedOperation> = {};
    for (const [id, operation] of Object.entries(acceptedOperations)) {
        setEntry(operations, id, { ...operation, result: decodeResult(operation.result, requestFor) });
    }
    return {
        ...rest,
        schemaVersion: 1,
        acceptedOperations: operations,
        validation: decodeCheckpoint(validation, requestFor),
    };
}

function parseFile(path: string, parser: JSONParser): void {
    parser.onError = (error) => {
        throw new SyntaxError(error.message);
    };
    const file = openSync(path, "r");
    try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        for (;;) {
            const size = readSync(file, buffer);
            if (!size) break;
            parser.write(buffer.subarray(0, size));
        }
        if (!parser.isEnded) parser.end();
    } finally {
        closeSync(file);
    }
}

/** Alias discovery validates the JSON but never builds its operation history. */
export function readAttachedRecordHeader(path: string): RecordHeader {
    const header: RecordHeader = {};
    const parser = new JSONParser({
        paths: ["$.schemaVersion", "$.projectRoot"],
        keepStack: false,
        stringBufferSize: 65536,
    });
    parser.onValue = ({ key, value }) => {
        if (key === "schemaVersion" && typeof value === "number") header.schemaVersion = value;
        if (key === "projectRoot" && typeof value === "string") header.projectRoot = value;
    };
    parseFile(path, parser);
    return header;
}

/**
 * Old records can contain gigabytes of repeated requests. Consume one receipt at a time,
 * interning its request before retaining it. Do not read/parse the entire old file first.
 * Reads are passive; the next ordinary locked write stores the compact representation.
 */
export function readAttachedRecord(path: string): AttachedWorkflowRecord {
    const fields: JsonTypes.JsonObject = {};
    const operations: Record<string, AcceptedOperation | StoredOperation> = {};
    const requests = new Requests();
    const parser = new JSONParser({
        paths: ["$.acceptedOperations.*", "$.*"],
        keepStack: false,
        stringBufferSize: 65536,
    });
    parser.onValue = ({ key, value, stack, parent }) => {
        if (typeof key !== "string" || value === undefined) return;
        if (stack.length === 2 && stack[1].key === "acceptedOperations") {
            if (!value || typeof value !== "object" || Array.isArray(value))
                throw new SyntaxError("Invalid Attached receipt.");
            const operation = value as ParsedOperation;
            const action = operation.result?.workflow?.nextAction;
            if (action && "request" in action) action.request = requests.intern(action.request);
            setEntry(operations, key, operation);
            // The selected parent is also emitted. Drop already-consumed siblings explicitly.
            if (parent && !Array.isArray(parent)) delete parent[key];
        } else if (stack.length === 1 && key !== "acceptedOperations") {
            setEntry(fields, key, value);
        }
    };
    parseFile(path, parser);
    if (fields.schemaVersion !== 1 && fields.schemaVersion !== 2)
        throw new Error("Unsupported Attached record schema.");
    const record = { ...fields, acceptedOperations: operations } as ParsedRecord;
    if (record.schemaVersion === 1 && record.validation?.request)
        record.validation.request = requests.intern(record.validation.request);
    return decodeRecord(record);
}
