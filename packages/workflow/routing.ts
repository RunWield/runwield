import { createAgentRegistry } from "@runwield/agents";
import { toolRegistry, type RoutingIntent, type TriageOutcome, type TriageOutcomeInput } from "@runwield/tools";

const { normalizeOutcome: normalizeTriageOutcome } = toolRegistry.get("triage_report");
const { primary: agents } = createAgentRegistry().ids;

const interactiveRoutes = {
    INQUIRY: { kind: "conversation", agentName: agents.GUIDE },
    IDEATION: { kind: "conversation", agentName: agents.IDEATOR },
    OPERATION: { kind: "operation", agentName: agents.OPERATOR },
    QUICK_FIX: { kind: "quick_fix", agentName: agents.ENGINEER },
    PLANNED_CHANGE: { kind: "planning", agentName: agents.PLANNER },
    PROJECT: { kind: "planning", agentName: agents.ARCHITECT },
} as const satisfies Record<RoutingIntent, TriageRoute>;

interface TriageRoute {
    kind: "conversation" | "operation" | "quick_fix" | "planning";
    agentName: string;
}

export type InteractiveTriageDecision = (typeof interactiveRoutes)[RoutingIntent] & { report: TriageOutcome };

export type AttachedTriageDecision = { report: TriageOutcome } & (
    | {
          kind: "role_handoff";
          agentName: typeof agents.GUIDE | typeof agents.IDEATOR;
          routingIntent: "INQUIRY" | "IDEATION";
      }
    | { kind: "planning"; agentName: typeof agents.PLANNER }
    | { kind: "unsupported_in_preview" }
);

export function routeInteractiveTriage(input: TriageOutcomeInput): InteractiveTriageDecision | null {
    const report = normalizeTriageOutcome(input);
    return report ? { ...interactiveRoutes[report.routingIntent], report } : null;
}

export function routeAttachedTriage(input: TriageOutcomeInput): AttachedTriageDecision | null {
    const report = normalizeTriageOutcome(input);
    if (!report) return null;

    const { routingIntent } = report;
    if (routingIntent === "INQUIRY" || routingIntent === "IDEATION") {
        return { kind: "role_handoff", agentName: interactiveRoutes[routingIntent].agentName, routingIntent, report };
    }
    if (routingIntent === "PLANNED_CHANGE") {
        return { ...interactiveRoutes[routingIntent], report };
    }
    return { kind: "unsupported_in_preview", report };
}
