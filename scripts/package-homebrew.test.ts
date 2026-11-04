import { serveHttp } from "../src/shared/http-server.ts";
import { test } from "node:test";
import { tmpdir } from "node:os";
import {
    copyFile as fsCopyFile,
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    readdir as fsReaddir,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "../src/testing/assertions.ts";
import { join } from "node:path";
import { packageHomebrew, parsePackageHomebrewArgs } from "./package-homebrew.ts";
import type { ExistingRunWieldPackage, HomebrewInputs, MnemotecaInput } from "./package-homebrew.ts";
import type { FetchRequest } from "../src/shared/fetch-request.ts";
import { defineCommittedGitFixture } from "../src/shared/git-test-fixture.ts";

interface PackageManifest extends ExistingRunWieldPackage {
    formulas: string[];
}

interface EditableMnemotecaInput extends Omit<MnemotecaInput, "license"> {
    license?: string;
}

interface EditableHomebrewInputs extends Omit<HomebrewInputs, "mnemoteca"> {
    mnemoteca: EditableMnemotecaInput;
}

async function sha256Text(bytes: Uint8Array): Promise<string> {
    const input = new Uint8Array(bytes.length);
    input.set(bytes);
    const hash = await crypto.subtle.digest("SHA-256", input.buffer);
    return Array.from(new Uint8Array(hash))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

async function writeAsset(root: string, name: string, text: string): Promise<string> {
    const bytes = new TextEncoder().encode(text);
    await fsWriteFile(join(root, name), bytes);
    return await sha256Text(bytes);
}

async function makeReleaseFixture(tag = "v1.2.3") {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-homebrew-release-"));
    async function add(name: string, text: string): Promise<string> {
        return await writeAsset(root, name, text);
    }

    const wldArm = await add(`wld-${tag}-darwin-arm64.tar.gz`, "wld arm");
    const wldX64 = await add(`wld-${tag}-darwin-x64.tar.gz`, "wld x64");
    await add(`wld-${tag}-darwin-arm64.tar.gz.sha256`, `${wldArm}  wld-${tag}-darwin-arm64.tar.gz\n`);
    await add(`wld-${tag}-darwin-x64.tar.gz.sha256`, `${wldX64}  wld-${tag}-darwin-x64.tar.gz\n`);
    const memArm = await add("mnemoteca_0.3.1_darwin_arm64.tar.gz", "memory arm");
    const memX64 = await add("mnemoteca_0.3.1_darwin_amd64.tar.gz", "memory x64");

    const requests: string[] = [];
    const abort = new AbortController();
    const server = serveHttp(
        { port: 0, hostname: "127.0.0.1", signal: abort.signal, onListen() {} },
        async (request) => {
            const path = new URL(request.url).pathname.slice(1);
            requests.push(path);
            try {
                return new Response(await fsReadFile(join(root, path)));
            } catch {
                return new Response("not found", { status: 404 });
            }
        },
    );
    const port = server.addr.port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const inputsPath = join(root, "inputs.json");
    await fsWriteFile(
        inputsPath,
        JSON.stringify({
            mnemoteca: {
                tag: "v0.3.1",
                license: "MIT",
                homepage: "https://github.com/gandazgul/mnemoteca",
                assets: {
                    "darwin-arm64": {
                        url: `${baseUrl}/mnemoteca_0.3.1_darwin_arm64.tar.gz`,
                        sha256: memArm,
                    },
                    "darwin-x64": {
                        url: `${baseUrl}/mnemoteca_0.3.1_darwin_amd64.tar.gz`,
                        sha256: memX64,
                    },
                },
            },
            homebrewDependencies: {
                cymbal: { formula: "1broseidon/tap/cymbal", testedVersion: "v0.7.7" },
            },
        }),
    );
    return {
        root,
        baseUrl,
        inputsPath,
        requests,
        close: async () => {
            abort.abort();
            await server.finished.catch(() => {});
            await fsRm(root, { recursive: true });
        },
    };
}

test("package:homebrew renders formulas from verified immutable assets", async () => {
    const fixture = await makeReleaseFixture();
    try {
        const output = join(fixture.root, "tap");
        await packageHomebrew({
            wldTag: "v1.2.3",
            mnemotecaTag: "v0.3.1",
            output,
            inputsPath: fixture.inputsPath,
            wldBaseUrl: fixture.baseUrl,
            mnemotecaBaseUrl: fixture.baseUrl,
            testOnly: true,
        });

        const wld = await fsReadFile(join(output, "Formula", "wld.rb"), "utf8");
        const mnemoteca = await fsReadFile(join(output, "Formula", "mnemoteca.rb"), "utf8");
        assertStringIncludes(wld, "class Wld < Formula");
        assertStringIncludes(wld, '  version "1.2.3"\n');
        assertStringIncludes(wld, 'depends_on "gandazgul/tap/mnemoteca"');
        assertStringIncludes(wld, 'depends_on "ketch"');
        assertEquals(wld.includes("1broseidon/tap/ketch"), false);
        const dependencies = Array.from(wld.matchAll(/depends_on "([^"]+)"/g), (match) => match[1]);
        assertEquals(dependencies, [...dependencies].sort(), "Formula dependencies must be alphabetized");
        assertStringIncludes(wld, "runwield-install.json");
        assertStringIncludes(wld, "brew upgrade gandazgul/tap/wld");
        assertStringIncludes(wld, 'license "MIT"');
        assertStringIncludes(wld, "depends_on :macos");
        assertStringIncludes(wld, "# test-only artifact; do not publish this formula");
        assertStringIncludes(mnemoteca, "class Mnemoteca < Formula");
        assertStringIncludes(mnemoteca, '  version "0.3.1"\n');
        assertStringIncludes(mnemoteca, "depends_on :macos");
        assertStringIncludes(mnemoteca, "mnemoteca_0.3.1_darwin_arm64.tar.gz");
        const manifest: PackageManifest = JSON.parse(
            await fsReadFile(join(output, "runwield-homebrew-package.json"), "utf8"),
        );
        assertEquals(manifest.testOnly, true);
        assertEquals(manifest.formulas, ["Formula/wld.rb", "Formula/mnemoteca.rb"]);
    } finally {
        await fixture.close();
    }
});

test("package:homebrew rejects publishable RC tags before emitting output", async () => {
    const fixture = await makeReleaseFixture();
    try {
        await assertRejects(
            () =>
                packageHomebrew({
                    wldTag: "v1.2.3-rc.1",
                    mnemotecaTag: "v0.3.1",
                    output: join(fixture.root, "tap"),
                    inputsPath: fixture.inputsPath,
                    testOnly: false,
                }),
            Error,
            "Stable tag",
        );
    } finally {
        await fixture.close();
    }
});

test("package:homebrew validates Candidate bytes only as test output", async () => {
    const fixture = await makeReleaseFixture();
    try {
        for (const arch of ["darwin-arm64", "darwin-x64"]) {
            const oldName = `wld-v1.2.3-${arch}.tar.gz`;
            const name = `wld-v1.2.3-rc.1-${arch}.tar.gz`;
            await fsCopyFile(join(fixture.root, oldName), join(fixture.root, name));
            await fsWriteFile(
                join(fixture.root, `${name}.sha256`),
                (await fsReadFile(join(fixture.root, `${oldName}.sha256`), "utf8")).replace(oldName, name),
            );
        }
        const output = join(fixture.root, "tap");
        await packageHomebrew({
            wldTag: "v1.2.3-rc.1",
            mnemotecaTag: "v0.3.1",
            output,
            inputsPath: fixture.inputsPath,
            testOnly: true,
            wldBaseUrl: fixture.baseUrl,
            mnemotecaBaseUrl: fixture.baseUrl,
        });
        const manifest: PackageManifest = JSON.parse(
            await fsReadFile(join(output, "runwield-homebrew-package.json"), "utf8"),
        );
        assertEquals(manifest.wldTag, "v1.2.3-rc.1");
        const wld = await fsReadFile(join(output, "Formula", "wld.rb"), "utf8");
        assertStringIncludes(wld, "wld-v1.2.3-rc.1-darwin-arm64.tar.gz");
        assertEquals(/^ {2}version /m.test(wld), false, "Candidate URL already gives Homebrew the exact version");
        assertEquals(manifest.testOnly, true);
    } finally {
        await fixture.close();
    }
});

test("package:homebrew rejects corrupt release bytes", async () => {
    const fixture = await makeReleaseFixture();
    try {
        await fsWriteFile(join(fixture.root, "wld-v1.2.3-darwin-arm64.tar.gz"), "corrupt");
        await assertRejects(
            () =>
                packageHomebrew({
                    wldTag: "v1.2.3",
                    mnemotecaTag: "v0.3.1",
                    output: join(fixture.root, "tap"),
                    inputsPath: fixture.inputsPath,
                    wldBaseUrl: fixture.baseUrl,
                    mnemotecaBaseUrl: fixture.baseUrl,
                    testOnly: true,
                }),
            Error,
            "Checksum mismatch",
        );
    } finally {
        await fixture.close();
    }
});

test("package:homebrew rejects incomplete platform assets", async () => {
    const fixture = await makeReleaseFixture();
    try {
        const inputs: EditableHomebrewInputs = JSON.parse(await fsReadFile(fixture.inputsPath, "utf8"));
        delete inputs.mnemoteca.assets["darwin-x64"];
        await fsWriteFile(fixture.inputsPath, JSON.stringify(inputs));
        await assertRejects(
            () =>
                packageHomebrew({
                    wldTag: "v1.2.3",
                    mnemotecaTag: "v0.3.1",
                    output: join(fixture.root, "tap"),
                    inputsPath: fixture.inputsPath,
                    wldBaseUrl: fixture.baseUrl,
                    mnemotecaBaseUrl: fixture.baseUrl,
                    testOnly: true,
                }),
            Error,
            "darwin-x64",
        );
    } finally {
        await fixture.close();
    }
});

test("package:homebrew rejects base URL overrides for publishable output", async () => {
    const fixture = await makeReleaseFixture();
    try {
        await assertRejects(
            () =>
                packageHomebrew({
                    wldTag: "v1.2.3",
                    mnemotecaTag: "v0.3.1",
                    output: join(fixture.root, "tap"),
                    inputsPath: fixture.inputsPath,
                    wldBaseUrl: fixture.baseUrl,
                    testOnly: false,
                }),
            Error,
            "Base URL overrides require --test-only",
        );
    } finally {
        await fixture.close();
    }
});

test("package:homebrew rejects missing publishable license metadata", async () => {
    const fixture = await makeReleaseFixture();
    try {
        const inputs: EditableHomebrewInputs = JSON.parse(await fsReadFile(fixture.inputsPath, "utf8"));
        delete inputs.mnemoteca.license;
        await fsWriteFile(fixture.inputsPath, JSON.stringify(inputs));
        await assertRejects(
            () =>
                packageHomebrew({
                    wldTag: "",
                    mnemotecaTag: "v0.3.1",
                    output: join(fixture.root, "tap"),
                    inputsPath: fixture.inputsPath,
                    mnemotecaBaseUrl: fixture.baseUrl,
                    testOnly: true,
                }),
            Error,
            "license and homepage",
        );
    } finally {
        await fixture.close();
    }
});

test("package:homebrew rejects publishable Mnemoteca refresh over test-only RunWield", async () => {
    const fixture = await makeReleaseFixture();
    try {
        const output = join(fixture.root, "tap");
        await fsMkdir(join(output, "Formula"), { recursive: true });
        await fsWriteFile(
            join(output, "Formula", "wld.rb"),
            'url "http://127.0.0.1/wld-v1.2.3-darwin-arm64.tar.gz"\n# test-only artifact; do not publish this formula\n',
        );
        await fsWriteFile(
            join(output, "runwield-homebrew-package.json"),
            JSON.stringify({ testOnly: true, wldTag: "v1.2.3", formulas: ["Formula/wld.rb"] }),
        );

        await assertRejects(
            () =>
                packageHomebrew({
                    wldTag: "",
                    mnemotecaTag: "v0.3.1",
                    output,
                    inputsPath: fixture.inputsPath,
                    testOnly: false,
                }),
            Error,
            "test-only RunWield formula",
        );
    } finally {
        await fixture.close();
    }
});

test("package:homebrew refreshes only Mnemoteca when wld tag is omitted", async () => {
    const fixture = await makeReleaseFixture();
    try {
        const output = join(fixture.root, "tap");
        await fsMkdir(join(output, "Formula"), { recursive: true });
        await fsWriteFile(join(output, "Formula", "wld.rb"), "preserved wld formula\n");
        await fsWriteFile(
            join(output, "runwield-homebrew-package.json"),
            JSON.stringify({ testOnly: true, wldTag: "v1.2.3", formulas: ["Formula/wld.rb"] }),
        );
        await packageHomebrew({
            wldTag: "",
            mnemotecaTag: "v0.3.1",
            output,
            inputsPath: fixture.inputsPath,
            mnemotecaBaseUrl: fixture.baseUrl,
            testOnly: true,
        });

        assertEquals(await fsReadFile(join(output, "Formula", "wld.rb"), "utf8"), "preserved wld formula\n");
        const mnemoteca = await fsReadFile(join(output, "Formula", "mnemoteca.rb"), "utf8");
        assertStringIncludes(mnemoteca, "class Mnemoteca < Formula");
        assertStringIncludes(mnemoteca, '  version "0.3.1"\n');
        const manifest: PackageManifest = JSON.parse(
            await fsReadFile(join(output, "runwield-homebrew-package.json"), "utf8"),
        );
        assertEquals(manifest.testOnly, true);
        assertEquals(manifest.wldTag, "v1.2.3");
        assertEquals(manifest.formulas, ["Formula/wld.rb", "Formula/mnemoteca.rb"]);
    } finally {
        await fixture.close();
    }
});

test("package:homebrew release workflow mixed URLs and publication versions", async () => {
    const fixture = await makeReleaseFixture();
    const realFetch = globalThis.fetch;
    // Keep release URLs in generated formulas; serve verified fixture bytes at the network boundary.
    const fixtureFetch: FetchRequest = (input, init) => {
        const url = String(input);
        const name = url
            .slice(url.lastIndexOf("/") + 1)
            .replace("0.3.3", "0.3.1")
            .replace("-rc.1", "");
        if (url.endsWith(".sha256")) {
            return realFetch(`${fixture.baseUrl}/${name}`, init).then(
                async (response) =>
                    new Response(
                        (await response.text()).replace("v1.2.3-", url.includes("-rc.1") ? "v1.2.3-rc.1-" : "v1.2.3-"),
                    ),
            );
        }
        return realFetch(`${fixture.baseUrl}/${name}`, init);
    };
    globalThis.fetch = Object.assign(fixtureFetch, realFetch);
    try {
        await fsWriteFile(
            fixture.inputsPath,
            (await fsReadFile(fixture.inputsPath, "utf8")).replaceAll("0.3.1", "0.3.3"),
        );
        for (const tag of ["v1.2.3", "v1.2.3-rc.1"]) {
            for (const mode of ["mixed", "remote-test", "publication"]) {
                const output = join(fixture.root, `${tag}-${mode}`);
                // Same arguments as release.yml: only RunWield has a local URL override.
                const args = ["--wld-tag", tag, "--mnemoteca-tag", "v0.3.3", "--output", output];
                if (mode !== "publication") args.push("--test-only");
                if (mode === "mixed") args.push("--wld-base-url", "http://127.0.0.1:8765");
                const options = parsePackageHomebrewArgs(args);
                options.inputsPath = fixture.inputsPath;
                if (mode === "publication" && tag.includes("-rc.")) {
                    await assertRejects(() => packageHomebrew(options), Error, "Stable tag");
                    continue;
                }
                await packageHomebrew(options);
                const wld = await fsReadFile(join(output, "Formula", "wld.rb"), "utf8");
                const mnemoteca = await fsReadFile(join(output, "Formula", "mnemoteca.rb"), "utf8");
                assertEquals(wld.includes('  version "'), mode === "mixed" && tag === "v1.2.3");
                assertEquals(mnemoteca.includes('  version "'), false);
                assertStringIncludes(mnemoteca, "https://github.com/gandazgul/mnemoteca/releases/download/v0.3.3/");
                assertStringIncludes(
                    wld,
                    mode === "mixed"
                        ? "http://127.0.0.1:8765/"
                        : `https://github.com/RunWield/runwield/releases/download/${tag}/`,
                );
            }
        }
    } finally {
        globalThis.fetch = realFetch;
        await fixture.close();
    }
});

for (const [tag, license] of [
    ["v0.1.0", '"MIT"'],
    ["v0.12.4", ":cannot_represent"],
    ["v0.14.0-rc.1", '"MIT"'],
    ["v0.14.0", '"MIT"'],
]) {
    test(`package:homebrew preserves the release license for ${tag}`, async () => {
        const fixture = await makeReleaseFixture(tag);
        try {
            const output = join(fixture.root, "tap");
            await packageHomebrew({
                wldTag: tag,
                mnemotecaTag: "v0.3.1",
                output,
                inputsPath: fixture.inputsPath,
                wldBaseUrl: fixture.baseUrl,
                mnemotecaBaseUrl: fixture.baseUrl,
                testOnly: true,
            });
            const formula = await fsReadFile(join(output, "Formula", "wld.rb"), "utf8");
            assertStringIncludes(formula, `license ${license}`);
        } finally {
            await fixture.close();
        }
    });
}

const tapFixture = defineCommittedGitFixture({
    "README.md": "Independent tap instructions\n",
    "Formula/extra.rb": "class Extra < Formula\nend\n",
    "Formula/wld.rb": "old wld formula\n",
    "extra.txt": "keep me\n",
});

async function seedMnemoteca(output: string, tag = "v0.3.4", repo = "RunWield/mnemoteca") {
    const version = tag.slice(1);
    await fsWriteFile(
        join(output, "Formula", "mnemoteca.rb"),
        `class Mnemoteca < Formula
  if Hardware::CPU.arm?
    url "https://github.com/${repo}/releases/download/${tag}/mnemoteca_${version}_darwin_arm64.tar.gz"
    sha256 "${"a".repeat(64)}"
  else
    url "https://github.com/${repo}/releases/download/${tag}/mnemoteca_${version}_darwin_amd64.tar.gz"
    sha256 "${"b".repeat(64)}"
  end
end
`,
    );
    await fsWriteFile(
        join(output, "runwield-homebrew-package.json"),
        JSON.stringify({
            wldTag: "v1.2.2",
            mnemotecaTag: tag,
            testOnly: false,
            generatedAt: "2020-01-01T00:00:00.000Z",
            formulas: ["Formula/wld.rb", "Formula/mnemoteca.rb", "Formula/extra.rb"],
            testedDependencies: { independent: { formula: "independent", testedVersion: "v9.8.7" } },
            independentMetadata: { releaseOwner: "Mnemoteca", keep: [1, 2] },
        }),
    );
}

async function snapshotTree(root: string, prefix = ""): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    for (const entry of await fsReaddir(join(root, prefix), { withFileTypes: true })) {
        const path = join(prefix, entry.name);
        if (entry.isDirectory()) Object.assign(files, await snapshotTree(root, path));
        else files[path] = (await fsReadFile(join(root, path))).toString("base64");
    }
    return files;
}

function withoutWldOwnedFiles(files: Record<string, string>) {
    const retained = { ...files };
    delete retained["Formula/wld.rb"];
    delete retained["runwield-homebrew-package.json"];
    return retained;
}

test("package:homebrew wld-only preserves newer Mnemoteca and independent tap content with stale inputs", async () => {
    const fixture = await makeReleaseFixture();
    const output = await tapFixture.checkout();
    try {
        await fsWriteFile(
            fixture.inputsPath,
            (await fsReadFile(fixture.inputsPath, "utf8")).replaceAll("0.3.1", "0.3.3"),
        );
        await seedMnemoteca(output);
        const before = await snapshotTree(output);
        const manifestPath = join(output, "runwield-homebrew-package.json");
        const manifestBefore = JSON.parse(await fsReadFile(manifestPath, "utf8"));
        await packageHomebrew(
            parsePackageHomebrewArgs([
                "--wld-tag",
                "v1.2.3",
                "--output",
                output,
                "--inputs",
                fixture.inputsPath,
                "--test-only",
                "--wld-base-url",
                fixture.baseUrl,
            ]),
        );
        const after = await snapshotTree(output);
        assertEquals(withoutWldOwnedFiles(after), withoutWldOwnedFiles(before));
        const wld = await fsReadFile(join(output, "Formula", "wld.rb"), "utf8");
        assertStringIncludes(wld, "wld-v1.2.3-darwin-arm64.tar.gz");
        assertStringIncludes(wld, "wld-v1.2.3-darwin-x64.tar.gz");
        const manifestAfter = JSON.parse(await fsReadFile(manifestPath, "utf8"));
        assertEquals(manifestAfter, {
            ...manifestBefore,
            wldTag: "v1.2.3",
            testOnly: true,
            generatedAt: manifestAfter.generatedAt,
        });
        assertEquals(manifestAfter.generatedAt === manifestBefore.generatedAt, false);
        assertEquals(
            fixture.requests.some((path) => path.includes("mnemoteca")),
            false,
        );
    } finally {
        await fixture.close();
        await fsRm(output, { recursive: true });
    }
});

for (const repo of ["gandazgul/mnemoteca", "RunWield/mnemoteca"]) {
    test(`package:homebrew wld-only preserves future ${repo} without an inputs file or dependency download`, async () => {
        const fixture = await makeReleaseFixture();
        const output = await tapFixture.checkout();
        const realFetch = globalThis.fetch;
        const requests: string[] = [];
        const fixtureFetch: FetchRequest = (input, init) => {
            const url = String(input);
            requests.push(url);
            if (!url.startsWith("https://github.com/RunWield/runwield/releases/download/v1.2.3/")) {
                throw new Error(`Unexpected dependency download: ${url}`);
            }
            return realFetch(`${fixture.baseUrl}/${url.slice(url.lastIndexOf("/") + 1)}`, init);
        };
        globalThis.fetch = Object.assign(fixtureFetch, realFetch);
        try {
            await seedMnemoteca(output, "v9.87.6", repo);
            const before = await snapshotTree(output);
            const manifestPath = join(output, "runwield-homebrew-package.json");
            const manifestBefore = JSON.parse(await fsReadFile(manifestPath, "utf8"));
            await packageHomebrew(
                parsePackageHomebrewArgs([
                    "--wld-tag",
                    "v1.2.3",
                    "--output",
                    output,
                    "--inputs",
                    join(fixture.root, "missing.json"),
                ]),
            );
            assertEquals(withoutWldOwnedFiles(await snapshotTree(output)), withoutWldOwnedFiles(before));
            const wld = await fsReadFile(join(output, "Formula", "wld.rb"), "utf8");
            assertStringIncludes(wld, "wld-v1.2.3-darwin-arm64.tar.gz");
            assertStringIncludes(wld, "wld-v1.2.3-darwin-x64.tar.gz");
            assertEquals(wld.includes('  version "'), false, "Release URLs provide the version");
            const manifestAfter = JSON.parse(await fsReadFile(manifestPath, "utf8"));
            assertEquals(manifestAfter, {
                ...manifestBefore,
                wldTag: "v1.2.3",
                generatedAt: manifestAfter.generatedAt,
            });
            assertEquals(requests.length, 4);
        } finally {
            globalThis.fetch = realFetch;
            await fixture.close();
            await fsRm(output, { recursive: true });
        }
    });
}

test("package:homebrew requires at least one tag and accepts either or both", async () => {
    for (const selection of [
        ["--wld-tag", "v1.2.3"],
        ["--mnemoteca-tag", "v0.3.4"],
        ["--wld-tag", "v1.2.3", "--mnemoteca-tag", "v0.3.4"],
    ]) {
        const options = parsePackageHomebrewArgs([...selection, "--output", "tap"]);
        assertEquals(Boolean(options.wldTag || options.mnemotecaTag), true);
    }
    assertThrows(() => parsePackageHomebrewArgs(["--output", "tap"]), Error, "at least one tag");
    await assertRejects(
        () =>
            packageHomebrew({
                wldTag: "",
                mnemotecaTag: "",
                output: "tap",
                inputsPath: "missing",
                testOnly: false,
            }),
        Error,
        "at least one tag",
    );
    assertThrows(
        () =>
            parsePackageHomebrewArgs([
                "--wld-tag",
                "v1.2.3",
                "--output",
                "tap",
                "--mnemoteca-base-url",
                "http://localhost",
            ]),
        Error,
        "requires --mnemoteca-tag",
    );
});

interface InvalidBaseCase {
    name: string;
    manifest?: string;
    formula?: (formula: string) => string;
    remove?: string;
}

const validBaseMetadata = {
    mnemotecaTag: "v0.3.4",
    testOnly: false,
    formulas: ["Formula/wld.rb", "Formula/mnemoteca.rb"],
};
const invalidBases: InvalidBaseCase[] = [
    { name: "missing manifest", remove: "runwield-homebrew-package.json" },
    { name: "missing formula", remove: "Formula/mnemoteca.rb" },
    { name: "malformed manifest", manifest: "{" },
    { name: "null manifest", manifest: "null" },
    { name: "missing tag", manifest: JSON.stringify({ ...validBaseMetadata, mnemotecaTag: undefined }) },
    { name: "non-string tag", manifest: JSON.stringify({ ...validBaseMetadata, mnemotecaTag: 34 }) },
    {
        name: "Candidate dependency",
        manifest: JSON.stringify({ ...validBaseMetadata, mnemotecaTag: "v0.3.4-rc.1" }),
        formula: (text) => text.replaceAll("0.3.4", "0.3.4-rc.1"),
    },
    { name: "missing test-only metadata", manifest: JSON.stringify({ ...validBaseMetadata, testOnly: undefined }) },
    { name: "malformed test-only metadata", manifest: JSON.stringify({ ...validBaseMetadata, testOnly: "false" }) },
    { name: "missing formula metadata", manifest: JSON.stringify({ ...validBaseMetadata, formulas: [] }) },
    { name: "test-only manifest", manifest: JSON.stringify({ ...validBaseMetadata, testOnly: true }) },
    { name: "test-only formula", formula: (text) => `${text}# test-only artifact; do not publish\n` },
    { name: "mismatched release tag", formula: (text) => text.replaceAll("v0.3.4/", "v0.3.3/") },
    { name: "untrusted repository", formula: (text) => text.replaceAll("RunWield/mnemoteca", "attacker/mnemoteca") },
    { name: "mutable release URL", formula: (text) => text.replaceAll("download/v0.3.4", "latest/download") },
    { name: "wrong version asset", formula: (text) => text.replaceAll("mnemoteca_0.3.4", "mnemoteca_0.3.3") },
    { name: "missing architecture", formula: (text) => text.replace(/ {2}else[\s\S]*? {2}end/, "  end") },
    { name: "duplicate architecture", formula: (text) => text.replaceAll("darwin_amd64", "darwin_arm64") },
    { name: "missing checksum", formula: (text) => text.replace(/ {4}sha256 "[^"]+"\n/, "") },
    { name: "malformed checksum", formula: (text) => text.replace("a".repeat(64), "not-a-checksum") },
    { name: "empty formula", formula: () => "" },
    {
        name: "surplus platform asset",
        formula: (text) =>
            text.replace(
                "class Mnemoteca < Formula",
                `class Mnemoteca < Formula
  on_linux do
    url "https://github.com/RunWield/mnemoteca/releases/download/v0.3.4/mnemoteca_0.3.4_linux_amd64.tar.gz"
    sha256 "${"c".repeat(64)}"
  end`,
            ),
    },
];
for (const scenario of invalidBases) {
    test(`package:homebrew wld-only rejects ${scenario.name} without writes or downloads`, async () => {
        const fixture = await makeReleaseFixture();
        const output = await tapFixture.checkout();
        const realFetch = globalThis.fetch;
        const requests: string[] = [];
        const fixtureFetch: FetchRequest = (input, init) => {
            const url = String(input);
            requests.push(url);
            return realFetch(`${fixture.baseUrl}/${url.slice(url.lastIndexOf("/") + 1)}`, init);
        };
        globalThis.fetch = Object.assign(fixtureFetch, realFetch);
        try {
            await seedMnemoteca(output);
            if (scenario.manifest !== undefined) {
                await fsWriteFile(join(output, "runwield-homebrew-package.json"), scenario.manifest);
            }
            if (scenario.formula) {
                const path = join(output, "Formula", "mnemoteca.rb");
                await fsWriteFile(path, scenario.formula(await fsReadFile(path, "utf8")));
            }
            if (scenario.remove) await fsRm(join(output, scenario.remove));
            const before = await snapshotTree(output);
            await assertRejects(
                () =>
                    packageHomebrew({
                        wldTag: "v1.2.3",
                        mnemotecaTag: "",
                        output,
                        inputsPath: fixture.inputsPath,
                        testOnly: false,
                    }),
                Error,
            );
            assertEquals(await snapshotTree(output), before);
            assertEquals(requests, []);
        } finally {
            globalThis.fetch = realFetch;
            await fixture.close();
            await fsRm(output, { recursive: true });
        }
    });
}

for (const arch of ["arm64", "x64"]) {
    test(`package:homebrew wld-only verifies ${arch} checksum before any writes`, async () => {
        const fixture = await makeReleaseFixture();
        const output = await tapFixture.checkout();
        try {
            await seedMnemoteca(output);
            await fsWriteFile(join(fixture.root, `wld-v1.2.3-darwin-${arch}.tar.gz`), "corrupt");
            const before = await snapshotTree(output);
            await assertRejects(
                () =>
                    packageHomebrew({
                        wldTag: "v1.2.3",
                        mnemotecaTag: "",
                        output,
                        inputsPath: fixture.inputsPath,
                        testOnly: true,
                        wldBaseUrl: fixture.baseUrl,
                    }),
                Error,
                "Checksum mismatch",
            );
            assertEquals(await snapshotTree(output), before);
        } finally {
            await fixture.close();
            await fsRm(output, { recursive: true });
        }
    });
}

for (const [tag, license] of [
    ["v0.1.0", '"MIT"'],
    ["v0.12.4", ":cannot_represent"],
    ["v0.14.0-rc.1", '"MIT"'],
    ["v0.14.0", '"MIT"'],
]) {
    test(`package:homebrew wld-only retains local version and license for ${tag}`, async () => {
        const fixture = await makeReleaseFixture(tag);
        const output = await tapFixture.checkout();
        try {
            await seedMnemoteca(output);
            await packageHomebrew({
                wldTag: tag,
                mnemotecaTag: "",
                output,
                inputsPath: "missing.json",
                wldBaseUrl: fixture.baseUrl,
                testOnly: true,
            });
            const formula = await fsReadFile(join(output, "Formula", "wld.rb"), "utf8");
            assertStringIncludes(formula, `license ${license}`);
            assertEquals(formula.includes('  version "'), !tag.includes("-rc."));
        } finally {
            await fixture.close();
            await fsRm(output, { recursive: true });
        }
    });
}

for (const rejection of ["Candidate", "wld override", "Mnemoteca override"]) {
    test(`package:homebrew wld-only rejects publishable ${rejection} without writes`, async () => {
        const fixture = await makeReleaseFixture();
        const output = await tapFixture.checkout();
        try {
            await seedMnemoteca(output);
            const before = await snapshotTree(output);
            await assertRejects(
                () =>
                    packageHomebrew({
                        wldTag: rejection === "Candidate" ? "v1.2.3-rc.1" : "v1.2.3",
                        mnemotecaTag: "",
                        output,
                        inputsPath: fixture.inputsPath,
                        testOnly: false,
                        wldBaseUrl: rejection === "wld override" ? fixture.baseUrl : undefined,
                        mnemotecaBaseUrl: rejection === "Mnemoteca override" ? fixture.baseUrl : undefined,
                    }),
                Error,
                rejection === "Candidate"
                    ? "Stable tag"
                    : rejection === "wld override"
                      ? "--test-only"
                      : "requires --mnemoteca-tag",
            );
            assertEquals(await snapshotTree(output), before);
        } finally {
            await fixture.close();
            await fsRm(output, { recursive: true });
        }
    });
}

test("package:homebrew wld-only retains a test-only base only in test mode", async () => {
    const fixture = await makeReleaseFixture();
    const output = await tapFixture.checkout();
    try {
        await seedMnemoteca(output);
        const manifestPath = join(output, "runwield-homebrew-package.json");
        const manifest = JSON.parse(await fsReadFile(manifestPath, "utf8"));
        await fsWriteFile(manifestPath, JSON.stringify({ ...manifest, testOnly: true }));
        const formulaPath = join(output, "Formula", "mnemoteca.rb");
        const formula = `${await fsReadFile(formulaPath, "utf8")}# test-only artifact; do not publish\n`;
        await fsWriteFile(formulaPath, formula);
        await packageHomebrew({
            wldTag: "v1.2.3",
            mnemotecaTag: "",
            output,
            inputsPath: "missing.json",
            testOnly: true,
            wldBaseUrl: fixture.baseUrl,
        });
        assertEquals(await fsReadFile(formulaPath, "utf8"), formula);
        const after: PackageManifest = JSON.parse(await fsReadFile(manifestPath, "utf8"));
        assertEquals(after.testOnly, true);
        assertEquals(after.wldTag, "v1.2.3");
    } finally {
        await fixture.close();
        await fsRm(output, { recursive: true });
    }
});

test("package:homebrew wld-only rejects a missing wld asset without writes", async () => {
    const fixture = await makeReleaseFixture();
    const output = await tapFixture.checkout();
    try {
        await seedMnemoteca(output);
        await fsRm(join(fixture.root, "wld-v1.2.3-darwin-x64.tar.gz"));
        const before = await snapshotTree(output);
        await assertRejects(() =>
            packageHomebrew({
                wldTag: "v1.2.3",
                mnemotecaTag: "",
                output,
                inputsPath: fixture.inputsPath,
                testOnly: true,
                wldBaseUrl: fixture.baseUrl,
            }),
        );
        assertEquals(await snapshotTree(output), before);
    } finally {
        await fixture.close();
        await fsRm(output, { recursive: true });
    }
});
