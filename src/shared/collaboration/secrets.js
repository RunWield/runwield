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

export const SECRET_STORE_SCHEMA_VERSION = 1;
export { PROJECT_SECRET_STORE_RELATIVE_PATH };

/**
 * @param {string} planId
 * @param {string} spaceId
 * @returns {string}
 */
export function secretRecordKey(planId, spaceId) {
    return `${planId}:${spaceId}`;
}

/**
 * @typedef {Object} SecretStoreDocument
 * @property {number} schemaVersion
 * @property {Record<string, import("./protocol.js").LocalSecretRecord>} records
 */

/**
 * @typedef {Object} SecretStoreLocation
 * @property {"global"|"project"} owner
 * @property {string} path
 * @property {string} [projectRoot]
 */

/**
 * @param {string} [homeDir]
 * @returns {string}
 */
export function getGlobalSecretStorePath(homeDir = getHomeDir()) {
    return join(homeDir, ".wld", "collaboration-secrets.json");
}

/**
 * @param {string} [homeDir]
 * @returns {SecretStoreLocation}
 */
export function getGlobalSecretStoreLocation(homeDir = getHomeDir()) {
    return { owner: "global", path: getGlobalSecretStorePath(homeDir) };
}

/**
 * @param {string} projectRoot
 * @returns {string}
 */
export function getProjectSecretStorePath(projectRoot) {
    return resolveProjectRuntimeLayout(projectRoot).primary.projectSecretStorePath;
}

/**
 * @param {string} projectRoot
 * @returns {Promise<SecretStoreLocation>}
 */
export async function getProjectSecretStoreLocation(projectRoot) {
    const layout = await enterProjectRuntime(projectRoot);
    return { owner: "project", projectRoot, path: layout.primary.projectSecretStorePath };
}

/**
 * @param {SecretStoreLocation} location
 * @returns {Promise<string>}
 */
async function resolveSecretStorePath(location) {
    if (location.owner === "global") return location.path;
    if (!location.projectRoot) throw new Error("Project secret store location requires a project root.");
    return (await enterProjectRuntime(location.projectRoot)).primary.projectSecretStorePath;
}

/**
 * @param {SecretStoreLocation} location
 * @returns {Promise<SecretStoreDocument>}
 */
export async function readSecretStore(location) {
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

/**
 * @param {SecretStoreLocation} location
 * @param {SecretStoreDocument} document
 */
export async function writeSecretStore(location, document) {
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

/**
 * @param {SecretStoreLocation} path
 * @param {string} key
 * @param {import("./protocol.js").LocalSecretRecord} record
 */
export async function putSecretRecord(path, key, record) {
    const document = await readSecretStore(path);
    document.records[key] = normalizeLocalSecretRecord(record);
    await writeSecretStore(path, document);
}

/**
 * @param {SecretStoreLocation} path
 * @param {string} key
 * @returns {Promise<import("./protocol.js").LocalSecretRecord | undefined>}
 */
export async function getSecretRecord(path, key) {
    return (await readSecretStore(path)).records[key];
}

/**
 * @typedef {Object} PullSecretMatch
 * @property {string} path
 * @property {string} key
 * @property {import("./protocol.js").LocalSecretRecord} record
 */

/**
 * @param {import("./protocol.js").LocalSecretRecord} record
 * @param {string} planId
 * @param {string} spaceId
 * @returns {boolean}
 */
function isCompatibleSecretRecord(record, planId, spaceId) {
    const normalized = normalizeLocalSecretRecord(record);
    if (normalized.planId && normalized.planId !== planId) return false;
    if (normalized.spaceId && normalized.spaceId !== spaceId) return false;
    return true;
}

/**
 * @param {PullSecretMatch[]} matches
 * @param {import("./protocol.js").LocalSecretRecord} [expected]
 */
function assertCompatiblePullSecretMatches(matches, expected) {
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
    for (const field of ["contentKey", "maintainerCapability"]) {
        const baseline = records.find(
            (entry) => /** @type {Record<string, string | undefined>} */ (entry.record)[field],
        );
        if (!baseline) continue;
        const expectedValue = /** @type {Record<string, string | undefined>} */ (baseline.record)[field];
        for (const entry of records) {
            const actualValue = /** @type {Record<string, string | undefined>} */ (entry.record)[field];
            if (expectedValue && actualValue && expectedValue !== actualValue) {
                throw new Error(
                    `Conflicting collaboration secret record for ${field}; refusing to choose between ${baseline.label} and ${entry.label}.`,
                );
            }
        }
    }
}

/**
 * @param {SecretStoreLocation[]} paths
 * @param {string} planId
 * @param {string} spaceId
 * @returns {Promise<PullSecretMatch[]>}
 */
async function collectPullSecretMatches(paths, planId, spaceId) {
    const keys = [secretRecordKey(planId, spaceId), planId];
    const documents = [];
    for (const path of paths) {
        documents.push({ path: path.path, document: await readSecretStore(path) });
    }
    const matches = /** @type {PullSecretMatch[]} */ ([]);
    for (const key of keys) {
        for (const { path, document } of documents) {
            const record = document.records[key];
            if (record) matches.push({ path, key, record });
        }
    }
    return matches;
}

/**
 * @param {SecretStoreLocation[]} paths
 * @param {string} planId
 * @param {string} spaceId
 * @param {import("./protocol.js").LocalSecretRecord} expected
 */
export async function assertCompatiblePullSecretRecord(paths, planId, spaceId, expected) {
    const matches = await collectPullSecretMatches(paths, planId, spaceId);
    assertCompatiblePullSecretMatches(matches, expected);
}

/**
 * @param {SecretStoreLocation[]} paths
 * @param {string} planId
 * @param {string} spaceId
 * @returns {Promise<PullSecretMatch | null>}
 */
export async function resolvePullSecretRecord(paths, planId, spaceId) {
    const matches = await collectPullSecretMatches(paths, planId, spaceId);
    assertCompatiblePullSecretMatches(matches);
    return matches[0] || null;
}

/**
 * Resolve only records that are either explicitly bound to the requested Shared
 * Space or legacy records with no stored spaceId. Records for another Shared
 * Space are ignored instead of being used for authorization.
 *
 * @param {SecretStoreLocation[]} paths
 * @param {string} planId
 * @param {string} spaceId
 * @returns {Promise<PullSecretMatch | null>}
 */
export async function resolveCompatibleSecretRecord(paths, planId, spaceId) {
    const matches = (await collectPullSecretMatches(paths, planId, spaceId)).filter((match) =>
        isCompatibleSecretRecord(match.record, planId, spaceId),
    );
    assertCompatiblePullSecretMatches(matches);
    return matches[0] || null;
}

/**
 * @param {SecretStoreLocation} path
 * @param {string} key
 * @param {import("./protocol.js").LocalSecretRecord} record
 */
export async function putCompatibleSecretRecord(path, key, record) {
    const existing = await getSecretRecord(path, key);
    const normalized = normalizeLocalSecretRecord(record);
    if (existing) {
        for (const field of ["contentKey", "maintainerCapability", "reviewerCapability"]) {
            const oldValue = /** @type {Record<string, string | undefined>} */ (existing)[field];
            const newValue = /** @type {Record<string, string | undefined>} */ (normalized)[field];
            if (oldValue && newValue && oldValue !== newValue) {
                throw new Error(`Conflicting collaboration secret record for ${key}; refusing to replace ${field}.`);
            }
        }
    }
    await putSecretRecord(path, key, { ...existing, ...normalized });
}

/**
 * @param {SecretStoreLocation} path
 * @param {string} key
 */
export async function deleteSecretRecord(path, key) {
    const document = await readSecretStore(path);
    if (!Object.hasOwn(document.records, key)) return;
    delete document.records[key];
    await writeSecretStore(path, document);
}

/**
 * @typedef {Object} DeletedSecretRecord
 * @property {string} path
 * @property {string} key
 */

/**
 * Delete local secret records for the given Plan/Shared Space pair from all
 * provided stores. Legacy planId-only records are deleted only when they are
 * not bound to a different Shared Space.
 *
 * @param {SecretStoreLocation[]} paths
 * @param {string} planId
 * @param {string} spaceId
 * @returns {Promise<DeletedSecretRecord[]>}
 */
export async function deleteCompatibleSecretRecords(paths, planId, spaceId) {
    const keys = [secretRecordKey(planId, spaceId), planId];
    const deleted = /** @type {DeletedSecretRecord[]} */ ([]);
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

/**
 * @param {unknown} value
 * @returns {SecretStoreDocument}
 */
export function normalizeSecretStore(value) {
    const record = assertRecord(value, "Secret store");
    if (record.schemaVersion !== SECRET_STORE_SCHEMA_VERSION) {
        throw new Error(`Unsupported collaboration secret store schema version: ${String(record.schemaVersion)}`);
    }
    const records = assertRecord(record.records, "Secret store records");
    /** @type {Record<string, import("./protocol.js").LocalSecretRecord>} */
    const normalizedRecords = {};
    for (const [key, secretRecord] of Object.entries(records)) {
        normalizedRecords[key] = normalizeLocalSecretRecord(secretRecord);
    }
    return { schemaVersion: SECRET_STORE_SCHEMA_VERSION, records: normalizedRecords };
}

/**
 * @param {string} projectRoot
 */
export async function ensureProjectSecretStoreIgnored(projectRoot) {
    const layout = await enterProjectRuntime(projectRoot);
    await fsMkdir(layout.primary.internalRoot, { recursive: true });
    await ensureRunWieldOwnedGitignoreBlock(layout.primary.checkoutRoot);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function redactSecretStoreValue(value) {
    return redactSecrets(JSON.stringify(redactSecretStoreFields(value)));
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function redactSecretStoreFields(value) {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item) => redactSecretStoreFields(item));
    /** @type {Record<string, unknown>} */
    const redacted = {};
    for (const [key, fieldValue] of Object.entries(value)) {
        if (key === "contentKey" || key === "reviewerCapability" || key === "maintainerCapability") {
            redacted[key] = redactCapabilityValue(typeof fieldValue === "string" ? fieldValue : "");
        } else {
            redacted[key] = redactSecretStoreFields(fieldValue);
        }
    }
    return redacted;
}
