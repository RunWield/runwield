import { createHash } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { plans } from "@runwield/plans";
import { normalizePlanServerUrl } from "@runwield/plans/format";
import type { ProjectId } from "@runwield/projects";
import { ensurePrivateDir, openNativeFileLock, syncParentDirectory, writeJsonAtomically } from "@runwield/resources/fs";
import type { PreparedSharedSpace } from "@runwield/plans/plan-server";
import {
    assertNonEmptyString,
    assertRecord,
    normalizeCreateSharedSpacePayload,
    normalizeSharedSpaceMetadata,
    type SharedSpaceMetadata,
} from "@runwield/plans/plan-server";
import {
    getGlobalSecretStoreLocation,
    getProjectSecretStoreLocation,
    type SecretStoreLocation,
} from "../../shared/collaboration/secrets.ts";

/** Credentials and the exact encrypted request for a pending Plan share. */
export interface ShareAttempt {
    requestId: string;
    serverUrl: string;
    projectSecrets: boolean;
    prepared: PreparedSharedSpace;
    bodyHash: string;
    startedAt: string;
    /** A previous request may have committed on the selected server. */
    mayHaveCreated: boolean;
    created?: SharedSpaceMetadata;
}

interface ShareAttemptJournal {
    current: ShareAttempt | undefined;
    globalStore: SecretStoreLocation;
    projectStore: SecretStoreLocation;
    save(attempt: ShareAttempt): void;
    finish(): void;
}

function readAttempt(
    path: string,
    projectId: ProjectId,
    planId: string,
    projectSecrets: boolean,
): ShareAttempt | undefined {
    let contents: string;
    try {
        contents = readFileSync(path, "utf8");
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
    }
    const stored = assertRecord(JSON.parse(contents), "Plan sharing attempt");
    const prepared = assertRecord(stored.prepared, "Prepared Shared Space");
    const createPayload = normalizeCreateSharedSpacePayload(prepared.createPayload);
    const created = stored.created === undefined ? undefined : normalizeSharedSpaceMetadata(stored.created);
    if (
        stored.version !== 2 ||
        stored.projectId !== projectId ||
        stored.identity !== "anonymous" ||
        createPayload.planId !== planId ||
        stored.projectSecrets !== projectSecrets ||
        typeof stored.mayHaveCreated !== "boolean" ||
        (created && (!stored.mayHaveCreated || created.planId !== planId || created.latestRevision !== 1))
    ) {
        throw new Error("Pending Plan sharing attempt does not match this Plan and secret store.");
    }
    return {
        requestId: assertNonEmptyString(stored.requestId, "Share request ID"),
        serverUrl: normalizePlanServerUrl(assertNonEmptyString(stored.serverUrl, "Plan Server URL")),
        projectSecrets,
        prepared: {
            createPayload,
            contentKey: assertNonEmptyString(prepared.contentKey, "Content key"),
            reviewerCapability: assertNonEmptyString(prepared.reviewerCapability, "Reviewer capability"),
            maintainerCapability: assertNonEmptyString(prepared.maintainerCapability, "Maintainer capability"),
        },
        bodyHash: assertNonEmptyString(stored.bodyHash, "Original Plan body hash"),
        startedAt: assertNonEmptyString(stored.startedAt, "Start time"),
        mayHaveCreated: stored.mayHaveCreated,
        created,
    };
}

/** One pending attempt per owner and Plan, even if the requested secret store changes. */
export async function withShareAttempt<Result>(
    cwd: string,
    projectId: ProjectId,
    planId: string,
    run: (journal: ShareAttemptJournal) => Result | Promise<Result>,
): Promise<Result> {
    if (!plans.identity.isValid(planId)) throw new Error("Plan sharing requires a durable Plan ID.");
    const globalStore = getGlobalSecretStoreLocation();
    const projectStore = await getProjectSecretStoreLocation(cwd);
    const key = createHash("sha256")
        .update(JSON.stringify([projectId, planId]))
        .digest("hex");
    const globalPath = join(dirname(globalStore.path), "plan-share-attempts", `${key}.json`);
    const projectPath = join(dirname(projectStore.path), "plan-share-attempts", `${key}.json`);
    ensurePrivateDir(dirname(globalPath));
    const lock = openNativeFileLock(`${globalPath}.lock`);
    try {
        await lock.lock(true);
        const globalAttempt = readAttempt(globalPath, projectId, planId, false);
        const projectAttempt = readAttempt(projectPath, projectId, planId, true);
        if (globalAttempt && projectAttempt) throw new Error("Conflicting pending Plan sharing attempts.");
        const current = globalAttempt ?? projectAttempt;
        let activePath = current ? (current.projectSecrets ? projectPath : globalPath) : undefined;
        return await run({
            current,
            globalStore,
            projectStore,
            save(attempt) {
                const path = attempt.projectSecrets ? projectPath : globalPath;
                if (activePath && path !== activePath) throw new Error("Pending Plan sharing secret store changed.");
                writeJsonAtomically(path, { version: 2, projectId, identity: "anonymous", ...attempt });
                activePath = path;
            },
            finish() {
                if (!activePath) return;
                unlinkSync(activePath);
                syncParentDirectory(activePath);
            },
        });
    } finally {
        lock.close();
    }
}

type RetainedShareIdentity = { requestId: string } | { serverUrl: string; spaceId: string };

/** Clear a pending journal only when it matches the owner's settled receipt. */
export async function settleRetainedShareAttempt(
    cwd: string,
    projectId: ProjectId,
    planId: string,
    identity: RetainedShareIdentity,
): Promise<void> {
    await withShareAttempt(cwd, projectId, planId, ({ current, finish }) => {
        if (!current) return;
        const matches =
            "requestId" in identity
                ? current.requestId === identity.requestId
                : current.serverUrl === identity.serverUrl && current.created?.spaceId === identity.spaceId;
        if (matches) finish();
    });
}
