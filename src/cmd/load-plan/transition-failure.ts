/**
 * @module cmd/load-plan/transition-failure
 * Turning a refused lifecycle transition into something the user can act on.
 */

import type { TransitionResult } from "../../shared/workflow/state-transition.ts";

/**
 * Turn a non-committed transition into an error that tells the user what to do
 * next. The transaction layer returns typed recovery recipes precisely so an
 * interrupted lifecycle operation is never a dead end; dropping them here would
 * leave the user with a bare failure and no route forward.
 */
export function transitionFailureError(transition: TransitionResult, fallbackMessage: string): Error {
    const recovery = (transition.recoveryActions || [])
        .map((action) => {
            const detail = action.command ? `${action.description} (${action.command})` : action.description;
            return `  - ${action.label}: ${detail}`;
        })
        .join("\n");
    return new Error(`${transition.message || fallbackMessage}${recovery ? `\nRecovery options:\n${recovery}` : ""}`);
}
