/**
 * @module cmd/plans/share
 * Publish an active saved Plan as a remote-canonical Shared Space.
 */

import { parseArgs } from "../../shared/cli-args.ts";
import { CLI_BIN, getCwd } from "../../constants.js";
import { ensurePlanIdentity, hashPlanBody, listPlans, updatePlanCollaborationMetadata } from "../../plan-store.js";
import {
    generateBearerCapability,
    hashCapability,
    MAINTAINER_SCOPE,
    redactSecrets,
    REVIEWER_SCOPE,
} from "../../shared/collaboration/capabilities.ts";
import { createCollaborationClient, SYSTEM_COLLABORATION_FETCH } from "../../shared/collaboration/client.js";
import { encryptJsonPayload, exportContentKey, generateContentKey } from "../../shared/collaboration/crypto.ts";
import { COLLABORATION_LOCK_BYPASS, COLLABORATION_STATE_REMOTE_CANONICAL } from "../../shared/collaboration/lock.ts";
import { normalizeSharedSpaceMetadata } from "../../shared/collaboration/protocol.js";
import {
    deleteSecretRecord,
    ensureProjectSecretStoreIgnored,
    getGlobalSecretStoreLocation,
    getProjectSecretStoreLocation,
    getSecretRecord,
    putSecretRecord,
} from "../../shared/collaboration/secrets.js";
import { buildCollaborationUrl, redactCollaborationUrl } from "../../shared/collaboration/urls.ts";
import { getDefaultPlanServerUrl } from "../../shared/settings.js";
import { normalizePlanServerUrl } from "../../shared/collaboration/urls.ts";
import { resolveWorkflowPlanLocation } from "../../shared/workflow/plan-location.ts";
import { enterProjectRuntime } from "../../shared/project-runtime-layout.ts";

interface PlansShareArgs {
    planServer?: string;
    projectSecrets: boolean;
    help: boolean;
    target?: string;
}

interface CreateResponse {
    spaceId: string;
    latestRevision: number;
    expiresAt?: string;
}

interface WireRecord {
    [key: string]: WireValue;
}

type WireValue = boolean | number | string | null | WireRecord | WireValue[] | undefined;

type CreateSharedSpacePayload = Parameters<ReturnType<typeof createCollaborationClient>["createSharedSpace"]>[0];

/** @param {string[]} argv */
export function parsePlansShareArgs(argv: string[]): PlansShareArgs {
    const parsed = parseArgs(argv, {
        boolean: ["help", "project-secrets"],
        string: ["plan-server"],
        alias: { h: "help" },
    });
    const positionals = parsed._.map(String);
    if (parsed.help) return { help: true, projectSecrets: Boolean(parsed["project-secrets"]) };
    if (positionals.length === 0) throw new Error("Missing Plan name or id for share.");
    if (positionals.length > 1) throw new Error(`Unexpected share argument: ${positionals[1]}`);
    return {
        planServer: typeof parsed["plan-server"] === "string" ? parsed["plan-server"] : undefined,
        projectSecrets: Boolean(parsed["project-secrets"]),
        help: false,
        target: positionals[0],
    };
}

function printShareHelp() {
    console.log(`Usage: ${CLI_BIN} plans share <plan-name-or-id> [--plan-server <url>] [--project-secrets]

Publishes an active saved Plan to a remote Plan Server and prints secret reviewer/maintainer URLs once.`);
}

function normalizeCreateResponse(value: WireValue): CreateResponse {
    if (value && typeof value === "object" && !Array.isArray(value) && "space" in value) {
        return normalizeCreateResponse(value.space);
    }
    const metadata = normalizeSharedSpaceMetadata(value);
    if (metadata.latestRevision !== 1) throw new Error("Plan Server create response must report latestRevision 1.");
    return { spaceId: metadata.spaceId, latestRevision: metadata.latestRevision, expiresAt: metadata.expiresAt };
}

/**
 * @param {string} cwd
 * @param {string} target
 */
async function resolveActivePlan(cwd: string, target: string) {
    if (target.replaceAll("\\", "/").startsWith("archived/")) {
        throw new Error("Cannot share archived Plans. Restore the Plan first, then run `wld plans share <plan>`.");
    }

    try {
        const { plan: named } = await resolveWorkflowPlanLocation(cwd, target, { readOnly: true });
        if (named) return { ...named, name: target, planName: target };
    } catch (error) {
        if (error instanceof Error && /must be relative|cannot escape/.test(error.message)) {
            throw new Error(
                "Can only share active saved Plans under docs/plans/. External markdown files are not supported.",
            );
        }
    }

    const resources = await listPlans(cwd);
    const matches = resources.filter((resource) => resource.attrs.planId === target || resource.name === target);
    if (matches.length > 1) {
        throw new Error(`Duplicate planId values found for ${target}; repair plan front matter before continuing.`);
    }
    if (matches.length === 1) return { ...matches[0], planName: matches[0].name };

    throw new Error(
        `Active saved Plan not found by name or planId: ${target}. Use \`${CLI_BIN} plans\` to list active Plans.`,
    );
}

/**
 * @param {PlansShareArgs} args
 */
function resolvePlanServerUrl(args: PlansShareArgs): string {
    if (args.planServer) return normalizePlanServerUrl(args.planServer);
    const configured = getDefaultPlanServerUrl();
    if (!configured) {
        throw new Error(
            "Missing Plan Server URL. Pass --plan-server <url> or configure planServerUrl in RunWield settings.",
        );
    }
    return normalizePlanServerUrl(configured);
}

/**
 * @param {string} planId
 * @param {string} spaceId
 */
function secretRecordKey(planId: string, spaceId: string): string {
    return `${planId}:${spaceId}`;
}

type SecretStoreLocation =
    Awaited<ReturnType<typeof getProjectSecretStoreLocation>> | ReturnType<typeof getGlobalSecretStoreLocation>;

async function assertNoConflictingSecretRecord(
    secretStorePath: SecretStoreLocation,
    planId: string,
    spaceId: string,
): Promise<void> {
    const existingByPlan = await getSecretRecord(secretStorePath, planId);
    if (existingByPlan && existingByPlan.spaceId && existingByPlan.spaceId !== spaceId) {
        throw new Error(`Local collaboration secrets already exist for planId ${planId} and a different remote space.`);
    }
    const existingByPair = await getSecretRecord(secretStorePath, secretRecordKey(planId, spaceId));
    if (existingByPair && existingByPair.spaceId && existingByPair.spaceId !== spaceId) {
        throw new Error(`Local collaboration secrets already exist for planId ${planId} and a different remote space.`);
    }
}

/**
 * @param {string} serverUrl
 * @param {string} spaceId
 * @param {string} maintainerCapability
 */
async function cleanupRemoteSpace(serverUrl: string, spaceId: string, maintainerCapability: string): Promise<void> {
    const client = createCollaborationClient({
        serverUrl,
        bearerCapability: maintainerCapability,
        fetch: SYSTEM_COLLABORATION_FETCH,
    });
    await client.updateSharedSpaceLifecycle(spaceId, { action: "delete" });
}

export interface SharePlanForReviewOptions {
    target: string;
    cwd?: string;
    planServer?: string;
    projectSecrets?: boolean;
    allowExisting?: boolean;
}

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

export async function sharePlanForReview(shareOptions: SharePlanForReviewOptions): Promise<SharedPlanReviewLink> {
    const cwd = shareOptions.cwd || getCwd();
    await enterProjectRuntime(cwd);
    const target = shareOptions.target;
    const selected = await resolveActivePlan(cwd, target);
    const location = await resolveWorkflowPlanLocation(cwd, selected.planName || selected.name);
    const resource = await ensurePlanIdentity(location.documentRoot, selected.planName || selected.name);
    const args = {
        target,
        planServer: shareOptions.planServer,
        projectSecrets: Boolean(shareOptions.projectSecrets),
        help: false,
    };
    if (resource.attrs.collaborationState === COLLABORATION_STATE_REMOTE_CANONICAL) {
        if (!shareOptions.allowExisting) {
            throw new Error(
                "This Plan is already shared and remote-canonical. Use future `wld plans pull`, `wld plans push`, or `wld plans unshare` flows.",
            );
        }
        const serverUrl = String(resource.attrs.collaborationServerUrl || "");
        if (!serverUrl) {
            throw new Error("Shared Plan is missing collaborationServerUrl; cannot reconstruct review URL.");
        }
        const spaceId = String(resource.attrs.collaborationSpaceId || "");
        if (!spaceId) throw new Error("Shared Plan is missing collaborationSpaceId; cannot reconstruct review URL.");
        const projectSecretStore = await getProjectSecretStoreLocation(cwd);
        const globalSecretStore = getGlobalSecretStoreLocation();
        const explicitSecretStorePath = shareOptions.projectSecrets ? projectSecretStore : globalSecretStore;
        const fallbackSecretStorePath = shareOptions.projectSecrets ? globalSecretStore : projectSecretStore;
        const secretRecord =
            (await getSecretRecord(explicitSecretStorePath, secretRecordKey(resource.planId, spaceId))) ||
            (await getSecretRecord(explicitSecretStorePath, resource.planId)) ||
            (await getSecretRecord(fallbackSecretStorePath, secretRecordKey(resource.planId, spaceId))) ||
            (await getSecretRecord(fallbackSecretStorePath, resource.planId));
        if (!secretRecord?.contentKey || !secretRecord?.reviewerCapability) {
            throw new Error("Shared Plan local reviewer secrets are missing; cannot reconstruct review URL.");
        }
        return {
            planName: resource.name,
            planId: resource.planId,
            reviewerUrl: buildCollaborationUrl({
                serverUrl,
                spaceId,
                contentKey: secretRecord.contentKey,
                bearerCapability: secretRecord.reviewerCapability,
                role: REVIEWER_SCOPE,
            }),
            maintainerUrl: secretRecord.maintainerCapability
                ? buildCollaborationUrl({
                      serverUrl,
                      spaceId,
                      contentKey: secretRecord.contentKey,
                      bearerCapability: secretRecord.maintainerCapability,
                      role: MAINTAINER_SCOPE,
                  })
                : "",
            serverUrl,
            spaceId,
            revision: Number(resource.attrs.collaborationRevision || 1),
            reused: true,
        };
    }

    const serverUrl = resolvePlanServerUrl(args);
    const now = new Date().toISOString();

    const contentKey = await generateContentKey();
    const exportedContentKey = await exportContentKey(contentKey);
    const reviewerCapability = generateBearerCapability();
    const maintainerCapability = generateBearerCapability();
    const payloadCiphertext = await encryptJsonPayload(
        {
            planId: resource.planId,
            title: resource.attrs.summary || resource.name,
            metadata: { ...resource.attrs },
            body: resource.body,
        },
        contentKey,
    );
    const reviewerHash = await hashCapability(reviewerCapability);
    const maintainerHash = await hashCapability(maintainerCapability);
    const createPayload: CreateSharedSpacePayload = {
        planId: resource.planId,
        initialRevision: { payloadCiphertext },
        capabilities: [
            { scope: REVIEWER_SCOPE, capabilityHash: reviewerHash },
            { scope: MAINTAINER_SCOPE, capabilityHash: maintainerHash },
        ],
    };

    const unauthenticatedClient = createCollaborationClient({
        serverUrl,
        bearerCapability: "",
        fetch: SYSTEM_COLLABORATION_FETCH,
    });
    let created;
    let reviewerUrl = "";
    let maintainerUrl = "";
    let secretStorePath: SecretStoreLocation | null = null;
    let localSecretKey = "";
    try {
        created = normalizeCreateResponse((await unauthenticatedClient.createSharedSpace(createPayload)) as WireValue);
        reviewerUrl = buildCollaborationUrl({
            serverUrl,
            spaceId: created.spaceId,
            contentKey: exportedContentKey,
            bearerCapability: reviewerCapability,
            role: REVIEWER_SCOPE,
        });
        maintainerUrl = buildCollaborationUrl({
            serverUrl,
            spaceId: created.spaceId,
            contentKey: exportedContentKey,
            bearerCapability: maintainerCapability,
            role: MAINTAINER_SCOPE,
        });

        secretStorePath = args.projectSecrets
            ? await getProjectSecretStoreLocation(cwd)
            : getGlobalSecretStoreLocation();
        if (args.projectSecrets) {
            await ensureProjectSecretStoreIgnored(cwd);
        }
        await assertNoConflictingSecretRecord(secretStorePath, resource.planId, created.spaceId);
        localSecretKey = secretRecordKey(resource.planId, created.spaceId);
        await putSecretRecord(secretStorePath, localSecretKey, {
            planId: resource.planId,
            spaceId: created.spaceId,
            contentKey: exportedContentKey,
            reviewerCapability,
            maintainerCapability,
            updatedAt: now,
        });

        await updatePlanCollaborationMetadata(
            cwd,
            resource.name,
            {
                collaborationState: COLLABORATION_STATE_REMOTE_CANONICAL,
                collaborationServerUrl: serverUrl,
                collaborationSpaceId: created.spaceId,
                collaborationRevision: 1,
                collaborationBodyHash: await hashPlanBody(resource.body),
                collaborationSyncedAt: now,
            },
            COLLABORATION_LOCK_BYPASS.share,
            { body: resource.body },
        );
    } catch (error) {
        if (!created) throw error;
        try {
            await cleanupRemoteSpace(serverUrl, created.spaceId, maintainerCapability);
        } catch (cleanupError) {
            console.error(
                `[RunWield] Failed to clean up remote Shared Space ${created.spaceId}: ${redactSecrets(cleanupError, [
                    reviewerCapability,
                    maintainerCapability,
                    exportedContentKey,
                ])}`,
            );
            console.error("[RunWield] Remote space may still exist. Save this recovery maintainer URL securely:");
            console.error(maintainerUrl);
            throw new Error(
                `Share failed after remote creation and cleanup also failed. Recovery URL was printed once. Original error: ${redactSecrets(
                    error,
                    [reviewerCapability, maintainerCapability, exportedContentKey],
                )}`,
            );
        }
        if (secretStorePath && localSecretKey) {
            try {
                if (secretStorePath) await deleteSecretRecord(secretStorePath, localSecretKey);
            } catch (secretCleanupError) {
                throw new Error(
                    `Share failed after remote creation; remote Shared Space ${created.spaceId} was deleted, but local secret cleanup failed for ${localSecretKey} in ${secretStorePath}. Remove that stale record before retrying. Original error: ${redactSecrets(
                        error,
                        [reviewerCapability, maintainerCapability, exportedContentKey],
                    )} Secret cleanup error: ${redactSecrets(secretCleanupError, [
                        reviewerCapability,
                        maintainerCapability,
                        exportedContentKey,
                    ])}`,
                );
            }
        }
        throw new Error(
            `Share failed after remote creation; remote Shared Space ${created.spaceId} was deleted and local secret state was cleaned up. ${redactSecrets(
                error,
                [reviewerCapability, maintainerCapability, exportedContentKey],
            )}`,
        );
    }

    return {
        planName: resource.name,
        planId: resource.planId,
        reviewerUrl,
        maintainerUrl,
        serverUrl,
        spaceId: created.spaceId,
        revision: 1,
        expiresAt: created.expiresAt,
        reused: false,
    };
}

/**
 * @param {string[]} argv
 */
export async function runPlansShareCommand(argv: string[]): Promise<void> {
    const args = parsePlansShareArgs(argv);
    if (args.help) {
        printShareHelp();
        return;
    }
    const cwd = getCwd();
    await enterProjectRuntime(cwd);
    const shared = await sharePlanForReview({
        target: args.target as string,
        cwd,
        planServer: args.planServer,
        projectSecrets: args.projectSecrets,
        allowExisting: false,
    });
    console.log(
        `[RunWield] Shared Plan ${shared.planName} as remote Shared Space ${shared.spaceId} (revision ${shared.revision}).`,
    );
    console.log("\nReviewer URL (secret; share only with reviewers):");
    console.log(shared.reviewerUrl);
    console.log("\nMaintainer URL (powerful secret):");
    console.log(shared.maintainerUrl);
    if (shared.expiresAt) {
        console.log(
            `\nInactivity retention: this Shared Space expires at ${shared.expiresAt}. New revisions, comments, resolve/reopen, or close actions refresh the expiry; viewing alone does not.`,
        );
    }
    console.log(
        "\nWarning: anyone with the maintainer URL can pull, push, close, or unshare this Shared Space. Store these URLs securely; RunWield will not print them again.",
    );
    console.log(
        `[RunWield] Stored local secret material outside Plan front matter/settings. API/server URL: ${redactCollaborationUrl(
            shared.serverUrl,
        )}`,
    );
}
