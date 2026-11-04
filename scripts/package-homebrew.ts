import { mkdir as fsMkdir, readFile as fsReadFile, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import process from "node:process";
/**
 * Render the owner Homebrew tap from immutable RunWield and Mnemoteca release assets.
 */

import { basename, join } from "node:path";
import { parseReleaseTag } from "./release.js";
import { releaseLicense } from "./release-license.ts";

const RUNWIELD_REPO = "RunWield/runwield";
const MNEMOTECA_REPO = "gandazgul/mnemoteca";
const DEFAULT_INPUTS_PATH = "packaging/homebrew/tested-dependencies.json";
const ARCHES = Object.freeze(["darwin-arm64", "darwin-x64"]);

export interface AssetInput {
    url: string;
    sha256: string;
}

export type PackageAssets = Record<string, AssetInput>;

export interface MnemotecaInput {
    tag: string;
    license: string;
    homepage: string;
    assets: PackageAssets;
}

export interface TestedDependencyInput {
    formula: string;
    testedVersion: string;
}

export interface HomebrewInputs {
    mnemoteca: MnemotecaInput;
    homebrewDependencies: Record<string, TestedDependencyInput>;
}

export interface HomebrewOptions {
    wldTag: string;
    mnemotecaTag: string;
    output: string;
    inputsPath: string;
    wldBaseUrl?: string;
    mnemotecaBaseUrl?: string;
    testOnly: boolean;
}

interface WldFormulaInput {
    version: string;
    assets: PackageAssets;
}

interface MnemotecaFormulaInput extends WldFormulaInput {
    license: string;
    homepage: string;
}

interface ExistingPackageManifest extends Partial<ExistingRunWieldPackage> {
    formulas?: string[];
}

function usage() {
    return [
        "Usage: package-homebrew.ts [--wld-tag <tag>] [--mnemoteca-tag <stable-tag>] --output <dir>",
        "       [--inputs <path>] [--wld-base-url <url>] [--mnemoteca-base-url <url>] [--test-only]",
        "       Supply at least one tag. A single tag refreshes only that package in an existing tap tree.",
    ].join("\n");
}

export function parsePackageHomebrewArgs(args: string[]): HomebrewOptions {
    const options: HomebrewOptions = {
        wldTag: "",
        mnemotecaTag: "",
        output: "",
        inputsPath: DEFAULT_INPUTS_PATH,
        testOnly: false,
    };
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--test-only") options.testOnly = true;
        else if (arg === "--wld-tag") options.wldTag = args[++index] || "";
        else if (arg === "--mnemoteca-tag") options.mnemotecaTag = args[++index] || "";
        else if (arg === "--output") options.output = args[++index] || "";
        else if (arg === "--inputs") options.inputsPath = args[++index] || "";
        else if (arg === "--wld-base-url") options.wldBaseUrl = args[++index] || "";
        else if (arg === "--mnemoteca-base-url") options.mnemotecaBaseUrl = args[++index] || "";
        else throw new Error(`Unknown package:homebrew option: ${arg}\n${usage()}`);
    }
    if ((!options.wldTag && !options.mnemotecaTag) || !options.output || !options.inputsPath) throw new Error(usage());
    if (!options.wldTag && options.wldBaseUrl) throw new Error("--wld-base-url requires --wld-tag.");
    if (!options.mnemotecaTag && options.mnemotecaBaseUrl) {
        throw new Error("--mnemoteca-base-url requires --mnemoteca-tag.");
    }
    return options;
}

function assertStableTag(tag: string) {
    const parsed = parseReleaseTag(tag);
    if (parsed.kind !== "stable") throw new Error(`Homebrew packages require a Stable tag: ${tag}`);
    return parsed;
}

function assetUrl(baseUrl: string, name: string) {
    return `${baseUrl.replace(/\/$/, "")}/${name}`;
}

function releaseBaseUrl(repo: string, tag: string, baseUrl: string | undefined) {
    return baseUrl || `https://github.com/${repo}/releases/download/${tag}`;
}

function assertReleasedAssetUrl(url: string, repo: string, tag: string) {
    const expected = `https://github.com/${repo}/releases/download/${tag}/`;
    if (!url.startsWith(expected)) throw new Error(`Publishable Homebrew asset must use ${expected}: ${url}`);
}

async function sha256(bytes: Uint8Array) {
    const input = new Uint8Array(bytes.length);
    input.set(bytes);
    const hash = await crypto.subtle.digest("SHA-256", input.buffer);
    return Array.from(new Uint8Array(hash))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

async function readUrlBytes(url: string) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed ${response.status}: ${url}`);
    return new Uint8Array(await response.arrayBuffer());
}

function checksumForAsset(text: string, assetName: string) {
    for (const line of text.split("\n")) {
        const [sum, name] = line.trim().split(/\s+/, 2);
        if (name === assetName && /^[0-9a-f]{64}$/i.test(sum)) return sum.toLowerCase();
    }
    throw new Error(`Checksum file is missing ${assetName}.`);
}

async function verifyAsset(url: string, expectedSha: string) {
    const bytes = await readUrlBytes(url);
    const actual = await sha256(bytes);
    if (actual !== expectedSha.toLowerCase()) {
        throw new Error(`Checksum mismatch for ${url}: expected ${expectedSha}, got ${actual}`);
    }
}

async function verifiedRunWieldAsset(baseUrl: string, assetName: string) {
    const shaUrl = assetUrl(baseUrl, `${assetName}.sha256`);
    const shaText = new TextDecoder().decode(await readUrlBytes(shaUrl));
    const expected = checksumForAsset(shaText, assetName);
    const url = assetUrl(baseUrl, assetName);
    await verifyAsset(url, expected);
    return { url, sha256: expected };
}

async function verifiedMnemotecaAssets(input: MnemotecaInput, baseUrl: string | undefined) {
    const assets: PackageAssets = {};
    for (const arch of ARCHES) {
        const current = input.assets[arch];
        if (!current?.url || !current.sha256) throw new Error(`Missing Mnemoteca asset input for ${arch}.`);
        const url = baseUrl ? assetUrl(baseUrl, basename(current.url)) : current.url;
        await verifyAsset(url, current.sha256);
        assets[arch] = { url, sha256: current.sha256.toLowerCase() };
    }
    return assets;
}

function assertNoPlaceholders(text: string) {
    if (/TODO|PLACEHOLDER|__[^_]+__/i.test(text)) throw new Error("Generated formula contains a placeholder.");
}

function validateInputs(inputs: HomebrewInputs, tag: string) {
    if (!inputs.mnemoteca?.tag || !inputs.mnemoteca.assets) throw new Error("Missing Mnemoteca input metadata.");
    if (inputs.mnemoteca.tag !== tag) {
        throw new Error(`Inputs contain ${inputs.mnemoteca.tag}, not requested Mnemoteca tag ${tag}.`);
    }
    if (!inputs.mnemoteca.license || !inputs.mnemoteca.homepage) {
        throw new Error("Mnemoteca inputs must include license and homepage.");
    }
    for (const [name, dependency] of Object.entries(inputs.homebrewDependencies || {})) {
        if (!dependency.formula || !dependency.testedVersion) {
            throw new Error(`Homebrew dependency ${name} must include formula and testedVersion.`);
        }
    }
}

function renderWldFormula(wld: WldFormulaInput, testOnly: boolean) {
    // Homebrew reads Candidate versions correctly, but mistakes Stable archive names for CPU versions.
    // GitHub release URLs and Candidate names already identify the version; repeating it fails brew audit.
    const releaseUrl = `https://github.com/${RUNWIELD_REPO}/releases/download/v${wld.version}/`;
    const versionDeclaration =
        !wld.version.includes("-rc.") && !Object.values(wld.assets).every((asset) => asset.url.startsWith(releaseUrl))
            ? `  version "${wld.version}"\n`
            : "";
    return `require "json"

class Wld < Formula
  desc "Plan-first AI coding harness"
  homepage "https://github.com/RunWield/runwield"
${versionDeclaration}  license ${releaseLicense(wld.version).homebrew}

  if Hardware::CPU.arm?
    url "${wld.assets["darwin-arm64"].url}"
    sha256 "${wld.assets["darwin-arm64"].sha256}"
  else
    url "${wld.assets["darwin-x64"].url}"
    sha256 "${wld.assets["darwin-x64"].sha256}"
  end

  depends_on "1broseidon/tap/cymbal"
  depends_on "agent-browser"
  depends_on "gandazgul/tap/mnemoteca"
  depends_on "git"
  depends_on "ketch"
  depends_on :macos

  def install
    libexec.install "wld"
    (libexec/"runwield-install.json").write JSON.pretty_generate({
      schemaVersion:     1,
      packageManager:    "homebrew",
      packageIdentifier: "gandazgul/tap/wld",
      updateCommand:     "brew upgrade gandazgul/tap/wld",
      repairCommand:     "brew reinstall gandazgul/tap/wld",
      installDirectory:  libexec.to_s,
      version:           "v#{version}",
    })
    bin.install_symlink libexec/"wld" => "wld"
  end

  test do
    assert_match "runwield", shell_output("#{bin}/wld --version")
    assert_match "brew upgrade gandazgul/tap/wld", shell_output("#{bin}/wld update")
  end
end
${testOnly ? "# test-only artifact; do not publish this formula\n" : ""}`;
}

function renderMnemotecaFormula(mnemoteca: MnemotecaFormulaInput) {
    const releaseUrl = `https://github.com/${MNEMOTECA_REPO}/releases/download/v${mnemoteca.version}/`;
    const versionDeclaration = Object.values(mnemoteca.assets).every((asset) => asset.url.startsWith(releaseUrl))
        ? ""
        : `  version "${mnemoteca.version}"\n`;
    return `class Mnemoteca < Formula
  desc "Local semantic memory CLI"
  homepage "${mnemoteca.homepage}"
${versionDeclaration}  license "${mnemoteca.license}"

  if Hardware::CPU.arm?
    url "${mnemoteca.assets["darwin-arm64"].url}"
    sha256 "${mnemoteca.assets["darwin-arm64"].sha256}"
  else
    url "${mnemoteca.assets["darwin-x64"].url}"
    sha256 "${mnemoteca.assets["darwin-x64"].sha256}"
  end

  depends_on :macos

  def install
    bin.install "mnemoteca"
  end

  test do
    ENV["MNEMOTECA_DB_PATH"] = testpath/"mnemoteca.sqlite3"
    assert_match "mnemoteca", shell_output(bin/"mnemoteca")
    system bin/"mnemoteca", "init", "--name", "homebrew-test"
  end
end
`;
}

function renderReadme() {
    return `# gandazgul/homebrew-tap

Homebrew tap source for independently released RunWield packages.

Install:

\`\`\`sh
brew install gandazgul/tap/wld
brew install gandazgul/tap/mnemoteca
\`\`\`

RunWield license: https://github.com/RunWield/runwield/blob/main/LICENSE

RunWield v0.14.0 and later use MIT metadata. Recovery of earlier releases preserves their original license metadata.

Refresh one package from this repository while preserving the other. Mnemoteca refresh requires matching verified
preparation inputs. Supplying both tags explicitly prepares both packages in a separate output directory.
Use a separate disposable copy for package checks: the checker stages and commits its input tree.
Publish only after full macOS qualification from the same tap revision; a concurrent update requires a fresh check.

Use a copy of the current tap:

\`\`\`sh
git clone https://github.com/RunWield/homebrew-tap.git <existing-tap-dir>
bun run package:homebrew --wld-tag <stable-tag> --output <existing-tap-dir>
bun run package:homebrew --mnemoteca-tag <stable-tag> --output <existing-tap-dir>
\`\`\`
`;
}

export interface ExistingRunWieldPackage {
    wldTag: string;
    testOnly: boolean;
}

async function readExistingRunWieldPackage(
    output: string,
    requestedTestOnly: boolean,
): Promise<ExistingRunWieldPackage> {
    const formulaPath = join(output, "Formula", "wld.rb");
    const manifestPath = join(output, "runwield-homebrew-package.json");
    const formula = await fsReadFile(formulaPath, "utf8").catch((error) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            throw new Error("Mnemoteca-only refresh requires an existing Formula/wld.rb.");
        }
        throw error;
    });
    const manifest: ExistingPackageManifest = JSON.parse(
        await fsReadFile(manifestPath, "utf8").catch((error) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
                throw new Error("Mnemoteca-only refresh requires an existing package manifest.");
            }
            throw error;
        }),
    );
    if (!manifest.wldTag || !Array.isArray(manifest.formulas) || !manifest.formulas.includes("Formula/wld.rb")) {
        throw new Error("Mnemoteca-only refresh requires a manifest that preserves Formula/wld.rb and wldTag.");
    }
    const parsed = assertStableTag(manifest.wldTag);
    if (manifest.testOnly && !requestedTestOnly) {
        throw new Error("Cannot refresh a test-only RunWield formula as publishable output.");
    }
    if (!requestedTestOnly) {
        if (formula.includes("test-only artifact")) {
            throw new Error("Cannot publish a preserved test-only RunWield formula.");
        }
        for (const url of formula.matchAll(/url "([^"]+)"/g)) assertReleasedAssetUrl(url[1], RUNWIELD_REPO, parsed.tag);
    }
    return { wldTag: parsed.tag, testOnly: Boolean(manifest.testOnly) || requestedTestOnly };
}

interface ExistingMnemotecaManifest {
    mnemotecaTag: string;
    testOnly: boolean;
    formulas: string[];
}

async function readExistingMnemotecaPackage(output: string, requestedTestOnly: boolean) {
    const manifest: ExistingMnemotecaManifest = JSON.parse(
        await fsReadFile(join(output, "runwield-homebrew-package.json"), "utf8"),
    );
    if (
        !manifest ||
        typeof manifest.mnemotecaTag !== "string" ||
        typeof manifest.testOnly !== "boolean" ||
        !Array.isArray(manifest.formulas) ||
        !manifest.formulas.includes("Formula/mnemoteca.rb")
    ) {
        throw new Error("RunWield-only refresh requires a valid Mnemoteca package manifest.");
    }
    const tag = assertStableTag(manifest.mnemotecaTag).tag;
    const formula = await fsReadFile(join(output, "Formula", "mnemoteca.rb"), "utf8");
    if (!requestedTestOnly && (manifest.testOnly || formula.includes("test-only artifact"))) {
        throw new Error("Cannot publish a preserved test-only Mnemoteca package.");
    }
    const pairs = Array.from(formula.matchAll(/\burl\s+"([^"]+)"\s+sha256\s+"([0-9a-f]{64})"/gi));
    if (
        pairs.length !== 2 ||
        Array.from(formula.matchAll(/\burl\s+/g)).length !== 2 ||
        Array.from(formula.matchAll(/\bsha256\s+/g)).length !== 2
    ) {
        throw new Error("Existing Mnemoteca formula requires two complete macOS URL/checksum pairs.");
    }
    for (const arch of ["arm64", "amd64"]) {
        const name = `mnemoteca_${tag.slice(1)}_darwin_${arch}.tar.gz`;
        if (
            !pairs.some((pair) =>
                [MNEMOTECA_REPO, "RunWield/mnemoteca"].some(
                    (repo) => pair[1] === `https://github.com/${repo}/releases/download/${tag}/${name}`,
                ),
            )
        ) {
            throw new Error(
                `Existing Mnemoteca formula must use matching immutable release URLs for ${tag} (${arch}).`,
            );
        }
    }
    return manifest;
}

async function verifiedWldAssets(options: HomebrewOptions, tag: string) {
    const assets: PackageAssets = {};
    const base = releaseBaseUrl(RUNWIELD_REPO, tag, options.wldBaseUrl);
    for (const arch of ARCHES) {
        assets[arch] = await verifiedRunWieldAsset(base, `wld-${tag}-${arch}.tar.gz`);
        if (!options.testOnly) assertReleasedAssetUrl(assets[arch].url, RUNWIELD_REPO, tag);
    }
    return assets;
}

export async function packageHomebrew(options: HomebrewOptions) {
    if (!options.wldTag && !options.mnemotecaTag) throw new Error(usage());
    if (!options.mnemotecaTag && options.mnemotecaBaseUrl) {
        throw new Error("--mnemoteca-base-url requires --mnemoteca-tag.");
    }
    if (!options.testOnly && (options.wldBaseUrl || options.mnemotecaBaseUrl)) {
        throw new Error("Base URL overrides require --test-only.");
    }
    const wldTag = options.wldTag
        ? options.testOnly
            ? parseReleaseTag(options.wldTag)
            : assertStableTag(options.wldTag)
        : null;
    if (wldTag && !options.mnemotecaTag) {
        const existing = await readExistingMnemotecaPackage(options.output, options.testOnly);
        const assets = await verifiedWldAssets(options, wldTag.tag);
        const formula = renderWldFormula({ version: wldTag.tag.slice(1), assets }, options.testOnly);
        assertNoPlaceholders(formula);
        await fsWriteFile(join(options.output, "Formula", "wld.rb"), formula);
        await fsWriteFile(
            join(options.output, "runwield-homebrew-package.json"),
            `${JSON.stringify(
                {
                    ...existing,
                    wldTag: wldTag.tag,
                    testOnly: options.testOnly,
                    generatedAt: new Date().toISOString(),
                },
                null,
                4,
            )}\n`,
        );
        return;
    }
    const mnemotecaTag = assertStableTag(options.mnemotecaTag);
    const inputs: HomebrewInputs = JSON.parse(await fsReadFile(options.inputsPath, "utf8"));
    validateInputs(inputs, mnemotecaTag.tag);
    const existingWld = wldTag ? null : await readExistingRunWieldPackage(options.output, options.testOnly);

    const mnemotecaBase = options.mnemotecaBaseUrl || releaseBaseUrl(MNEMOTECA_REPO, mnemotecaTag.tag, undefined);
    const mnemotecaAssets = await verifiedMnemotecaAssets(inputs.mnemoteca, mnemotecaBase);
    if (!options.testOnly) {
        for (const asset of Object.values(mnemotecaAssets)) {
            assertReleasedAssetUrl(asset.url, MNEMOTECA_REPO, mnemotecaTag.tag);
        }
    }

    const wldAssets = wldTag ? await verifiedWldAssets(options, wldTag.tag) : {};

    const formulaDir = join(options.output, "Formula");
    const readmePath = join(options.output, "README.md");
    if (wldTag) {
        await fsRm(options.output, { recursive: true }).catch((error) => {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        });
    }
    await fsMkdir(formulaDir, { recursive: true });

    const mnemotecaFormula = renderMnemotecaFormula({
        version: mnemotecaTag.tag.slice(1),
        assets: mnemotecaAssets,
        license: inputs.mnemoteca.license,
        homepage: inputs.mnemoteca.homepage,
    });
    const formulas = ["Formula/wld.rb", "Formula/mnemoteca.rb"];
    const generatedTexts = [mnemotecaFormula];
    if (wldTag) {
        const wldFormula = renderWldFormula({ version: wldTag.tag.slice(1), assets: wldAssets }, options.testOnly);
        generatedTexts.unshift(wldFormula);
        await fsWriteFile(join(formulaDir, "wld.rb"), wldFormula);
    }
    for (const text of generatedTexts) assertNoPlaceholders(text);

    await fsWriteFile(join(formulaDir, "mnemoteca.rb"), mnemotecaFormula);
    await fsWriteFile(readmePath, renderReadme());

    const manifest = {
        testOnly: existingWld?.testOnly || options.testOnly,
        wldTag: wldTag?.tag || existingWld?.wldTag,
        mnemotecaTag: mnemotecaTag.tag,
        generatedAt: new Date().toISOString(),
        formulas,
        testedDependencies: inputs.homebrewDependencies,
    };
    await fsWriteFile(join(options.output, "runwield-homebrew-package.json"), `${JSON.stringify(manifest, null, 4)}\n`);
}

export async function main(args = process.argv.slice(2)) {
    await packageHomebrew(parsePackageHomebrewArgs(args));
}

if (import.meta.main) await main();
