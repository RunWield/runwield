/**
 * @module shared/workflow/validation-position
 * Same-process validation display projection.
 *
 * This module is not a continuation authority. Workflow recovery reads the durable
 * Plan validation checkpoint and current Plan state. A value stored here can help a
 * live Session show where validation is, but it must never choose a restart phase,
 * skip Mechanical Validation, or override a checkpoint.
 */

import type { HostedSession } from "../session/hosted-session.ts";

/** The phase currently shown for a live validation run. */
export type ValidationPhaseName = "mechanical" | "semantic" | "delivery";

export type ValidationPosition = {
    phase: ValidationPhaseName;
    /** Presentation-only note for UI code that wants to show a semantic repair wait. */
    awaiting?: "semantic_repair" | null;
};

/**
 * Positions per session, per Plan.
 *
 * Keyed weakly on the session: this is per-run state and must not keep a finished
 * session alive. Keyed by Plan name inside, because a Project drives several Plans
 * through the same session and one child's position is not another's.
 */
const POSITIONS = new WeakMap<object, Map<string, ValidationPosition>>();

export function rememberValidationPosition(
    hostedSession: HostedSession | undefined,
    planName: string,
    position: ValidationPosition,
): void {
    if (!hostedSession || !planName) return;
    const byPlan = POSITIONS.get(hostedSession) || new Map<string, ValidationPosition>();
    byPlan.set(planName, position);
    POSITIONS.set(hostedSession, byPlan);
}

export function getValidationPosition(
    hostedSession: HostedSession | undefined,
    planName: string,
): ValidationPosition | undefined {
    if (!hostedSession || !planName) return undefined;
    return POSITIONS.get(hostedSession)?.get(planName);
}

/**
 * Forget a Plan's position.
 *
 * Called when a run reaches a terminal outcome. Leaving a stale position behind
 * would make the next live UI projection show the middle of the last run.
 */
export function clearValidationPosition(
    hostedSession: HostedSession | undefined,
    planName: string,
): void {
    if (!hostedSession || !planName) return;
    POSITIONS.get(hostedSession)?.delete(planName);
}
