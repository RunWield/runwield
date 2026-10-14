/**
 * @module shared/workflow/triage-outcome
 * The one Triage outcome rule shared by the `triage_report` tool, Native routing, and
 * the Attached Workflow Coordinator.
 *
 * Pi-free on purpose: the Attached runtime uses this rule without loading a Session.
 */

import { normalizeRoutingIntent, normalizeWorkKind } from "../../constants.js";
import { sanitizeSessionName } from "../session-name.ts";

export const TRIAGE_COMPLEXITIES = ["LOW", "MEDIUM", "HIGH"] as const;

export type TriageRoutingIntent = NonNullable<ReturnType<typeof normalizeRoutingIntent>>;
export type TriageWorkKind = NonNullable<ReturnType<typeof normalizeWorkKind>>;
export type TriageComplexity = (typeof TRIAGE_COMPLEXITIES)[number];
export type TriageClassification = Extract<TriageRoutingIntent, "PLANNED_CHANGE" | "PROJECT">;

export interface TriageOutcome {
    routingIntent: TriageRoutingIntent;
    classification?: TriageClassification;
    workKind?: TriageWorkKind;
    complexity: TriageComplexity;
    summary: string;
    sessionName?: string;
}

/** Raw Triage fields as a Router, a stored decision, or an External Agent Host supplies them. */
export interface TriageOutcomeInput {
    routingIntent?: string;
    classification?: string;
    workKind?: string;
    complexity?: string;
    summary?: string;
    sessionName?: string;
}

function normalizeTriageComplexity(value: string | undefined): TriageComplexity | null {
    return value === "LOW" || value === "MEDIUM" || value === "HIGH" ? value : null;
}

/**
 * Normalize canonical `routingIntent` and legacy `classification` input into a Triage
 * outcome. Plan Classification is kept only for plan-producing intents, and Work Kind
 * only for PLANNED_CHANGE.
 *
 * Returns null unless a valid Routing Intent, a valid complexity, and a non-empty
 * summary are present.
 */
export function normalizeTriageOutcome(input: TriageOutcomeInput | null | undefined): TriageOutcome | null {
    if (!input) return null;
    const routingIntent = normalizeRoutingIntent(input.routingIntent) || normalizeRoutingIntent(input.classification);
    const complexity = normalizeTriageComplexity(input.complexity);
    if (!routingIntent || !complexity || typeof input.summary !== "string" || !input.summary) return null;

    const outcome: TriageOutcome = { routingIntent, complexity, summary: input.summary };
    const sessionName = sanitizeSessionName(input.sessionName);
    if (sessionName) outcome.sessionName = sessionName;
    if (routingIntent === "PLANNED_CHANGE" || routingIntent === "PROJECT") outcome.classification = routingIntent;
    const workKind = normalizeWorkKind(input.workKind);
    if (workKind && routingIntent === "PLANNED_CHANGE") outcome.workKind = workKind;
    return outcome;
}
