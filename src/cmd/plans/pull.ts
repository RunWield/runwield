/**
 * @module cmd/plans/pull
 * Pull encrypted remote Shared Space feedback into a local locked Plan.
 */

import { parseArgs } from "@std/cli/parse-args";
import { CLI_BIN, getCwd } from "../../constants.js";
import {
    createPulledCollaborationPlan,
    hashPlanBody,
    listPlanResources,
    updatePlanCollaborationMetadata,
} from "../../plan-store.js";
import { MAINTAINER_SCOPE, redactSecrets } from "../../shared/collaboration/capabilities.ts";
import { createCollaborationClient, SYSTEM_COLLABORATION_FETCH } from "../../shared/collaboration/client.js";
import { decryptJsonPayload, importContentKey } from "../../shared/collaboration/crypto.ts";
import { COLLABORATION_LOCK_BYPASS, COLLABORATION_STATE_REMOTE_CANONICAL } from "../../shared/collaboration/lock.js";
import {
    normalizeDecryptedReviewCommentPayload,
    normalizeEncryptedCommentRecord,
    normalizeEncryptedPlanPayload,
    normalizeRevisionMetadata,
    normalizeSharedSpaceMetadata,
} from "../../shared/collaboration/protocol.js";
import {
    assertCompatiblePullSecretRecord,
    ensureProjectSecretStoreIgnored,
    getGlobalSecretStoreLocation,
    getProjectSecretStoreLocation,
    putCompatibleSecretRecord,
    resolvePullSecretRecord,
    secretRecordKey,
} from "../../shared/collaboration/secrets.js";
import { parseCollaborationUrl, redactCollaborationUrl } from "../../shared/collaboration/urls.ts";
import { normalizePlanServerUrl } from "../../shared/collaboration/urls.ts";
import { enterProjectRuntime } from "../../shared/project-runtime-layout.ts";
import { SessionRuntime } from "../../shared/session/session-runtime.ts";
import {
    buildPullRevisionRequest,
    type PullReviewComment,
    selectPullPlanningAgent,
    summarizePullPlanningOutcome,
} from "../../shared/workflow/collaboration-pull.ts";

interface PlansPullArgs {
    target?: string;
    planServer?: string;
    projectSecrets: boolean;
    to?: string;
    help: boolean;
}

export interface PullPlanForRevisionOptions {
    cwd?: string;
    target: string;
    planServer?: string;
    projectSecrets?: boolean;
    to?: string;
}

export interface RunPlansPullOptions {
    sessionRuntime?: SessionRuntime;
    sessionId?: string;
}

interface WireRecord {
    [key: string]: WireValue;
}

type WireValue = boolean | number | string | null | WireRecord | WireValue[] | undefined;
type PlanResource = Awaited<ReturnType<typeof listPlanResources>>[number];
type PlanAttrs = PlanResource["attrs"];
type EncryptedComment = ReturnType<typeof normalizeEncryptedCommentRecord>;

interface ResolvedPull {
    serverUrl: string;
    spaceId: string;
    contentKey: string;
    maintainerCapability: string;
    planName?: string;
    localResource?: PlanResource;
}

interface LocalPull {
    planName: string;
    path?: string;
    attrs: PlanAttrs;
    action: "created" | "updated" | "up-to-date";
}

export interface PulledPlanRevision {
    planName: string;
    planPath?: string;
    title: string;
    attrs: PlanAttrs;
    action: LocalPull["action"];
    serverUrl: string;
    spaceId: string;
    remoteStatus: string;
    expiresAt?: string;
    revision: number;
    comments: PullReviewComment[];
    unreadableCommentCount: number;
    secretImported: boolean;
}

/** @param {string[]} argv */
export function parsePlansPullArgs(argv: string[]): PlansPullArgs {
    const parsed = parseArgs(argv, {
        boolean: ["help", "project-secrets"],
        string: ["plan-server", "to"],
        alias: { h: "help" },
    });
    const positionals = parsed._.map(String);
    if (parsed.help) return { help: true, projectSecrets: Boolean(parsed["project-secrets"]) };
    if (positionals.length === 0) throw new Error("Missing maintainer URL or Plan name/id for pull.");
    if (positionals.length > 1) throw new Error(`Unexpected pull argument: ${positionals[1]}`);
    return {
        target: positionals[0],
        planServer: typeof parsed["plan-server"] === "string" ? parsed["plan-server"] : undefined,
        projectSecrets: Boolean(parsed["project-secrets"]),
        to: typeof parsed.to === "string" ? parsed.to : undefined,
        help: false,
    };
}

function printPullHelp() {
    console.log(
        `Usage: ${CLI_BIN} plans pull <maintainer-url-or-plan-name-or-id> [--plan-server <url>] [--project-secrets] [--to <plan-name>]

Pulls a remote Shared Space revision and encrypted review comments, updates/creates a locked local Plan, then launches Planner or Architect with redacted review context.`,
    );
}

/** @param {string} value */
function looksLikeUrl(value: string): boolean {
    return /^https?:\/\//i.test(value);
}

function normalizeSpaceResponse(value: WireValue): ReturnType<typeof normalizeSharedSpaceMetadata> {
    if (value && typeof value === "object" && !Array.isArray(value) && "space" in value) {
        return normalizeSpaceResponse(value.space);
    }
    return normalizeSharedSpaceMetadata(value);
}

function normalizeRevisionResponse(value: WireValue): ReturnType<typeof normalizeRevisionMetadata> {
    if (
        value && typeof value === "object" && !Array.isArray(value) &&
        typeof value.revision === "object"
    ) {
        return normalizeRevisionResponse(value.revision);
    }
    return normalizeRevisionMetadata(value);
}

function normalizeCommentsResponse(value: WireValue): EncryptedComment[] {
    if (Array.isArray(value)) return value.map(normalizeEncryptedCommentRecord);
    if (value && typeof value === "object" && !Array.isArray(value)) {
        const comments = value.comments;
        if (Array.isArray(comments)) return comments.map(normalizeEncryptedCommentRecord);
    }
    throw new Error("Remote comments response must be an array or an object with a comments array.");
}

/** @param {string} cwd @param {boolean} projectSecrets */
async function secretPaths(cwd: string, projectSecrets: boolean) {
    const globalLocation = getGlobalSecretStoreLocation();
    const projectLocation = await getProjectSecretStoreLocation(cwd);
    return projectSecrets ? [projectLocation, globalLocation] : [globalLocation, projectLocation];
}

function findResourceByPlanId(resources: PlanResource[], planId: string): PlanResource | null {
    const matches = resources.filter((resource) => resource.planId === planId || resource.attrs?.planId === planId);
    if (matches.length > 1) {
        throw new Error(`Duplicate planId values found for ${planId}; repair plan front matter before continuing.`);
    }
    return matches[0] || null;
}

function findResourceByNameOrId(resources: PlanResource[], target: string): PlanResource | null {
    const matches = resources.filter((resource) =>
        resource.planName === target || resource.name === target || resource.planId === target ||
        resource.attrs?.planId === target
    );
    if (matches.length > 1) throw new Error(`Multiple Plans matched ${target}; use a unique Plan name or planId.`);
    return matches[0] || null;
}

function hasCompleteRemoteCanonicalMetadata(attrs: PlanAttrs): boolean {
    return attrs.collaborationState === COLLABORATION_STATE_REMOTE_CANONICAL &&
        typeof attrs.collaborationServerUrl === "string" && attrs.collaborationServerUrl.length > 0 &&
        typeof attrs.collaborationSpaceId === "string" && attrs.collaborationSpaceId.length > 0 &&
        typeof attrs.collaborationBodyHash === "string" && attrs.collaborationBodyHash.length > 0;
}

function redactedError(error: Error, secrets: string[]): string {
    return redactSecrets(error, secrets);
}

export async function pullPlanForRevision(
    pullOptions: PullPlanForRevisionOptions,
): Promise<PulledPlanRevision> {
    const cwd = pullOptions.cwd || getCwd();
    await enterProjectRuntime(cwd);
    const now = new Date().toISOString();
    const target = pullOptions.target;
    const isUrl = looksLikeUrl(target);
    if (!isUrl && pullOptions.to) throw new Error("--to is only supported when pulling from a maintainer URL.");

    let resolved: ResolvedPull;
    if (isUrl) {
        const parsed = parseCollaborationUrl(target);
        if (parsed.role !== MAINTAINER_SCOPE) {
            throw new Error("wld plans pull requires a maintainer URL, not a reviewer URL.");
        }
        resolved = {
            serverUrl: pullOptions.planServer ? normalizePlanServerUrl(pullOptions.planServer) : parsed.serverUrl,
            spaceId: parsed.spaceId,
            contentKey: parsed.contentKey,
            maintainerCapability: parsed.bearerCapability,
        };
    } else {
        const resource = findResourceByNameOrId(await listPlanResources(cwd, { backfillMissing: false }), target);
        if (!resource) throw new Error(`Active Plan not found: ${target}`);
        if (resource.attrs.collaborationState !== COLLABORATION_STATE_REMOTE_CANONICAL) {
            throw new Error("Plan is not shared/remote-canonical; use `wld plans share` before pull.");
        }
        const planId = resource.planId || resource.attrs.planId;
        const spaceId = resource.attrs.collaborationSpaceId;
        if (!planId || !spaceId || !resource.attrs.collaborationServerUrl) {
            throw new Error("Shared Plan is missing collaboration metadata; cannot pull.");
        }
        const paths = await secretPaths(cwd, Boolean(pullOptions.projectSecrets));
        const found = await resolvePullSecretRecord(paths, planId, spaceId);
        if (!found?.record?.contentKey || !found.record.maintainerCapability) {
            throw new Error(
                "Shared Plan local maintainer secrets are missing; pull with the maintainer URL to import them.",
            );
        }
        resolved = {
            serverUrl: pullOptions.planServer
                ? normalizePlanServerUrl(pullOptions.planServer)
                : resource.attrs.collaborationServerUrl,
            spaceId,
            contentKey: found.record.contentKey,
            maintainerCapability: found.record.maintainerCapability,
            planName: resource.planName || resource.name,
            localResource: resource,
        };
    }

    const secrets = [resolved.contentKey, resolved.maintainerCapability];
    let space;
    let revision;
    let comments;
    try {
        const client = createCollaborationClient({
            serverUrl: resolved.serverUrl,
            bearerCapability: resolved.maintainerCapability,
            fetch: SYSTEM_COLLABORATION_FETCH,
        });
        space = normalizeSpaceResponse(await client.getSharedSpace(resolved.spaceId) as WireValue);
        revision = normalizeRevisionResponse(
            await client.getRevision(resolved.spaceId, space.latestRevision) as WireValue,
        );
        comments = normalizeCommentsResponse(
            await client.listComments(resolved.spaceId, revision.revision) as WireValue,
        );
    } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        throw new Error(`Unable to fetch remote Shared Space: ${redactedError(cause, secrets)}`);
    }

    let key;
    let planPayload;
    try {
        key = await importContentKey(resolved.contentKey);
        planPayload = normalizeEncryptedPlanPayload(await decryptJsonPayload(revision.payloadCiphertext, key));
    } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        throw new Error(`Unable to decrypt remote Plan revision: ${redactedError(cause, secrets)}`);
    }
    if (planPayload.planId !== space.planId) {
        throw new Error("Remote Plan payload planId does not match Shared Space metadata.");
    }

    if (isUrl) {
        const paths = await secretPaths(cwd, Boolean(pullOptions.projectSecrets));
        const importedSecretRecord = {
            planId: planPayload.planId,
            spaceId: resolved.spaceId,
            contentKey: resolved.contentKey,
            maintainerCapability: resolved.maintainerCapability,
            updatedAt: now,
        };
        await assertCompatiblePullSecretRecord(
            paths,
            planPayload.planId,
            resolved.spaceId,
            importedSecretRecord,
        );
        if (pullOptions.projectSecrets) {
            await ensureProjectSecretStoreIgnored(cwd);
        }
        await putCompatibleSecretRecord(
            paths[0],
            secretRecordKey(planPayload.planId, resolved.spaceId),
            importedSecretRecord,
        );
    }

    const decryptedComments: PullReviewComment[] = [];
    for (const comment of comments) {
        try {
            const payload = normalizeDecryptedReviewCommentPayload(await decryptJsonPayload(comment.ciphertext, key));
            decryptedComments.push({
                id: comment.id,
                createdAt: payload.createdAt || comment.createdAt,
                resolved: comment.resolved,
                readable: true,
                displayName: payload.displayName,
                body: payload.body,
                type: payload.type,
                originalText: payload.originalText,
                ...(payload.anchor ? { anchor: payload.anchor } : {}),
            });
        } catch (error) {
            const cause = error instanceof Error ? error : new Error(String(error));
            decryptedComments.push({
                id: comment.id,
                createdAt: comment.createdAt,
                resolved: comment.resolved,
                readable: false,
                error: redactedError(cause, secrets),
            });
        }
    }

    const resources = await listPlanResources(cwd, { backfillMissing: false });
    const existingById = resolved.localResource || findResourceByPlanId(resources, planPayload.planId);
    if (isUrl && pullOptions.to && existingById) {
        throw new Error("--to is only supported for fresh maintainer URL pulls with no matching local Plan.");
    }
    const remoteBodyHash = await hashPlanBody(planPayload.body);
    let local: LocalPull;

    if (existingById) {
        const attrs = existingById.attrs || {};
        const planName = existingById.planName || existingById.name;
        const localPlanId = existingById.planId || attrs.planId;
        if (localPlanId !== planPayload.planId) {
            throw new Error(
                "Local Plan planId does not match the remote Plan payload; refusing to overwrite during pull.",
            );
        }
        if (!hasCompleteRemoteCanonicalMetadata(attrs)) {
            throw new Error(
                "Local Plan with the same planId is not a complete remote-canonical collaboration Plan; refusing to overwrite during pull.",
            );
        }
        if (attrs.collaborationServerUrl !== resolved.serverUrl || attrs.collaborationSpaceId !== resolved.spaceId) {
            throw new Error("Local Plan is bound to a different remote Shared Space; refusing to rebind during pull.");
        }
        const localRevision = Number(attrs.collaborationRevision || 0);
        if (localRevision > revision.revision) {
            throw new Error("Local collaboration revision is newer than the remote Shared Space.");
        }
        const currentHash = await hashPlanBody(existingById.body || "");
        if (attrs.collaborationBodyHash && currentHash !== attrs.collaborationBodyHash) {
            throw new Error(
                "Local Plan body diverged from the last pulled/pushed collaboration hash; refusing to overwrite.",
            );
        }
        if (localRevision === revision.revision && currentHash !== remoteBodyHash) {
            throw new Error("Remote body differs without a newer revision; refusing to overwrite.");
        }
        const action = currentHash === remoteBodyHash && localRevision === revision.revision ? "up-to-date" : "updated";
        const updatedAttrs = await updatePlanCollaborationMetadata(
            cwd,
            planName,
            {
                ...planPayload.metadata,
                planId: planPayload.planId,
                collaborationState: COLLABORATION_STATE_REMOTE_CANONICAL,
                collaborationServerUrl: resolved.serverUrl,
                collaborationSpaceId: resolved.spaceId,
                collaborationRevision: revision.revision,
                collaborationSyncedAt: now,
            },
            COLLABORATION_LOCK_BYPASS.pull,
            { body: planPayload.body },
        );
        local = { planName, path: existingById.path, attrs: updatedAttrs, action };
    } else {
        const created = await createPulledCollaborationPlan(cwd, {
            preferredName: pullOptions.to,
            title: planPayload.title || String(planPayload.metadata.summary || "shared-plan"),
            body: planPayload.body,
            attrs: {
                ...planPayload.metadata,
                planId: planPayload.planId,
                summary: typeof planPayload.metadata.summary === "string"
                    ? planPayload.metadata.summary
                    : planPayload.title,
                collaborationState: COLLABORATION_STATE_REMOTE_CANONICAL,
                collaborationServerUrl: resolved.serverUrl,
                collaborationSpaceId: resolved.spaceId,
                collaborationRevision: revision.revision,
                collaborationBodyHash: remoteBodyHash,
                collaborationSyncedAt: now,
                updatedAt: now,
            },
        });
        local = { planName: created.planName, path: created.path, attrs: created.attrs, action: "created" };
    }

    return {
        planName: local.planName,
        planPath: local.path,
        title: planPayload.title,
        attrs: local.attrs,
        action: local.action,
        serverUrl: resolved.serverUrl,
        spaceId: resolved.spaceId,
        remoteStatus: space.status || "open",
        expiresAt: space.expiresAt,
        revision: revision.revision,
        comments: decryptedComments,
        unreadableCommentCount: decryptedComments.filter((comment) => !comment.readable).length,
        secretImported: isUrl,
    };
}

async function launchPlanningAgent(pulled: PulledPlanRevision, options: RunPlansPullOptions) {
    const agentName = selectPullPlanningAgent(pulled.attrs);
    const initialRequest = buildPullRevisionRequest({
        planName: pulled.planName,
        planPath: pulled.planPath,
        title: pulled.title,
        attrs: pulled.attrs,
        remote: {
            serverUrl: redactCollaborationUrl(pulled.serverUrl),
            spaceId: pulled.spaceId,
            status: pulled.remoteStatus,
            revision: pulled.revision,
        },
        action: pulled.action,
        comments: pulled.comments,
        unreadableCommentCount: pulled.unreadableCommentCount,
    });
    let sessionRuntime = options.sessionRuntime;
    let sessionId = options.sessionId;
    if (!sessionRuntime || !sessionId) {
        const { startInteractiveSession } = await import("../../ui/tui/" + "chat-session.ts");
        await startInteractiveSession(null, {
            browser: (await import("../../shared/browser-port.ts")).SYSTEM_BROWSER_PORT,
            onSessionReady: (nextSessionId: string, nextRuntime: SessionRuntime) => {
                sessionId = nextSessionId;
                sessionRuntime = nextRuntime;
            },
        });
    }
    if (!sessionRuntime || !sessionId) {
        throw new Error("plans pull requires an interactive session runtime to launch Planner/Architect.");
    }
    if (typeof sessionRuntime.switchAgent === "function") {
        await sessionRuntime.switchAgent(sessionId, { agentName });
    }
    return await sessionRuntime.runPlanningAgent(sessionId, {
        agentName,
        initialRequest,
        triageMeta: pulled.attrs,
        planName: pulled.planName,
    });
}

export async function runPlansPullCommand(
    argv: string[],
    options: RunPlansPullOptions = {},
): Promise<void> {
    const parsed = parsePlansPullArgs(argv);
    if (parsed.help) {
        printPullHelp();
        return;
    }
    const cwd = getCwd();
    await enterProjectRuntime(cwd);
    const pulled = await pullPlanForRevision({
        target: parsed.target as string,
        cwd,
        planServer: parsed.planServer,
        projectSecrets: parsed.projectSecrets,
        to: parsed.to,
    });
    const selectedAgent = selectPullPlanningAgent(pulled.attrs);
    const outcome = await launchPlanningAgent(pulled, options);
    console.log(
        `[RunWield] Pulled Shared Space ${pulled.spaceId} revision ${pulled.revision}; local Plan ${pulled.action}: ${pulled.planName}.`,
    );
    if (pulled.secretImported) {
        console.log("[RunWield] Imported maintainer secrets into the collaboration secret store.");
    }
    if (pulled.remoteStatus === "closed") {
        console.log("[RunWield] Remote Shared Space is closed; pull is readable but future push may be blocked.");
    }
    if (pulled.expiresAt) {
        console.log(
            `[RunWield] Inactivity retention is enabled; this Shared Space currently expires at ${pulled.expiresAt}.`,
        );
    }
    console.log(
        `[RunWield] Decrypted ${
            pulled.comments.length - pulled.unreadableCommentCount
        } comments (${pulled.unreadableCommentCount} unreadable).`,
    );
    console.log(`[RunWield] Selected planning Agent: ${selectedAgent}.`);
    console.log(`[RunWield] ${summarizePullPlanningOutcome(outcome, pulled.planName)}`);
}
