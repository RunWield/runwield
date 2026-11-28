import { plans } from "@runwield/plans";
import { COLLABORATION_STATE_REMOTE_CANONICAL, hashPlanBody, normalizePlanServerUrl } from "@runwield/plans/format";
import { openShareAttemptJournal, type ShareAttempt } from "@runwield/plans/share-attempt-journal";
import type { ProjectStoreIdentity } from "@runwield/projects";
import { updatePlanCollaborationMetadata, type PlanResource } from "../../plan-store.ts";
import {
    MAINTAINER_SCOPE,
    REVIEWER_SCOPE,
    redactSecrets,
    CollaborationApiError,
    PlanServerUpgradeRequiredError,
    SharedSpaceGoneError,
    openPlanServerConnection,
    buildCollaborationUrl,
} from "@runwield/plans/plan-server";
import { COLLABORATION_LOCK_BYPASS } from "../../shared/collaboration/lock.ts";
import {
    deleteSecretRecord,
    ensureProjectSecretStoreIgnored,
    getGlobalSecretStoreLocation,
    getProjectSecretStoreLocation,
    getSecretRecord,
    putSharedPlanSecretRecord,
    secretRecordKey,
    type SecretStoreLocation,
} from "../../shared/collaboration/secrets.ts";
import { getDefaultPlanServerUrl } from "../../shared/settings.ts";
import {
    markCollaborationNetworkEffect,
    markReplayableShareNetworkEffect,
    retainCollaborationOperationResult,
    retainGoneShareOperationResult,
} from "../operation-results.ts";
import { loadPlan } from "../queries.ts";

/** Sharing preferences used by the active Plan owner. */
export interface PlanSharePreferences {
    planServer?: string;
    projectSecrets?: boolean;
    allowExisting?: boolean;
    requireSelectedServer?: boolean;
}

/** Links and metadata for a published Shared Space. */
export interface SharedPlanReviewLink {
    planName: string;
    planId: string;
    reviewerUrl: string;
    maintainerUrl: string;
    serverUrl: string;
    spaceId: string;
    revision: number;
    expiresAt?: string;
    reused: boolean;
}

function resolvePlanServerUrl(args: PlanSharePreferences): string {
    const configured = args.planServer || getDefaultPlanServerUrl();
    if (!configured) {
        throw new Error(
            "Missing Plan Server URL. Pass --plan-server <url> or configure planServerUrl in RunWield settings.",
        );
    }
    return normalizePlanServerUrl(configured);
}

async function reuseSharedPlan(
    resource: PlanResource,
    args: PlanSharePreferences,
    preferredStore: SecretStoreLocation,
    fallbackStore: SecretStoreLocation,
): Promise<SharedPlanReviewLink> {
    if (!args.allowExisting) {
        throw new Error(
            "This Plan is already shared and remote-canonical. Use future `wld plans pull`, `wld plans push`, or `wld plans unshare` flows.",
        );
    }
    const serverUrl = String(resource.attrs.collaborationServerUrl || "");
    if (!serverUrl) throw new Error("Shared Plan is missing collaborationServerUrl; cannot reconstruct review URL.");
    if (args.requireSelectedServer && normalizePlanServerUrl(serverUrl) !== resolvePlanServerUrl(args)) {
        throw new Error("This Plan is already shared on a different Plan Server.");
    }
    const spaceId = String(resource.attrs.collaborationSpaceId || "");
    if (!spaceId) throw new Error("Shared Plan is missing collaborationSpaceId; cannot reconstruct review URL.");
    const key = secretRecordKey(resource.planId, spaceId);
    const secretRecord =
        (await getSecretRecord(preferredStore, key)) ||
        (await getSecretRecord(preferredStore, resource.planId)) ||
        (await getSecretRecord(fallbackStore, key)) ||
        (await getSecretRecord(fallbackStore, resource.planId));
    if (!secretRecord?.contentKey || !secretRecord?.reviewerCapability) {
        throw new Error("Shared Plan local reviewer secrets are missing; cannot reconstruct review URL.");
    }
    return shareLinks(
        resource,
        { serverUrl, spaceId, revision: Number(resource.attrs.collaborationRevision || 1), reused: true },
        { ...secretRecord, reviewerCapability: secretRecord.reviewerCapability },
    );
}

interface ReviewSpace {
    serverUrl: string;
    spaceId: string;
    revision: number;
    expiresAt?: string;
    reused: boolean;
}

interface ReviewSecrets {
    contentKey: string;
    reviewerCapability: string;
    maintainerCapability?: string;
}

function shareLinks(resource: PlanResource, space: ReviewSpace, secrets: ReviewSecrets): SharedPlanReviewLink {
    const { serverUrl, spaceId } = space;
    const base = { serverUrl, spaceId, contentKey: secrets.contentKey };
    return {
        ...space,
        planName: resource.name,
        planId: resource.planId,
        reviewerUrl: buildCollaborationUrl({
            ...base,
            role: REVIEWER_SCOPE,
            bearerCapability: secrets.reviewerCapability,
        }),
        maintainerUrl: secrets.maintainerCapability
            ? buildCollaborationUrl({ ...base, role: MAINTAINER_SCOPE, bearerCapability: secrets.maintainerCapability })
            : "",
    };
}

/** Publish the active Plan or resume its pending share to the original server. */
export async function sharePreparedPlan(
    cwd: string,
    project: ProjectStoreIdentity,
    selected: PlanResource,
    args: PlanSharePreferences,
): Promise<SharedPlanReviewLink> {
    if (!plans.identity.isValid(selected.planId)) throw new Error("Plan sharing requires a durable Plan ID.");
    return await openShareAttemptJournal(project).withAttempt(
        selected.planId,
        async ({ current: pendingAttempt, save, finish }) => {
            const latest = await loadPlan(cwd, selected.name);
            if (!latest || latest.attrs.planId !== selected.planId)
                throw new Error("Plan changed before it could be shared.");
            const resource = { ...selected, attrs: latest.attrs, body: latest.body };
            const alreadyShared = resource.attrs.collaborationState === COLLABORATION_STATE_REMOTE_CANONICAL;
            if (alreadyShared) {
                if (!pendingAttempt) {
                    const globalStore = getGlobalSecretStoreLocation();
                    const projectStore = await getProjectSecretStoreLocation(cwd);
                    const preferred = args.projectSecrets ? projectStore : globalStore;
                    const fallback = args.projectSecrets ? globalStore : projectStore;
                    return await reuseSharedPlan(resource, args, preferred, fallback);
                }
                if (
                    resource.attrs.collaborationServerUrl !== pendingAttempt.serverUrl ||
                    resource.attrs.collaborationSpaceId !== pendingAttempt.created?.spaceId
                ) {
                    throw new Error("The pending share belongs to a different Shared Space than this Plan.");
                }
            }

            const serverUrl = pendingAttempt?.serverUrl ?? resolvePlanServerUrl(args);
            const projectSecrets = pendingAttempt?.projectSecrets ?? Boolean(args.projectSecrets);
            if (projectSecrets) await ensureProjectSecretStoreIgnored(cwd);
            const attempt: ShareAttempt = pendingAttempt ?? {
                requestId: crypto.randomUUID(),
                serverUrl,
                projectSecrets,
                prepared: await openPlanServerConnection(serverUrl).prepareSharedSpace({
                    planId: resource.planId,
                    title: resource.attrs.summary || resource.name,
                    metadata: resource.attrs,
                    body: resource.body,
                }),
                bodyHash: await hashPlanBody(resource.body),
                startedAt: new Date().toISOString(),
                mayHaveCreated: false,
            };
            const { contentKey, reviewerCapability, maintainerCapability, createPayload } = attempt.prepared;
            const store = projectSecrets ? await getProjectSecretStoreLocation(cwd) : getGlobalSecretStoreLocation();
            try {
                let created = alreadyShared ? attempt.created : undefined;
                if (!created) {
                    if (!attempt.mayHaveCreated) save({ ...attempt, mayHaveCreated: true });
                    markReplayableShareNetworkEffect();
                    created = await openPlanServerConnection(serverUrl).replaySharedSpace(
                        createPayload,
                        attempt.requestId,
                    );
                    if (attempt.created && created.spaceId !== attempt.created.spaceId)
                        throw new Error("The Plan Server returned a different Shared Space for this attempt.");
                    if (!attempt.created) save({ ...attempt, mayHaveCreated: true, created });
                }
                await putSharedPlanSecretRecord(store, {
                    planId: resource.planId,
                    spaceId: created.spaceId,
                    contentKey,
                    reviewerCapability,
                    maintainerCapability,
                    updatedAt: attempt.startedAt,
                });

                if (!alreadyShared) {
                    await updatePlanCollaborationMetadata(
                        cwd,
                        resource.name,
                        {
                            collaborationState: COLLABORATION_STATE_REMOTE_CANONICAL,
                            collaborationServerUrl: serverUrl,
                            collaborationSpaceId: created.spaceId,
                            collaborationRevision: created.latestRevision,
                            collaborationBodyHash: attempt.bodyHash,
                            collaborationSyncedAt: attempt.startedAt,
                        },
                        COLLABORATION_LOCK_BYPASS.share,
                        { expectedPlanId: resource.planId },
                    );
                }
                const result = shareLinks(
                    resource,
                    {
                        serverUrl,
                        spaceId: created.spaceId,
                        revision: created.latestRevision,
                        expiresAt: created.expiresAt,
                        reused: false,
                    },
                    attempt.prepared,
                );
                // A managed owner can lose its SSH reply after the local Plan has committed.
                retainCollaborationOperationResult({ action: "share", value: result });
                finish();
                return result;
            } catch (error) {
                if (error instanceof SharedSpaceGoneError) {
                    if (attempt.created) {
                        await deleteSecretRecord(store, secretRecordKey(resource.planId, attempt.created.spaceId));
                    }
                    retainGoneShareOperationResult(resource.planId, attempt.requestId);
                    finish();
                    throw error;
                }
                if (error instanceof PlanServerUpgradeRequiredError) {
                    if (!attempt.mayHaveCreated) save(attempt);
                    throw error;
                }
                const details = redactSecrets(error, [
                    contentKey,
                    reviewerCapability,
                    maintainerCapability,
                    createPayload.initialRevision.payloadCiphertext,
                    attempt.requestId,
                ]);
                if (
                    !attempt.mayHaveCreated &&
                    error instanceof CollaborationApiError &&
                    [400, 413].includes(error.status ?? 0)
                ) {
                    // A refusal before any possibly committed request lets a corrected draft start a fresh share.
                    finish();
                    markCollaborationNetworkEffect(false);
                    throw new Error(`The Plan Server rejected the Shared Space request. ${details}`);
                }
                throw new Error(
                    `Unable to publish the Shared Space on ${serverUrl}. Retry sharing this Plan to recover the original attempt. ${details}`,
                );
            }
        },
    );
}
