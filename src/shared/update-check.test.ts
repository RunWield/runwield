import { readFile as fsReadFile, mkdtemp as fsMkdtemp, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertEquals, assertRejects } from "../testing/assertions.ts";
import {
    fetchLatestRunWieldRcRelease,
    fetchLatestRunWieldRelease,
    getCachedUpdateAvailability,
    getTagPinnedInstallerUrls,
    isNewerRunWieldVersion,
    LATEST_RELEASE_API_URL,
    LATEST_RELEASE_WEB_URL,
    normalizeRunWieldVersion,
    parseRunWieldReleaseVersion,
    readUpdateCheckCache,
    refreshUpdateCheckCache,
    RELEASES_API_URL,
    RELEASES_WEB_URL,
    writeUpdateCheckCache,
} from "./update-check.js";

import type { FetchRequest } from "./fetch-request.ts";

function fixedClock(value: number) {
    return { now: () => value };
}

function updatePorts(fetch: FetchRequest, now = 10) {
    return { network: { fetch }, clock: fixedClock(now) };
}

test("normalizes RunWield release versions", () => {
    assertEquals(normalizeRunWieldVersion("1.2.3"), "v1.2.3");
    assertEquals(normalizeRunWieldVersion("v1.2.3-rc.4"), "v1.2.3-rc.4");
    assertEquals(parseRunWieldReleaseVersion("v1.2.3"), {
        major: 1,
        minor: 2,
        patch: 3,
        rc: null,
        stable: true,
        normalized: "v1.2.3",
    });
});

test("compares stable and candidate release versions", () => {
    assertEquals(isNewerRunWieldVersion("v1.2.4", "v1.2.3"), true);
    assertEquals(isNewerRunWieldVersion("v1.2.3", "v1.2.3"), false);
    assertEquals(isNewerRunWieldVersion("v1.2.3", "v1.2.4"), false);
    assertEquals(isNewerRunWieldVersion("v1.2.3", "v1.2.3-rc.2"), true);
    assertEquals(isNewerRunWieldVersion("v1.2.3-rc.2", "v1.2.3-rc.1"), true);
    assertEquals(isNewerRunWieldVersion("v1.2.3-rc.1", "v1.2.3"), false);
});

test("non-release current versions are updateable when they differ from latest", () => {
    assertEquals(isNewerRunWieldVersion("v1.2.3", "abc1234"), true);
    assertEquals(isNewerRunWieldVersion("v1.2.3", "1.2.3"), false);
});

test("cache reads fresh valid metadata and rejects stale or malformed data", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-update-cache-"));
    try {
        const cachePath = `${dir}/update-check.json`;
        await writeUpdateCheckCache({ latestVersion: "1.2.3", checkedAt: 1000, cachePath });
        assertEquals(await readUpdateCheckCache(fixedClock(2000), { ttlMs: 5000, cachePath }), {
            latestVersion: "v1.2.3",
            checkedAt: 1000,
        });
        assertEquals(await readUpdateCheckCache(fixedClock(7000), { ttlMs: 5000, cachePath }), null);

        await fsWriteFile(cachePath, "not json");
        assertEquals(await readUpdateCheckCache(fixedClock(2000), { ttlMs: 5000, cachePath }), null);

        await fsWriteFile(cachePath, JSON.stringify({ latestVersion: "bad", checkedAt: 1000 }));
        assertEquals(await readUpdateCheckCache(fixedClock(2000), { ttlMs: 5000, cachePath }), null);
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("cached availability recomputes against current version", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-update-availability-"));
    try {
        const cachePath = `${dir}/update-check.json`;
        await writeUpdateCheckCache({ latestVersion: "v2.0.0", checkedAt: 1000, cachePath });
        assertEquals(await getCachedUpdateAvailability(fixedClock(2000), { currentVersion: "v1.0.0", cachePath }), {
            latestVersion: "v2.0.0",
            available: true,
            checkedAt: 1000,
        });
        assertEquals(await getCachedUpdateAvailability(fixedClock(2000), { currentVersion: "v2.0.0", cachePath }), {
            latestVersion: "v2.0.0",
            available: false,
            checkedAt: 1000,
        });
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("refresh fetches GitHub latest and ignores cache write failures", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchRequest = (url) => {
        calls.push(String(url));
        return Promise.resolve(new Response(JSON.stringify({ tag_name: "v3.0.0" }), { status: 200 }));
    };
    const root = await fsMkdtemp(join(tmpdir(), "runwield-cache-write-failure-"));
    try {
        const regularFile = join(root, "not-a-directory");
        await fsWriteFile(regularFile, "preserved");
        const result = await refreshUpdateCheckCache(
            { currentVersion: "v2.0.0", cachePath: join(regularFile, "update-check.json") },
            updatePorts(fetchImpl),
        );
        assertEquals(calls, [LATEST_RELEASE_API_URL]);
        assertEquals(result.available, true);
        assertEquals(result.latestVersion, "v3.0.0");
        assertEquals(result.checkedAt, 10);
        assertEquals(await fsReadFile(regularFile, "utf8"), "preserved");
    } finally {
        await fsRm(root, { recursive: true });
    }
});

test("latest API rejects malformed release data", async () => {
    const fetchImpl = () => Promise.resolve(new Response(JSON.stringify({ name: "RunWield" }), { status: 200 }));
    await assertRejects(
        () => refreshUpdateCheckCache({ currentVersion: "v1.0.0" }, updatePorts(fetchImpl)),
        Error,
        "tag_name",
    );
});

test("latest release lookup falls back to GitHub web redirect after API 403", async () => {
    const calls: string[] = [];
    const webResponse = new Response("", { status: 200 });
    Object.defineProperty(webResponse, "url", {
        value: "https://github.com/gandazgul/runwield/releases/tag/v4.5.6",
    });
    const fetchImpl: FetchRequest = (url) => {
        calls.push(String(url));
        return Promise.resolve(
            String(url) === LATEST_RELEASE_API_URL ? new Response("forbidden", { status: 403 }) : webResponse,
        );
    };

    assertEquals(
        await fetchLatestRunWieldRelease({
            fetch: fetchImpl,
        }),
        {
            tagName: "v4.5.6",
            version: "v4.5.6",
        },
    );
    assertEquals(calls, [LATEST_RELEASE_API_URL, LATEST_RELEASE_WEB_URL]);
});

test("latest RC lookup selects the highest published candidate", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchRequest = (url) => {
        calls.push(String(url));
        return Promise.resolve(
            new Response(
                JSON.stringify([
                    { tag_name: "v1.2.3-rc.1", prerelease: true, draft: false },
                    { tag_name: "v1.2.3", prerelease: false, draft: false },
                    { tag_name: "v1.2.4-rc.2", prerelease: true, draft: false },
                    { tag_name: "v1.2.4-rc.3", prerelease: true, draft: true },
                ]),
                { status: 200 },
            ),
        );
    };

    assertEquals(
        await fetchLatestRunWieldRcRelease({
            fetch: fetchImpl,
        }),
        {
            tagName: "v1.2.4-rc.2",
            version: "v1.2.4-rc.2",
        },
    );
    assertEquals(calls, [RELEASES_API_URL]);
});

test("latest RC lookup falls back to the releases page when the API rate limit is exhausted", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchRequest = (url) => {
        calls.push(String(url));
        if (String(url) === RELEASES_API_URL) return Promise.resolve(new Response("rate limited", { status: 403 }));
        return Promise.resolve(
            new Response(
                '<a href="/gandazgul/runwield/releases/tag/v1.2.3">Stable</a>' +
                    '<a href="/gandazgul/runwield/releases/tag/v1.2.4-rc.2">Candidate</a>' +
                    '<a href="/gandazgul/runwield/releases/tag/v1.2.4-rc.1">Older candidate</a>',
                { status: 200 },
            ),
        );
    };

    assertEquals(
        await fetchLatestRunWieldRcRelease({
            fetch: fetchImpl,
        }),
        {
            tagName: "v1.2.4-rc.2",
            version: "v1.2.4-rc.2",
        },
    );
    assertEquals(calls, [RELEASES_API_URL, RELEASES_WEB_URL]);
});

test("latest RC lookup reports when no candidate is published", async () => {
    const fetchImpl = () => Promise.resolve(new Response(JSON.stringify([{ tag_name: "v1.2.3", prerelease: false }])));
    await assertRejects(
        () =>
            fetchLatestRunWieldRcRelease({
                fetch: fetchImpl,
            }),
        Error,
        "No RunWield release candidate is published.",
    );
});

test("constructs tag-pinned installer URLs", () => {
    assertEquals(getTagPinnedInstallerUrls("1.2.3"), [
        "https://raw.githubusercontent.com/gandazgul/runwield/v1.2.3/install.sh",
        "https://github.com/gandazgul/runwield/raw/refs/tags/v1.2.3/install.sh",
    ]);
});
