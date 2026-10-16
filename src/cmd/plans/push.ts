/**
 * @module cmd/plans/push
 * Push the current local shared Plan body as a new encrypted remote Revision.
 */

import { parseArgs } from "../../shared/cli-args.ts";
import { CLI_BIN, getCwd } from "../../constants.js";
import { hashPlanBody, listPlans, listPlanResources, updatePlanCollaborationMetadata } from "../../plan-store.js";
import { redactSecrets, REVIEWER_SCOPE } from "../../shared/collaboration/capabilities.ts";
import { createCollaborationClient, SYSTEM_COLLABORATION_FETCH } from "../../shared/collaboration/client.js";
import { encryptJsonPayload, importContentKey } from "../../shared/collaboration/crypto.ts";
import { COLLABORATION_LOCK_BYPASS, COLLABORATION_STATE_REMOTE_CANONICAL } from "../../shared/collaboration/lock.ts";
import { normalizeRevisionMetadata, normalizeSharedSpaceMetadata } from "../../shared/collaboration/protocol.js";
import {
    getGlobalSecretStoreLocation,
    getProjectSecretStoreLocation,
    resolvePullSecretRecord,
} from "../../shared/collaboration/secrets.js";
import { buildCollaborationUrl } from "../../shared/collaboration/urls.ts";
import { normalizePlanServerUrl } from "../../shared/collaboration/urls.ts";
import { resolveWorkflowPlanLocation } from "../../shared/workflow/plan-location.ts";
import { enterProjectRuntime } from "../../shared/project-runtime-layout.ts";

interface PlansPushArgs {
    target?: string;
    planServer?: string;
    projectSecrets: boolean;
    help: boolean;
}

export interface PushPlanRevisionOptions {
    target: string;
    cwd?: string;
    planServer?: string;
    projectSecrets?: boolean;
}

export interface PushedPlanRevision {
    planName: string;
    planId: string;
    serverUrl: string;
    spaceId: string;
    previousRevision: number;
    revision: number;
    reviewerUrl: string;
}

interface WireRecord {
    [key: string]: WireValue;
}

type WireValue = boolean | number | string | null | WireRecord | WireValue[] | undefined;
type PlanResource = Awaited<ReturnType<typeof listPlanResources>>[number];
type PlanAttrs = PlanResource["attrs"];

/** @param {string[]} argv */
export function parsePlansPushArgs(argv: string[]): PlansPushArgs {
    const parsed = parseArgs(argv, {
        boolean: ["help", "project-secrets"],
        string: ["plan-server"],
        alias: { h: "help" },
    });
    const positionals = parsed._.map(String);
    if (parsed.help) return { help: true, projectSecrets: Boolean(parsed["project-secrets"]) };
    if (positionals.length === 0) throw new Error("Missing Plan name or id for push.");
    if (positionals.length > 1) throw new Error(`Unexpected push argument: ${positionals[1]}`);
    return {
        target: positionals[0],
        planServer: typeof parsed["plan-server"] === "string" ? parsed["plan-server"] : undefined,
        projectSecrets: Boolean(parsed["project-secrets"]),
        help: false,
    };
}

function printPushHelp() {
    console.log(`Usage: ${CLI_BIN} plans push <plan-name-or-id> [--plan-server <url>] [--project-secrets]

Publishes the current local shared Plan body as a new encrypted remote Revision using maintainer secrets.`);
}

function normalizeSpaceResponse(value: WireValue): ReturnType<typeof normalizeSharedSpaceMetadata> {
    if (value && typeof value === "object" && !Array.isArray(value) && "space" in value) {
        return normalizeSpaceResponse(value.space);
    }
    return normalizeSharedSpaceMetadata(value);
}

function normalizeRevisionResponse(value: WireValue): ReturnType<typeof normalizeRevisionMetadata> {
    if (value && typeof value === "object" && !Array.isArray(value) && typeof value.revision === "object") {
        return normalizeRevisionResponse(value.revision);
    }
    return normalizeRevisionMetadata(value);
}

/** @param {string} cwd @param {boolean} projectSecrets */
async function secretPaths(cwd: string, projectSecrets: boolean) {
    const globalLocation = getGlobalSecretStoreLocation();
    const projectLocation = await getProjectSecretStoreLocation(cwd);
    return projectSecrets ? [projectLocation, globalLocation] : [globalLocation, projectLocation];
}

function findResourceByNameOrId(resources: PlanResource[], target: string): PlanResource | null {
    const matches = resources.filter(
        (resource) =>
            resource.planName === target ||
            resource.name === target ||
            resource.planId === target ||
            resource.attrs?.planId === target,
    );
    if (matches.length > 1) throw new Error(`Multiple Plans matched ${target}; use a unique Plan name or planId.`);
    return matches[0] || null;
}

function hasCompleteRemoteCanonicalMetadata(attrs: PlanAttrs): boolean {
    return (
        attrs.collaborationState === COLLABORATION_STATE_REMOTE_CANONICAL &&
        typeof attrs.collaborationServerUrl === "string" &&
        attrs.collaborationServerUrl.length > 0 &&
        typeof attrs.collaborationSpaceId === "string" &&
        attrs.collaborationSpaceId.length > 0 &&
        Number.isInteger(Number(attrs.collaborationRevision)) &&
        Number(attrs.collaborationRevision) > 0 &&
        typeof attrs.collaborationBodyHash === "string" &&
        attrs.collaborationBodyHash.length > 0
    );
}

function redactedError(error: Error, secrets: string[]): string {
    return redactSecrets(error, secrets);
}

export async function pushPlanRevision(pushOptions: PushPlanRevisionOptions): Promise<PushedPlanRevision> {
    const cwd = pushOptions.cwd || getCwd();
    await enterProjectRuntime(cwd);
    const now = new Date().toISOString();
    const target = pushOptions.target;
    const selected = (await listPlans(cwd)).filter((plan) => plan.name === target || plan.attrs.planId === target);
    if (selected.length > 1) throw new Error(`Multiple Plans matched ${target}; use a unique Plan name or planId.`);
    await resolveWorkflowPlanLocation(cwd, selected[0]?.name || target);
    const resource = findResourceByNameOrId(await listPlanResources(cwd, { backfillMissing: false }), target);
    if (!resource) throw new Error(`Active Plan not found: ${target}`);
    const attrs = resource.attrs || {};
    if (!hasCompleteRemoteCanonicalMetadata(attrs)) {
        throw new Error(
            "Plan is not a complete shared remote-canonical Plan; run `wld plans share` or `wld plans pull` first.",
        );
    }

    const planId = resource.planId || attrs.planId;
    const planName = resource.planName || resource.name;
    const spaceId = String(attrs.collaborationSpaceId);
    const localRevision = Number(attrs.collaborationRevision);
    if (!planId) throw new Error("Shared Plan is missing planId; cannot push.");

    const serverUrl = pushOptions.planServer
        ? normalizePlanServerUrl(pushOptions.planServer)
        : String(attrs.collaborationServerUrl);
    if (serverUrl !== attrs.collaborationServerUrl) {
        throw new Error(
            "Plan Server override does not match the local Shared Plan collaborationServerUrl; refusing to push to a different server.",
        );
    }

    const paths = await secretPaths(cwd, Boolean(pushOptions.projectSecrets));
    const found = await resolvePullSecretRecord(paths, planId, spaceId);
    if (!found?.record?.contentKey) {
        throw new Error("Shared Plan local content key is missing; pull with the maintainer URL to import secrets.");
    }
    if (!found.record.maintainerCapability) {
        throw new Error(
            "Shared Plan local maintainer secrets are missing; pull with the maintainer URL to import them.",
        );
    }

    const secretRecord = found.record;
    const secrets = [
        secretRecord.contentKey,
        secretRecord.maintainerCapability,
        secretRecord.reviewerCapability,
    ].filter((value) => typeof value === "string");
    let space;
    try {
        const client = createCollaborationClient({
            serverUrl,
            bearerCapability: secretRecord.maintainerCapability,
            fetch: SYSTEM_COLLABORATION_FETCH,
        });
        space = normalizeSpaceResponse((await client.getSharedSpace(spaceId)) as WireValue);
    } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        throw new Error(`Unable to fetch remote Shared Space: ${redactedError(cause, secrets)}`);
    }

    if (space.status === "closed") {
        throw new Error("Remote Shared Space is closed and cannot accept new revisions.");
    }
    if (space.planId !== planId) {
        throw new Error("Remote Shared Space planId does not match the local Plan; refusing to push.");
    }
    if (space.spaceId !== spaceId) {
        throw new Error("Remote Shared Space id does not match the local Plan; refusing to push.");
    }
    if (space.latestRevision > localRevision) {
        throw new Error("Remote Shared Space has a newer revision. Run `wld plans pull` before pushing.");
    }
    if (space.latestRevision < localRevision) {
        throw new Error("Local collaboration revision is newer than the remote Shared Space; refusing to push.");
    }

    const body = resource.body || "";
    const currentBodyHash = await hashPlanBody(body);
    if (currentBodyHash === attrs.collaborationBodyHash) {
        throw new Error(
            "Local Plan body is unchanged from the last pulled/pushed revision; refusing to create a duplicate no-op revision.",
        );
    }

    const key = await importContentKey(secretRecord.contentKey);
    const payloadCiphertext = String(
        await encryptJsonPayload(
            {
                planId,
                title: attrs.summary || planName,
                metadata: { ...attrs, planId },
                body,
            },
            key,
        ),
    );

    const expectedRevision = localRevision + 1;
    let appended;
    try {
        const client = createCollaborationClient({
            serverUrl,
            bearerCapability: secretRecord.maintainerCapability,
            fetch: SYSTEM_COLLABORATION_FETCH,
        });
        appended = normalizeRevisionResponse(
            (await client.appendRevision(spaceId, { payloadCiphertext, expectedRevision })) as WireValue,
        );
    } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        throw new Error(`Unable to append remote revision: ${redactedError(cause, [...secrets, payloadCiphertext])}`);
    }
    if (appended.spaceId !== spaceId || appended.revision !== expectedRevision) {
        throw new Error(
            "Plan Server append response did not match the expected new revision; local metadata was not changed.",
        );
    }

    try {
        await updatePlanCollaborationMetadata(
            cwd,
            planName,
            {
                ...attrs,
                planId,
                collaborationState: COLLABORATION_STATE_REMOTE_CANONICAL,
                collaborationServerUrl: serverUrl,
                collaborationSpaceId: spaceId,
                collaborationRevision: appended.revision,
                collaborationBodyHash: currentBodyHash,
                collaborationSyncedAt: now,
                updatedAt: now,
            },
            COLLABORATION_LOCK_BYPASS.push,
            { body },
        );
    } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        throw new Error(
            `Remote revision ${appended.revision} was appended, but local collaboration metadata update failed. Run \`${CLI_BIN} plans pull ${planName}\` before retrying or editing further. ${redactedError(
                cause,
                secrets,
            )}`,
        );
    }

    const reviewerUrl = secretRecord.reviewerCapability
        ? buildCollaborationUrl({
              serverUrl,
              spaceId,
              contentKey: secretRecord.contentKey,
              bearerCapability: secretRecord.reviewerCapability,
              role: REVIEWER_SCOPE,
          })
        : "";

    return {
        planName,
        planId,
        serverUrl,
        spaceId,
        previousRevision: localRevision,
        revision: appended.revision,
        reviewerUrl,
    };
}

/**
 * @param {string[]} argv
 */
export async function runPlansPushCommand(argv: string[]): Promise<void> {
    const parsed = parsePlansPushArgs(argv);
    if (parsed.help) {
        printPushHelp();
        return;
    }
    const cwd = getCwd();
    await enterProjectRuntime(cwd);
    const pushed = await pushPlanRevision({
        target: parsed.target as string,
        cwd,
        planServer: parsed.planServer,
        projectSecrets: parsed.projectSecrets,
    });
    console.log(
        `[RunWield] Pushed Shared Space ${pushed.spaceId} revision ${pushed.revision} from local Plan: ${pushed.planName}.`,
    );
    if (pushed.reviewerUrl) {
        console.log(`[RunWield] Reviewer link remains valid: ${pushed.reviewerUrl}`);
    } else {
        console.log(
            "[RunWield] Existing reviewer links remain valid; this checkout does not have reviewer secrets to reconstruct the URL.",
        );
    }
    console.log(
        "[RunWield] Share the reviewer link with reviewers; do not share maintainer URLs unless handing off maintainer access.",
    );
}
