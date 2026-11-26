export type HostDeliveryMode = "publication" | "in_place";
/** Typed process-independent waits. Outcomes are claims; the engine checks them. */
import type { ReviewCompletePayload } from "../../src/shared/workflow/review-outcome.ts";
import type { ReviewDiffScope, ReviewDiffSpan } from "../../src/shared/workflow/review-inspection.ts";
import type {
    PendingHostDecision,
    PendingHostRecorder,
    PendingHostRepair,
    ValidationDecisionIdentity,
    ValidationHostIdentity,
    ValidationInteractionResponse,
    ValidationRepairIdentity,
} from "@runwield/plans/controller-state";
import type { ValidationRecoveryResult } from "../../src/shared/workflow/validation-recovery.ts";

export type ValidationReviewerIdentity = ValidationHostIdentity & {
    semanticRound: number;
    reviewMode: "discovery" | "verify";
    correctionCount: number;
    diffHash: string;
};
/** Describes the review, repair, decision, or recording work validation needs from the host. */
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
    | PendingHostRepair
    | PendingHostDecision
    | PendingHostRecorder;
/** Pairs a host response with the request identity that validation must check before continuing. */
export type ValidationHostResume =
    | {
          kind: "reviewer";
          identity: ValidationReviewerIdentity;
          outcome: ReviewCompletePayload | null;
          coverage: ReviewDiffSpan[];
          failure?: import("../../src/shared/workflow/validation-operational-errors.ts").ValidationOperationalFailure;
      }
    | { kind: "decision"; identity: ValidationDecisionIdentity; answer: ValidationInteractionResponse }
    | { kind: "task_completed"; identity: ValidationRepairIdentity; report: string }
    | { kind: "recorder"; identity: ValidationHostIdentity; sections: string };
/** Reports the next host request or the outcome of this validation turn. */
export type HostTurnValidationResult =
    | { kind: "host_request"; request: ValidationHostRequest }
    | {
          kind: "verified";
          planName: string;
          completionMode?: HostDeliveryMode;
          workRecord?: import("@runwield/plans").PlanFrontMatter["workRecord"];
      }
    | { kind: "paused" | "failed"; reason: string; recovery?: ValidationRecoveryResult };
export type ValidationHostTurn = { resume?: ValidationHostResume; consumed?: boolean; signal?: AbortSignal };

/** Check that both host requests carry the same identity fields and values. */
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

/** Host shutdown leaves the canonical validation checkpoint resumable. */
export class ValidationHostShutdown extends Error {
    constructor() {
        super("The validation host stopped.");
    }
}
