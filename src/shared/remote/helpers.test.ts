import { test } from "node:test";
import { strict as assert } from "node:assert";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { getHomeDir } from "../../constants.js";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import {
    writeFixtureHelperModule,
    writeRemoteHelperArtifacts,
    seedLaptopHelpers,
    seedRemoteHelpers,
} from "../../testing/remote-helper-fixture.ts";
import { remoteHelperPins, remoteHelperPaths } from "./helpers.ts";
import { prepareRemoteFiles } from "./runtime.js";
import type { RemoteHelper } from "./helpers.ts";

const PLATFORM = { os: "Linux", arch: "x86_64" };

interface HelperFixture {
    root: string;
    artifacts: string;
    home: string;
    module: typeof import("./helpers.ts");
    helpers: RemoteHelper[];
}

async function fixture(run: (fixture: HelperFixture) => Promise<void>): Promise<void> {
    await withProcessGlobalTestLock(async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), "helper-supply-")));
        const oldHome = process.env.HOME;
        const oldFetch = globalThis.fetch;
        const oldPath = process.env.PATH;
        try {
            const home = join(root, "home");
            await mkdir(home);
            process.env.HOME = home;
            const artifacts = join(root, "artifacts");
            const data = await writeRemoteHelperArtifacts(artifacts);
            const source = await writeFixtureHelperModule(root, data.manifestPath);
            const module = await import(pathToFileURL(source).href);
            await seedLaptopHelpers(artifacts, home, data.pins);
            globalThis.fetch = Object.assign(() => Promise.reject(new Error("offline")), {
                preconnect: oldFetch.preconnect,
            });
            const helpers = await module.obtainRemoteHelpers(PLATFORM);
            await run({ root, artifacts, home, module, helpers });
        } finally {
            if (oldHome === undefined) delete process.env.HOME;
            else process.env.HOME = oldHome;
            process.env.PATH = oldPath;
            globalThis.fetch = oldFetch;
            await rm(root, { recursive: true, force: true });
        }
    });
}

function serveArtifacts(f: HelperFixture, corrupt = ""): void {
    globalThis.fetch = Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
            const url = String(input);
            const pin = f.helpers.find(({ pin }) => pin.url === url || pin.licenseUrl === url)?.pin;
            if (!pin) return new Response("not found", { status: 404 });
            const name = url === pin.url ? "archive.tar.gz" : "LICENSE";
            return new Response(
                new Uint8Array(
                    name === corrupt
                        ? new TextEncoder().encode("corrupt")
                        : await readFile(join(f.artifacts, pin.name, name)),
                ),
            );
        },
        { preconnect: globalThis.fetch.preconnect },
    );
}

test("pinned Linux helpers have both architectures and verified archive, binary and license identities", () => {
    for (const arch of ["x86_64", "aarch64"]) {
        const pins = remoteHelperPins({ os: "Linux", arch });
        assert.deepEqual(
            pins.map((pin) => pin.name),
            ["cymbal", "ketch"],
        );
        for (const pin of pins) {
            assert.match(pin.sha256, /^[a-f0-9]{64}$/);
            assert.match(pin.binarySha256, /^[a-f0-9]{64}$/);
            assert.match(pin.licenseSha256, /^[a-f0-9]{64}$/);
            assert.equal(pin.license, "MIT");
            const paths = remoteHelperPaths(pin, "/server");
            assert.equal(
                paths.remote,
                `/server/.cache/runwield/helpers/${pin.name}/${pin.version}/${pin.target}/${pin.sha256}`,
            );
            assert.equal(paths.laptop.startsWith(join(getHomeDir(), ".cache/runwield/remote/helpers")), true);
            assert.equal(paths.laptop.includes(".wld"), false);
            assert.equal(paths.remote.endsWith(paths.cacheParts.join("/")), true);
        }
    }
});

test("warm laptop supplies both helper binaries and notices without network", async () => {
    await fixture(async ({ module, helpers, artifacts }) => {
        const second = await module.obtainRemoteHelpers(PLATFORM);
        assert.equal(second.length, 2);
        assert.deepEqual(second, helpers);
        for (const helper of second) {
            assert.deepEqual(
                new Uint8Array(helper.binary),
                new Uint8Array(await readFile(join(artifacts, helper.pin.name, helper.pin.binary))),
            );
            assert.deepEqual(
                new Uint8Array(helper.notice),
                new Uint8Array(await readFile(join(artifacts, helper.pin.name, "LICENSE"))),
            );
        }
    });
});

test("a pinned archive with a different expected binary digest is not accepted", async () => {
    await fixture(async (f) => {
        f.module.remoteHelperPins(PLATFORM)[0].binarySha256 = "0".repeat(64);
        serveArtifacts(f);
        await assert.rejects(f.module.obtainRemoteHelpers(PLATFORM), /binary checksum mismatch/);
    });
});

test("cold laptop downloads and caches verified archives and licenses for offline repair", async () => {
    await fixture(async (f) => {
        for (const { pin } of f.helpers) await rm(f.module.remoteHelperPaths(pin, "").laptop, { recursive: true });
        serveArtifacts(f);
        assert.deepEqual(await f.module.obtainRemoteHelpers(PLATFORM), f.helpers);
        globalThis.fetch = Object.assign(() => Promise.reject(new Error("offline")), {
            preconnect: globalThis.fetch.preconnect,
        });
        assert.deepEqual(await f.module.obtainRemoteHelpers(PLATFORM), f.helpers);
    });
});

for (const name of ["archive.tar.gz", "LICENSE"]) {
    test(`corrupt cached ${name} is replaced and never accepted offline`, async () => {
        await fixture(async (f) => {
            const cache = f.module.remoteHelperPaths(f.helpers[0].pin, "").laptop;
            await writeFile(join(cache, name), "damaged");
            await assert.rejects(f.module.obtainRemoteHelpers(PLATFORM), /offline/);
            serveArtifacts(f);
            assert.deepEqual(await f.module.obtainRemoteHelpers(PLATFORM), f.helpers);
        });
    });
    test(`untrusted downloaded ${name} fails without publishing a cache`, async () => {
        await fixture(async (f) => {
            const cache = f.module.remoteHelperPaths(f.helpers[0].pin, "").laptop;
            await rm(cache, { recursive: true });
            serveArtifacts(f, name);
            await assert.rejects(f.module.obtainRemoteHelpers(PLATFORM), /checksum mismatch/);
            await assert.rejects(readFile(join(cache, name)), /ENOENT/);
        });
    });
}

async function installFixtureSsh(f: HelperFixture): Promise<void> {
    const bin = join(f.root, "bin");
    await mkdir(bin);
    // Real Python protocol runs on the server HOME. tee records whether payload bytes were sent.
    await writeFile(
        join(bin, "ssh"),
        `#!/bin/sh\n[ "$1" = -T ] && [ "$2" = -- ] && [ "$3" = server ] || exit 42\ntee '${f.root}/transfer' | sh -c "$4"\n`,
    );
    await chmod(join(bin, "ssh"), 0o700);
    process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
}

test(
    "private helper installation is atomic, reuses without payload, and repairs abandoned stages and damage",
    { skip: process.platform === "win32" },
    async () => {
        await fixture(async (f) => {
            await installFixtureSsh(f);
            await f.module.prepareRemoteHelpers("server", f.home, f.helpers);
            const path = f.module.remoteHelperPaths(f.helpers[1].pin, f.home).remote;
            const first = await readFile(join(f.root, "transfer"));
            assert.equal(first.includes(f.helpers[1].binary), true);
            assert.equal(await readFile(join(path, "LICENSE"), "utf8"), new TextDecoder().decode(f.helpers[1].notice));
            await f.module.prepareRemoteHelpers("server", f.home, f.helpers);
            const reused = await readFile(join(f.root, "transfer"), "utf8");
            assert.equal(reused.trim().split("\n").length, 1);
            assert.equal(JSON.parse(reused).kind, "helper");
            const abandoned = join(dirname(path), `.stage-${f.helpers[1].pin.sha256}-abandoned`);
            await mkdir(abandoned);
            await writeFile(join(abandoned, "LICENSE"), "interrupted");
            await writeFile(join(path, ".stage-abandoned"), "interrupted");
            await writeFile(join(path, "LICENSE"), "damaged");
            await f.module.prepareRemoteHelpers("server", f.home, f.helpers);
            assert.equal((await readdir(path)).includes(".stage-abandoned"), false);
            await assert.rejects(readdir(abandoned), /ENOENT/);
            const verified = await f.module.verifiedRemoteHelperPath(PLATFORM, "/usr/bin");
            assert.equal(
                verified,
                [...f.helpers.map(({ pin }) => f.module.remoteHelperPaths(pin, f.home).remote), "/usr/bin"].join(":"),
            );
        });
    },
);

for (const failure of ["checksum", "notice", "preflight", "truncated"]) {
    test(
        `failed helper ${failure} transfer publishes no executable or notice`,
        { skip: process.platform === "win32" },
        async () => {
            await fixture(async (f) => {
                await installFixtureSsh(f);
                const { pin, binary, notice } = f.helpers[0];
                const payload = failure === "preflight" ? new TextEncoder().encode("#!/bin/sh\nexit 7\n") : binary;
                const { sha256Bytes } = await import("../../../scripts/build-metadata.ts");
                const paths = f.module.remoteHelperPaths(pin, f.home);
                await assert.rejects(
                    prepareRemoteFiles(
                        "server",
                        {
                            kind: "helper",
                            cacheParts: paths.cacheParts,
                            files: [
                                {
                                    name: pin.binary,
                                    sha256:
                                        failure === "preflight"
                                            ? await sha256Bytes(payload)
                                            : failure === "checksum"
                                              ? "0".repeat(64)
                                              : pin.binarySha256,
                                    size: payload.length + (failure === "truncated" ? 1 : 0),
                                    executable: true,
                                },
                                {
                                    name: "LICENSE",
                                    sha256: failure === "notice" ? "0".repeat(64) : pin.licenseSha256,
                                    size: notice.length,
                                    executable: false,
                                },
                            ],
                        },
                        [payload, notice],
                    ),
                    failure === "preflight" ? /preflight failed/ : /checksum mismatch|Incomplete/,
                );
                await assert.rejects(readFile(`${paths.remote}/${pin.binary}`), /ENOENT/);
                await assert.rejects(readFile(`${paths.remote}/LICENSE`), /ENOENT/);
            });
        },
    );
}

for (const damage of ["missing", "binary", "license", "not executable", "symlink", "directory"]) {
    test(
        `supervisor refuses ${damage} private helper and asks to reconnect`,
        { skip: process.platform === "win32" },
        async () => {
            await fixture(async (f) => {
                await seedRemoteHelpers(
                    f.artifacts,
                    f.home,
                    f.helpers.map(({ pin }) => pin),
                );
                const path = f.module.remoteHelperPaths(f.helpers[0].pin, f.home).remote;
                if (damage === "missing") await rm(join(path, "cymbal"));
                if (damage === "binary") await writeFile(join(path, "cymbal"), "damaged");
                if (damage === "license") await writeFile(join(path, "LICENSE"), "damaged");
                if (damage === "not executable") await chmod(join(path, "cymbal"), 0o600);
                if (damage === "symlink") {
                    await rm(join(path, "cymbal"));
                    await symlink(join(f.artifacts, "cymbal/cymbal"), join(path, "cymbal"));
                }
                if (damage === "directory") {
                    await rm(join(path, "cymbal"));
                    await mkdir(join(path, "cymbal"));
                }
                await assert.rejects(f.module.verifiedRemoteHelperPath(PLATFORM, "/usr/bin"), /Reconnect to repair/);
                await installFixtureSsh(f);
                await f.module.prepareRemoteHelpers("server", f.home, f.helpers);
                assert.equal((await f.module.verifiedRemoteHelperPath(PLATFORM, "system")).endsWith(":system"), true);
            });
        },
    );
}

test(
    "ARM64 private helpers use the same verified preparation and PATH contract",
    { skip: process.platform === "win32" },
    async () => {
        await fixture(async (f) => {
            await installFixtureSsh(f);
            const platform = { os: "Linux", arch: "aarch64" };
            const helpers = await f.module.obtainRemoteHelpers(platform);
            await f.module.prepareRemoteHelpers("server", f.home, helpers);
            assert.equal((await f.module.verifiedRemoteHelperPath(platform, "system")).endsWith(":system"), true);
            assert.equal(
                helpers.every(({ pin }) => pin.target === "aarch64-unknown-linux-gnu"),
                true,
            );
        });
    },
);

test("helper installation rejects an untrusted SSH cache locator", { skip: process.platform === "win32" }, async () => {
    await fixture(async (f) => {
        await installFixtureSsh(f);
        await writeFile(
            join(f.root, "bin/ssh"),
            '#!/bin/sh\nread header\nprintf \'{"ok":true,"reused":true,"path":"/tmp/untrusted"}\\n\'\n',
        );
        await assert.rejects(f.module.prepareRemoteHelpers("server", f.home, f.helpers), /unexpected cache path/);
    });
});

test(
    "helper cache repairs executable permissions and serializes simultaneous connections",
    { skip: process.platform === "win32" },
    async () => {
        await fixture(async (f) => {
            await installFixtureSsh(f);
            await Promise.all([
                f.module.prepareRemoteHelpers("server", f.home, f.helpers),
                f.module.prepareRemoteHelpers("server", f.home, f.helpers),
            ]);
            const path = f.module.remoteHelperPaths(f.helpers[0].pin, f.home).remote;
            await chmod(join(path, "cymbal"), 0o600);
            await chmod(join(path, "LICENSE"), 0o666);
            await f.module.prepareRemoteHelpers("server", f.home, f.helpers);
            assert.equal((await f.module.verifiedRemoteHelperPath(PLATFORM, "system")).endsWith(":system"), true);
        });
    },
);

test("a reused helper must still pass its real --help preflight", { skip: process.platform === "win32" }, async () => {
    await fixture(async (f) => {
        await installFixtureSsh(f);
        await f.module.prepareRemoteHelpers("server", f.home, f.helpers);
        const original = process.env.REMOTE_HELPER_FIXTURE_DENY_HELP;
        try {
            process.env.REMOTE_HELPER_FIXTURE_DENY_HELP = "1";
            await assert.rejects(f.module.prepareRemoteHelpers("server", f.home, f.helpers), /preflight failed/);
        } finally {
            if (original === undefined) delete process.env.REMOTE_HELPER_FIXTURE_DENY_HELP;
            else process.env.REMOTE_HELPER_FIXTURE_DENY_HELP = original;
        }
    });
});

test(
    "an unreadable helper cache is kept rather than treated as corrupt",
    { skip: process.platform === "win32" || process.getuid?.() === 0 },
    async () => {
        await fixture(async (f) => {
            const archive = join(f.module.remoteHelperPaths(f.helpers[0].pin, f.home).laptop, "archive.tar.gz");
            const original = await readFile(archive);
            await chmod(archive, 0);
            try {
                await assert.rejects(f.module.obtainRemoteHelpers(PLATFORM), /EACCES/);
            } finally {
                await chmod(archive, 0o600);
            }
            assert.deepEqual(await readFile(archive), original);
        });
    },
);
