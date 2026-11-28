import { plans } from "@runwield/plans";
import { isEpicArtifactName } from "@runwield/plans/format";
import { validateWorkRecordCreation } from "@runwield/plans/work-record-files";
import {
    PROJECT_STORE_MAX_BYTES,
    sameProjectStoreBinding,
    validateProjectStoreBinding,
    type ProjectStoreBinding,
} from "@runwield/plans/project-store-wire";
import {
    isPlanMilestone,
    isPlanMilestoneVersion,
    type PackageDocuments,
    type PlanHistory,
} from "@runwield/plans/history";
import type { ProjectStoreCommand, ProjectStoreReply } from "../../plan-store/index.ts";
// Six bytes per UTF-16 code unit covers JSON escaping in the response envelope.
export const HISTORY_PAGE_CHARS = 128 * 1024;
export const PROJECT_STORE_PLAN_REVISION_HEADER = "X-RunWield-Plan-Revision";
export interface ProjectStoreRequest {
    binding: ProjectStoreBinding;
    command: ProjectStoreCommand;
}
const identity = (value: string | undefined) =>
    typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
function fields(value: ProjectStoreRequest, allowed: string[]) {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== [...allowed].sort().join(",")
    )
        throw new Error("Unsupported request fields.");
}
export function validateProjectStoreRequest(request: ProjectStoreRequest): void {
    fields(request, ["binding", "command"]);
    validateProjectStoreBinding(request.binding);
    const command = request.command;
    if (!command) throw new Error("Invalid Plan identity.");
    if ("planId" in command) {
        const durablePlanId =
            command.kind === "list-history" ||
            command.kind === "show-history" ||
            command.kind === "restore-history" ||
            command.kind === "revise-plan" ||
            command.kind === "plan-resource" ||
            command.kind === "read-documents" ||
            command.kind === "collaboration" ||
            command.kind === "save-epic-artifact" ||
            command.kind === "append-epic-qa";
        const valid = durablePlanId ? plans.identity.isValid(command.planId) : identity(command.planId);
        if (!valid) throw new Error("Invalid Plan identity.");
    }
    const common = ["kind", "planId", "operationId", "expectedRevision"];
    const historyTarget = "planId" in command ? "planId" : "reference";
    const recordingReference = "reference" in command && command.reference !== undefined ? ["reference"] : [];
    const commandFields = {
        "preview-retention": ["kind", "offset", "snapshot"],
        "settle-prune-copies": ["kind", "target", "token"],
        "confirm-retention": ["kind", "target", "token"],
        "inspect-owner": ["kind"],
        "repair-owner": ["kind", "operationId"],
        "import-plans": [
            "kind",
            "operationId",
            "selection",
            ...(command.kind === "import-plans" && "includeArchived" in command ? ["includeArchived"] : []),
        ],
        "read-import-result": ["kind", "operationId"],
        "read-retained-family-controller": ["kind", "executionPlanId", "attemptId", "member"],
        "checkpoint-retained-family-controller": [
            "kind",
            "operationId",
            "executionPlanId",
            "attemptId",
            "member",
            "updates",
            "options",
        ],
        "lifecycle-decision": [...common, "decision"],
        "recover-execution": [
            ...common,
            "attemptId",
            "action",
            "controllerRevision",
            ...(command.kind === "recover-execution" && command.action === "recreate" ? ["replacementAttemptId"] : []),
        ],
        "reopen-review": [...common, "attemptId"],
        "unshare-preview": ["kind", "options"],
        collaboration: [
            "kind",
            "operationId",
            "intent",
            ...(command.kind === "collaboration" && "planId" in command ? ["planId"] : []),
        ],
        "read-collaboration-result": ["kind", "operationId"],
        "inspect-share-identity": ["kind", "operationId"],
        "save-epic-artifact": [...common, "resource", "body"],
        "append-epic-qa": [...common, "childPlanId", "childRevision", "childHeading", "checklistMarkdown"],
        "epic-projection": [...common, "childPlanId", "childRevision", "projection", "notes"],
        "record-deviation": [...common, "proposal"],
        "sequence-snapshot": ["kind", "planId"],
        "prepare-sequence": [...common, "inputs"],
        "sequence-decision": [...common, "documents", "decision"],
        "read-sequence-result": ["kind", "planId", "operationId"],
        "author-children": [...common, "children", "options", "finalize"],
        "read-children-result": ["kind", "planId", "operationId"],
        "read-execution": ["kind", "planId"],
        "check-publication-owner": ["kind", "planId", "claim"],
        "read-publication": ["kind", "planId", "reference"],
        "settle-publication": [...common, "reference"],
        "settle-in-place": [...common, "attemptId"],
        "read-execution-documents": ["kind", "planId", "input"],
        "create-plan": ["kind", "operationId", "input"],
        "revise-plan": [...common, "input"],
        "author-plan": ["kind", "operationId", "planId", "input"],
        "resolve-plan": ["kind", "reference"],
        "list-plans": ["kind"],
        "list-plan-documents": ["kind"],
        "settle-retained-record": [...common, "attemptId"],
        "read-retained-recording": ["kind", "reference", "pendingPublication"],
        "prepare-retained-record": [...common, "attemptId", "pendingPublication", "sections"],
        "settle-retained-abandonment": [...common, "attemptId"],
        "settle-retained-cleanup": [...common, "attemptId"],
        "checkpoint-retained-execution": [...common, "attemptId", "updates", "options"],
        "read-retained-execution": ["kind", "reference", "attemptId"],
        "archive-catalog": ["kind"],
        "list-history": ["kind", historyTarget, "offset", "snapshot"],
        "show-history": ["kind", historyTarget, "version", "offset", "snapshot"],
        "restore-history": [...common, "version"],
        "read-archive": ["kind", "reference"],
        "archive-plan": [...common, "reason", "force", "now"],
        "restore-plan": [...common],
        "rename-plan": [...common, "name"],
        "plan-resource-catalog": ["kind"],
        "plan-resource": ["kind", "planId"],
        "review-presentation": ["kind", "planId"],
        "capture-review": ["kind", "planId", "expectedRevision"],
        "record-human-review": [...common, "metadata"],
        "save-epic-review": [...common, "review"],
        "review-decision": [
            ...common,
            "input",
            "decision",
            "classification",
            "workKind",
            "sourceStatus",
            "sourceMarkdown",
            "controllerRevision",
        ],
        "create-project-work-record": ["kind", "operationId", "input"],
        "record-catalog": ["kind"],
        "record-query": ["kind", "query", "limit", "accessMode"],
        read: ["kind", "planId", "resource"],
        "read-documents": ["kind", "planId", "resource"],
        "read-collaboration": ["kind", "planId"],
        "read-record": ["kind", "planId", "recordId"],
        "verify-recording-delivery": ["kind", "planId", "reference"],
        "read-recording-context": ["kind", "planId", "automatic", "pendingPublication"],
        "read-delivery-sources": ["kind", "planId", "reference", "confirmed"],
        "reserve-recording": [...common, "attemptId", ...recordingReference],
        "prepare-record": [...common, "attemptId", "sections", ...recordingReference],
        "search-records": ["kind", "planId", "query", "limit"],
        "save-record": [...common, "title", "summary"],
        "reconcile-record-index": [...common, "recordId"],
        "read-frozen": ["kind", "planId", "resource", "snapshotId", "snapshotDigest", "attemptId"],
        "seal-publication": [
            ...common,
            "attemptId",
            "validatedCommit",
            "targetBranch",
            ...("preparation" in command ? ["preparation"] : []),
        ],
        "freeze-publication-policy": [...common, "attemptId", "policy"],
        "reserve-execution": [...common, "reservation"],
        reconcile: ["kind", "planId", "operationId"],
        "save-document": [...common, "resource", "body"],
        "edit-documents": [...common, "edits"],
        "save-prose": [...common, "body"],
        "save-definition": [...common, "changes"],
        "record-event": [...common, "event"],
        "execution-checkpoint": [...common, "attemptId", "checkpoint"],
    };
    const exact = Object.hasOwn(commandFields, command.kind) ? commandFields[command.kind] : [];
    if (!exact.length || Object.keys(command).sort().join(",") !== exact.sort().join(","))
        throw new Error("Unsupported store operation or fields.");
    if (
        command.kind === "collaboration" &&
        command.planId !== undefined &&
        (command.intent?.action !== "share" ||
            !command.intent.options ||
            (command.intent.options.planId !== undefined && command.intent.options.planId !== command.planId))
    )
        throw new Error("Invalid managed Plan sharing intent.");
    if (
        (command.kind === "resolve-plan" ||
            command.kind === "read-archive" ||
            ((command.kind === "list-history" || command.kind === "show-history") && !("planId" in command)) ||
            command.kind === "read-retained-execution") &&
        (typeof command.reference !== "string" || !command.reference || command.reference.length > 1024)
    )
        throw new Error("Invalid Plan reference.");
    if (command.kind === "create-plan" || command.kind === "revise-plan" || command.kind === "author-plan") {
        const { input } = command;
        const allowed = ["contextMarkdown", "validationMarkdown", "definition", "parentPlan", "dependencies"];
        if (command.kind !== "revise-plan") allowed.push("planName");
        if (command.kind === "author-plan") allowed.push("expectedRevision");
        if (
            !input ||
            typeof input !== "object" ||
            Array.isArray(input) ||
            Object.keys(input).some((key) => !allowed.includes(key)) ||
            (command.kind !== "revise-plan" &&
                (typeof command.input.planName !== "string" || !command.input.planName)) ||
            typeof input.contextMarkdown !== "string" ||
            (command.kind === "author-plan" &&
                command.input.expectedRevision !== undefined &&
                (typeof command.input.expectedRevision !== "string" ||
                    !/^[a-f0-9]{64}$/.test(command.input.expectedRevision)))
        )
            throw new Error("Invalid Plan authoring input.");
    }
    if (
        command.kind === "import-plans" &&
        (typeof command.selection !== "string" ||
            !command.selection.startsWith("/") ||
            command.selection.length > 4096 ||
            ("includeArchived" in command && command.includeArchived !== true))
    )
        throw new Error("Invalid import selection.");
    if (
        (command.kind === "show-history" || command.kind === "restore-history") &&
        !isPlanMilestoneVersion(command.version)
    )
        throw new Error("Invalid history version.");
    if (
        (command.kind === "list-history" || command.kind === "show-history" || command.kind === "preview-retention") &&
        (!Number.isSafeInteger(command.offset) ||
            command.offset < 0 ||
            (command.offset === 0 ? command.snapshot !== "" : !/^[a-f0-9]{64}$/.test(command.snapshot)))
    )
        throw new Error("Invalid history cursor.");
    if (
        (command.kind === "confirm-retention" || command.kind === "settle-prune-copies") &&
        (!["plans", "records"].includes(command.target) || !/^[a-f0-9]{64}$/.test(command.token))
    )
        throw new Error("Invalid prune confirmation.");
    if (
        "operationId" in command &&
        (typeof command.operationId !== "string" || !/^[a-f0-9-]{36}$/.test(command.operationId))
    )
        throw new Error("Invalid operation identity.");
    if (
        "expectedRevision" in command &&
        (typeof command.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(command.expectedRevision))
    )
        throw new Error("Expected revision is required.");
    if (
        "resource" in command &&
        !["context.md", "validation.md", "manual-qa.md", "integration-report.md"].includes(command.resource)
    )
        throw new Error("Unsupported document resource.");
    if (
        command.kind === "save-epic-artifact" &&
        (!isEpicArtifactName(command.resource) || typeof command.body !== "string")
    )
        throw new Error("Invalid Epic artifact.");
    if (
        command.kind === "append-epic-qa" &&
        (!plans.identity.isValid(command.childPlanId) ||
            command.childPlanId === command.planId ||
            !/^[a-f0-9]{64}$/.test(command.childRevision) ||
            typeof command.childHeading !== "string" ||
            typeof command.checklistMarkdown !== "string")
    )
        throw new Error("Invalid Epic QA section.");
    if (
        command.kind === "archive-plan" &&
        (typeof command.reason !== "string" ||
            typeof command.force !== "boolean" ||
            typeof command.now !== "string" ||
            (command.now !== "" && !Number.isFinite(Date.parse(command.now))))
    )
        throw new Error("Invalid archive request.");
    if (
        command.kind === "rename-plan" &&
        (typeof command.name !== "string" || !command.name || command.name.length > 1024)
    )
        throw new Error("Invalid Plan name.");
    if (
        command.kind === "review-decision" &&
        (typeof command.sourceStatus !== "string" ||
            typeof command.sourceMarkdown !== "string" ||
            (command.controllerRevision !== null && !Number.isSafeInteger(command.controllerRevision)) ||
            !command.input ||
            !Array.isArray(command.input.inputs) ||
            typeof command.input.definitionHash !== "string" ||
            !command.decision ||
            typeof command.decision !== "object" ||
            Array.isArray(command.decision))
    )
        throw new Error("Invalid review decision.");
    if (command.kind === "create-project-work-record") validateWorkRecordCreation(command.input);
    if (command.kind === "record-query" && !["current", "all"].includes(command.accessMode))
        throw new Error("Invalid record access mode.");
    if ("recordId" in command && !identity(command.recordId)) throw new Error("Invalid record identity.");
    if (
        (command.kind === "search-records" || command.kind === "record-query") &&
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
            (!(command.validatedCommit === "" && command.targetBranch === "") &&
                !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(command.validatedCommit)) ||
            typeof command.targetBranch !== "string" ||
            command.targetBranch.length > 255 ||
            command.targetBranch.includes(".."))
    )
        throw new Error("Invalid publication input.");
    if (
        command.kind === "recover-execution" &&
        command.action === "recreate" &&
        (command.attemptId === null ||
            !identity(command.attemptId) ||
            !identity(command.replacementAttemptId) ||
            command.replacementAttemptId === command.attemptId)
    )
        throw new Error("Invalid recovery replacement identity.");
    if (command.kind === "settle-in-place" && !identity(command.attemptId))
        throw new Error("Invalid in-place execution identity.");
    if (
        command.kind === "freeze-publication-policy" &&
        (!identity(command.attemptId) ||
            !command.policy ||
            Object.keys(command.policy).sort().join(",") !== "autoGenerateRecords,plans,workRecords" ||
            [command.policy.plans, command.policy.workRecords, command.policy.autoGenerateRecords].some(
                (value) => typeof value !== "boolean",
            ))
    )
        throw new Error("Invalid execution publication policy.");
    if (
        command.kind === "reserve-execution" &&
        (!command.reservation ||
            typeof command.reservation !== "object" ||
            Array.isArray(command.reservation) ||
            Object.keys(command.reservation).some(
                (key) => !["targetBranch", "suggestedAttemptId", "executionMode"].includes(key),
            ) ||
            (command.reservation.targetBranch !== undefined && typeof command.reservation.targetBranch !== "string") ||
            (command.reservation.suggestedAttemptId !== undefined &&
                !identity(command.reservation.suggestedAttemptId)) ||
            (command.reservation.executionMode !== undefined &&
                command.reservation.executionMode !== "non_git_in_place"))
    )
        throw new Error("Invalid execution reservation.");
    if (command.kind === "execution-checkpoint") {
        if (
            !identity(command.attemptId) ||
            !command.checkpoint ||
            ![
                "validation_checkpoint_saved",
                "execution_started",
                "execution_failed",
                "implementation_finished",
                "mechanical_validation_failed",
                "mechanical_validation_passed",
                "semantic_review_feedback",
                "semantic_review_passed",
                "validation_passed",
                "validation_failed",
            ].includes(command.checkpoint.event) ||
            !command.checkpoint.details ||
            typeof command.checkpoint.details !== "object" ||
            Array.isArray(command.checkpoint.details)
        )
            throw new Error("Invalid execution checkpoint.");
        const allowed = [
            "failureReason",
            "executionReport",
            "executionBaselineTree",
            "validationCiAttempts",
            "validationSemanticRounds",
            "mechanicalFailureKind",
            "validationCheckpoint",
            "humanReviewMode",
            "humanReviewDecision",
            "humanReviewedAt",
        ];
        if (
            Object.keys(command.checkpoint).some((key) => !["event", "details"].includes(key)) ||
            Object.keys(command.checkpoint.details).some((key) => !allowed.includes(key))
        )
            throw new Error("Unsupported execution checkpoint field.");
    }
    if (
        command.kind === "seal-publication" &&
        command.preparation !== undefined &&
        typeof command.preparation !== "boolean"
    )
        throw new Error("Invalid publication stage.");
    if (
        command.kind === "read-recording-context" &&
        (typeof command.automatic !== "boolean" || typeof command.pendingPublication !== "boolean")
    )
        throw new Error("Invalid recording context request.");
    if (command.kind === "read-delivery-sources" && typeof command.confirmed !== "boolean")
        throw new Error("Invalid recording source request.");
    if ((command.kind === "reserve-recording" || command.kind === "prepare-record") && !identity(command.attemptId))
        throw new Error("Invalid recording attempt.");
    if (
        command.kind === "prepare-record" &&
        (!command.sections ||
            typeof command.sections.title !== "string" ||
            typeof command.sections.summary !== "string")
    )
        throw new Error("Invalid Recorder sections.");
    if (
        command.kind === "read-publication" ||
        command.kind === "settle-publication" ||
        command.kind === "read-delivery-sources" ||
        command.kind === "verify-recording-delivery" ||
        ((command.kind === "reserve-recording" || command.kind === "prepare-record") && command.reference !== undefined)
    ) {
        const ref = command.reference;
        if (
            !ref ||
            ref.kind !== "package" ||
            (command.kind !== "reserve-recording" &&
                command.kind !== "prepare-record" &&
                ref.planId !== command.planId) ||
            !identity(ref.planId) ||
            ref.projectId !== request.binding.projectId ||
            ref.repositoryId !== request.binding.repositoryId ||
            !identity(ref.attemptId) ||
            !identity(ref.inputId) ||
            !/^[a-f0-9]{64}$/.test(ref.digest) ||
            typeof ref.personalOwner !== "string"
        )
            throw new Error("Invalid publication reference.");
    }
    if (
        command.kind === "edit-documents" &&
        (!Array.isArray(command.edits) ||
            !command.edits.length ||
            command.edits.some(
                (edit) =>
                    !edit ||
                    Object.keys(edit).sort().join(",") !== "body,expectedRevision,planId,resource" ||
                    !identity(edit.planId) ||
                    !["context.md", "validation.md", "manual-qa.md", "integration-report.md"].includes(edit.resource) ||
                    typeof edit.body !== "string" ||
                    !/^[a-f0-9]{64}$/.test(edit.expectedRevision),
            ) ||
            command.planId !== command.edits[0]?.planId ||
            command.expectedRevision !== command.edits[0]?.expectedRevision)
    )
        throw new Error("Invalid document edit batch.");
    if ("body" in command && typeof command.body !== "string") throw new Error("Invalid document body.");
    if (
        command.kind === "record-event" &&
        ![
            "review_approved",
            "review_feedback",
            "hold_reset_to_draft",
            "readiness_passed",
            "epic_readiness_passed",
        ].includes(command.event)
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
export function validateProjectStoreReply(reply: ProjectStoreReply, request: ProjectStoreRequest): void {
    validateProjectStoreBinding(reply.binding);
    if (!sameProjectStoreBinding(reply.binding, request.binding)) throw new Error("Reply owner mismatch.");
    if (Object.keys(reply).sort().join(",") !== "binding,result") throw new Error("Unsupported reply fields.");
    const result = reply.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid store reply.");
    let allowed =
        "recording" in result
            ? ["recording"]
            : "sources" in result
              ? ["sources"]
              : "documentView" in result
                ? ["documentView"]
                : "manifest" in result
                  ? ["manifest"]
                  : "execution" in result
                    ? ["execution"]
                    : "documents" in result
                      ? ["documents"]
                      : "plan" in result
                        ? ["plan"]
                        : "plans" in result
                          ? ["plans"]
                          : "records" in result
                            ? ["records"]
                            : "spaceId" in result
                              ? ["planId", "spaceId", "latestRevision"]
                              : "resource" in result
                                ? ["planId", "resource", "revision", "body", "writable"]
                                : [
                                      "operationId",
                                      "status",
                                      "revision",
                                      "qaStatus",
                                      "snapshotId",
                                      "snapshotDigest",
                                      "attemptId",
                                      "recordId",
                                      "planId",
                                  ];
    if ("ownerDiagnostics" in result) allowed = ["ownerDiagnostics"];
    if ("importResult" in result) allowed = ["importResult"];
    if ("familyController" in result) allowed = ["familyController"];
    if ("unsharePreview" in result) allowed = ["unsharePreview"];
    if ("collaborationResult" in result) allowed = ["collaborationResult"];
    if ("sharePlanId" in result) allowed = ["sharePlanId", "shareEffectStarted"];
    if ("sequenceDocuments" in result) allowed = ["sequenceDocuments"];
    if ("sequenceResult" in result) allowed = ["sequenceResult"];
    if ("children" in result) allowed = ["children"];
    if ("retainedRecording" in result) allowed = ["retainedRecording"];
    if ("retainedExecution" in result) allowed = ["retainedExecution"];
    if ("retentionPage" in result) allowed = ["retentionPage"];
    if ("pruneResult" in result) allowed = ["pruneResult"];
    if ("historyPage" in result) allowed = ["historyPage"];
    if ("archives" in result) allowed = ["archives"];
    if ("archived" in result) allowed = ["archived"];
    if ("resourceCatalog" in result) allowed = ["resourceCatalog"];
    if ("planResource" in result) allowed = ["planResource"];
    if ("presentation" in result) allowed = ["presentation"];
    if ("reviewInput" in result) allowed = ["reviewInput"];
    if ("createdRecord" in result) allowed = ["operationId", "createdRecord"];
    if ("recordResources" in result) allowed = ["recordResources"];
    if ("recordSearch" in result) allowed = ["recordSearch"];
    if (Object.keys(result).some((key) => !allowed.includes(key))) throw new Error("Unsupported reply result fields.");
    if (request.command.kind === "confirm-retention" || request.command.kind === "settle-prune-copies") {
        if (
            !("pruneResult" in result) ||
            typeof result.pruneResult.deleted !== "boolean" ||
            !Array.isArray(result.pruneResult.copies)
        )
            throw new Error("Invalid prune result.");
    } else if (request.command.kind === "inspect-owner") {
        if (!("ownerDiagnostics" in result) || !Array.isArray(result.ownerDiagnostics))
            throw new Error("Invalid owner diagnostics.");
    } else if (request.command.kind === "read-import-result") {
        if (!("importResult" in result) || !Array.isArray(result.importResult.planIds))
            throw new Error("Invalid import result.");
    } else if (request.command.kind === "read-retained-family-controller") {
        if (
            !("familyController" in result) ||
            (result.familyController &&
                (result.familyController.planName !== request.command.member.planName ||
                    (request.command.member.planId &&
                        result.familyController.planId !== request.command.member.planId)))
        )
            throw new Error("Invalid retained family controller.");
    } else if (request.command.kind === "unshare-preview") {
        if (
            !("unsharePreview" in result) ||
            typeof result.unsharePreview.message !== "string" ||
            !/^[a-f0-9]{64}$/.test(result.unsharePreview.confirmation)
        )
            throw new Error("Invalid unshare confirmation.");
    } else if (request.command.kind === "read-collaboration-result") {
        if (
            !("collaborationResult" in result) ||
            !["share", "share-gone", "push", "pull", "unshare"].includes(result.collaborationResult.action) ||
            (result.collaborationResult.action === "share-gone" &&
                !plans.identity.isValid(result.collaborationResult.value?.planId))
        )
            throw new Error("Invalid collaboration result.");
    } else if (request.command.kind === "inspect-share-identity") {
        if (
            !("sharePlanId" in result) ||
            (result.sharePlanId !== null && !plans.identity.isValid(result.sharePlanId)) ||
            typeof result.shareEffectStarted !== "boolean"
        )
            throw new Error("Invalid retained share identity.");
    } else if (request.command.kind === "sequence-snapshot") {
        if (!("sequenceDocuments" in result) || !Array.isArray(result.sequenceDocuments))
            throw new Error("Invalid Sequence snapshot.");
    } else if (request.command.kind === "read-sequence-result") {
        if (!("sequenceResult" in result) || typeof result.sequenceResult.approved !== "boolean")
            throw new Error("Invalid Sequence result.");
    } else if (request.command.kind === "read-children-result") {
        if (!("children" in result) || !Array.isArray(result.children))
            throw new Error("Invalid child authoring result.");
    } else if (request.command.kind === "read-retained-recording") {
        if (
            !("retainedRecording" in result) ||
            (result.retainedRecording && result.retainedRecording.execution.projectId !== request.binding.projectId)
        )
            throw new Error("Invalid retained recording reply.");
    } else if (request.command.kind === "read-retained-execution") {
        if (
            !("retainedExecution" in result) ||
            (result.retainedExecution !== null &&
                (result.retainedExecution.projectId !== request.binding.projectId ||
                    result.retainedExecution.repositoryId !== request.binding.repositoryId ||
                    typeof result.retainedExecution.planId !== "string" ||
                    (request.command.attemptId && result.retainedExecution.attempt.id !== request.command.attemptId)))
        )
            throw new Error("Invalid retained execution reply.");
    } else if (
        request.command.kind === "list-history" ||
        request.command.kind === "show-history" ||
        request.command.kind === "preview-retention"
    ) {
        const page =
            request.command.kind === "preview-retention"
                ? "retentionPage" in result && result.retentionPage
                : "historyPage" in result && result.historyPage;
        if (
            !page ||
            typeof page.text !== "string" ||
            !page.text.length ||
            page.text.length > HISTORY_PAGE_CHARS ||
            typeof page.complete !== "boolean" ||
            (!page.complete && page.text.length !== HISTORY_PAGE_CHARS) ||
            !/^[a-f0-9]{64}$/.test(page.snapshot) ||
            (request.command.offset > 0 && page.snapshot !== request.command.snapshot)
        )
            throw new Error("Invalid Plan history page.");
    } else if (request.command.kind === "archive-catalog") {
        if (!("archives" in result) || !Array.isArray(result.archives)) throw new Error("Invalid archive catalog.");
    } else if (request.command.kind === "read-archive") {
        if (!("archived" in result) || (result.archived !== null && typeof result.archived.markdown !== "string"))
            throw new Error("Invalid archived Plan.");
    } else if (request.command.kind === "plan-resource-catalog") {
        if (
            !("resourceCatalog" in result) ||
            !Array.isArray(result.resourceCatalog.resources) ||
            !Array.isArray(result.resourceCatalog.diagnostics)
        )
            throw new Error("Invalid Plan resource catalog.");
    } else if (request.command.kind === "plan-resource") {
        if (
            !("planResource" in result) ||
            result.planResource.planId !== request.command.planId ||
            typeof result.planResource.markdown !== "string"
        )
            throw new Error("Invalid Plan resource reply.");
    } else if (request.command.kind === "review-presentation") {
        if (
            !("presentation" in result) ||
            result.presentation.planId !== request.command.planId ||
            typeof result.presentation.plan !== "string"
        )
            throw new Error("Invalid review presentation reply.");
    } else if (request.command.kind === "capture-review") {
        if (
            !("reviewInput" in result) ||
            !Array.isArray(result.reviewInput.inputs) ||
            !/^[a-f0-9]{64}$/.test(result.reviewInput.definitionHash)
        )
            throw new Error("Invalid retained review input.");
    } else if (request.command.kind === "create-project-work-record") {
        if (
            !("createdRecord" in result) ||
            result.operationId !== request.command.operationId ||
            !result.createdRecord ||
            Object.keys(result.createdRecord).sort().join(",") !== "markdown,relativePath" ||
            typeof result.createdRecord.markdown !== "string" ||
            typeof result.createdRecord.relativePath !== "string" ||
            !/^work-records\/[^/\\]+\.md$/.test(result.createdRecord.relativePath)
        )
            throw new Error("Invalid created Work Record reply.");
    } else if (request.command.kind === "record-catalog") {
        if (
            !("recordResources" in result) ||
            !Array.isArray(result.recordResources) ||
            result.recordResources.some(
                (record) =>
                    !identity(record.attrs?.recordId) ||
                    typeof record.markdown !== "string" ||
                    typeof record.path !== "string",
            )
        )
            throw new Error("Invalid record catalog reply.");
    } else if (request.command.kind === "record-query") {
        if (
            !("recordSearch" in result) ||
            result.recordSearch.query !== request.command.query.trim() ||
            result.recordSearch.accessMode !== request.command.accessMode ||
            !Array.isArray(result.recordSearch.records)
        )
            throw new Error("Invalid record search reply.");
    } else if (request.command.kind === "read-recording-context") {
        if (!("recording" in result)) throw new Error("Invalid recording context reply.");
    } else if (request.command.kind === "read-delivery-sources") {
        if (!("sources" in result) || result.sources.delivered.planId !== request.command.planId)
            throw new Error("Invalid recording source reply.");
    } else if (request.command.kind === "read-documents") {
        if (
            !("documentView" in result) ||
            result.documentView.planId !== request.command.planId ||
            result.documentView.resource !== request.command.resource ||
            typeof result.documentView.body !== "string" ||
            !Array.isArray(result.documentView.documents)
        )
            throw new Error("Invalid Plan document reply.");
    } else if (request.command.kind === "read-publication" || request.command.kind === "verify-recording-delivery") {
        if (
            !("manifest" in result) ||
            result.manifest.planId !== request.command.planId ||
            result.manifest.inputId !== request.command.reference.inputId ||
            !Array.isArray(result.manifest.copies)
        )
            throw new Error("Invalid publication manifest reply.");
    } else if (request.command.kind === "read-execution") {
        if (
            !("execution" in result) ||
            (result.execution !== null &&
                (!identity(result.execution.attemptId) || !Array.isArray(result.execution.input?.inputs)))
        )
            throw new Error("Invalid execution context reply.");
    } else if (request.command.kind === "read-execution-documents") {
        if (
            !("documents" in result) ||
            typeof result.documents.planBody !== "string" ||
            typeof result.documents.approvedMarkdown !== "string"
        )
            throw new Error("Invalid execution documents reply.");
    } else if (request.command.kind === "resolve-plan" || request.command.kind === "check-publication-owner") {
        if (
            !("plan" in result) ||
            (result.plan !== null &&
                (!identity(result.plan.attrs.planId!) ||
                    typeof result.plan.body !== "string" ||
                    !/^[a-f0-9]{64}$/.test(result.plan.revision || "")))
        )
            throw new Error("Invalid resolved Plan reply.");
    } else if (request.command.kind === "list-plans" || request.command.kind === "list-plan-documents") {
        if (
            !("plans" in result) ||
            !Array.isArray(result.plans) ||
            result.plans.some((plan) => typeof plan.name !== "string" || !identity(plan.attrs.planId!))
        )
            throw new Error("Invalid Plan catalog reply.");
    } else if (request.command.kind === "read-collaboration") {
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
        request.command.kind === "create-plan" ||
        request.command.kind === "revise-plan" ||
        request.command.kind === "author-plan"
    ) {
        if (
            !("status" in result) ||
            Object.keys(result).sort().join(",") !== "operationId,planId,revision,status" ||
            result.operationId !== request.command.operationId ||
            result.status !== "completed" ||
            !plans.identity.isValid(result.planId) ||
            ("planId" in request.command && result.planId !== request.command.planId) ||
            typeof result.revision !== "string" ||
            !/^[a-f0-9]{64}$/.test(result.revision)
        )
            throw new Error("Invalid Plan authoring reply.");
    } else if (
        !("status" in result) ||
        result.operationId !== request.command.operationId ||
        !["completed", "unstarted", "pending", "unavailable"].includes(result.status) ||
        (result.qaStatus !== undefined &&
            (result.status !== "completed" ||
                !["append-epic-qa", "reconcile"].includes(request.command.kind) ||
                !["recorded", "already_present"].includes(result.qaStatus))) ||
        (result.status === "completed" && !/^[a-f0-9]{64}$/.test(result.revision || ""))
    )
        throw new Error("Invalid operation reply.");
}

export function parseHistoryList(text: string, expectedPlanId?: string) {
    const history: PlanHistory = JSON.parse(text);
    if (
        !history ||
        !plans.identity.isValid(history.planId) ||
        (expectedPlanId !== undefined && history.planId !== expectedPlanId) ||
        !/^[a-f0-9]{64}$/.test(history.revision) ||
        !Array.isArray(history.milestones) ||
        !history.milestones.every(isPlanMilestone)
    )
        throw new Error("Invalid Plan history reply.");
    return history;
}

export function parseMilestoneDocuments(text: string) {
    const documents: PackageDocuments = JSON.parse(text);
    if (
        !documents ||
        typeof documents?.["context.md"] !== "string" ||
        typeof documents["validation.md"] !== "string" ||
        Object.entries(documents).some(
            ([name, value]) =>
                !["context.md", "validation.md", "manual-qa.md", "integration-report.md"].includes(name) ||
                typeof value !== "string",
        )
    )
        throw new Error("Invalid milestone documents reply.");
    return documents;
}
