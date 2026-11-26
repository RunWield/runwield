import type { Static, TSchema } from "typebox";
import { memoryDefinition } from "./definitions/mnemoteca.ts";
import { checkMemoryDeleteScope, prepareMemory } from "./memory.ts";
import { MAX_CODE_BATCH_OUTPUT_CHARS, reportCodeBatch, validateCodeBatchParams } from "./code-batch.ts";
import { limitWebFetchText, limitWebSearchText, MAX_WEB_FETCH_CHARS } from "./web-text.ts";
import {
    webSearchDefinition,
    webFetchDefinition,
    webCodeSearchDefinition,
    webDocsSearchDefinition,
} from "./definitions/ketch.ts";
import {
    codeSearchDefinition,
    codeStructureDefinition,
    codeImplsDefinition,
    codeImportersDefinition,
    codeShowDefinition,
    codeOutlineDefinition,
    codeBatchDefinition,
    codeRefsDefinition,
    codeImpactDefinition,
    codeTraceDefinition,
    codeInvestigateDefinition,
    MAX_CODE_BATCH_OPERATIONS,
} from "./definitions/cymbal.ts";
import { artifactWrittenDefinition } from "./definitions/artifact-written.ts";
import { createImageDefinition } from "./definitions/create-image.ts";
import { editDocsDefinition, writeDocsDefinition } from "./definitions/docs-file-tools.ts";
import { initVerificationCommandDefinition } from "./definitions/init-verification-command.ts";
import { manualQaCompletedDefinition } from "./definitions/manual-qa-completed.ts";
import { pairCheckpointDefinition } from "./definitions/pair-checkpoint.ts";
import { planDeviationDefinition } from "./definitions/plan-deviation.ts";
import { planWrittenDefinition } from "./definitions/plan-written.ts";
import { qaChecklistGeneratedDefinition } from "./definitions/qa-checklist-generated.ts";
import { reviewDiffDefinition } from "./definitions/review-diff.ts";
import {
    assertSlicerConfirmation,
    slicerFinalizeDecompositionDefinition,
} from "./definitions/slicer-finalize-decomposition.ts";
import { reviewCompleteDefinition } from "./definitions/review-complete.ts";
import { seeImageDefinition } from "./definitions/see-image.ts";
import { userInterviewDefinition } from "./definitions/user-interview.ts";
import { workRecordCompletedDefinition } from "./definitions/work-record-completed.ts";
import { workRecordReadDefinition } from "./definitions/work-record-read.ts";
import { workRecordSearchDefinition } from "./definitions/work-record-search.ts";
import { multiFileEditDefinition } from "./definitions/multi-file-edit.ts";
import { backgroundTaskDefinition } from "./definitions/background-task.ts";
import { sanitizeSessionName, SET_SESSION_NAME_TOOL } from "./set-session-name.ts";
import { normalizeTriageOutcome, triageReport, TRIAGE_COMPLEXITIES, TRIAGE_REPORT_TOOL } from "./triage-report.ts";
import {
    hasRetiredRoutingIntent,
    normalizeRoutingIntent,
    normalizeWorkKind,
    ROUTING_INTENTS,
    WORK_KINDS,
} from "./routing.ts";
import {
    createTaskCompletedDefinition,
    ENGINEER_MESSAGE_DESCRIPTION,
    IMPLEMENTATION_REPORT_MIN_LENGTH,
    normalizeImplementationReport,
} from "./task-completed.ts";
import { createDelegateAgentDefinition, DELEGATION_MODES, prepareDelegation } from "./delegate-agent.ts";
import {
    applyExactTextEdits,
    diffEditedText,
    groupEditsByPath,
    prepareMultiFileEditArguments,
} from "./multi-file-edit.ts";
import {
    INTERVIEW_OTHER_VALUE,
    formatInterviewResult,
    interviewChoiceOptions,
    prepareInterview,
    prepareInterviewChoiceAnswer,
    prepareInterviewOtherAnswer,
    prepareInterviewTextAnswer,
} from "./user-interview.ts";
import { assertArtifactKindPath, resolveArtifactTitle } from "./artifact-written.ts";
import { prepareBackgroundTask } from "./background-task.ts";
import { prepareSingleEditArguments, validateEditDocsPath, validateWriteDocsPath } from "./docs-file-tools.ts";
import { INIT_VERIFICATION_COMMAND_PLACEHOLDER, prepareProjectCommands } from "./init-verification-command.ts";
import { prepareManualQaChecklist } from "./manual-qa-completed.ts";
import {
    formatPairCheckpointReport,
    preparePairCheckpointReport,
    preparePairCheckpointResolution,
    resolvePairCheckpointAction,
} from "./pair-checkpoint.ts";
import { preparePlanDeviation } from "./plan-deviation.ts";
import { collectExecutionPolicyOverrides, normalizeSubmittedPlanName } from "./plan-written.ts";
import { prepareReviewCompletion } from "./review-complete.ts";
import { resolveImageQuestion } from "./see-image.ts";
import { validateWorkRecordSections } from "./work-record-completed.ts";

interface NamedTool {
    readonly name: string;
}

function fixedTool<Definition extends NamedTool>(definition: Definition) {
    const name: Definition["name"] = definition.name;
    return { name, definition } as const;
}

function freezeDescriptor<Value>(value: Value): Readonly<Value> {
    if ((typeof value === "object" && value !== null) || typeof value === "function") {
        if (Object.isFrozen(value)) return value;
        Object.freeze(value);
        for (const key of Reflect.ownKeys(value)) {
            const property = Object.getOwnPropertyDescriptor(value, key);
            if (property && "value" in property) freezeDescriptor(property.value);
        }
    }
    return value;
}

// Preserve the order in which bundled extensions contribute to the system prompt.
const extensionEntries = {
    [memoryDefinition.name]: {
        ...fixedTool(memoryDefinition),
        /** Validate the fields required by the selected action and resolve its defaults. */
        prepare: prepareMemory,
        /** Return the reason deletion must stop, or null when only the requested scope contains the ID. */
        checkDeleteScope: checkMemoryDeleteScope,
    },
    [codeSearchDefinition.name]: fixedTool(codeSearchDefinition),
    [codeShowDefinition.name]: fixedTool(codeShowDefinition),
    [codeOutlineDefinition.name]: fixedTool(codeOutlineDefinition),
    [codeBatchDefinition.name]: {
        ...fixedTool(codeBatchDefinition),
        /** Maximum operations accepted per batch. */
        maxOperations: MAX_CODE_BATCH_OPERATIONS,
        /** Maximum characters in the complete batch report. */
        maxOutputChars: MAX_CODE_BATCH_OUTPUT_CHARS,
        /** Return the first invalid input message, or null for an accepted batch. */
        validate: validateCodeBatchParams,
        /** Build a report from one to five read results in request order. */
        report: reportCodeBatch,
    },
    [codeRefsDefinition.name]: fixedTool(codeRefsDefinition),
    [codeImpactDefinition.name]: fixedTool(codeImpactDefinition),
    [codeTraceDefinition.name]: fixedTool(codeTraceDefinition),
    [codeInvestigateDefinition.name]: fixedTool(codeInvestigateDefinition),
    [codeStructureDefinition.name]: fixedTool(codeStructureDefinition),
    [codeImplsDefinition.name]: fixedTool(codeImplsDefinition),
    [codeImportersDefinition.name]: fixedTool(codeImportersDefinition),
    [webSearchDefinition.name]: {
        ...fixedTool(webSearchDefinition),
        /** Limit combined search results that include fetched page text. */
        limitText: limitWebSearchText,
    },
    [webFetchDefinition.name]: {
        ...fixedTool(webFetchDefinition),
        /** Default character limit before any truncation notice. */
        maxOutputChars: MAX_WEB_FETCH_CHARS,
        /** Limit fetched text and report whether it was truncated. */
        limitText: limitWebFetchText,
    },
    [webCodeSearchDefinition.name]: fixedTool(webCodeSearchDefinition),
    [webDocsSearchDefinition.name]: fixedTool(webDocsSearchDefinition),
} as const;

const entries = freezeDescriptor({
    [artifactWrittenDefinition.name]: {
        ...fixedTool(artifactWrittenDefinition),
        /** Check the kind-specific directory after the caller resolves the real project-relative path. */
        assertKindPath: assertArtifactKindPath,
        /** Use the supplied title, the first top-level Markdown heading, or the artifact filename. */
        resolveTitle: resolveArtifactTitle,
    },
    [createImageDefinition.name]: fixedTool(createImageDefinition),
    [editDocsDefinition.name]: {
        ...fixedTool(editDocsDefinition),
        /** Accept legacy arguments before the caller validates the single-replacement schema. */
        prepareArguments: prepareSingleEditArguments,
        /** Return the edit tool's validation message for an invalid Markdown target. */
        validatePath: validateEditDocsPath,
    },
    [initVerificationCommandDefinition.name]: {
        ...fixedTool(initVerificationCommandDefinition),
        /** Trim the supplied commands and preserve omissions so the caller can write only the requested settings. */
        prepare: prepareProjectCommands,
        placeholder: INIT_VERIFICATION_COMMAND_PLACEHOLDER,
    },
    [manualQaCompletedDefinition.name]: {
        ...fixedTool(manualQaCompletedDefinition),
        /** Trim the submitted checklist, returning null when it contains only whitespace. */
        prepareChecklist: prepareManualQaChecklist,
    },
    [pairCheckpointDefinition.name]: {
        ...fixedTool(pairCheckpointDefinition),
        /** Preserve shorthand calls that omit action and supply a summary. */
        resolveAction: resolvePairCheckpointAction,
        /** Prepare a checkpoint report, returning null when its required summary is blank. */
        prepareReport: preparePairCheckpointReport,
        /** Validate the fields of a requested resolution before the caller checks the current checkpoint. */
        prepareResolution: preparePairCheckpointResolution,
        /** Render the submitted report with the number assigned by the Session. */
        formatReport: formatPairCheckpointReport,
    },
    [planDeviationDefinition.name]: {
        ...fixedTool(planDeviationDefinition),
        /** Trim the confirmation text, dropping an omitted or blank reason. */
        prepare: preparePlanDeviation,
    },
    [planWrittenDefinition.name]: {
        ...fixedTool(planWrittenDefinition),
        /** Accept a filename or docs/plans path before the Plan store checks the canonical name. */
        normalizeName: normalizeSubmittedPlanName,
        /** Collect only the policy values explicitly supplied. Existing Plan fields can survive an omission. */
        executionPolicyOverrides: collectExecutionPolicyOverrides,
    },
    [qaChecklistGeneratedDefinition.name]: fixedTool(qaChecklistGeneratedDefinition),
    [reviewCompleteDefinition.name]: {
        ...fixedTool(reviewCompleteDefinition),
        /** Validate and normalize a submitted semantic review. */
        prepare: prepareReviewCompletion,
    },
    [reviewDiffDefinition.name]: fixedTool(reviewDiffDefinition),
    [slicerFinalizeDecompositionDefinition.name]: {
        ...fixedTool(slicerFinalizeDecompositionDefinition),
        /** Require the user's confirmation text before the host finalizes the decomposition. */
        assertConfirmation: assertSlicerConfirmation,
    },
    [seeImageDefinition.name]: {
        ...fixedTool(seeImageDefinition),
        /** Resolve the text to submit to the configured vision model. */
        resolveQuestion: resolveImageQuestion,
    },
    [userInterviewDefinition.name]: {
        ...fixedTool(userInterviewDefinition),
        /** Validate the whole batch before the host opens its first interaction. */
        prepare: prepareInterview,
        /** Build the choice list for a validated yes/no or multiple-choice question. */
        choiceOptions: interviewChoiceOptions,
        /** Convert a host’s selected choice into the corresponding typed answer. */
        prepareChoiceAnswer: prepareInterviewChoiceAnswer,
        /** Normalize the free text supplied for an Other selection. */
        prepareOtherAnswer: prepareInterviewOtherAnswer,
        /** Normalize a text answer according to the validated question’s empty-answer policy. */
        prepareTextAnswer: prepareInterviewTextAnswer,
        /** Render the interview result and its JSON payload without an interaction host. */
        formatResult: formatInterviewResult,
        otherValue: INTERVIEW_OTHER_VALUE,
    },
    [workRecordCompletedDefinition.name]: {
        ...fixedTool(workRecordCompletedDefinition),
        /** Validate the required text without modifying the submitted sections. */
        validateSections: validateWorkRecordSections,
    },
    [workRecordReadDefinition.name]: fixedTool(workRecordReadDefinition),
    [workRecordSearchDefinition.name]: fixedTool(workRecordSearchDefinition),
    [writeDocsDefinition.name]: {
        ...fixedTool(writeDocsDefinition),
        /** Return the write tool's validation message for an invalid Markdown target. */
        validatePath: validateWriteDocsPath,
    },
    [multiFileEditDefinition.name]: {
        ...fixedTool(multiFileEditDefinition),
        /** Accept legacy single edits and path aliases before the caller validates the current schema. */
        prepareArguments: prepareMultiFileEditArguments,
        /** Group edits by the supplied path in submission order. Path resolution is the caller’s responsibility. */
        groupByPath: groupEditsByPath,
        /** Apply a file's edits atomically in memory, retaining its BOM and original line endings. */
        apply: applyExactTextEdits,
        /** Compare the original and edited text and locate the first changed line. */
        diff: diffEditedText,
    },
    [backgroundTaskDefinition.name]: {
        ...fixedTool(backgroundTaskDefinition),
        /** Validate the fields for the selected action and convert a start timeout to milliseconds. */
        prepare: prepareBackgroundTask,
    },
    ...extensionEntries,
    [TRIAGE_REPORT_TOOL.name]: {
        ...fixedTool(TRIAGE_REPORT_TOOL),
        /** Validate the routing fields and return a JSON triage report. */
        report: triageReport,
        /** Read an external triage result and return null when its routing fields are invalid. */
        normalizeOutcome: normalizeTriageOutcome,
        routingIntents: ROUTING_INTENTS,
        workKinds: WORK_KINDS,
        complexities: TRIAGE_COMPLEXITIES,
        /** Resolve a supported routing intent from an external value. */
        normalizeRoutingIntent,
        /** Resolve a supported work kind from an external value. */
        normalizeWorkKind,
        /** Check whether the input uses a retired routing intent. */
        hasRetiredRoutingIntent,
    },
    [SET_SESSION_NAME_TOOL.name]: {
        ...fixedTool(SET_SESSION_NAME_TOOL),
        /** Trim and normalize a proposed Session name. */
        sanitize: sanitizeSessionName,
    },
    task_completed: {
        name: "task_completed",
        /** Build the completion schema for the selected report kind. */
        define: createTaskCompletedDefinition,
        /** Normalize the submitted implementation report. */
        normalizeReport: normalizeImplementationReport,
        implementationReportMinLength: IMPLEMENTATION_REPORT_MIN_LENGTH,
        engineerMessageDescription: ENGINEER_MESSAGE_DESCRIPTION,
    },
    delegate_agent: {
        name: "delegate_agent",
        /** Build the tool schema from the host's permitted modes and registered roles. */
        define: createDelegateAgentDefinition,
        modes: DELEGATION_MODES,
        /** Validate the requested delegation before the caller applies its role and authority rules. */
        prepare: prepareDelegation,
    },
} as const);

/** A name declared by RunWield’s built-in and bundled extension tools. */
export type ToolName = keyof typeof entries;
/** The definition and operations for a registered tool. */
export type ToolEntry<Name extends ToolName = ToolName> = (typeof entries)[Name];
/** A bundled extension tool name, independent of the host that executes it. */
export type ExtensionToolName = keyof typeof extensionEntries;

type EntryParameters<Entry extends ToolEntry> = Entry extends {
    readonly definition: { readonly parameters: infer Schema extends TSchema };
}
    ? Static<Schema>
    : Entry extends { readonly define: (...args: infer _Args) => { readonly parameters: infer Schema extends TSchema } }
      ? Static<Schema>
      : never;

/** The model input inferred from the registered tool schema. */
export type ToolParameters<Name extends ToolName> = EntryParameters<ToolEntry<Name>>;

interface ListTools {
    (group: "extension"): readonly ExtensionToolName[];
    (): readonly ToolName[];
}

/** The RunWield tool catalog and operations over supplied values. */
export interface ToolRegistry {
    /** List all registrations, or request bundled extension names in system-prompt order. */
    readonly list: ListTools;
    /** Check whether an external name is registered and narrow its type for lookup. */
    readonly has: (name: string) => name is ToolName;
    /** Read the typed entry, including its definition or context-dependent definition builder. */
    readonly get: <Name extends ToolName>(name: Name) => ToolEntry<Name>;
}

const names = Object.freeze(Object.keys(entries) as ToolName[]);
const extensionNames = Object.freeze(Object.keys(extensionEntries) as ExtensionToolName[]);

function list(group: "extension"): readonly ExtensionToolName[];
function list(): readonly ToolName[];
function list(group?: "extension"): readonly ToolName[] {
    return group === "extension" ? extensionNames : names;
}

function has(name: string): name is ToolName {
    return Object.hasOwn(entries, name);
}

function get<Name extends ToolName>(name: Name): ToolEntry<Name> {
    if (!has(name)) throw new RangeError(`Unregistered tool: ${name}`);
    return entries[name];
}

export const toolRegistry: ToolRegistry = freezeDescriptor({ list, has, get });
