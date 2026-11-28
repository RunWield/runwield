import { plans, type PlanId } from "@runwield/plans";
import { normalizePlanServerUrl } from "@runwield/plans/format";
import { managedPersonalStoreActive } from "@runwield/plans/managed-project-connection";
import type { OpenPlanSharingOptions, PlanSharing } from "@runwield/plans/sharing";
import { PlanNotFoundError, type ProjectPlanStoreOptions } from "@runwield/plans/store";
import { projects, type ProjectId } from "@runwield/projects";
import { CLI_BIN, getCwd } from "../../constants.ts";
import { prepareWorktreeRegistry } from "../../shared/worktree-registry.ts";
import { admitManagedPlanCheckout, shareManagedPlan } from "../managed.ts";
import { bindProjectPlanStore, checkoutPlanIdentity } from "../project-binding.ts";
import { ensurePlanIdentity, listPlans } from "../queries.ts";
import { collaborationPlanLocation, prepareCollaborationPlan } from "./operations.ts";
import { sharePreparedPlan, type PlanSharePreferences, type SharedPlanReviewLink } from "./share.ts";

type LegacySharePreferences = Pick<PlanSharePreferences, "planServer" | "projectSecrets" | "allowExisting">;

export interface SharePlanForReviewOptions extends LegacySharePreferences {
    target: string;
    cwd?: string;
}

export type PlanShareIntent =
    | (LegacySharePreferences & { target: string; planId?: never })
    | { target?: never; planId: PlanId; planServer: string };

/** Open sharing against an admitted Project and the selected Plan Server. */
export function openPlanSharing({ projectId, serverUrl }: OpenPlanSharingOptions): PlanSharing {
    const planServer = normalizePlanServerUrl(serverUrl);
    const share = bindPlanSharing(projectId);
    return {
        async share(planId) {
            if (!plans.identity.isValid(planId)) throw new Error("Plan sharing requires a durable Plan ID.");
            const result = await share({ planId, planServer });
            if (result.planId !== planId) throw new Error("The Plan owner returned a different Plan.");
            const { planName, serverUrl, spaceId, revision, expiresAt, reviewerUrl, maintainerUrl } = result;
            return {
                planName,
                planId,
                serverUrl,
                spaceId,
                revision,
                expiresAt,
                ...(reviewerUrl ? { links: { reviewerUrl, maintainerUrl: maintainerUrl || undefined } } : {}),
            };
        },
    };
}

function bindPlanSharing(projectId: ProjectId, checkout?: ProjectPlanStoreOptions) {
    const run = bindProjectPlanStore(projectId, checkout ?? {});
    return (intent: PlanShareIntent) =>
        run(
            (cwd) =>
                managedPersonalStoreActive() ? shareManagedPlan(cwd, intent) : executeOwnedPlanShare(cwd, intent),
            checkout ? "retained" : "write",
        );
}

/** Translate the existing CLI's checkout and Plan reference at the Project boundary. */
export async function sharePlanForReview({
    cwd = getCwd(),
    ...intent
}: SharePlanForReviewOptions): Promise<SharedPlanReviewLink> {
    if (managedPersonalStoreActive()) await admitManagedPlanCheckout(cwd);
    else if (!projects.home.current()) await prepareWorktreeRegistry(cwd);
    const admitted = checkoutPlanIdentity(cwd);
    if (!admitted) throw new Error("Plan sharing requires an admitted Project.");
    return await bindPlanSharing(admitted.projectId, { admitted })(intent);
}

/** Resolve the active Plan under the bound personal owner before opening a connection. */
export async function executeOwnedPlanShare(
    cwd: string,
    intent: PlanShareIntent,
    expectedPlanId?: PlanId,
): Promise<SharedPlanReviewLink> {
    const { planId, target, ...preferences } = intent;
    const project = checkoutPlanIdentity(cwd);
    if (!project) throw new Error("Plan sharing requires an admitted Project.");
    if (planId !== undefined && (!plans.identity.isValid(planId) || target !== undefined))
        throw new Error("Plan sharing requires a durable Plan ID.");
    if (planId !== undefined && expectedPlanId !== undefined && planId !== expectedPlanId)
        throw new Error("Managed share belongs to a different Plan.");
    const boundId = expectedPlanId ?? planId;
    const name = boundId === undefined ? await resolveActivePlanName(cwd, target!) : await nameForPlanId(cwd, boundId);
    await prepareCollaborationPlan(cwd, name, boundId);
    const location = await collaborationPlanLocation(cwd, name);
    const resource = await ensurePlanIdentity(location.documentRoot, name);
    if (boundId !== undefined && resource.planId !== boundId) throw new PlanNotFoundError(boundId);
    return await sharePreparedPlan(
        cwd,
        project,
        resource,
        planId === undefined
            ? preferences
            : {
                  planServer: normalizePlanServerUrl(intent.planServer),
                  allowExisting: true,
                  requireSelectedServer: true,
              },
    );
}

async function nameForPlanId(cwd: string, planId: PlanId): Promise<string> {
    const matches = (await listPlans(cwd)).filter((plan) => plan.attrs.planId === planId);
    if (matches.length > 1)
        throw new Error(`Duplicate planId values found for ${planId}; repair plan front matter before continuing.`);
    if (!matches.length) throw new PlanNotFoundError(planId);
    return matches[0].name;
}

export async function resolveActivePlanName(cwd: string, target: string): Promise<string> {
    if (target.replaceAll("\\", "/").startsWith("archived/")) {
        throw new Error("Cannot share archived Plans. Restore the Plan first, then run `wld plans share <plan>`.");
    }
    try {
        if ((await collaborationPlanLocation(cwd, target, { readOnly: true })).plan) return target;
    } catch (error) {
        if (error instanceof Error && /must be relative|cannot escape/.test(error.message)) {
            throw new Error(
                "Can only share active saved Plans under docs/plans/. External markdown files are not supported.",
            );
        }
    }
    const matches = (await listPlans(cwd)).filter((plan) => plan.attrs.planId === target || plan.name === target);
    if (matches.length > 1) {
        throw new Error(`Duplicate planId values found for ${target}; repair plan front matter before continuing.`);
    }
    if (matches.length === 1) return matches[0].name;
    throw new Error(
        `Active saved Plan not found by name or planId: ${target}. Use \`${CLI_BIN} plans\` to list active Plans.`,
    );
}
