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
import { redactCapabilityValue, redactSecrets } from "./capabilities.ts";
import { assertRecord, normalizeLocalSecretRecord } from "./protocol.js";
import { getHomeDir, PROJECT_SECRET_STORE_RELATIVE_PATH } from "../../constants.js";
import { enterProjectRuntime, resolveProjectRuntimeLayout } from "../project-runtime-layout.ts";
import { ensureRunWieldOwnedGitignoreBlock } from "../runwield-owned-paths.ts";

import type { LocalSecretRecord } from "./protocol.js";

export interface SecretStoreDocument {
    schemaVersion: number;
    records: Record<string, LocalSecretRecord>;
}

export interface SecretStoreLocation {
    owner: "global" | "project";
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
export { PROJECT_SECRET_STORE_RELATIVE_PATH };

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
    return resolveProjectRuntimeLayout(projectRoot).primary.projectSecretStorePath;
}

export async function getProjectSecretStoreLocation(projectRoot: string): Promise<SecretStoreLocation> {
    const layout = await enterProjectRuntime(projectRoot);
    return { owner: "project", projectRoot, path: layout.primary.projectSecretStorePath };
}

async function resolveSecretStorePath(location: SecretStoreLocation): Promise<string> {
    if (location.owner === "global") return location.path;
    if (!location.projectRoot) throw new Error("Project secret store location requires a project root.");
    return (await enterProjectRuntime(location.projectRoot)).primary.projectSecretStorePath;
}

export async function readSecretStore(location: SecretStoreLocation): Promise<SecretStoreDocument> {
    const path = await resolveSecretStorePath(location);
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

export async function writeSecretStore(location: SecretStoreLocation, document: SecretStoreDocument) {
    const path = await resolveSecretStorePath(location);
    const normalized = normalizeSecretStore(document);
    await fsMkdir(dirname(path), { recursive: true });
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

export async function putSecretRecord(path: SecretStoreLocation, key: string, record: LocalSecretRecord) {
    const document = await readSecretStore(path);
    document.records[key] = normalizeLocalSecretRecord(record);
    await writeSecretStore(path, document);
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

export async function putCompatibleSecretRecord(path: SecretStoreLocation, key: string, record: LocalSecretRecord) {
    const existing = await getSecretRecord(path, key);
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
    await putSecretRecord(path, key, { ...existing, ...normalized });
}

export async function deleteSecretRecord(path: SecretStoreLocation, key: string) {
    const document = await readSecretStore(path);
    if (!Object.hasOwn(document.records, key)) return;
    delete document.records[key];
    await writeSecretStore(path, document);
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
        const document = await readSecretStore(path);
        let changed = false;
        for (const key of keys) {
            const record = document.records[key];
            if (!record || !isCompatibleSecretRecord(record, planId, spaceId)) continue;
            delete document.records[key];
            deleted.push({ path: path.path, key });
            changed = true;
        }
        if (changed) await writeSecretStore(path, document);
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
