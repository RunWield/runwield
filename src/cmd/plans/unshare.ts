/**
 * @module cmd/plans/unshare
 * Destructively delete a remote Shared Space and intentionally clear local collaboration state.
 */

import { parseArgs } from "../../shared/cli-args.ts";
import { CLI_BIN, getCwd } from "../../constants.js";
import { clearPlanCollaborationMetadata, listPlans, listPlanResources } from "../../plan-store.js";
import { redactSecrets } from "../../shared/collaboration/capabilities.ts";
import {
    CollaborationApiError,
    createCollaborationClient,
    SYSTEM_COLLABORATION_FETCH,
} from "../../shared/collaboration/client.js";
import { COLLABORATION_LOCK_BYPASS, COLLABORATION_STATE_REMOTE_CANONICAL } from "../../shared/collaboration/lock.ts";
import { normalizeSharedSpaceMetadata } from "../../shared/collaboration/protocol.js";
import {
    deleteCompatibleSecretRecords,
    getGlobalSecretStoreLocation,
    getProjectSecretStoreLocation,
    resolveCompatibleSecretRecord,
} from "../../shared/collaboration/secrets.js";
import { normalizePlanServerUrl } from "../../shared/collaboration/urls.ts";
import { resolveWorkflowPlanLocation } from "../../shared/workflow/plan-location.ts";
import { enterProjectRuntime } from "../../shared/project-runtime-layout.ts";

interface PlansUnshareArgs {
    target?: string;
    planServer?: string;
    projectSecrets: boolean;
    force: boolean;
    help: boolean;
}

export interface UnsharePlanOptions {
    target: string;
    cwd?: string;
    planServer?: string;
    projectSecrets?: boolean;
    force?: boolean;
}

export interface UnsharedPlan {
    planName: string;
    planId: string;
    serverUrl: string;
    spaceId: string;
    revision: number;
    alreadyDeleted: boolean;
    deletedSecretCount: number;
    localMetadataCleared: true;
}

interface RemoteDetails {
    planName: string;
    serverUrl: string;
    spaceId: string;
    revision: number;
    status?: string;
    alreadyDeleted?: boolean;
}

interface WireRecord {
    [key: string]: WireValue;
}

type WireValue = boolean | number | string | null | WireRecord | WireValue[] | undefined;
type PlanResource = Awaited<ReturnType<typeof listPlanResources>>[number];
type PlanAttrs = PlanResource["attrs"];

/** @param {string[]} argv */
export function parsePlansUnshareArgs(argv: string[]): PlansUnshareArgs {
    const parsed = parseArgs(argv, {
        boolean: ["help", "project-secrets", "force"],
        string: ["plan-server"],
        alias: { h: "help" },
    });
    const positionals = parsed._.map(String);
    if (parsed.help) {
        return { help: true, projectSecrets: Boolean(parsed["project-secrets"]), force: Boolean(parsed.force) };
    }
    if (positionals.length === 0) throw new Error("Missing Plan name or id for unshare.");
    if (positionals.length > 1) throw new Error(`Unexpected unshare argument: ${positionals[1]}`);
    return {
        target: positionals[0],
        planServer: typeof parsed["plan-server"] === "string" ? parsed["plan-server"] : undefined,
        projectSecrets: Boolean(parsed["project-secrets"]),
        force: Boolean(parsed.force),
        help: false,
    };
}

function printUnshareHelp() {
    console.log(`Usage: ${CLI_BIN} plans unshare <plan-name-or-id> [--plan-server <url>] [--project-secrets] [--force]

Deletes the remote Shared Space using maintainer secrets, then clears local collaboration secrets and lock metadata. This is destructive for all reviewer and maintainer links.`);
}

function normalizeSpaceResponse(value: WireValue): ReturnType<typeof normalizeSharedSpaceMetadata> {
    if (value && typeof value === "object" && !Array.isArray(value) && "space" in value) {
        return normalizeSpaceResponse(value.space);
    }
    return normalizeSharedSpaceMetadata(value);
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
        Number(attrs.collaborationRevision) > 0
    );
}

function errorStatus(error: Error): number | undefined {
    return error instanceof CollaborationApiError ? error.status : undefined;
}

function isNotFoundError(error: Error): boolean {
    return errorStatus(error) === 404;
}

function isAmbiguousRemoteError(error: Error): boolean {
    const status = errorStatus(error);
    if (status && status >= 500) return true;
    return /(?:Plan Server error 5\d\d|Network failure|ECONN|ETIMEDOUT|timeout|fetch failed)/i.test(error.message);
}

function redactedError(error: Error, secrets: string[]): string {
    return redactSecrets(error, secrets);
}

/** @param {string} message */
function confirm(message: string): boolean {
    const answer = globalThis.prompt(`${message}\nType yes to continue: `) || "";
    return /^(?:y|yes)$/i.test(answer.trim());
}

function confirmationMessage(details: RemoteDetails): string {
    const state = details.alreadyDeleted ? "clear local collaboration state for already-deleted" : "delete";
    return `Destructive unshare will ${state} Shared Space ${details.spaceId} for Plan ${details.planName} on ${details.serverUrl} (revision ${details.revision}, status ${
        details.status || "unknown"
    }). Reviewer and maintainer links will stop working, and other checkouts or browser sessions will need deleted-remote recovery.`;
}

export async function unsharePlan(unshareOptions: UnsharePlanOptions): Promise<UnsharedPlan> {
    const cwd = unshareOptions.cwd || getCwd();
    await enterProjectRuntime(cwd);
    const now = new Date().toISOString();
    const target = unshareOptions.target;
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
    if (!planId) throw new Error("Shared Plan is missing planId; cannot unshare.");

    const serverUrl = unshareOptions.planServer
        ? normalizePlanServerUrl(unshareOptions.planServer)
        : String(attrs.collaborationServerUrl);
    if (serverUrl !== attrs.collaborationServerUrl) {
        throw new Error(
            "Plan Server override does not match the local Shared Plan collaborationServerUrl; refusing to unshare a different server.",
        );
    }

    const paths = await secretPaths(cwd, Boolean(unshareOptions.projectSecrets));
    const found = await resolveCompatibleSecretRecord(paths, planId, spaceId);
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
    const client = createCollaborationClient({
        serverUrl,
        bearerCapability: secretRecord.maintainerCapability,
        fetch: SYSTEM_COLLABORATION_FETCH,
    });

    let space: ReturnType<typeof normalizeSharedSpaceMetadata> | null = null;
    let alreadyDeleted = false;
    try {
        space = normalizeSpaceResponse((await client.getSharedSpace(spaceId)) as WireValue);
    } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        if (isNotFoundError(cause)) {
            alreadyDeleted = true;
        } else if (isAmbiguousRemoteError(cause)) {
            throw new Error(
                `Unable to verify remote Shared Space; local collaboration metadata was not changed. Retry when the Plan Server is reachable. ${redactedError(
                    cause,
                    secrets,
                )}`,
            );
        } else {
            throw new Error(
                `Unable to fetch remote Shared Space; local collaboration metadata was not changed. ${redactedError(
                    cause,
                    secrets,
                )}`,
            );
        }
    }

    if (space) {
        if (space.planId !== planId) {
            throw new Error("Remote Shared Space planId does not match the local Plan; refusing to unshare.");
        }
        if (space.spaceId !== spaceId) {
            throw new Error("Remote Shared Space id does not match the local Plan; refusing to unshare.");
        }
    }

    const remoteDetails = {
        planName,
        serverUrl,
        spaceId,
        revision: space?.latestRevision || localRevision,
        status: space?.status || (alreadyDeleted ? "deleted" : "unknown"),
        alreadyDeleted,
    };
    if (!unshareOptions.force) {
        const accepted = confirm(confirmationMessage(remoteDetails));
        if (!accepted) {
            throw new Error(
                "Unshare cancelled; remote Shared Space and local collaboration metadata were not changed.",
            );
        }
    }

    let deletedDuringDelete = false;
    if (!alreadyDeleted) {
        try {
            await client.updateSharedSpaceLifecycle(spaceId, { action: "delete" });
        } catch (error) {
            const cause = error instanceof Error ? error : new Error(String(error));
            if (isNotFoundError(cause)) {
                alreadyDeleted = true;
                deletedDuringDelete = true;
            } else if (isAmbiguousRemoteError(cause)) {
                throw new Error(
                    `Remote delete result is ambiguous; local collaboration metadata was not changed. Retry or verify before cleanup. ${redactedError(
                        cause,
                        secrets,
                    )}`,
                );
            } else {
                throw new Error(
                    `Unable to delete remote Shared Space; local collaboration metadata was not changed. ${redactedError(
                        cause,
                        secrets,
                    )}`,
                );
            }
        }
    }

    if (deletedDuringDelete && !unshareOptions.force) {
        const accepted = confirm(confirmationMessage({ ...remoteDetails, alreadyDeleted: true }));
        if (!accepted) {
            throw new Error(
                "Local cleanup cancelled for already-deleted Shared Space; local collaboration metadata was not changed.",
            );
        }
    }

    let deletedSecrets;
    try {
        deletedSecrets = await deleteCompatibleSecretRecords(paths, planId, spaceId);
    } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        throw new Error(
            `Remote Shared Space ${spaceId} is deleted, but local collaboration secret cleanup failed. Local Plan remains locked until cleanup is retried. ${redactedError(
                cause,
                secrets,
            )}`,
        );
    }

    try {
        await clearPlanCollaborationMetadata(cwd, planName, COLLABORATION_LOCK_BYPASS.unshare, { updatedAt: now });
    } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        throw new Error(
            `Remote Shared Space ${spaceId} is deleted and ${deletedSecrets.length} local secret record(s) were removed, but local collaboration metadata cleanup failed. Remove the lock metadata or retry unshare before editing. ${redactedError(
                cause,
                secrets,
            )}`,
        );
    }

    return {
        planName,
        planId,
        serverUrl,
        spaceId,
        revision: remoteDetails.revision,
        alreadyDeleted,
        deletedSecretCount: deletedSecrets.length,
        localMetadataCleared: true,
    };
}

/**
 * @param {string[]} argv
 */
export async function runPlansUnshareCommand(argv: string[]): Promise<void> {
    const parsed = parsePlansUnshareArgs(argv);
    if (parsed.help) {
        printUnshareHelp();
        return;
    }
    const cwd = getCwd();
    await enterProjectRuntime(cwd);
    const result = await unsharePlan({
        target: parsed.target as string,
        cwd,
        planServer: parsed.planServer,
        projectSecrets: parsed.projectSecrets,
        force: parsed.force,
    });
    const remoteState = result.alreadyDeleted ? "was already deleted" : "deleted";
    console.log(`[RunWield] Unshared ${result.planName}: remote Shared Space ${result.spaceId} ${remoteState}.`);
    console.log(`[RunWield] Removed ${result.deletedSecretCount} local collaboration secret record(s).`);
    console.log("[RunWield] Cleared local collaboration lock metadata; the Plan body was preserved.");
}
