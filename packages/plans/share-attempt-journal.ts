import { createHash } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { enter } from "@runwield/project-runtime";
import { projects, type ProjectId, type ProjectStoreIdentity } from "@runwield/projects";
import { ensurePrivateDir, openNativeFileLock, syncParentDirectory, writeJsonAtomically } from "@runwield/resources/fs";
import { getHomeDir } from "@runwield/resources/home";
import { isPlanId, type PlanId } from "@runwield/plan-storage-format";
import { normalizePlanServerUrl } from "./format.ts";
import {
    assertNonEmptyString,
    assertRecord,
    normalizeCreateSharedSpacePayload,
    normalizeSharedSpaceMetadata,
    type PreparedSharedSpace,
    type SharedSpaceMetadata,
} from "./plan-server.ts";

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

/** A Plan's pending share and the writes available until the journal callback returns. */
export interface LockedShareAttempt {
    readonly current: ShareAttempt | undefined;
    /** Persist the exact replay request or its confirmed Shared Space. */
    save(attempt: ShareAttempt): void;
    /** Remove the pending attempt after the host retains its result. */
    finish(): void;
}

/** Match a gone request by ID or a successful share by server and Shared Space. */
export type ShareAttemptReceipt = { requestId: string } | { serverUrl: string; spaceId: string };

/** Host-only journal for an admitted owner, with one pending share per Plan. */
export interface ShareAttemptJournal {
    /** Read or update the attempt while holding the same lock across both secret-store locations. */
    withAttempt<Result>(
        planId: PlanId,
        run: (attempt: LockedShareAttempt) => Result | Promise<Result>,
    ): Promise<Result>;
    /** Clear the attempt only when it matches the host's retained receipt. */
    settle(planId: PlanId, receipt: ShareAttemptReceipt): Promise<void>;
}

function readAttempt(
    path: string,
    projectId: ProjectId,
    planId: PlanId,
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

async function projectAttemptDirectory(project: ProjectStoreIdentity): Promise<string> {
    if (projects.home.isOwner(project)) {
        projects.home.assertStoreIdentity(project);
        return join(projects.home.storeLocation(project), "internal", "plan-share-attempts");
    }
    const layout = await enter(project);
    return join(dirname(layout.primary.projectSecretStorePath), "plan-share-attempts");
}

async function withAttempt<Result>(
    project: ProjectStoreIdentity,
    planId: PlanId,
    run: (attempt: LockedShareAttempt) => Result | Promise<Result>,
): Promise<Result> {
    if (!isPlanId(planId)) throw new Error("Plan sharing requires a durable Plan ID.");
    const { projectId } = project;
    const globalDirectory = join(getHomeDir(), ".wld", "plan-share-attempts");
    const projectDirectory = await projectAttemptDirectory(project);
    const key = createHash("sha256")
        .update(JSON.stringify([projectId, planId]))
        .digest("hex");
    const globalPath = join(globalDirectory, `${key}.json`);
    const projectPath = join(projectDirectory, `${key}.json`);
    ensurePrivateDir(globalDirectory);
    const lock = openNativeFileLock(`${globalPath}.lock`);
    let active = false;
    const assertActive = () => {
        if (!active) throw new Error("The Plan sharing attempt lock is no longer held.");
    };
    try {
        await lock.lock(true);
        const globalAttempt = readAttempt(globalPath, projectId, planId, false);
        const projectAttempt = readAttempt(projectPath, projectId, planId, true);
        if (globalAttempt && projectAttempt) throw new Error("Conflicting pending Plan sharing attempts.");
        const current = globalAttempt ?? projectAttempt;
        let activePath = current ? (current.projectSecrets ? projectPath : globalPath) : undefined;
        active = true;
        return await run({
            current,
            save(attempt) {
                assertActive();
                const path = attempt.projectSecrets ? projectPath : globalPath;
                if (activePath && path !== activePath) throw new Error("Pending Plan sharing secret store changed.");
                writeJsonAtomically(path, { version: 2, projectId, identity: "anonymous", ...attempt });
                activePath = path;
            },
            finish() {
                assertActive();
                if (!activePath) return;
                unlinkSync(activePath);
                syncParentDirectory(activePath);
            },
        });
    } finally {
        active = false;
        lock.close();
    }
}

/** Bind the filesystem journal to the Project admitted by the personal host. */
export function openShareAttemptJournal(project: ProjectStoreIdentity): ShareAttemptJournal {
    return {
        withAttempt(planId, run) {
            return withAttempt(project, planId, run);
        },
        async settle(planId, receipt) {
            await withAttempt(project, planId, ({ current, finish }) => {
                if (!current) return;
                const matches =
                    "requestId" in receipt
                        ? current.requestId === receipt.requestId
                        : current.serverUrl === receipt.serverUrl && current.created?.spaceId === receipt.spaceId;
                if (matches) finish();
            });
        },
    };
}
