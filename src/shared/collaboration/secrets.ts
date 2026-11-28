import { projects } from "@runwield/projects";
import { recoverWindowsRename } from "../native-file-replace-windows.ts";
import { rename as fsRename } from "node:fs/promises";
import {
    chmod as fsChmod,
    mkdir as fsMkdir,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
/** @module shared/collaboration/secrets */

import { dirname, join } from "node:path";
import {
    redactCapabilityValue,
    redactSecrets,
    assertRecord,
    normalizeLocalSecretRecord,
} from "@runwield/plans/plan-server";
import { getHomeDir } from "../../constants.ts";
import { enterProjectRuntime, resolveProjectRuntimeLayout } from "@runwield/project-runtime/layout";
import { ensureRunWieldOwnedGitignoreBlock } from "@runwield/project-runtime/owned-paths";
import { collaborationSecretStoreLockPath } from "@runwield/project-runtime";
import { openNativeFileLock } from "@runwield/resources/fs";

import type { LocalSecretRecord } from "@runwield/plans/plan-server";

export interface SecretStoreDocument {
    schemaVersion: number;
    records: Record<string, LocalSecretRecord>;
}

export interface SecretStoreLocation {
    owner: "global" | "project" | "home-project";
    homeOwner?: import("@runwield/projects").HomeProjectOwner;
    path: string;
    projectRoot?: string;
}

export interface PullSecretMatch {
    path: string;
    key: string;
    record: LocalSecretRecord;
}

export interface DeletedSecretRecord {
    path: string;
    key: string;
}

interface RawSecretStoreDocument {
    schemaVersion?: unknown;
    records?: unknown;
}

type SecretCapabilityField = keyof Pick<
    LocalSecretRecord,
    "contentKey" | "maintainerCapability" | "reviewerCapability"
>;

export const SECRET_STORE_SCHEMA_VERSION = 1;

export function secretRecordKey(planId: string, spaceId: string): string {
    return `${planId}:${spaceId}`;
}

export function getGlobalSecretStorePath(homeDir = getHomeDir()): string {
    return join(homeDir, ".wld", "collaboration-secrets.json");
}

export function getGlobalSecretStoreLocation(homeDir = getHomeDir()): SecretStoreLocation {
    return { owner: "global", path: getGlobalSecretStorePath(homeDir) };
}

export function getProjectSecretStorePath(projectRoot: string): string {
    const owner = projects.home.current();
    if (owner) {
        projects.home.assertStoreIdentity(owner);
        return join(projects.home.storeLocation(owner), "internal", "collaboration-secrets.json");
    }
    return resolveProjectRuntimeLayout(projectRoot).primary.projectSecretStorePath;
}

export async function getProjectSecretStoreLocation(projectRoot: string): Promise<SecretStoreLocation> {
    const owner = projects.home.current();
    if (owner) return { owner: "home-project", homeOwner: owner, path: getProjectSecretStorePath(projectRoot) };
    const layout = await enterProjectRuntime(projectRoot);
    return { owner: "project", projectRoot, path: layout.primary.projectSecretStorePath };
}

async function resolveSecretStorePath(location: SecretStoreLocation): Promise<string> {
    if (location.owner === "global") return location.path;
    if (location.owner === "home-project") {
        if (!location.homeOwner) throw new Error("Home Project secret owner is required.");
        projects.home.assertStoreIdentity(location.homeOwner);
        return join(projects.home.storeLocation(location.homeOwner), "internal", "collaboration-secrets.json");
    }
    if (!location.projectRoot) throw new Error("Project secret store location requires a project root.");
    return (await enterProjectRuntime(location.projectRoot)).primary.projectSecretStorePath;
}

async function readStoreDocument(path: string): Promise<SecretStoreDocument> {
    try {
        const raw = await fsReadFile(path, "utf8");
        return normalizeSecretStore(JSON.parse(raw));
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return { schemaVersion: SECRET_STORE_SCHEMA_VERSION, records: {} };
        }
        throw new Error(`Unable to read collaboration secret store: ${redactSecrets(error)}`);
    }
}

async function writeStoreDocument(path: string, document: SecretStoreDocument): Promise<void> {
    const normalized = normalizeSecretStore(document);
    const tempPath = `${path}.${crypto.randomUUID()}.tmp`;
    const content = `${JSON.stringify(normalized, null, 2)}\n`;
    try {
        await fsWriteFile(tempPath, content, { mode: 0o600 });
        try {
            await fsChmod(tempPath, 0o600);
        } catch {
            /* best effort */
        }
        try {
            await fsRename(tempPath, path);
        } catch (error) {
            if (!(error instanceof Error && recoverWindowsRename(error, tempPath, path))) throw error;
        }
        try {
            await fsChmod(path, 0o600);
        } catch {
            /* best effort */
        }
    } catch (error) {
        try {
            await fsRm(tempPath);
        } catch {
            /* ignore cleanup */
        }
        throw new Error(`Unable to write collaboration secret store: ${redactSecrets(error)}`);
    }
}

export async function readSecretStore(location: SecretStoreLocation): Promise<SecretStoreDocument> {
    return await readStoreDocument(await resolveSecretStorePath(location));
}

async function withSecretStoreLock<Result>(
    location: SecretStoreLocation,
    run: (path: string) => Promise<Result>,
): Promise<Result> {
    // Runtime entry may adopt legacy authority. Finish it before acquiring this store's lock.
    const path = await resolveSecretStorePath(location);
    await fsMkdir(dirname(path), { recursive: true, mode: 0o700 });
    const lock = openNativeFileLock(collaborationSecretStoreLockPath(path));
    try {
        await lock.lock(true);
        return await run(path);
    } finally {
        lock.close();
    }
}

/** Replace the complete document. Record mutations must use the current document under the same lock. */
export async function writeSecretStore(location: SecretStoreLocation, document: SecretStoreDocument): Promise<void> {
    await withSecretStoreLock(location, (path) => writeStoreDocument(path, document));
}

async function updateSecretStore(
    location: SecretStoreLocation,
    update: (records: SecretStoreDocument["records"]) => boolean,
): Promise<void> {
    await withSecretStoreLock(location, async (path) => {
        const document = await readStoreDocument(path);
        if (update(document.records)) await writeStoreDocument(path, document);
    });
}

export async function putSecretRecord(path: SecretStoreLocation, key: string, record: LocalSecretRecord) {
    await updateSecretStore(path, (records) => {
        records[key] = normalizeLocalSecretRecord(record);
        return true;
    });
}

export async function getSecretRecord(path: SecretStoreLocation, key: string): Promise<LocalSecretRecord | undefined> {
    return (await readSecretStore(path)).records[key];
}

function isCompatibleSecretRecord(record: LocalSecretRecord, planId: string, spaceId: string) {
    const normalized = normalizeLocalSecretRecord(record);
    if (normalized.planId && normalized.planId !== planId) return false;
    if (normalized.spaceId && normalized.spaceId !== spaceId) return false;
    return true;
}

function assertCompatiblePullSecretMatches(matches: PullSecretMatch[], expected?: LocalSecretRecord) {
    const normalizedExpected = expected ? normalizeLocalSecretRecord(expected) : undefined;
    const records = normalizedExpected
        ? [
              ...matches.map((match) => ({ label: `${match.path}:${match.key}`, record: match.record })),
              {
                  label: "incoming maintainer URL",
                  record: normalizedExpected,
              },
          ]
        : matches.map((match) => ({ label: `${match.path}:${match.key}`, record: match.record }));
    for (const field of ["contentKey", "maintainerCapability"] satisfies SecretCapabilityField[]) {
        const baseline = records.find((entry) => entry.record[field]);
        if (!baseline) continue;
        const expectedValue = baseline.record[field];
        for (const entry of records) {
            const actualValue = entry.record[field];
            if (expectedValue && actualValue && expectedValue !== actualValue) {
                throw new Error(
                    `Conflicting collaboration secret record for ${field}; refusing to choose between ${baseline.label} and ${entry.label}.`,
                );
            }
        }
    }
}

async function collectPullSecretMatches(
    paths: SecretStoreLocation[],
    planId: string,
    spaceId: string,
): Promise<PullSecretMatch[]> {
    const keys = [secretRecordKey(planId, spaceId), planId];
    const documents = [];
    for (const path of paths) {
        documents.push({ path: path.path, document: await readSecretStore(path) });
    }
    const matches: PullSecretMatch[] = [];
    for (const key of keys) {
        for (const { path, document } of documents) {
            const record = document.records[key];
            if (record) matches.push({ path, key, record });
        }
    }
    return matches;
}

export async function assertCompatiblePullSecretRecord(
    paths: SecretStoreLocation[],
    planId: string,
    spaceId: string,
    expected: LocalSecretRecord,
) {
    const matches = await collectPullSecretMatches(paths, planId, spaceId);
    assertCompatiblePullSecretMatches(matches, expected);
}

export async function resolvePullSecretRecord(
    paths: SecretStoreLocation[],
    planId: string,
    spaceId: string,
): Promise<PullSecretMatch | null> {
    const matches = await collectPullSecretMatches(paths, planId, spaceId);
    assertCompatiblePullSecretMatches(matches);
    return matches[0] || null;
}

/**
 * Resolve only records that are either explicitly bound to the requested Shared
 * Space or legacy records with no stored spaceId. Records for another Shared
 * Space are ignored instead of being used for authorization.
 *
 */
export async function resolveCompatibleSecretRecord(
    paths: SecretStoreLocation[],
    planId: string,
    spaceId: string,
): Promise<PullSecretMatch | null> {
    const matches = (await collectPullSecretMatches(paths, planId, spaceId)).filter((match) =>
        isCompatibleSecretRecord(match.record, planId, spaceId),
    );
    assertCompatiblePullSecretMatches(matches);
    return matches[0] || null;
}

function setCompatibleRecord(records: SecretStoreDocument["records"], key: string, record: LocalSecretRecord): boolean {
    const existing = Object.hasOwn(records, key) ? records[key] : undefined;
    const normalized = normalizeLocalSecretRecord(record);
    if (existing) {
        for (const field of [
            "contentKey",
            "maintainerCapability",
            "reviewerCapability",
        ] satisfies SecretCapabilityField[]) {
            const oldValue = existing[field];
            const newValue = normalized[field];
            if (oldValue && newValue && oldValue !== newValue) {
                throw new Error(`Conflicting collaboration secret record for ${key}; refusing to replace ${field}.`);
            }
        }
    }
    records[key] = { ...existing, ...normalized };
    return true;
}

export async function putCompatibleSecretRecord(path: SecretStoreLocation, key: string, record: LocalSecretRecord) {
    await updateSecretStore(path, (records) => setCompatibleRecord(records, key, record));
}

/** Bind freshly created credentials without replacing a legacy record for another Shared Space. */
export async function putSharedPlanSecretRecord(
    path: SecretStoreLocation,
    record: LocalSecretRecord & { planId: string; spaceId: string },
): Promise<void> {
    const { planId, spaceId } = record;
    const key = secretRecordKey(planId, spaceId);
    await updateSecretStore(path, (records) => {
        if ([records[planId], records[key]].some((stored) => stored?.spaceId && stored.spaceId !== spaceId))
            throw new Error(
                `Local collaboration secrets already exist for planId ${planId} and a different remote space.`,
            );
        return setCompatibleRecord(records, key, record);
    });
}

/** Adopt transferred credentials only where the receiving store has no record. */
export async function mergeMissingSecretRecords(
    path: SecretStoreLocation,
    incoming: ReadonlyArray<[string, LocalSecretRecord]>,
): Promise<void> {
    if (!incoming.length) return;
    await updateSecretStore(path, (records) => {
        let changed = false;
        for (const [key, record] of incoming) {
            if (Object.hasOwn(records, key)) continue;
            records[key] = record;
            changed = true;
        }
        return changed;
    });
}

export async function deleteSecretRecord(path: SecretStoreLocation, key: string) {
    await updateSecretStore(path, (records) => Object.hasOwn(records, key) && delete records[key]);
}

/**
 * Delete local secret records for the given Plan/Shared Space pair from all
 * provided stores. Legacy planId-only records are deleted only when they are
 * not bound to a different Shared Space.
 *
 */
export async function deleteCompatibleSecretRecords(
    paths: SecretStoreLocation[],
    planId: string,
    spaceId: string,
): Promise<DeletedSecretRecord[]> {
    const keys = [secretRecordKey(planId, spaceId), planId];
    const deleted: DeletedSecretRecord[] = [];
    for (const path of paths) {
        await updateSecretStore(path, (records) => {
            let changed = false;
            for (const key of keys) {
                const record = Object.hasOwn(records, key) ? records[key] : undefined;
                if (!record || !isCompatibleSecretRecord(record, planId, spaceId)) continue;
                delete records[key];
                deleted.push({ path: path.path, key });
                changed = true;
            }
            return changed;
        });
    }
    return deleted;
}

export function normalizeSecretStore(value: unknown): SecretStoreDocument {
    const record: RawSecretStoreDocument = assertRecord(value, "Secret store");
    if (record.schemaVersion !== SECRET_STORE_SCHEMA_VERSION) {
        throw new Error(`Unsupported collaboration secret store schema version: ${String(record.schemaVersion)}`);
    }
    const records: Record<string, unknown> = assertRecord(record.records, "Secret store records");

    const normalizedRecords: SecretStoreDocument["records"] = {};
    for (const [key, secretRecord] of Object.entries(records)) {
        normalizedRecords[key] = normalizeLocalSecretRecord(secretRecord);
    }
    return { schemaVersion: SECRET_STORE_SCHEMA_VERSION, records: normalizedRecords };
}

export async function ensureProjectSecretStoreIgnored(projectRoot: string) {
    const owner = projects.home.current();
    if (owner) {
        projects.home.assertStoreIdentity(owner);
        return;
    }
    const layout = await enterProjectRuntime(projectRoot);
    await fsMkdir(layout.primary.internalRoot, { recursive: true });
    await ensureRunWieldOwnedGitignoreBlock(layout.primary.checkoutRoot);
}

export function redactSecretStoreValue(value: unknown): string {
    return redactSecrets(JSON.stringify(redactSecretStoreFields(value)));
}

function redactSecretStoreFields(value: unknown): unknown {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item) => redactSecretStoreFields(item));

    const redacted: Record<string, unknown> = {};
    for (const [key, fieldValue] of Object.entries(value)) {
        if (key === "contentKey" || key === "reviewerCapability" || key === "maintainerCapability") {
            redacted[key] = redactCapabilityValue(typeof fieldValue === "string" ? fieldValue : "");
        } else {
            redacted[key] = redactSecretStoreFields(fieldValue);
        }
    }
    return redacted;
}
