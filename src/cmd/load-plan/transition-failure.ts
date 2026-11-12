/**
 * @module cmd/load-plan/transition-failure
 * Turning a refused lifecycle transition into something the user can act on.
 */

import { CLI_BIN } from "../../constants.js";
import type { TransitionResult } from "../../plan-store/index.ts";

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
    const blocked =
        transition.status === "blocked"
            ? "\nA previous Plan update stopped before RunWield could prove the result. " +
              `Run \`${CLI_BIN} plans doctor --repair\` to repair safe records.`
            : "";
    return new Error(
        `${transition.message || fallbackMessage}${blocked}${recovery ? `\nRecovery options:\n${recovery}` : ""}`,
    );
}
