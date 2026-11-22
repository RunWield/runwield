import type { Static, TSchema } from "typebox";
import { memoryDefinition } from "./definitions/mnemoteca.ts";
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
import { slicerFinalizeDecompositionDefinition } from "./definitions/slicer-finalize-decomposition.ts";
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
import { createDelegateAgentDefinition, DELEGATION_MODES } from "./delegate-agent.ts";
import { applyExactTextEdits, diffEditedText } from "./multi-file-edit.ts";
import { INTERVIEW_OTHER_VALUE, prepareInterview } from "./user-interview.ts";

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
    [memoryDefinition.name]: fixedTool(memoryDefinition),
    [codeSearchDefinition.name]: fixedTool(codeSearchDefinition),
    [codeShowDefinition.name]: fixedTool(codeShowDefinition),
    [codeOutlineDefinition.name]: fixedTool(codeOutlineDefinition),
    [codeBatchDefinition.name]: {
        ...fixedTool(codeBatchDefinition),
        maxOperations: MAX_CODE_BATCH_OPERATIONS,
    },
    [codeRefsDefinition.name]: fixedTool(codeRefsDefinition),
    [codeImpactDefinition.name]: fixedTool(codeImpactDefinition),
    [codeTraceDefinition.name]: fixedTool(codeTraceDefinition),
    [codeInvestigateDefinition.name]: fixedTool(codeInvestigateDefinition),
    [codeStructureDefinition.name]: fixedTool(codeStructureDefinition),
    [codeImplsDefinition.name]: fixedTool(codeImplsDefinition),
    [codeImportersDefinition.name]: fixedTool(codeImportersDefinition),
    [webSearchDefinition.name]: fixedTool(webSearchDefinition),
    [webFetchDefinition.name]: fixedTool(webFetchDefinition),
    [webCodeSearchDefinition.name]: fixedTool(webCodeSearchDefinition),
    [webDocsSearchDefinition.name]: fixedTool(webDocsSearchDefinition),
} as const;

const entries = freezeDescriptor({
    [artifactWrittenDefinition.name]: fixedTool(artifactWrittenDefinition),
    [createImageDefinition.name]: fixedTool(createImageDefinition),
    [editDocsDefinition.name]: fixedTool(editDocsDefinition),
    [initVerificationCommandDefinition.name]: fixedTool(initVerificationCommandDefinition),
    [manualQaCompletedDefinition.name]: fixedTool(manualQaCompletedDefinition),
    [pairCheckpointDefinition.name]: fixedTool(pairCheckpointDefinition),
    [planDeviationDefinition.name]: fixedTool(planDeviationDefinition),
    [planWrittenDefinition.name]: fixedTool(planWrittenDefinition),
    [qaChecklistGeneratedDefinition.name]: fixedTool(qaChecklistGeneratedDefinition),
    [reviewCompleteDefinition.name]: fixedTool(reviewCompleteDefinition),
    [reviewDiffDefinition.name]: fixedTool(reviewDiffDefinition),
    [slicerFinalizeDecompositionDefinition.name]: fixedTool(slicerFinalizeDecompositionDefinition),
    [seeImageDefinition.name]: fixedTool(seeImageDefinition),
    [userInterviewDefinition.name]: {
        ...fixedTool(userInterviewDefinition),
        prepare: prepareInterview,
        otherValue: INTERVIEW_OTHER_VALUE,
    },
    [workRecordCompletedDefinition.name]: fixedTool(workRecordCompletedDefinition),
    [workRecordReadDefinition.name]: fixedTool(workRecordReadDefinition),
    [workRecordSearchDefinition.name]: fixedTool(workRecordSearchDefinition),
    [writeDocsDefinition.name]: fixedTool(writeDocsDefinition),
    [multiFileEditDefinition.name]: {
        ...fixedTool(multiFileEditDefinition),
        apply: applyExactTextEdits,
        diff: diffEditedText,
    },
    [backgroundTaskDefinition.name]: fixedTool(backgroundTaskDefinition),
    ...extensionEntries,
    [TRIAGE_REPORT_TOOL.name]: {
        ...fixedTool(TRIAGE_REPORT_TOOL),
        report: triageReport,
        normalizeOutcome: normalizeTriageOutcome,
        routingIntents: ROUTING_INTENTS,
        workKinds: WORK_KINDS,
        complexities: TRIAGE_COMPLEXITIES,
        normalizeRoutingIntent,
        normalizeWorkKind,
        hasRetiredRoutingIntent,
    },
    [SET_SESSION_NAME_TOOL.name]: {
        ...fixedTool(SET_SESSION_NAME_TOOL),
        sanitize: sanitizeSessionName,
    },
    task_completed: {
        name: "task_completed",
        define: createTaskCompletedDefinition,
        normalizeReport: normalizeImplementationReport,
        implementationReportMinLength: IMPLEMENTATION_REPORT_MIN_LENGTH,
        engineerMessageDescription: ENGINEER_MESSAGE_DESCRIPTION,
    },
    delegate_agent: {
        name: "delegate_agent",
        define: createDelegateAgentDefinition,
        modes: DELEGATION_MODES,
    },
} as const);

export type ToolName = keyof typeof entries;
export type ToolEntry<Name extends ToolName = ToolName> = (typeof entries)[Name];
export type ExtensionToolName = keyof typeof extensionEntries;

type EntryParameters<Entry extends ToolEntry> = Entry extends {
    readonly definition: { readonly parameters: infer Schema extends TSchema };
}
    ? Static<Schema>
    : Entry extends { readonly define: (...args: infer _Args) => { readonly parameters: infer Schema extends TSchema } }
      ? Static<Schema>
      : never;

export type ToolParameters<Name extends ToolName> = EntryParameters<ToolEntry<Name>>;

interface ListTools {
    (group: "extension"): readonly ExtensionToolName[];
    (): readonly ToolName[];
}

export interface ToolRegistry {
    readonly list: ListTools;
    readonly has: (name: string) => name is ToolName;
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
