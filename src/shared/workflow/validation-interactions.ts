/**
 * @module shared/workflow/validation-interactions
 * User interactions for the session-independent engine.
 *
 * `requestInteraction` is the engine's thin window onto the port's interaction
 * method; `pauseForUserAction` is the standard pause the loop offers whenever it
 * runs out of moves.
 */

import { type ValidationInteractionRequest, ValidationInteractionTypes } from "./validation-ports.ts";
import type { ValidationInteractionResponse } from "./validation-ports.ts";
import type { UserActionChoice, UserActionPause, ValidationLoopArgs } from "./validation-types.ts";
import { emitStatus } from "./validation-emit.ts";
import { buildValidationUserMessage } from "./validation-user-messages.ts";

import { sameHostIdentity, ValidationHostRejected, ValidationHostWait } from "./validation-host-contract.ts";
import { saveHostCheckpoint } from "./validation-host-state.ts";

export async function requestInteraction(
    args: ValidationLoopArgs,
    request: ValidationInteractionRequest,
): Promise<ValidationInteractionResponse> {
    if (!args.hostTurn) return await args.session.requestInteraction(request);
    const checkpoint = args.validationCheckpoint!;
    const bytes = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify([request, checkpoint.pendingCiDecision, checkpoint.generation])),
    );
    const key = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
    // Answers replay by logical prompt; request identities belong to one durable wait.
    // A repeated CI failure can show the same prompt, but must not accept an old Retry.
    const pending = checkpoint.pendingHostDecision;
    const sequence = (checkpoint.hostDecisionSequence || 0) + 1;
    const identity = pending?.identity.key.startsWith(`${key}:`)
        ? pending.identity
        : {
              attemptId: checkpoint.attemptId,
              generation: checkpoint.generation,
              kind: "decision" as const,
              key: `${key}:${sequence}`,
          };
    const resume = args.hostTurn.resume;
    const accepted = checkpoint.hostDecisionChoices?.[key];
    if (
        accepted &&
        (resume?.kind !== "decision" || !sameHostIdentity(identity, resume.identity) || args.hostTurn.consumed)
    )
        return accepted;
    if (resume?.kind === "decision" && !args.hostTurn.consumed) {
        if (!sameHostIdentity(identity, resume.identity)) throw new ValidationHostRejected();
        const answer = resume.answer;
        if (
            request.type === "select" &&
            (answer.outcome !== "selected" || !request.options?.some((option) => option.value === answer.value))
        )
            throw new ValidationHostRejected("Invalid decision option.");
        if (
            request.type === "text" &&
            (answer.outcome !== "text" ||
                typeof answer.value !== "string" ||
                (!request.allowEmpty && !answer.value.trim()))
        )
            throw new ValidationHostRejected("Invalid text answer.");
        args.hostTurn.consumed = true;
        await saveHostCheckpoint(args, {
            // Stop pauses this call, not every future call for the same round.
            hostDecisionChoices:
                answer.outcome === "selected" && answer.value === "stop"
                    ? checkpoint.hostDecisionChoices
                    : { ...checkpoint.hostDecisionChoices, [key]: answer },
            pendingHostDecision: undefined,
        });
        return answer;
    }
    if (accepted) return accepted;
    const hostRequest = { kind: "decision" as const, identity, interaction: request };
    await saveHostCheckpoint(args, {
        pendingHostDecision: hostRequest,
        hostDecisionSequence: identity === pending?.identity ? checkpoint.hostDecisionSequence : sequence,
    });
    throw new ValidationHostWait(hostRequest);
}

/**
 * Pause for a decision only the user can make, and offer exactly two ways out.
 *
 * RunWield does not halt. When it runs out of moves it says what happened in plain
 * words, says what the user should do, and waits — Retry runs the same thing again,
 * Stop leaves the work at its last safe point. A failed Retry lands right back here
 * with the same two choices, so there is never a dead end.
 *
 * A session that cannot prompt (headless, scripted, cancelled) reads as Stop, which
 * is the safe answer: it never loops unattended and never guesses on the user's
 * behalf.
 */
export async function pauseForUserAction(args: ValidationLoopArgs, pause: UserActionPause): Promise<UserActionChoice> {
    const message = buildValidationUserMessage({
        kind: "user_action",
        whatHappened: pause.whatHappened,
        doThis: pause.doThis,
        details: pause.details,
    });
    const options = pause.options || [
        { value: "retry" as const, label: "Retry" },
        { value: "stop" as const, label: "Stop" },
    ];
    emitStatus(args, message, "warning");
    const response = await requestInteraction(args, {
        type: ValidationInteractionTypes.SELECT,
        prompt: message,
        options,
    });
    const selectedValue =
        response.outcome === "selected" && typeof response.value === "string"
            ? options.find((option) => option.value === response.value)?.value
            : undefined;
    return selectedValue || "stop";
}
