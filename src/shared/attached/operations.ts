/**
 * @module shared/attached/operations
 * The bounded operation contract between an External Agent Host carrier and the
 * Attached Workflow Coordinator: input envelopes, results, limits, and strict parsing.
 *
 * Carriers pass raw JSON. Everything a host sends is checked here before the
 * coordinator reads or writes a record, so the CLI and MCP carriers hold no rules.
 */

import {
    ENGINEER_MESSAGE_DESCRIPTION,
    IMPLEMENTATION_REPORT_MIN_LENGTH,
    normalizeImplementationReport,
} from "../workflow/implementation-report.ts";
import type { ActiveExecutionWorkflow } from "../session/hosted-session.js";
import { ROUTING_INTENTS, WORK_KINDS } from "../../constants.js";
import { TRIAGE_COMPLEXITIES, type TriageOutcome, type TriageOutcomeInput } from "../workflow/triage-outcome.ts";

export type AttachedJsonValue = string | number | boolean | null | AttachedJsonValue[] | AttachedJsonObject;
export type AttachedJsonObject = { [key: string]: AttachedJsonValue };

/** Lifecycle operations keep their Core tool names; `activate`, `status`, and `start_execution` have no Core tool equivalent. */
export type AttachedOperationName =
    | "activate"
    | "triage_report"
    | "status"
    | "plan_written"
    | "start_execution"
    | "task_completed"
    | "start_validation"
    | "review_diff"
    | "review_complete"
    | "validation_decision";

/** Version of the Triage role and outcome contract the host receives with a Triage action. */
export const ATTACHED_TRIAGE_CONTRACT_VERSION = "runwield.attached.triage/1";
/** Version of the Planner role and `plan_written` contract the host receives with a planning action. */
export const ATTACHED_PLANNER_CONTRACT_VERSION = "runwield.attached.planner/1";

export const ATTACHED_IMPLEMENTER_CONTRACT_VERSION = "runwield.attached.implementation/1";

export const MAX_ATTACHED_INPUT_BYTES = 64 * 1024;
const MAX_REQUEST_TEXT_LENGTH = 32 * 1024;
const MAX_SUMMARY_LENGTH = 4 * 1024;
const MAX_SHORT_TEXT_LENGTH = 200;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TRANSCRIPT_FIELD_PATTERN = /^(transcript|messages|conversation|history|turns|chat|log)s?$/i;
const PATH_FIELD_PATTERN = /(path|paths|dir|directory|cwd|root|file|files|worktree)$/i;

export type AttachedRejectionCode =
    | "invalid_input"
    | "payload_too_large"
    | "unknown_field"
    | "transcript_field"
    | "path_field"
    | "invalid_outcome"
    | "workflow_not_found"
    | "project_moved"
    | "action_superseded"
    | "revision_conflict"
    | "workflow_busy";

export interface AttachedRejection {
    code: AttachedRejectionCode;
    message: string;
    field?: string;
}

/** What the host and its adapter report about themselves. Core adds its own version. */
export interface HostEvidence {
    host: string;
    hostVersion: string;
    adapterVersion: string;
}

export interface RecordedEvidence extends HostEvidence {
    coreVersion: string;
}

export interface AttachedOperationEnvelope<Payload> {
    projectRoot: string;
    operationId: string;
    evidence: HostEvidence;
    payload: Payload;
}

export interface ActivatePayload {
    requestText: string;
    hostRequestId: string;
}

export interface TriageReportPayload {
    actionId: string;
    outcome: TriageOutcomeInput;
}

/** The Core `plan_written` arguments. Values are checked by the Plan execution policy, not here. */
export interface PlanWrittenPayload {
    actionId: string;
    planName: string;
    executionAgent?: string;
    collaborationRecommendation?: string;
}

export interface StartExecutionPayload {
    actionId?: string;
    consent?: "proceed" | "decline";
}
export interface TaskCompletedPayload {
    actionId: string;
    message: string;
}
/** Durable execution authority returned by shared preparation, plus the issued Plan revision. */
export interface AttachedExecution extends ActiveExecutionWorkflow {
    actionId: string;
    planRevision: string;
    planBodyRevision: string;
}
export interface AttachedPendingConsent {
    actionId: string;
    kind: "non_git_in_place";
    disclosure: string;
}
export type StartExecutionEnvelope = WorkflowOperationEnvelope<StartExecutionPayload>;
export type TaskCompletedEnvelope = WorkflowOperationEnvelope<TaskCompletedPayload>;

export type ActivateEnvelope = AttachedOperationEnvelope<ActivatePayload>;

/** An operation on an existing workflow, checked against its saved revision. */
export interface WorkflowOperationEnvelope<Payload> extends AttachedOperationEnvelope<Payload> {
    workflowId: string;
    expectedRevision: number;
}

export type TriageReportEnvelope = WorkflowOperationEnvelope<TriageReportPayload>;
export type PlanWrittenEnvelope = WorkflowOperationEnvelope<PlanWrittenPayload>;

export interface StatusEnvelope {
    projectRoot: string;
    workflowId?: string;
}

export type AttachedWorkflowState =
    | "triaging"
    | "awaiting_planning"
    | "awaiting_review"
    | "plan_ready"
    | "awaiting_consent"
    | "implementing"
    | "implemented"
    | "validating"
    | "reviewed"
    | "closed";

export interface AttachedReviewOutcome {
    kind: "feedback" | "approved" | "canceled";
    feedback?: string;
    imagePaths?: string[];
    approvalAction?: string;
}

/** The durable identity and accepted outcome of the current browser review round. */
export interface AttachedReviewRound {
    round: number;
    actionId: string;
    planRevision: string;
    controllerRevision: number;
    waitingReason: "user_decision";
    status: "pending" | "applied";
    outcome?: AttachedReviewOutcome;
}

/** The RunWield roles a host plays in Attached Mode. */
export type AttachedHostRole =
    "router" | "planner" | "engineer" | "frontend-engineer" | "reviewer" | "reviewer-feedback-engineer";

export interface PendingHostAction {
    actionId: string;
    role: AttachedHostRole;
    contractVersion: string;
    note?: string;
    feedback?: string;
    imagePaths?: string[];
}

export type AttachedNextAction =
    | ({ kind: "triage" } & PendingHostAction)
    | ({ kind: "plan"; projectSetup: string[] } & PendingHostAction)
    | { kind: "review"; round: number; planName: string }
    | { kind: "plan_ready"; planName: string; guidance: string }
    | { kind: "consent"; actionId: string; consentKind: "non_git_in_place"; disclosure: string }
    | ({
          kind: "implementation";
          planName: string;
          planPath: string;
          executionCwd: string;
          executionMode: string;
          worktreeBranch?: string;
          disclosure: string;
      } & PendingHostAction)
    | { kind: "implemented"; planName: string; guidance: string }
    | {
          kind: "validation";
          actionId: string;
          request: import("../workflow/validation-host-contract.ts").ValidationHostRequest;
      }
    | {
          kind: "validation_recovery";
          guidance: string;
          resultKind?: "paused" | "failed";
          recovery?: import("../workflow/validation-recovery.ts").ValidationRecoveryResult;
      }
    | { kind: "awaiting_delivery"; planName: string; guidance: string }
    | { kind: "return_to_host"; reason: "unsupported_in_preview" | "plan_advanced_in_core"; message?: string };

/** The Plan a workflow submitted. The workflow references the Plan; it does not own it. */
export interface AttachedPlanReference {
    planId: string;
    planName: string;
}

/** The effective role instructions Core returns with a pending host action. Never saved. */
export interface AttachedRoleInstructions {
    role: AttachedHostRole;
    contractVersion: string;
    text: string;
}

export type AttachedWorkflowClosure =
    { reason: "unsupported_in_preview"; routingIntent: string } | { reason: "plan_advanced_in_core"; message: string };

export interface ProjectMovedRecovery {
    case: "project_moved";
    recordedProjectRoot: string;
    currentProjectRoot: string;
}

export interface AttachedWorkflowView {
    workflowId: string;
    revision: number;
    state: AttachedWorkflowState;
    nextAction: AttachedNextAction;
    triageOutcome: TriageOutcome | null;
    plan: AttachedPlanReference | null;
    review: AttachedReviewRound | null;
    execution: AttachedExecution | null;
    pendingConsent: AttachedPendingConsent | null;
    closure: AttachedWorkflowClosure | null;
    recovery: ProjectMovedRecovery | null;
}

export type AttachedOperationResult =
    | {
          ok: true;
          operation: AttachedOperationName;
          workflow: AttachedWorkflowView;
          instructions?: AttachedRoleInstructions;
          diff?: import("../workflow/review-diff.ts").ReviewDiffRead;
      }
    | {
          ok: false;
          operation: AttachedOperationName;
          rejection: AttachedRejection;
          workflow?: AttachedWorkflowView;
          instructions?: AttachedRoleInstructions;
          diff?: import("../workflow/review-diff.ts").ReviewDiffRead;
      };

export type ParsedInput<Envelope> = { ok: true; envelope: Envelope } | { ok: false; rejection: AttachedRejection };

class InputRejection extends Error {
    constructor(readonly rejection: AttachedRejection) {
        super(rejection.message);
    }
}

function reject(code: AttachedRejectionCode, field: string, message: string): never {
    throw new InputRejection({ code, field, message });
}

function rejectUnknownField(field: string): never {
    const key = field.split(".").at(-1) || field;
    if (TRANSCRIPT_FIELD_PATTERN.test(key)) {
        reject(
            "transcript_field",
            field,
            `${field} looks like host conversation content, which RunWield never stores.`,
        );
    }
    if (PATH_FIELD_PATTERN.test(key)) {
        reject("path_field", field, `${field} names a filesystem location; RunWield resolves paths itself.`);
    }
    reject("unknown_field", field, `${field} is not part of this operation.`);
}

function readObject(value: AttachedJsonValue | undefined, field: string, keys: readonly string[]): AttachedJsonObject {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        reject("invalid_input", field, `${field} must be a JSON object.`);
    }
    for (const key of Object.keys(value)) {
        if (!keys.includes(key)) rejectUnknownField(field ? `${field}.${key}` : key);
    }
    return value;
}

function readText(object: AttachedJsonObject, key: string, field: string, maxLength: number): string {
    const value = object[key];
    if (typeof value !== "string" || !value.trim()) {
        reject("invalid_input", field, `${field} must be a non-empty string.`);
    }
    if (value.length > maxLength) reject("payload_too_large", field, `${field} exceeds ${maxLength} characters.`);
    return value;
}

function readOptionalText(object: AttachedJsonObject, key: string, field: string, maxLength: number) {
    return object[key] === undefined ? undefined : readText(object, key, field, maxLength);
}

function readIdentifier(object: AttachedJsonObject, key: string, field: string): string {
    const value = readText(object, key, field, MAX_SHORT_TEXT_LENGTH);
    if (/[/\\]/.test(value) || value.startsWith(".") || value.includes("..")) {
        reject("path_field", field, `${field} must be an identifier, not a path.`);
    }
    if (!IDENTIFIER_PATTERN.test(value)) {
        reject("invalid_input", field, `${field} must be 1-128 letters, digits, '.', '_', ':', or '-'.`);
    }
    return value;
}

function readRevision(object: AttachedJsonObject, key: string): number {
    const value = object[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        reject("invalid_input", key, `${key} must be a positive integer.`);
    }
    return value;
}

function readEvidence(object: AttachedJsonObject): HostEvidence {
    const evidence = readObject(object.evidence, "evidence", ["host", "hostVersion", "adapterVersion"]);
    return {
        host: readIdentifier(evidence, "host", "evidence.host"),
        hostVersion: readText(evidence, "hostVersion", "evidence.hostVersion", MAX_SHORT_TEXT_LENGTH),
        adapterVersion: readText(evidence, "adapterVersion", "evidence.adapterVersion", MAX_SHORT_TEXT_LENGTH),
    };
}

function readOutcome(value: AttachedJsonValue | undefined): TriageOutcomeInput {
    const field = "payload.outcome";
    const outcome = readObject(value, field, ["routingIntent", "complexity", "summary", "workKind", "sessionName"]);
    return {
        routingIntent: readText(outcome, "routingIntent", `${field}.routingIntent`, MAX_SHORT_TEXT_LENGTH),
        complexity: readText(outcome, "complexity", `${field}.complexity`, MAX_SHORT_TEXT_LENGTH),
        summary: readText(outcome, "summary", `${field}.summary`, MAX_SUMMARY_LENGTH),
        workKind: readOptionalText(outcome, "workKind", `${field}.workKind`, MAX_SHORT_TEXT_LENGTH),
        sessionName: readOptionalText(outcome, "sessionName", `${field}.sessionName`, MAX_SHORT_TEXT_LENGTH),
    };
}

function parse<Envelope>(input: AttachedJsonValue | undefined, read: () => Envelope): ParsedInput<Envelope> {
    if (input === undefined) {
        return { ok: false, rejection: { code: "invalid_input", message: "Input must be one JSON object." } };
    }
    if (new TextEncoder().encode(JSON.stringify(input)).length > MAX_ATTACHED_INPUT_BYTES) {
        return {
            ok: false,
            rejection: { code: "payload_too_large", message: `Input exceeds ${MAX_ATTACHED_INPUT_BYTES} bytes.` },
        };
    }
    try {
        return { ok: true, envelope: read() };
    } catch (error) {
        if (error instanceof InputRejection) return { ok: false, rejection: error.rejection };
        throw error;
    }
}

export function parseActivateInput(projectRoot: string, input: AttachedJsonValue | undefined) {
    return parse(input, (): ActivateEnvelope => {
        const object = readObject(input, "", ["operationId", "evidence", "payload"]);
        const payload = readObject(object.payload, "payload", ["requestText", "hostRequestId"]);
        return {
            projectRoot,
            operationId: readIdentifier(object, "operationId", "operationId"),
            evidence: readEvidence(object),
            payload: {
                requestText: readText(payload, "requestText", "payload.requestText", MAX_REQUEST_TEXT_LENGTH),
                hostRequestId: readIdentifier(payload, "hostRequestId", "payload.hostRequestId"),
            },
        };
    });
}

function readWorkflowEnvelope<Payload>(
    projectRoot: string,
    input: AttachedJsonValue | undefined,
    payloadKeys: readonly string[],
    readPayload: (payload: AttachedJsonObject) => Payload,
): WorkflowOperationEnvelope<Payload> {
    const object = readObject(input, "", ["operationId", "workflowId", "expectedRevision", "evidence", "payload"]);
    const payload = readObject(object.payload, "payload", payloadKeys);
    return {
        projectRoot,
        operationId: readIdentifier(object, "operationId", "operationId"),
        workflowId: readIdentifier(object, "workflowId", "workflowId"),
        expectedRevision: readRevision(object, "expectedRevision"),
        evidence: readEvidence(object),
        payload: readPayload(payload),
    };
}

export function parseTriageReportInput(projectRoot: string, input: AttachedJsonValue | undefined) {
    return parse(input, (): TriageReportEnvelope =>
        readWorkflowEnvelope(projectRoot, input, ["actionId", "outcome"], (payload) => ({
            actionId: readIdentifier(payload, "actionId", "payload.actionId"),
            outcome: readOutcome(payload.outcome),
        })),
    );
}

export function parsePlanWrittenInput(projectRoot: string, input: AttachedJsonValue | undefined) {
    const keys = ["actionId", "planName", "executionAgent", "collaborationRecommendation"];
    return parse(input, (): PlanWrittenEnvelope =>
        readWorkflowEnvelope(projectRoot, input, keys, (payload) => ({
            actionId: readIdentifier(payload, "actionId", "payload.actionId"),
            planName: readText(payload, "planName", "payload.planName", MAX_SHORT_TEXT_LENGTH),
            executionAgent: readOptionalText(
                payload,
                "executionAgent",
                "payload.executionAgent",
                MAX_SHORT_TEXT_LENGTH,
            ),
            collaborationRecommendation: readOptionalText(
                payload,
                "collaborationRecommendation",
                "payload.collaborationRecommendation",
                MAX_SHORT_TEXT_LENGTH,
            ),
        })),
    );
}

export function parseStartExecutionInput(projectRoot: string, input: AttachedJsonValue | undefined) {
    return parse(input, (): StartExecutionEnvelope =>
        readWorkflowEnvelope(projectRoot, input, ["actionId", "consent"], (payload) => {
            if (payload.consent === undefined && payload.actionId === undefined) return {};
            if (payload.consent !== "proceed" && payload.consent !== "decline") {
                reject("invalid_input", "payload.consent", "Consent must be proceed or decline.");
            }
            return { actionId: readIdentifier(payload, "actionId", "payload.actionId"), consent: payload.consent };
        }),
    );
}

export function parseTaskCompletedInput(projectRoot: string, input: AttachedJsonValue | undefined) {
    return parse(input, (): TaskCompletedEnvelope =>
        readWorkflowEnvelope(projectRoot, input, ["actionId", "message"], (payload) => {
            if (typeof payload.message !== "string" || payload.message.length < IMPLEMENTATION_REPORT_MIN_LENGTH) {
                reject("invalid_input", "payload.message", "task_completed.message must be a non-empty string.");
            }
            return {
                actionId: readIdentifier(payload, "actionId", "payload.actionId"),
                message: normalizeImplementationReport(payload.message),
            };
        }),
    );
}

export function parseStatusInput(projectRoot: string, input: AttachedJsonValue | undefined) {
    return parse(input, (): StatusEnvelope => {
        const object = readObject(input, "", ["workflowId"]);
        return {
            projectRoot,
            ...(object.workflowId !== undefined && { workflowId: readIdentifier(object, "workflowId", "workflowId") }),
        };
    });
}

const IDENTIFIER_SCHEMA = { type: "string", pattern: IDENTIFIER_PATTERN.source };
const EVIDENCE_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["host", "hostVersion", "adapterVersion"],
    properties: {
        host: { ...IDENTIFIER_SCHEMA, description: "External Agent Host identifier, for example claude-code." },
        hostVersion: { type: "string" },
        adapterVersion: { type: "string" },
    },
};

export interface AttachedInputSchema extends AttachedJsonObject {
    type: "object";
    required: string[];
    properties: AttachedJsonObject;
}

function workflowOperationSchema(
    payloadRequired: string[],
    payloadProperties: AttachedJsonObject,
): AttachedInputSchema {
    return {
        type: "object",
        additionalProperties: false,
        required: ["operationId", "workflowId", "expectedRevision", "evidence", "payload"],
        properties: {
            operationId: IDENTIFIER_SCHEMA,
            workflowId: IDENTIFIER_SCHEMA,
            expectedRevision: { type: "integer", minimum: 1 },
            evidence: EVIDENCE_SCHEMA,
            payload: {
                type: "object",
                additionalProperties: false,
                required: payloadRequired,
                properties: payloadProperties,
            },
        },
    };
}

export interface AttachedOperationDescriptor {
    name: AttachedOperationName;
    description: string;
    inputSchema: AttachedInputSchema;
}

/** Host-facing descriptions and JSON Schemas. `parse*Input` above stays the authority. */
export const ATTACHED_OPERATIONS: AttachedOperationDescriptor[] = [
    {
        name: "activate",
        description:
            "Start one Attached Workflow for one explicitly activated user request. Returns the workflow, revision 1, and the pending Triage action.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["operationId", "evidence", "payload"],
            properties: {
                operationId: { ...IDENTIFIER_SCHEMA, description: "Unique per operation; a retry reuses it." },
                evidence: EVIDENCE_SCHEMA,
                payload: {
                    type: "object",
                    additionalProperties: false,
                    required: ["requestText", "hostRequestId"],
                    properties: {
                        requestText: { type: "string", maxLength: MAX_REQUEST_TEXT_LENGTH },
                        hostRequestId: IDENTIFIER_SCHEMA,
                    },
                },
            },
        },
    },
    {
        name: "triage_report",
        description:
            "Report the Triage outcome for the pending Router action. Repeating an accepted operationId returns the saved result.",
        inputSchema: workflowOperationSchema(["actionId", "outcome"], {
            actionId: IDENTIFIER_SCHEMA,
            outcome: {
                type: "object",
                additionalProperties: false,
                required: ["routingIntent", "complexity", "summary"],
                properties: {
                    routingIntent: {
                        type: "string",
                        enum: ROUTING_INTENTS.filter((intent) => intent !== "FEATURE"),
                    },
                    complexity: { type: "string", enum: [...TRIAGE_COMPLEXITIES] },
                    summary: { type: "string", maxLength: MAX_SUMMARY_LENGTH },
                    workKind: { type: "string", enum: WORK_KINDS },
                    sessionName: { type: "string", maxLength: MAX_SHORT_TEXT_LENGTH },
                },
            },
        }),
    },
    {
        name: "status",
        description:
            "Read state, revision, next action, and recovery. Omit workflowId to restore the most recent open workflow in this project.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: [],
            properties: { workflowId: IDENTIFIER_SCHEMA },
        },
    },
    {
        name: "plan_written",
        description:
            "Submit the Plan written in docs/plans/ for the pending Planner action. RunWield gives it a Plan ID and " +
            "Triage Front Matter, and sets up the project runtime. Repeating an accepted operationId returns the saved result.",
        inputSchema: workflowOperationSchema(["actionId", "planName"], {
            actionId: IDENTIFIER_SCHEMA,
            planName: {
                type: "string",
                maxLength: MAX_SHORT_TEXT_LENGTH,
                description: "Plan filename without extension, relative to docs/plans/.",
            },
            executionAgent: { type: "string", enum: ["engineer", "frontend-engineer"] },
            collaborationRecommendation: { type: "string", enum: ["autonomous", "pair"] },
        }),
    },
    {
        name: "start_execution",
        description:
            "Start the approved ready Plan through Core preparation. For a consent action, ask the user and resubmit actionId and consent: proceed or decline. Use status to restore an implementing handoff.",
        inputSchema: workflowOperationSchema([], {
            actionId: IDENTIFIER_SCHEMA,
            consent: { type: "string", enum: ["proceed", "decline"] },
        }),
    },
    {
        name: "task_completed",
        description:
            "Accept the worker report for the issued implementation or repair action through Core completion guards.",
        inputSchema: workflowOperationSchema(["actionId", "message"], {
            actionId: IDENTIFIER_SCHEMA,
            message: {
                type: "string",
                minLength: IMPLEMENTATION_REPORT_MIN_LENGTH,
                description: ENGINEER_MESSAGE_DESCRIPTION,
            },
        }),
    },
];

export interface AttachedValidationPayload {
    actionId?: string;
    outcome?: import("../workflow/review-outcome.ts").ReviewCompletePayload;
    answer?: import("../workflow/validation-ports.ts").ValidationInteractionResponse;
    command?: string;
    scope?: string;
    path?: string;
    offsetBytes?: number;
    maxBytes?: number;
}
export type AttachedValidationEnvelope = WorkflowOperationEnvelope<AttachedValidationPayload>;

export function parseValidationInput(
    projectRoot: string,
    input: AttachedJsonValue | undefined,
    operation: AttachedOperationName,
) {
    const keys =
        operation === "start_validation"
            ? []
            : operation === "review_diff"
              ? ["actionId", "command", "scope", "path", "offsetBytes", "maxBytes"]
              : operation === "review_complete"
                ? ["actionId", "approved", "feedback", "findings", "advisories", "integrationNotes"]
                : ["actionId", "answer"];
    return parse(input, (): AttachedValidationEnvelope =>
        readWorkflowEnvelope(projectRoot, input, keys, (payload) => {
            if (operation === "start_validation") return {};
            const actionId = readIdentifier(payload, "actionId", "payload.actionId");
            if (operation === "review_diff") {
                const command = readText(payload, "command", "payload.command", 20);
                if (!["list", "show"].includes(command)) {
                    reject("invalid_input", "payload.command", "Use list or show.");
                }
                if (payload.scope !== undefined && payload.scope !== "full" && payload.scope !== "repair") {
                    reject("invalid_input", "payload.scope", "Use full or repair scope.");
                }
                if (typeof payload.maxBytes === "number" && payload.maxBytes > 65536) {
                    reject("payload_too_large", "payload.maxBytes", "Each diff page is at most 65536 bytes.");
                }
                for (const key of ["offsetBytes", "maxBytes"]) {
                    const value = payload[key];
                    if (
                        value !== undefined &&
                        (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
                    ) {
                        reject("invalid_input", key, "Byte ranges must be non-negative integers.");
                    }
                }
                return {
                    actionId,
                    command,
                    scope: readOptionalText(payload, "scope", "payload.scope", 20),
                    path: readOptionalText(payload, "path", "payload.path", 4096),
                    offsetBytes: typeof payload.offsetBytes === "number" ? payload.offsetBytes : undefined,
                    maxBytes: typeof payload.maxBytes === "number" ? payload.maxBytes : undefined,
                };
            }
            if (operation === "validation_decision") {
                const answer = readObject(payload.answer, "payload.answer", [
                    "outcome",
                    "value",
                    "valueLabel",
                    "message",
                ]);
                if (
                    answer.value !== undefined &&
                    typeof answer.value !== "string" &&
                    typeof answer.value !== "boolean"
                ) {
                    reject("invalid_input", "payload.answer.value", "Answer must be text or boolean.");
                }
                return {
                    actionId,
                    answer: {
                        outcome: readText(answer, "outcome", "payload.answer.outcome", 200),
                        value:
                            typeof answer.value === "string" || typeof answer.value === "boolean"
                                ? answer.value
                                : undefined,
                        valueLabel: readOptionalText(answer, "valueLabel", "payload.answer.valueLabel", 200),
                        message: readOptionalText(answer, "message", "payload.answer.message", 4096),
                    },
                };
            }
            const outcome = payload;
            if (typeof outcome.approved !== "boolean") {
                reject("invalid_input", "payload.approved", "approved must be boolean.");
            }
            const findings =
                outcome.findings === undefined
                    ? undefined
                    : readRows(
                          outcome.findings,
                          "findings",
                          (row): import("../workflow/review-outcome.ts").ReviewFindingInput => {
                              readObject(row, "finding", [
                                  "id",
                                  "resolved",
                                  "title",
                                  "requirement",
                                  "evidence",
                                  "status",
                                  "rejectionReason",
                                  "origin",
                              ]);
                              if (row.resolved !== undefined && typeof row.resolved !== "boolean") {
                                  reject("invalid_input", "resolved", "resolved must be boolean.");
                              }
                              const status = row.status;
                              if (
                                  status !== undefined &&
                                  status !== "new" &&
                                  status !== "fix_confirmed" &&
                                  status !== "fix_rejected"
                              ) {
                                  reject("invalid_input", "status", "Invalid finding status.");
                              }
                              const origin = row.origin;
                              if (
                                  origin !== undefined &&
                                  origin !== "missed_original" &&
                                  origin !== "repair_regression"
                              )
                                  reject("invalid_input", "origin", "Invalid finding origin.");
                              return {
                                  title: readText(row, "title", "title", 4096),
                                  id: readOptionalText(row, "id", "id", 200),
                                  resolved: typeof row.resolved === "boolean" ? row.resolved : undefined,
                                  status,
                                  origin,
                                  requirement: readOptionalText(row, "requirement", "requirement", 4096),
                                  evidence: readOptionalText(row, "evidence", "evidence", 4096),
                                  rejectionReason: readOptionalText(row, "rejectionReason", "rejectionReason", 4096),
                              };
                          },
                      );
            const advisories =
                outcome.advisories === undefined
                    ? undefined
                    : readRows(outcome.advisories, "advisories", (row) => {
                          readObject(row, "advisory", ["title", "detail"]);
                          return {
                              title: readText(row, "title", "title", 4096),
                              detail: readOptionalText(row, "detail", "detail", 4096),
                          };
                      });
            const integrationNotes =
                outcome.integrationNotes === undefined
                    ? undefined
                    : readRows(outcome.integrationNotes, "integrationNotes", (row) => {
                          readObject(row, "note", ["check", "where"]);
                          return {
                              check: readText(row, "check", "check", 4096),
                              where: readOptionalText(row, "where", "where", 4096),
                          };
                      });
            return {
                actionId,
                outcome: {
                    approved: outcome.approved,
                    feedback: readOptionalText(outcome, "feedback", "feedback", 32768),
                    findings,
                    advisories,
                    integrationNotes,
                },
            };
        }),
    );
}
function readRows<Row>(value: AttachedJsonValue, field: string, read: (row: AttachedJsonObject) => Row): Row[] {
    if (!Array.isArray(value)) reject("invalid_input", field, "Must be an array.");
    return value.map((row) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) {
            reject("invalid_input", field, "Each row must be an object.");
        }
        return read(row);
    });
}

for (const name of ["start_validation", "review_diff", "review_complete", "validation_decision"] as const) {
    const descriptor: AttachedOperationDescriptor = {
        name,
        description:
            name === "start_validation"
                ? "Continue shared Core validation or recover an interrupted validation call. Not publication."
                : name === "review_diff"
                  ? "Read the pending reviewer candidate. Only show records coverage; list does not."
                  : name === "review_complete"
                    ? "Submit the fresh reviewer's structured outcome. Core checks coverage and candidate identity."
                    : "Submit the user's answer to the pending Core validation decision.",
        inputSchema: workflowOperationSchema(
            name === "start_validation"
                ? []
                : ["actionId", name === "review_diff" ? "command" : name === "review_complete" ? "approved" : "answer"],
            name === "start_validation"
                ? {}
                : name === "review_diff"
                  ? {
                        actionId: IDENTIFIER_SCHEMA,
                        command: { type: "string", enum: ["list", "show"] },
                        scope: { type: "string", enum: ["full", "repair"] },
                        path: { type: "string" },
                        offsetBytes: { type: "integer", minimum: 0 },
                        maxBytes: { type: "integer", minimum: 0 },
                    }
                  : name === "review_complete"
                    ? {
                          actionId: IDENTIFIER_SCHEMA,
                          approved: { type: "boolean" },
                          feedback: { type: "string" },
                          findings: {
                              type: "array",
                              items: {
                                  type: "object",
                                  additionalProperties: false,
                                  required: ["title"],
                                  properties: {
                                      id: { type: "string", minLength: 1, maxLength: 200 },
                                      title: { type: "string", minLength: 1, maxLength: 4096 },
                                      requirement: { type: "string", minLength: 1, maxLength: 4096 },
                                      evidence: { type: "string", minLength: 1, maxLength: 4096 },
                                      status: { type: "string", enum: ["new", "fix_confirmed", "fix_rejected"] },
                                      resolved: { type: "boolean" },
                                      rejectionReason: { type: "string", minLength: 1, maxLength: 4096 },
                                      origin: { type: "string", enum: ["missed_original", "repair_regression"] },
                                  },
                              },
                          },
                          advisories: {
                              type: "array",
                              items: {
                                  type: "object",
                                  additionalProperties: false,
                                  required: ["title"],
                                  properties: {
                                      title: { type: "string", minLength: 1, maxLength: 4096 },
                                      detail: { type: "string", minLength: 1, maxLength: 4096 },
                                  },
                              },
                          },
                          integrationNotes: {
                              type: "array",
                              items: {
                                  type: "object",
                                  additionalProperties: false,
                                  required: ["check"],
                                  properties: {
                                      check: { type: "string", minLength: 1, maxLength: 4096 },
                                      where: { type: "string", minLength: 1, maxLength: 4096 },
                                  },
                              },
                          },
                      }
                    : {
                          actionId: IDENTIFIER_SCHEMA,
                          answer: {
                              type: "object",
                              additionalProperties: false,
                              required: ["outcome"],
                              properties: {
                                  outcome: { type: "string" },
                                  value: { type: ["string", "boolean"] },
                                  valueLabel: { type: "string" },
                                  message: { type: "string" },
                              },
                          },
                      },
        ),
    };
    ATTACHED_OPERATIONS.push(descriptor);
}
