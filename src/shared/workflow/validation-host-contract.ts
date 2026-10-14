/** Typed process-independent waits. Outcomes are claims; the engine checks them. */
import type { ReviewCompletePayload } from "./review-outcome.ts";
import type { ReviewDiffScope, ReviewDiffSpan } from "./review-inspection.ts";
import type { ValidationInteractionRequest, ValidationInteractionResponse } from "./validation-ports.ts";
import type { ValidationRecoveryResult } from "./validation-recovery.ts";

export type ValidationHostIdentity = {
    attemptId: string;
    generation: string;
};
export type ValidationReviewerIdentity = ValidationHostIdentity & {
    semanticRound: number;
    reviewMode: "discovery" | "verify";
    correctionCount: number;
    diffHash: string;
};
export type ValidationDecisionIdentity = ValidationHostIdentity & {
    kind: "decision";
    key: string;
};
export type ValidationRepairIdentity = ValidationHostIdentity & {
    repairGeneration: string;
};
export type ValidationHostRequest =
    | {
          kind: "reviewer";
          identity: ValidationReviewerIdentity;
          prompt: string;
          cwd: string;
          reviewMode: "discovery" | "verify";
          requiredScope: ReviewDiffScope;
          fullDiff: string;
          repairDiff: string;
      }
    | {
          kind: "repair";
          identity: ValidationRepairIdentity;
          repairGeneration: string;
          prompt: string;
          cwd: string;
          role: string;
      }
    | { kind: "decision"; identity: ValidationDecisionIdentity; interaction: ValidationInteractionRequest };
export type ValidationHostResume =
    | {
          kind: "reviewer";
          identity: ValidationReviewerIdentity;
          outcome: ReviewCompletePayload | null;
          coverage: ReviewDiffSpan[];
          failure?: import("./validation-operational-errors.ts").ValidationOperationalFailure;
      }
    | { kind: "decision"; identity: ValidationDecisionIdentity; answer: ValidationInteractionResponse }
    | { kind: "task_completed"; identity: ValidationRepairIdentity; report: string };
export type HostTurnValidationResult =
    | { kind: "host_request"; request: ValidationHostRequest }
    | { kind: "awaiting_delivery"; planName: string }
    | { kind: "paused" | "failed"; reason: string; recovery?: ValidationRecoveryResult };
export type ValidationHostTurn = { resume?: ValidationHostResume; consumed?: boolean };

export function sameHostIdentity(
    left: ValidationHostIdentity | ValidationReviewerIdentity | ValidationDecisionIdentity | ValidationRepairIdentity,
    right: ValidationHostIdentity | ValidationReviewerIdentity | ValidationDecisionIdentity | ValidationRepairIdentity,
): boolean {
    const canonical = (value: typeof left) =>
        JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    return canonical(left) === canonical(right);
}

/** A typed suspension, not an operational error. Only the shared attempt owner settles it. */
export class ValidationHostWait extends Error {
    constructor(readonly request: ValidationHostRequest) {
        super("Validation is waiting for the host.");
    }
}
export class ValidationHostRejected extends Error {
    constructor(message = "The supplied outcome does not match the current validation request.") {
        super(message);
    }
}
