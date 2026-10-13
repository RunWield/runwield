import { readFileSync as fsReadFileSync } from "node:fs";
import { mkdir as fsMkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
/**
 * @module shared/update-check
 * Stable-channel update discovery and installer helpers.
 */

import { dirname, join } from "node:path";
import { fileURLToPath as fromFileUrl } from "node:url";
import { getSettingsDir } from "./settings.js";

export const RUNWIELD_REPO = "gandazgul/runwield";
export const LATEST_RELEASE_API_URL = `https://api.github.com/repos/${RUNWIELD_REPO}/releases/latest`;
export const RELEASES_API_URL = `https://api.github.com/repos/${RUNWIELD_REPO}/releases`;
export const RELEASES_WEB_URL = `https://github.com/${RUNWIELD_REPO}/releases`;
export const LATEST_RELEASE_WEB_URL = `https://github.com/${RUNWIELD_REPO}/releases/latest`;
export const UPDATE_CHECK_CACHE_FILENAME = "update-check.json";
export const UPDATE_CHECK_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const TAG_PINNED_INSTALLER_URL_TEMPLATE =
    "https://raw.githubusercontent.com/gandazgul/runwield/{tag}/install.sh";
export const TAG_PINNED_INSTALLER_WEB_URL_TEMPLATE =
    "https://github.com/gandazgul/runwield/raw/refs/tags/{tag}/install.sh";

/** @typedef {{ fetch: import("./fetch-request.ts").FetchRequest }} UpdateCheckNetworkPort */
/** @typedef {{ now: () => number }} UpdateCheckClockPort */
/** @typedef {{ network: UpdateCheckNetworkPort, clock: UpdateCheckClockPort }} UpdateCheckPorts */

export const SYSTEM_UPDATE_CHECK_PORTS = Object.freeze({
    network: { fetch: globalThis.fetch.bind(globalThis) },
    clock: { now: Date.now },
});

/**
 * @typedef {Object} UpdateCheckCache
 * @property {string} latestVersion
 * @property {number} checkedAt
 */

/**
 * @typedef {Object} RunWieldReleaseMetadata
 * @property {string} tagName
 * @property {string} version
 */

/**
 * @typedef {Object} ParsedRunWieldVersion
 * @property {number} major
 * @property {number} minor
 * @property {number} patch
 * @property {number | null} rc
 * @property {boolean} stable
 * @property {string} normalized
 */

/** @param {string} version */
export function normalizeRunWieldVersion(version) {
    const value = String(version || "").trim();
    if (!value) return "";
    return value.startsWith("v") ? value : `v${value}`;
}

/**
 * @param {string} version
 * @returns {ParsedRunWieldVersion | null}
 */
export function parseRunWieldReleaseVersion(version) {
    const normalized = normalizeRunWieldVersion(version);
    const match = /^v(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/.exec(normalized);
    if (!match) return null;
    const rc = match[4] === undefined ? null : Number(match[4]);
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        rc,
        stable: rc === null,
        normalized,
    };
}

/**
 * @param {ParsedRunWieldVersion} a
 * @param {ParsedRunWieldVersion} b
 */
function compareParsedVersions(a, b) {
    const majorDelta = a.major - b.major;
    if (majorDelta !== 0) return majorDelta;
    const minorDelta = a.minor - b.minor;
    if (minorDelta !== 0) return minorDelta;
    const patchDelta = a.patch - b.patch;
    if (patchDelta !== 0) return patchDelta;
    if (a.stable && !b.stable) return 1;
    if (!a.stable && b.stable) return -1;
    return (a.rc ?? 0) - (b.rc ?? 0);
}

/**
 * @param {string} leftVersion
 * @param {string} rightVersion
 * @returns {number | null}
 */
export function compareRunWieldVersions(leftVersion, rightVersion) {
    const left = parseRunWieldReleaseVersion(leftVersion);
    const right = parseRunWieldReleaseVersion(rightVersion);
    if (!left || !right) return null;
    return compareParsedVersions(left, right);
}

/**
 * @param {string} latestVersion
 * @param {string} currentVersion
 */
export function isNewerRunWieldVersion(latestVersion, currentVersion) {
    const comparison = compareRunWieldVersions(latestVersion, currentVersion);
    if (comparison !== null) return comparison > 0;
    const latest = parseRunWieldReleaseVersion(latestVersion);
    if (!latest) return false;
    return normalizeRunWieldVersion(currentVersion) !== latest.normalized;
}

export function getUpdateCheckCachePath() {
    return join(getSettingsDir("global"), UPDATE_CHECK_CACHE_FILENAME);
}

/**
 * @param {unknown} value
 * @returns {UpdateCheckCache | null}
 */
function normalizeCacheRecord(value) {
    if (!value || typeof value !== "object") return null;
    const record = /** @type {{ latestVersion?: unknown, checkedAt?: unknown }} */ (value);
    if (typeof record.latestVersion !== "string" || typeof record.checkedAt !== "number") return null;
    const latestVersion = normalizeRunWieldVersion(record.latestVersion);
    if (!parseRunWieldReleaseVersion(latestVersion) || !Number.isFinite(record.checkedAt)) return null;
    return { latestVersion, checkedAt: record.checkedAt };
}

/**
 * @param {string} text
 * @param {number} now
 * @param {number} ttlMs
 */
function parseFreshCacheText(text, now, ttlMs) {
    const parsed = JSON.parse(text);
    const record = normalizeCacheRecord(parsed);
    if (!record) return null;
    if (record.checkedAt > now || now - record.checkedAt > ttlMs) return null;
    return record;
}

/**
 * @param {UpdateCheckClockPort} clock
 * @param {{ ttlMs?: number, cachePath?: string }} [options]
 * @returns {UpdateCheckCache | null}
 */
export function readUpdateCheckCacheSync(clock, options = {}) {
    const now = clock.now();
    const ttlMs = options.ttlMs ?? UPDATE_CHECK_CACHE_TTL_MS;
    const cachePath = options.cachePath || getUpdateCheckCachePath();
    try {
        return parseFreshCacheText(fsReadFileSync(cachePath, "utf8"), now, ttlMs);
    } catch (_error) {
        return null;
    }
}

/**
 * @param {UpdateCheckClockPort} clock
 * @param {{ ttlMs?: number, cachePath?: string }} [options]
 * @returns {Promise<UpdateCheckCache | null>}
 */
export async function readUpdateCheckCache(clock, options = {}) {
    const now = clock.now();
    const ttlMs = options.ttlMs ?? UPDATE_CHECK_CACHE_TTL_MS;
    const cachePath = options.cachePath || getUpdateCheckCachePath();
    try {
        return parseFreshCacheText(await fsReadFile(cachePath, "utf8"), now, ttlMs);
    } catch (_error) {
        return null;
    }
}

/**
 * @param {{ latestVersion: string, checkedAt: number, cachePath?: string }} options
 */
export async function writeUpdateCheckCache(options) {
    const cachePath = options.cachePath || getUpdateCheckCachePath();
    const latestVersion = normalizeRunWieldVersion(options.latestVersion);
    if (!parseRunWieldReleaseVersion(latestVersion)) {
        throw new Error(`Invalid RunWield release version: ${options.latestVersion}`);
    }
    const checkedAt = options.checkedAt;
    await fsMkdir(dirname(cachePath), { recursive: true });
    await fsWriteFile(cachePath, `${JSON.stringify({ latestVersion, checkedAt }, null, 2)}\n`);
}

/**
 * @param {{ currentVersion: string, ttlMs?: number, cachePath?: string }} options
 * @param {UpdateCheckCache | null} cache
 */
function updateAvailabilityFromCache(options, cache) {
    if (!cache) return null;
    return {
        latestVersion: cache.latestVersion,
        available: isNewerRunWieldVersion(cache.latestVersion, options.currentVersion),
        checkedAt: cache.checkedAt,
    };
}

/**
 * @param {UpdateCheckClockPort} clock
 * @param {{ currentVersion: string, ttlMs?: number, cachePath?: string }} options
 */
export function getCachedUpdateAvailabilitySync(clock, options) {
    return updateAvailabilityFromCache(options, readUpdateCheckCacheSync(clock, options));
}

/**
 * @param {UpdateCheckClockPort} clock
 * @param {{ currentVersion: string, ttlMs?: number, cachePath?: string }} options
 */
export async function getCachedUpdateAvailability(clock, options) {
    return updateAvailabilityFromCache(options, await readUpdateCheckCache(clock, options));
}

/** @param {string} url */
function releaseTagFromGitHubReleaseUrl(url) {
    const match = /\/releases\/tag\/([^/?#]+)/.exec(String(url || ""));
    if (!match) return null;
    try {
        return decodeURIComponent(match[1]);
    } catch (_error) {
        return match[1];
    }
}

/** @param {string} html */
function releaseTagFromGitHubReleaseHtml(html) {
    const match = /\/releases\/tag\/([^"'<>?#]+)/.exec(html);
    if (!match) return null;
    try {
        return decodeURIComponent(match[1]);
    } catch (_error) {
        return match[1];
    }
}

/** @param {string} tag */
function releaseMetadataFromTag(tag) {
    const tagName = normalizeRunWieldVersion(tag);
    if (!parseRunWieldReleaseVersion(tagName)) throw new Error(`Invalid RunWield latest release tag: ${tag}`);
    return { tagName, version: tagName };
}

/** @typedef {{ tag_name?: string, prerelease?: boolean, draft?: boolean }} GitHubReleaseRecord */

/**
 * @param {GitHubReleaseRecord} release
 * @returns {RunWieldReleaseMetadata | null}
 */
function rcMetadataFromReleaseRecord(release) {
    if (release.draft || !release.prerelease || typeof release.tag_name !== "string") return null;
    const parsed = parseRunWieldReleaseVersion(release.tag_name);
    if (!parsed || parsed.stable) return null;
    return { tagName: parsed.normalized, version: parsed.normalized };
}

/**
 * @param {string} html
 * @returns {RunWieldReleaseMetadata | null}
 */
function latestRcMetadataFromReleaseHtml(html) {
    let latest = null;
    for (const match of html.matchAll(/\/releases\/tag\/([^"'<>?#]+)/g)) {
        let tag = match[1];
        try {
            tag = decodeURIComponent(tag);
        } catch (_error) {
            // Use the tag as published when it is not URI encoded correctly.
        }
        const parsed = parseRunWieldReleaseVersion(tag);
        if (!parsed || parsed.stable) continue;
        const candidate = { tagName: parsed.normalized, version: parsed.normalized };
        const comparison = latest ? compareRunWieldVersions(candidate.version, latest.version) : 1;
        if (comparison !== null && comparison > 0) latest = candidate;
    }
    return latest;
}

/**
 * @param {Response} response
 * @returns {Promise<RunWieldReleaseMetadata>}
 */
async function releaseMetadataFromLatestWebResponse(response) {
    const redirectedTag = releaseTagFromGitHubReleaseUrl(response.url) ||
        releaseTagFromGitHubReleaseUrl(response.headers.get("location") || "");
    if (redirectedTag) return releaseMetadataFromTag(redirectedTag);

    const htmlTag = releaseTagFromGitHubReleaseHtml(await response.text());
    if (htmlTag) return releaseMetadataFromTag(htmlTag);

    throw new Error("GitHub latest release web response is missing a release tag redirect.");
}

/**
 * @param {UpdateCheckNetworkPort} network
 * @returns {Promise<RunWieldReleaseMetadata>}
 */
export async function fetchLatestRunWieldRelease(network) {
    const fetchImpl = network.fetch;
    const response = await fetchImpl(LATEST_RELEASE_API_URL);
    if (response.ok) {
        const data = await response.json();
        if (!data || typeof data.tag_name !== "string") {
            throw new Error("GitHub latest release response is missing tag_name.");
        }
        return releaseMetadataFromTag(data.tag_name);
    }

    if (response.status !== 403) throw new Error(`GitHub latest release request failed: ${response.status}`);

    const webResponse = await fetchImpl(LATEST_RELEASE_WEB_URL, {
        headers: { accept: "text/html" },
        redirect: "follow",
    });
    if (!webResponse.ok) {
        throw new Error(
            `GitHub latest release request failed: ${response.status}; web fallback failed: ${webResponse.status}`,
        );
    }
    return await releaseMetadataFromLatestWebResponse(webResponse);
}

/**
 * @param {UpdateCheckNetworkPort} network
 * @returns {Promise<RunWieldReleaseMetadata>}
 */
export async function fetchLatestRunWieldRcRelease(network) {
    const response = await network.fetch(RELEASES_API_URL);
    /** @type {RunWieldReleaseMetadata | null} */
    let latest = null;

    if (response.ok) {
        const data = await response.json();
        if (!Array.isArray(data)) throw new Error("GitHub releases response is not a release list.");
        for (const release of data) {
            const candidate = rcMetadataFromReleaseRecord(/** @type {GitHubReleaseRecord} */ (release));
            if (!candidate) continue;
            const comparison = latest ? compareRunWieldVersions(candidate.version, latest.version) : 1;
            if (comparison !== null && comparison > 0) latest = candidate;
        }
    } else {
        if (response.status !== 403) throw new Error(`GitHub releases request failed: ${response.status}`);
        const webResponse = await network.fetch(RELEASES_WEB_URL, {
            headers: { accept: "text/html" },
            redirect: "follow",
        });
        if (!webResponse.ok) {
            throw new Error(
                `GitHub releases request failed: ${response.status}; web fallback failed: ${webResponse.status}`,
            );
        }
        latest = latestRcMetadataFromReleaseHtml(await webResponse.text());
    }

    if (!latest) throw new Error("No RunWield release candidate is published.");
    return latest;
}

/**
 * @param {{ currentVersion: string, cachePath?: string }} options
 * @param {UpdateCheckPorts} ports
 */
export async function refreshUpdateCheckCache(options, ports) {
    const release = await fetchLatestRunWieldRelease(ports.network);
    const checkedAt = ports.clock.now();
    try {
        await writeUpdateCheckCache({ latestVersion: release.version, checkedAt, cachePath: options.cachePath });
    } catch (_error) {
        // Update checks should survive read-only or temporarily unavailable config directories.
    }
    return {
        latestVersion: release.version,
        available: isNewerRunWieldVersion(release.version, options.currentVersion),
        checkedAt,
    };
}

/** @param {string} tag */
export function getTagPinnedInstallerUrls(tag) {
    const normalized = normalizeRunWieldVersion(tag);
    if (!parseRunWieldReleaseVersion(normalized)) throw new Error(`Invalid RunWield release tag: ${tag}`);
    return [
        TAG_PINNED_INSTALLER_URL_TEMPLATE.replace("{tag}", normalized),
        TAG_PINNED_INSTALLER_WEB_URL_TEMPLATE.replace("{tag}", normalized),
    ];
}

/** @param {string} execPath */
export function getInstalledWldDirectoryFromExecPath(execPath) {
    const path = String(execPath || "");
    const name = path.startsWith("file:") ? fromFileUrl(path).split("/").at(-1) : path.split("/").at(-1);
    if (name !== "wld") return null;
    return dirname(path.startsWith("file:") ? fromFileUrl(path) : path);
}
