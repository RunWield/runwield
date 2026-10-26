import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { sha256Bytes } from "../../../scripts/build-metadata.ts";
import type { ArtifactMetadata } from "../../../scripts/build-metadata.ts";
import { getHomeDir } from "../../constants.js";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { captureForegroundProcess } from "../captured-process.ts";
import {
    type LauncherIdentity,
    obtainReleaseRuntime,
    releaseRuntimeCacheDirectory,
    releaseRuntimeName,
} from "./release-artifact.ts";

const TAG = "v1.2.3";
const SUFFIX = "linux-x64";
const NAME = releaseRuntimeName(TAG, SUFFIX);
const LAUNCHER: LauncherIdentity = { buildId: "a".repeat(64), protocol: 1, version: TAG };

interface CacheFixture {
    root: string;
    archive: Uint8Array;
    checksum: string;
    cache: string;
}

async function pack(root: string, overrides: Partial<ArtifactMetadata> = {}): Promise<Uint8Array> {
    const stage = await mkdtemp(join(root, "archive-"));
    const binary = new TextEncoder().encode("verified runtime");
    await writeFile(join(stage, "wld"), binary);
    await writeFile(
        join(stage, "wld.build.json"),
        JSON.stringify({
            schema: 1,
            ...LAUNCHER,
            target: "x86_64-unknown-linux-gnu",
            sha256: await sha256Bytes(binary),
            ...overrides,
        }),
    );
    const archive = join(stage, "runtime.tar.gz");
    const result = await captureForegroundProcess("tar", {
        cwd: root,
        args: ["-czf", archive, "-C", stage, "wld", "wld.build.json"],
    });
    if (result.code !== 0) throw new Error("Could not create release fixture");
    return new Uint8Array(await readFile(archive));
}

async function checksumFor(archive: Uint8Array): Promise<string> {
    return `${await sha256Bytes(archive)}  ${NAME}\n`;
}

async function withCacheFixture(run: (fixture: CacheFixture) => Promise<void>): Promise<void> {
    await withProcessGlobalTestLock(async () => {
        const root = await mkdtemp(join(tmpdir(), "runtime-cache-"));
        const home = process.env.HOME;
        const originalFetch = globalThis.fetch;
        try {
            process.env.HOME = join(root, "home");
            await mkdir(getHomeDir(), { recursive: true });
            const archive = await pack(root);
            await run({
                root,
                archive,
                checksum: await checksumFor(archive),
                cache: releaseRuntimeCacheDirectory(TAG, SUFFIX),
            });
        } finally {
            if (home === undefined) delete process.env.HOME;
            else process.env.HOME = home;
            globalThis.fetch = originalFetch;
            await rm(root, { recursive: true, force: true });
        }
    });
}

type FetchInput = Parameters<typeof fetch>[0];

function setFetch(handler: (input: FetchInput) => Promise<Response>): void {
    globalThis.fetch = Object.assign(handler, { preconnect: globalThis.fetch.preconnect });
}

function serve(fixture: CacheFixture): void {
    const url = `https://github.com/gandazgul/runwield/releases/download/${TAG}/${NAME}`;
    const available = new Set([url, `${url}.sha256`]);
    setFetch((input) => {
        if (!available.delete(String(input))) {
            return Promise.reject(new Error(`Release is no longer available: ${String(input)}`));
        }
        if (String(input) === url) return Promise.resolve(new Response(new Uint8Array(fixture.archive)));
        if (String(input) === `${url}.sha256`) return Promise.resolve(new Response(fixture.checksum));
        return Promise.reject(new Error(`Unexpected release URL: ${String(input)}`));
    });
}

function offline(): void {
    setFetch(() => Promise.reject(new Error("Network is unavailable")));
}

async function seed(fixture: CacheFixture): Promise<void> {
    await mkdir(fixture.cache, { recursive: true });
    await writeFile(join(fixture.cache, NAME), fixture.archive);
    await writeFile(join(fixture.cache, `${NAME}.sha256`), fixture.checksum);
}

async function obtainAndClean(): Promise<void> {
    const runtime = await obtainReleaseRuntime(TAG, SUFFIX, LAUNCHER);
    try {
        assertEquals(await readFile(runtime.artifact, "utf8"), "verified runtime");
        assertEquals(runtime.metadata.buildId, LAUNCHER.buildId);
    } finally {
        await rm(runtime.directory, { recursive: true });
    }
}

test("downloaded runtime remains usable offline after caller removes its extraction", async () => {
    await withCacheFixture(async (fixture) => {
        assertEquals(fixture.cache, join(getHomeDir(), ".cache/runwield/remote/runtime", TAG, SUFFIX));
        serve(fixture);
        await obtainAndClean();
        assertEquals(new Uint8Array(await readFile(join(fixture.cache, NAME))), fixture.archive);
        assertEquals(await readFile(join(fixture.cache, `${NAME}.sha256`), "utf8"), fixture.checksum);
        offline();
        await obtainAndClean();
    });
});

test("release gate can seed a cache without a download or URL override", async () => {
    await withCacheFixture(async (fixture) => {
        await seed(fixture);
        offline();
        await obtainAndClean();
    });
});

for (const corruption of ["archive", "checksum", "extra line", "leading space", "missing checksum", "invalid tar"]) {
    test(`replaces a cache with ${corruption} corruption from one fresh release`, async () => {
        await withCacheFixture(async (fixture) => {
            await seed(fixture);
            if (corruption === "archive") await writeFile(join(fixture.cache, NAME), "truncated");
            if (corruption === "checksum") await writeFile(join(fixture.cache, `${NAME}.sha256`), "0".repeat(64));
            if (corruption === "extra line") {
                await writeFile(join(fixture.cache, `${NAME}.sha256`), fixture.checksum + fixture.checksum);
            }
            if (corruption === "leading space") {
                await writeFile(join(fixture.cache, `${NAME}.sha256`), ` ${fixture.checksum}`);
            }
            if (corruption === "missing checksum") await rm(join(fixture.cache, `${NAME}.sha256`));
            if (corruption === "invalid tar") {
                const bytes = new TextEncoder().encode("not a tar archive");
                await writeFile(join(fixture.cache, NAME), bytes);
                await writeFile(join(fixture.cache, `${NAME}.sha256`), await checksumFor(bytes));
            }
            serve(fixture);
            await obtainAndClean();
            assertEquals(new Uint8Array(await readFile(join(fixture.cache, NAME))), fixture.archive);
            assertEquals(await readFile(join(fixture.cache, `${NAME}.sha256`), "utf8"), fixture.checksum);
            offline();
            await obtainAndClean();
        });
    });
}

test("a cached archive must match the current launcher identity on every hit", async () => {
    await withCacheFixture(async (fixture) => {
        await seed(fixture);
        offline();
        await assertRejects(
            () => obtainReleaseRuntime(TAG, SUFFIX, { ...LAUNCHER, buildId: "b".repeat(64) }),
            Error,
            "Network is unavailable",
        );
        assertEquals(existsSync(fixture.cache), false);
    });
});

test("replaces cached metadata with a bad binary checksum even when the archive checksum is valid", async () => {
    await withCacheFixture(async (fixture) => {
        const archive = await pack(fixture.root, { sha256: "b".repeat(64) });
        await seed({ ...fixture, archive, checksum: await checksumFor(archive) });
        serve(fixture);
        await obtainAndClean();
        offline();
        await obtainAndClean();
    });
});

test("prunes other VERSION directories only after the current download is fully verified", async () => {
    await withCacheFixture(async (fixture) => {
        const previous = releaseRuntimeCacheDirectory("v1.2.2", SUFFIX);
        const unrelated = join(dirname(dirname(fixture.cache)), "notes");
        await mkdir(previous, { recursive: true });
        await writeFile(join(previous, "keep"), "previous runtime");
        await mkdir(unrelated);
        serve({ ...fixture, checksum: "invalid" });
        await assertRejects(() => obtainReleaseRuntime(TAG, SUFFIX, LAUNCHER), Error, "checksum mismatch");
        assertEquals(await readFile(join(previous, "keep"), "utf8"), "previous runtime");
        assertEquals(existsSync(fixture.cache), false);
        serve(fixture);
        await obtainAndClean();
        assertEquals(existsSync(dirname(previous)), false);
        assertEquals(existsSync(unrelated), true);
    });
});

test("a fully verified cache hit also prunes stale VERSION directories", async () => {
    await withCacheFixture(async (fixture) => {
        await seed(fixture);
        const previous = releaseRuntimeCacheDirectory("v1.2.2", "linux-arm64");
        await mkdir(previous, { recursive: true });
        offline();
        await obtainAndClean();
        assertEquals(existsSync(dirname(previous)), false);
    });
});

const BAD_IDENTITIES: Partial<ArtifactMetadata>[] = [
    { buildId: "b".repeat(64) },
    { protocol: 2 },
    { version: "v1.2.2" },
    { target: "aarch64-unknown-linux-gnu" },
    { sha256: "b".repeat(64) },
];
for (const identity of BAD_IDENTITIES) {
    test(`rejects download identity ${JSON.stringify(identity)} without publishing or pruning`, async () => {
        await withCacheFixture(async (fixture) => {
            const previous = releaseRuntimeCacheDirectory("v1.2.2", SUFFIX);
            await mkdir(previous, { recursive: true });
            const archive = await pack(fixture.root, identity);
            const extractions = (await readdir(tmpdir())).filter((name) => name.startsWith("wld-remote-release-"));
            serve({ ...fixture, archive, checksum: await checksumFor(archive) });
            await assertRejects(() => obtainReleaseRuntime(TAG, SUFFIX, LAUNCHER), Error);
            assertEquals(
                (await readdir(tmpdir())).filter((name) => name.startsWith("wld-remote-release-")),
                extractions,
            );
            assertEquals(existsSync(fixture.cache), false);
            assertEquals(await readdir(dirname(fixture.cache)), []);
            assertEquals(existsSync(previous), true);
        });
    });
}

test("a corrupt cache gets no repeated download after a bad replacement", async () => {
    await withCacheFixture(async (fixture) => {
        await seed({ ...fixture, checksum: "corrupt" });
        serve({ ...fixture, checksum: "still corrupt" });
        await assertRejects(() => obtainReleaseRuntime(TAG, SUFFIX, LAUNCHER), Error, "checksum mismatch");
        assertEquals(existsSync(fixture.cache), false);
        assertEquals(await readdir(dirname(fixture.cache)), []);
    });
});

test("a failed network response never publishes a partial cache pair", async () => {
    await withCacheFixture(async (fixture) => {
        setFetch((input) =>
            Promise.resolve(
                String(input).endsWith(".sha256")
                    ? new Response("unavailable", { status: 503 })
                    : new Response(new Uint8Array(fixture.archive)),
            ),
        );
        await assertRejects(() => obtainReleaseRuntime(TAG, SUFFIX, LAUNCHER), Error, "HTTP 503");
        assertEquals(existsSync(fixture.cache), false);
        assertEquals(await readdir(dirname(fixture.cache)), []);
    });
});

test("concurrent callers share a complete verified cache and own separate extractions", async () => {
    await withCacheFixture(async (fixture) => {
        let suppliedArchive = false;
        let suppliedChecksum = false;
        setFetch(async (input) => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            if (String(input).endsWith(".sha256")) {
                if (suppliedChecksum) throw new Error("The network is now offline");
                suppliedChecksum = true;
                return new Response(fixture.checksum);
            }
            if (suppliedArchive) throw new Error("The network is now offline");
            suppliedArchive = true;
            return new Response(new Uint8Array(fixture.archive));
        });
        const results = await Promise.all([
            obtainReleaseRuntime(TAG, SUFFIX, LAUNCHER),
            obtainReleaseRuntime(TAG, SUFFIX, LAUNCHER),
        ]);
        try {
            assertEquals(results[0].directory === results[1].directory, false);
            await rm(results[0].directory, { recursive: true });
            assertEquals(await readFile(results[1].artifact, "utf8"), "verified runtime");
        } finally {
            await Promise.all(results.map((runtime) => rm(runtime.directory, { recursive: true, force: true })));
        }
        offline();
        await obtainAndClean();
    });
});

test(
    "an unreadable runtime cache is kept rather than treated as corrupt",
    { skip: process.platform === "win32" || process.getuid?.() === 0 },
    async () => {
        await withCacheFixture(async (fixture) => {
            await seed(fixture);
            const archive = join(fixture.cache, NAME);
            await chmod(archive, 0);
            try {
                await assertRejects(() => obtainReleaseRuntime(TAG, SUFFIX, LAUNCHER), Error, "EACCES");
            } finally {
                await chmod(archive, 0o600);
            }
            assertEquals(new Uint8Array(await readFile(archive)), fixture.archive);
        });
    },
);
