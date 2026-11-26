import type { PairCheckpointParameters } from "./definitions/pair-checkpoint.ts";

export type PairCheckpointAction = "report" | "resolve";
export type PairCheckpointResolutionDecision = NonNullable<PairCheckpointParameters["decision"]>;

export interface PreparedPairCheckpointReport {
    summary: string;
    route?: string;
    state?: string;
    viewport?: string;
    evidence?: string[];
    diagnostics?: string;
    nextIncrement?: string;
    final: boolean;
}

export type PreparedPairCheckpointResolution =
    | { ok: true; checkpointId: string; decision: PairCheckpointResolutionDecision; revisionDirection?: string }
    | { ok: false; reason: "resolution_fields_required"; message: string }
    | { ok: false; reason: "revision_direction_required"; message: string; checkpointId: string };

/** Preserve shorthand calls that omit action and supply a summary. */
export function resolvePairCheckpointAction(params: PairCheckpointParameters): PairCheckpointAction {
    return params.action || (params.summary ? "report" : "resolve");
}

/** Prepare a checkpoint report, returning null when its required summary is blank. */
export function preparePairCheckpointReport(params: PairCheckpointParameters): PreparedPairCheckpointReport | null {
    const summary = params.summary?.trim() || "";
    if (!summary) return null;
    return {
        summary,
        ...(params.route ? { route: params.route } : {}),
        ...(params.state ? { state: params.state } : {}),
        ...(params.viewport ? { viewport: params.viewport } : {}),
        ...(params.evidence ? { evidence: [...params.evidence] } : {}),
        ...(params.diagnostics ? { diagnostics: params.diagnostics } : {}),
        ...(params.nextIncrement ? { nextIncrement: params.nextIncrement } : {}),
        final: params.final === true,
    };
}

/** Validate the fields of a requested resolution before the caller checks the current checkpoint. */
export function preparePairCheckpointResolution(params: PairCheckpointParameters): PreparedPairCheckpointResolution {
    const checkpointId = params.checkpointId?.trim() || "";
    const decision = params.decision;
    if (!checkpointId || !decision) {
        return {
            ok: false,
            reason: "resolution_fields_required",
            message: "pair_checkpoint resolve rejected: checkpointId and decision are required.",
        };
    }
    const revisionDirection = params.revisionDirection?.trim() || "";
    if (decision === "revise" && !revisionDirection) {
        return {
            ok: false,
            reason: "revision_direction_required",
            message: "pair_checkpoint resolve rejected: revisionDirection is required for revise.",
            checkpointId,
        };
    }
    return { ok: true, checkpointId, decision, ...(revisionDirection ? { revisionDirection } : {}) };
}

/** Render the submitted report with the number assigned by the Session. */
export function formatPairCheckpointReport(report: PreparedPairCheckpointReport, checkpointNumber: number): string {
    const lines = [
        `**Pair checkpoint ${checkpointNumber}${report.final ? " — final" : ""}.**`,
        "",
        "**Summary**",
        "",
        report.summary,
    ];
    if (report.route) lines.push("", "**Route**", "", report.route);
    if (report.state) lines.push("", "**State**", "", report.state);
    if (report.viewport) lines.push("", "**Viewport**", "", report.viewport);
    if (report.evidence?.length) {
        lines.push("", "**Evidence**", "", ...report.evidence.map((evidence) => `- ${evidence}`));
    }
    if (report.diagnostics) lines.push("", "**Diagnostics**", "", report.diagnostics);
    if (report.nextIncrement) lines.push("", "**Next increment**", "", report.nextIncrement);
    lines.push("", "Reply normally to ask a question, request a change, continue, stop, or switch to autonomous work.");
    return lines.join("\n");
}
