import { mkdir as fsMkdir, readFile as fsReadFile, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import process from "node:process";
/**
 * Render the owner Homebrew tap from immutable RunWield and Mnemoteca release assets.
 */

import { basename, join } from "node:path";
import { parseReleaseTag } from "./release.js";

const RUNWIELD_REPO = "gandazgul/runwield";
const MNEMOTECA_REPO = "gandazgul/mnemoteca";
const DEFAULT_INPUTS_PATH = "packaging/homebrew/tested-dependencies.json";
const ARCHES = Object.freeze(["darwin-arm64", "darwin-x64"]);

/**
 * @typedef {Object} AssetInput
 * @property {string} url
 * @property {string} sha256
 */

/** @typedef {Record<string, AssetInput>} PackageAssets */

/**
 * @typedef {Object} MnemotecaInput
 * @property {string} tag
 * @property {string} license
 * @property {string} homepage
 * @property {PackageAssets} assets
 */

/**
 * @typedef {Object} TestedDependencyInput
 * @property {string} formula
 * @property {string} testedVersion
 */

/**
 * @typedef {Object} HomebrewInputs
 * @property {MnemotecaInput} mnemoteca
 * @property {Record<string, TestedDependencyInput>} homebrewDependencies
 */

/**
 * @typedef {Object} HomebrewOptions
 * @property {string} wldTag
 * @property {string} mnemotecaTag
 * @property {string} output
 * @property {string} inputsPath
 * @property {string} [wldBaseUrl]
 * @property {string} [mnemotecaBaseUrl]
 * @property {boolean} testOnly
 */

function usage() {
    return [
        "Usage: package-homebrew.js [--wld-tag <stable-tag>] --mnemoteca-tag <stable-tag> --output <dir>",
        "       [--inputs <path>] [--wld-base-url <url>] [--mnemoteca-base-url <url>] [--test-only]",
        "       Omit --wld-tag to refresh only the Mnemoteca formula in an existing tap tree.",
    ].join("\n");
}

/** @param {string[]} args */
export function parsePackageHomebrewArgs(args) {
    /** @type {HomebrewOptions} */
    const options = { wldTag: "", mnemotecaTag: "", output: "", inputsPath: DEFAULT_INPUTS_PATH, testOnly: false };
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
    if (!options.mnemotecaTag || !options.output || !options.inputsPath) throw new Error(usage());
    if (!options.wldTag && options.wldBaseUrl) throw new Error("--wld-base-url requires --wld-tag.");
    return options;
}

/** @param {string} tag */
function assertStableTag(tag) {
    const parsed = parseReleaseTag(tag);
    if (parsed.kind !== "stable") throw new Error(`Homebrew packages require a Stable tag: ${tag}`);
    return parsed;
}

/**
 * @param {string} baseUrl
 * @param {string} name
 */
function assetUrl(baseUrl, name) {
    return `${baseUrl.replace(/\/$/, "")}/${name}`;
}

/**
 * @param {string} repo
 * @param {string} tag
 * @param {string | undefined} baseUrl
 */
function releaseBaseUrl(repo, tag, baseUrl) {
    return baseUrl || `https://github.com/${repo}/releases/download/${tag}`;
}

/**
 * @param {string} url
 * @param {string} repo
 * @param {string} tag
 */
function assertReleasedAssetUrl(url, repo, tag) {
    const expected = `https://github.com/${repo}/releases/download/${tag}/`;
    if (!url.startsWith(expected)) throw new Error(`Publishable Homebrew asset must use ${expected}: ${url}`);
}

/** @param {Uint8Array} bytes */
async function sha256(bytes) {
    const input = new Uint8Array(bytes.length);
    input.set(bytes);
    const hash = await crypto.subtle.digest("SHA-256", input.buffer);
    return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** @param {string} url */
async function readUrlBytes(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed ${response.status}: ${url}`);
    return new Uint8Array(await response.arrayBuffer());
}

/**
 * @param {string} text
 * @param {string} assetName
 */
function checksumForAsset(text, assetName) {
    for (const line of text.split("\n")) {
        const [sum, name] = line.trim().split(/\s+/, 2);
        if (name === assetName && /^[0-9a-f]{64}$/i.test(sum)) return sum.toLowerCase();
    }
    throw new Error(`Checksum file is missing ${assetName}.`);
}

/**
 * @param {string} url
 * @param {string} expectedSha
 */
async function verifyAsset(url, expectedSha) {
    const bytes = await readUrlBytes(url);
    const actual = await sha256(bytes);
    if (actual !== expectedSha.toLowerCase()) {
        throw new Error(`Checksum mismatch for ${url}: expected ${expectedSha}, got ${actual}`);
    }
}

/**
 * @param {string} baseUrl
 * @param {string} assetName
 */
async function verifiedRunWieldAsset(baseUrl, assetName) {
    const shaUrl = assetUrl(baseUrl, `${assetName}.sha256`);
    const shaText = new TextDecoder().decode(await readUrlBytes(shaUrl));
    const expected = checksumForAsset(shaText, assetName);
    const url = assetUrl(baseUrl, assetName);
    await verifyAsset(url, expected);
    return { url, sha256: expected };
}

/**
 * @param {MnemotecaInput} input
 * @param {string | undefined} baseUrl
 */
async function verifiedMnemotecaAssets(input, baseUrl) {
    /** @type {Record<string, AssetInput>} */
    const assets = {};
    for (const arch of ARCHES) {
        const current = input.assets[arch];
        if (!current?.url || !current.sha256) throw new Error(`Missing Mnemoteca asset input for ${arch}.`);
        const url = baseUrl ? assetUrl(baseUrl, basename(current.url)) : current.url;
        await verifyAsset(url, current.sha256);
        assets[arch] = { url, sha256: current.sha256.toLowerCase() };
    }
    return assets;
}

/** @param {string} text */
function assertNoPlaceholders(text) {
    if (/TODO|PLACEHOLDER|__[^_]+__/i.test(text)) throw new Error("Generated formula contains a placeholder.");
}

/**
 * @param {HomebrewInputs} inputs
 * @param {string} tag
 */
function validateInputs(inputs, tag) {
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

/**
 * @param {{ version: string, assets: Record<string, AssetInput> }} wld
 * @param {boolean} testOnly
 */
function renderWldFormula(wld, testOnly) {
    // Homebrew reads Candidate versions correctly, but mistakes Stable archive names for CPU versions.
    // GitHub release URLs and Candidate names already identify the version; repeating it fails brew audit.
    const releaseUrl = `https://github.com/${RUNWIELD_REPO}/releases/download/v${wld.version}/`;
    const versionDeclaration = !wld.version.includes("-rc.") &&
            !Object.values(wld.assets).every((asset) => asset.url.startsWith(releaseUrl))
        ? `  version "${wld.version}"\n`
        : "";
    return `require "json"

class Wld < Formula
  desc "Plan-first AI coding harness"
  homepage "https://github.com/gandazgul/runwield"
${versionDeclaration}  license :cannot_represent

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

/**
 * @param {{ version: string, assets: Record<string, AssetInput>, license: string, homepage: string }} mnemoteca
 */
function renderMnemotecaFormula(mnemoteca) {
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

Generated tap source for RunWield packages.

Install after the owner publishes this tap:

\`\`\`sh
brew install gandazgul/tap/wld
brew install gandazgul/tap/mnemoteca
\`\`\`

RunWield license: https://github.com/gandazgul/runwield/blob/main/LICENSE

The RunWield formula uses Homebrew's \`:cannot_represent\` metadata because the project license is not an SPDX license.

Regenerate from this repository with:

\`\`\`sh
bun run package:homebrew --wld-tag <stable-tag> --mnemoteca-tag <stable-tag> --output <dir>
bun run package:homebrew --mnemoteca-tag <stable-tag> --output <existing-tap-dir>
\`\`\`
`;
}

/**
 * @typedef {Object} ExistingRunWieldPackage
 * @property {string} wldTag
 * @property {boolean} testOnly
 */

/**
 * @param {string} output
 * @param {boolean} requestedTestOnly
 * @returns {Promise<ExistingRunWieldPackage>}
 */
async function readExistingRunWieldPackage(output, requestedTestOnly) {
    const formulaPath = join(output, "Formula", "wld.rb");
    const manifestPath = join(output, "runwield-homebrew-package.json");
    const formula = await fsReadFile(formulaPath, "utf8").catch((error) => {
        if ((error instanceof Error && "code" in error && error.code === "ENOENT")) {
            throw new Error("Mnemoteca-only refresh requires an existing Formula/wld.rb.");
        }
        throw error;
    });
    const manifest = JSON.parse(
        await fsReadFile(manifestPath, "utf8").catch((error) => {
            if ((error instanceof Error && "code" in error && error.code === "ENOENT")) {
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

/** @param {HomebrewOptions} options */
export async function packageHomebrew(options) {
    if (!options.testOnly && (options.wldBaseUrl || options.mnemotecaBaseUrl)) {
        throw new Error("Base URL overrides require --test-only.");
    }
    const wldTag = options.wldTag
        ? (options.testOnly ? parseReleaseTag(options.wldTag) : assertStableTag(options.wldTag))
        : null;
    const mnemotecaTag = assertStableTag(options.mnemotecaTag);
    const inputs = /** @type {HomebrewInputs} */ (JSON.parse(await fsReadFile(options.inputsPath, "utf8")));
    validateInputs(inputs, mnemotecaTag.tag);
    const existingWld = wldTag ? null : await readExistingRunWieldPackage(options.output, options.testOnly);

    const mnemotecaBase = options.mnemotecaBaseUrl || releaseBaseUrl(MNEMOTECA_REPO, mnemotecaTag.tag, undefined);
    const mnemotecaAssets = await verifiedMnemotecaAssets(inputs.mnemoteca, mnemotecaBase);
    if (!options.testOnly) {
        for (const asset of Object.values(mnemotecaAssets)) {
            assertReleasedAssetUrl(asset.url, MNEMOTECA_REPO, mnemotecaTag.tag);
        }
    }

    /** @type {Record<string, AssetInput>} */
    const wldAssets = {};
    if (wldTag) {
        const wldBase = releaseBaseUrl(RUNWIELD_REPO, wldTag.tag, options.wldBaseUrl);
        for (const arch of ARCHES) {
            const name = `wld-${wldTag.tag}-${arch}.tar.gz`;
            wldAssets[arch] = await verifiedRunWieldAsset(wldBase, name);
            if (!options.testOnly) assertReleasedAssetUrl(wldAssets[arch].url, RUNWIELD_REPO, wldTag.tag);
        }
    }

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
