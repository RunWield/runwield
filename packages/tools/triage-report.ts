import { Type, type Static } from "typebox";
import {
    ROUTING_INTENTS,
    WORK_KINDS,
    hasRetiredRoutingIntent,
    normalizeRoutingIntent,
    normalizeWorkKind,
} from "./routing.ts";
import type { RoutingIntent, WorkKind } from "./routing.ts";
import { sanitizeSessionName } from "./set-session-name.ts";

export const TRIAGE_COMPLEXITIES = ["LOW", "MEDIUM", "HIGH"] as const;

export type TriageComplexity = (typeof TRIAGE_COMPLEXITIES)[number];
export type TriageClassification = Extract<RoutingIntent, "PLANNED_CHANGE" | "PROJECT">;

interface TriageSummary {
    complexity: TriageComplexity;
    summary: string;
    sessionName?: string;
}

/** Only planned changes carry a Work Kind. Both Plan-producing routes carry their own classification. */
export type TriageOutcome = TriageSummary &
    (
        | { routingIntent: "PLANNED_CHANGE"; classification: "PLANNED_CHANGE"; workKind?: WorkKind }
        | { routingIntent: "PROJECT"; classification: "PROJECT"; workKind?: never }
        | { routingIntent: Exclude<RoutingIntent, TriageClassification>; classification?: never; workKind?: never }
    );

/** Fields a Router, a stored decision, or an external host can supply. */
export interface TriageOutcomeInput {
    routingIntent?: string;
    classification?: string;
    workKind?: string;
    complexity?: string;
    summary?: string;
    sessionName?: string;
}

export const TRIAGE_REPORT_TOOL = {
    name: "triage_report",
    exposure: "model-only",
    label: "Routing Intent Report",
    description:
        "Submit your Routing Intent for the user's request. " +
        "You MUST call this tool exactly once after enough discovery to route the request. " +
        "Clearly operational or informational requests may need no codebase exploration before routing. " +
        "Do not output the Routing Intent as freeform text — use this tool.",
    parameters: Type.Object({
        routingIntent: Type.Optional(
            Type.Enum([...ROUTING_INTENTS], {
                description:
                    "Canonical Routing Intent. INQUIRY: direct informational answer. IDEATION: explicit brainstorming/research/interview/PRD work. OPERATION: direct non-code repository/environment operation. QUICK_FIX: bounded no-plan code implementation. PLANNED_CHANGE: reviewed executable planned work. PROJECT: architecture/Epic plan. Router calls should provide this field; legacy direct calls may provide classification instead.",
            }),
        ),
        classification: Type.Optional(
            Type.Enum([...ROUTING_INTENTS], {
                description: "Legacy compatibility field. Use routingIntent for new calls.",
            }),
        ),
        complexity: Type.Enum([...TRIAGE_COMPLEXITIES], {
            description: "How complex is this request?",
        }),
        summary: Type.String({
            description: "Brief summary of the request and why it should route there.",
        }),
        sessionName: Type.Optional(
            Type.String({
                description:
                    "Optional short 3-6 word Session Name. If omitted, the Agent can name the Session later via set_session_name.",
            }),
        ),
        workKind: Type.Optional(
            Type.Enum([...WORK_KINDS], {
                description:
                    "Optional Work Kind for PLANNED_CHANGE. BUG_FIX for planned bug fixes, FEATURE for new/enhanced functionality, REFACTOR for structural changes, MAINTENANCE for upkeep, DOCUMENTATION for documentation creation or substantial documentation updates.",
            }),
        ),
    }),
} as const;

export type TriageReportParameters = Static<typeof TRIAGE_REPORT_TOOL.parameters>;

function normalizeTriageComplexity(value: string | undefined): TriageComplexity | null {
    return TRIAGE_COMPLEXITIES.find((complexity) => complexity === value) ?? null;
}

/** Return null when the fields cannot form a valid Triage outcome. */
export function normalizeTriageOutcome(input: TriageOutcomeInput | null | undefined): TriageOutcome | null {
    if (!input || hasRetiredRoutingIntent(input.routingIntent, input.classification)) return null;
    const routingIntent = normalizeRoutingIntent(input.routingIntent) || normalizeRoutingIntent(input.classification);
    const complexity = normalizeTriageComplexity(input.complexity);
    if (!routingIntent || !complexity || typeof input.summary !== "string" || !input.summary) return null;

    const sessionName = sanitizeSessionName(input.sessionName);
    const summary = { complexity, summary: input.summary, ...(sessionName && { sessionName }) };
    if (routingIntent === "PLANNED_CHANGE") {
        const workKind = normalizeWorkKind(input.workKind);
        return { routingIntent, ...summary, classification: routingIntent, ...(workKind && { workKind }) };
    }
    if (routingIntent === "PROJECT") return { routingIntent, ...summary, classification: routingIntent };
    return { routingIntent, ...summary };
}

export function triageReport(input: TriageReportParameters): TriageOutcome {
    const outcome = normalizeTriageOutcome(input);
    if (!outcome) {
        throw new TypeError("triage_report requires a valid canonical routingIntent, complexity, and summary");
    }
    return outcome;
}
