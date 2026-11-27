import { isPlanId, normalizePlanId } from "@runwield/plan-storage-format";
import { getPlanRevisionForText, injectFrontMatter, parsePlanFrontMatter } from "./format.ts";
import { buildPlanEventUpdates, getPlanLifecycleActionMetadata } from "./lifecycle.ts";

/** Work with a Plan document and its lifecycle rules without opening project storage. */
export const plans = {
    documents: {
        parse: parsePlanFrontMatter,
        create: injectFrontMatter,
        revision: getPlanRevisionForText,
    },
    identity: { parse: normalizePlanId, isValid: isPlanId },
    lifecycle: {
        changesFor: buildPlanEventUpdates,
        actionsFor: getPlanLifecycleActionMetadata,
    },
} as const;

export type Plans = typeof plans;
export type { PlanId } from "@runwield/plan-storage-format";
export type { PlanEvent, PlanEventDetails, PlanLifecycleActionMetadata, PlanStatus } from "./lifecycle.ts";
export type {
    DeliveryEvidence,
    ExecutionMode,
    HumanReviewDecision,
    HumanReviewMode,
    NonGitDeliveryEvidence,
    PlanDocumentMetadata,
    PlanFrontMatter,
    PlanFrontMatterInput,
    PlanFrontMatterWithCustomFields,
    PlanPresentationFields,
    WorktreeDeliveryEvidence,
} from "./document.ts";
export type { ParsedPlanFrontMatter, ParsePlanFrontMatterResult } from "./format.ts";
