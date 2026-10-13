import { bashFixtureExecutable, bashFixturePath, quoteBashFixture } from "./bash-fixture.ts";
import { captureForegroundProcess } from "../src/shared/captured-process.ts";
import { captureScriptProcess } from "./script-process.ts";
import { tmpdir } from "node:os";
import {
    chmod as fsChmod,
    copyFile as fsCopyFile,
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import process from "node:process";
import { join } from "node:path";

import { RUNWIELD_ROOT } from "../runtime-root.js";

/**
 * Deno runs test modules concurrently inside one process, so `Deno.cwd()` is
 * shared mutable state that any other test file may chdir out from under us.
 * Anchor every repository path to the shared runtime root instead.
 */
export const REPO_ROOT = RUNWIELD_ROOT;

/** @param {string[]} segments */
export function repoPath(...segments) {
    return join(REPO_ROOT, ...segments);
}

/** @typedef {"Darwin" | "Linux"} TestOs */
/** @typedef {"x86_64" | "arm64"} TestArch */
/** @typedef {"wld" | "cymbal" | "ketch" | "snip"} ReleaseBinaryName */
/** @typedef {ReleaseBinaryName | "mnemoteca" | "agent-browser"} BinaryName */

export const VERSIONS = {
    runwield: "v9.9.9",
    cymbal: "v0.14.0",
    ketch: "v0.13.0",
    snip: "v0.22.0",
};

/** @type {BinaryName[]} */
export const BINARY_NAMES = ["wld", "mnemoteca", "cymbal", "ketch", "agent-browser", "snip"];

/** @type {ReleaseBinaryName[]} */
export const RELEASE_BINARY_NAMES = ["wld", "cymbal", "ketch", "snip"];

/** @type {Array<Exclude<ReleaseBinaryName, "wld">>} */
export const HELPER_NAMES = ["cymbal", "ketch", "snip"];

/**
 * @param {string} path
 * @param {string} body
 */
export async function writeExecutable(path, body) {
    await fsWriteFile(path, body);
    await fsChmod(path, 0o755);
}

/**
 * @param {string} root
 * @param {string} binaryName
 * @param {string} [entryName]
 */
export async function makeArchive(root, binaryName, entryName = binaryName) {
    const dir = await fsMkdtemp(join(root ?? tmpdir(), "runwield-fixture-"));
    const body = binaryName === "wld"
        ? `#!/usr/bin/env bash
if [[ "$1" == "snip-filters" && "$2" == "install" ]]; then
  printf 'snip=%s\npath=%s\n' "$(command -v snip || true)" "$PATH" >> "\${WLD_FILTER_LOG:?}"
  exit 0
fi
echo wld version
`
        : `#!/usr/bin/env bash\necho ${binaryName} version\n`;
    await writeExecutable(join(dir, entryName), body);
    const archive = join(root, `${binaryName}-${entryName}.tar.gz`);
    const status = await captureScriptProcess("tar", { args: ["-czf", archive, "-C", dir, entryName] });
    if (!status.success) throw new Error(`tar failed for ${binaryName}`);
    return archive;
}

/**
 * @param {string} path
 */
export async function sha256(path) {
    const bytes = await fsReadFile(path);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {TestOs} os
 * @param {TestArch} arch
 */
export function assetNamesFor(os, arch) {
    const helperOs = os === "Darwin" ? "darwin" : "linux";
    const helperArch = arch === "x86_64" ? "amd64" : "arm64";
    const wldArch = arch === "x86_64" ? "x64" : "arm64";
    const cymbalArch = arch === "x86_64" ? "x86_64" : "arm64";
    const ketchArch = arch === "x86_64" ? "x86_64" : "arm64";
    return {
        wld: `wld-${VERSIONS.runwield}-${helperOs}-${wldArch}.tar.gz`,
        cymbal: `cymbal_${VERSIONS.cymbal}_${helperOs}_${cymbalArch}.tar.gz`,
        ketch: `ketch_${VERSIONS.ketch.slice(1)}_${helperOs}_${ketchArch}.tar.gz`,
        snip: `snip_${VERSIONS.snip.slice(1)}_${helperOs}_${helperArch}.tar.gz`,
    };
}

/**
 * @param {{ os?: TestOs, arch?: TestArch, badChecksumFor?: ReleaseBinaryName, omitChecksumFor?: ReleaseBinaryName, badDigestFor?: BinaryName, omitDigestFor?: BinaryName, missingAssetFor?: BinaryName, missingExecutableFor?: BinaryName, latestApiFailsFor?: string[], releaseApiFailsFor?: string[], mnemotecaInstallerFails?: boolean, mnemotecaInstallerSkipsExecutable?: boolean, mnemotecaInstallerPrompts?: boolean }} [options]
 */
export async function createFixture(options = {}) {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-fixture-"));
    const fixtureDir = join(root, "fixtures");
    const binDir = join(root, "fake-bin");
    const installDir = join(root, "install dir with spaces");
    const curlLog = join(root, "curl.log");
    const mnemotecaInstallerLog = join(root, "mnemoteca-installer.log");
    const os = options.os ?? "Linux";
    const arch = options.arch ?? "x86_64";
    const assets = assetNamesFor(os, arch);
    await fsMkdir(fixtureDir);
    await fsMkdir(binDir);
    await fsMkdir(installDir);

    /** @type {Record<ReleaseBinaryName, string>} */
    const archivePaths = /** @type {Record<ReleaseBinaryName, string>} */ ({});
    for (const name of RELEASE_BINARY_NAMES) {
        const entryName = options.missingExecutableFor === name ? `${name}-wrong` : name;
        archivePaths[name] = await makeArchive(root, name, entryName);
        if (options.missingAssetFor !== name) {
            await fsCopyFile(archivePaths[name], join(fixtureDir, assets[name]));
        }
    }

    /** @type {Partial<Record<BinaryName, string>>} */
    const digests = {};
    for (const name of RELEASE_BINARY_NAMES) {
        if (options.missingAssetFor === name) continue;
        digests[name] = options.badDigestFor === name ? "0".repeat(64) : await sha256(join(fixtureDir, assets[name]));
    }

    /** @type {string[]} */
    const wldSums = [];
    /** @type {string[]} */
    const helperSums = [];
    for (const name of RELEASE_BINARY_NAMES) {
        if (options.missingAssetFor === name || options.omitChecksumFor === name) continue;
        const checksum = options.badChecksumFor === name ? "0".repeat(64) : digests[name];
        const line = `${checksum}  ${assets[name]}`;
        if (name === "wld") wldSums.push(line);
        else helperSums.push(line);
    }
    await fsWriteFile(join(fixtureDir, "SHA256SUMS"), `${wldSums.join("\n")}\n`);
    await fsWriteFile(join(fixtureDir, "checksums.txt"), `${helperSums.join("\n")}\n`);

    for (const name of RELEASE_BINARY_NAMES) {
        const assetDigest = options.omitDigestFor === name || !digests[name] ? null : `sha256:${digests[name]}`;
        await fsWriteFile(
            join(fixtureDir, `${name}-release.json`),
            JSON.stringify({ assets: assetDigest ? [{ name: assets[name], digest: assetDigest }] : [] }, null, 2),
        );
        const expandedAssetsHtml = assetDigest
            ? `<a href="/${name}/download/${assets[name]}">${
                assets[name]
            }</a>\n<clipboard-copy id="clipboard-button-${assetDigest}"></clipboard-copy>\n`
            : `<a href="/${name}/download/${assets[name]}">${assets[name]}</a>\n`;
        await fsWriteFile(join(fixtureDir, `${name}-expanded-assets.html`), expandedAssetsHtml);
    }

    await fsWriteFile(
        join(fixtureDir, "mnemoteca-install.sh"),
        `#!/usr/bin/env bash
set -euo pipefail
printf 'repo=%s\\ninstall_dir=%s\\ndb_path=%s\\n' "\${MNEMOTECA_REPO:-}" "\${INSTALL_DIR:-}" "\${MNEMOTECA_DB_PATH-unset}" >> '${bashFixturePath(mnemotecaInstallerLog)}'
${
            options.mnemotecaInstallerPrompts
                ? `printf 'Mnemoteca upgrade prompt: '
answer=
for _ in 1 2 3; do
  IFS= read -r answer || answer=
  [ -n "$answer" ] && break
done
printf 'answer=%s\\n' "$answer" >> '${bashFixturePath(mnemotecaInstallerLog)}'
`
                : ""
        }${options.mnemotecaInstallerFails ? "exit 42\n" : ""}${
            options.mnemotecaInstallerSkipsExecutable ? "exit 0\n" : `mkdir -p "\${INSTALL_DIR:?}"
cat >"$INSTALL_DIR/mnemoteca" <<'MNEMOTECABIN'
#!/usr/bin/env bash
echo mnemoteca version
MNEMOTECABIN
chmod 755 "$INSTALL_DIR/mnemoteca"
`
        }`,
    );

    await writeExecutable(
        join(binDir, "curl"),
        `#!/usr/bin/env bash
set -euo pipefail
out=""
url=""
write_format=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) write_format="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf '%s\n' "$url" >> '${bashFixturePath(curlLog)}'
latest_api_failures=' ${(options.latestApiFailsFor ?? []).join(" ")} '
release_api_failures=' ${(options.releaseApiFailsFor ?? []).join(" ")} '
case "$url" in
  *api.github.com/repos/gandazgul/runwield/releases/latest*)
    [[ "$latest_api_failures" == *' runwield '* ]] && exit 22
    body='{"url":"https://api.github.com/repos/gandazgul/runwield/releases/1","tag_name":"${VERSIONS.runwield}"}'
    ;;
  *api.github.com/repos/1broseidon/cymbal/releases/latest*)
    [[ "$latest_api_failures" == *' cymbal '* ]] && exit 22
    body='{"url":"https://api.github.com/repos/1broseidon/cymbal/releases/1","tag_name":"${VERSIONS.cymbal}"}'
    ;;
  *api.github.com/repos/1broseidon/ketch/releases/latest*)
    [[ "$latest_api_failures" == *' ketch '* ]] && exit 22
    body='{"url":"https://api.github.com/repos/1broseidon/ketch/releases/1","tag_name":"${VERSIONS.ketch}"}'
    ;;
  *api.github.com/repos/edouard-claude/snip/releases/latest*)
    [[ "$latest_api_failures" == *' snip '* ]] && exit 22
    body='{"url":"https://api.github.com/repos/edouard-claude/snip/releases/1","tag_name":"${VERSIONS.snip}"}'
    ;;
  *github.com/gandazgul/runwield/releases/latest*) effective_url='https://github.com/gandazgul/runwield/releases/tag/${VERSIONS.runwield}' ;;
  *github.com/1broseidon/cymbal/releases/latest*) effective_url='https://github.com/1broseidon/cymbal/releases/tag/${VERSIONS.cymbal}' ;;
  *github.com/1broseidon/ketch/releases/latest*) effective_url='https://github.com/1broseidon/ketch/releases/tag/${VERSIONS.ketch}' ;;
  *github.com/edouard-claude/snip/releases/latest*) effective_url='https://github.com/edouard-claude/snip/releases/tag/${VERSIONS.snip}' ;;
  *api.github.com/repos/gandazgul/runwield/releases/tags/*)
    [[ "$release_api_failures" == *' runwield '* ]] && exit 22
    file='${bashFixturePath(join(fixtureDir, "wld-release.json"))}'
    ;;
  *api.github.com/repos/1broseidon/cymbal/releases/tags/*)
    [[ "$release_api_failures" == *' cymbal '* ]] && exit 22
    file='${bashFixturePath(join(fixtureDir, "cymbal-release.json"))}'
    ;;
  *api.github.com/repos/1broseidon/ketch/releases/tags/*)
    [[ "$release_api_failures" == *' ketch '* ]] && exit 22
    file='${bashFixturePath(join(fixtureDir, "ketch-release.json"))}'
    ;;
  *api.github.com/repos/edouard-claude/snip/releases/tags/*)
    [[ "$release_api_failures" == *' snip '* ]] && exit 22
    file='${bashFixturePath(join(fixtureDir, "snip-release.json"))}'
    ;;
  *github.com/1broseidon/cymbal/releases/expanded_assets/*) file='${bashFixturePath(join(fixtureDir, "cymbal-expanded-assets.html"))}' ;;
  *github.com/1broseidon/ketch/releases/expanded_assets/*) file='${bashFixturePath(join(fixtureDir, "ketch-expanded-assets.html"))}' ;;
  *github.com/edouard-claude/snip/releases/expanded_assets/*) file='${bashFixturePath(join(fixtureDir, "snip-expanded-assets.html"))}' ;;
  *raw.githubusercontent.com/gandazgul/mnemoteca/main/install.sh) file='${bashFixturePath(join(fixtureDir, "mnemoteca-install.sh"))}' ;;
  */SHA256SUMS) file='${bashFixturePath(join(fixtureDir, "SHA256SUMS"))}' ;;
  */checksums.txt) file='${bashFixturePath(join(fixtureDir, "checksums.txt"))}' ;;
  *) file='${bashFixturePath(fixtureDir)}'/"$(basename "$url")" ;;
esac
if [[ "$write_format" == '%{url_effective}' ]]; then
  printf '%s' "\${effective_url:-$url}"
elif [[ -n "\${body:-}" ]]; then
  if [[ -n "$out" ]]; then printf '%s' "$body" > "$out"; else printf '%s' "$body"; fi
else
  if [[ ! -f "$file" ]]; then echo "missing fixture $url" >&2; exit 22; fi
  if [[ -n "$out" ]]; then cp "$file" "$out"; else cat "$file"; fi
fi
`,
    );

    await writeExecutable(
        join(binDir, "npm"),
        `#!/usr/bin/env bash
set -euo pipefail
prefix=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) prefix="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [[ -z "$prefix" ]]; then
  echo "missing npm prefix" >&2
  exit 1
fi
mkdir -p "$prefix/bin"
cat >"$prefix/bin/agent-browser" <<'NPMEOF'
#!/usr/bin/env bash
echo agent-browser version
NPMEOF
chmod 755 "$prefix/bin/agent-browser"
`,
    );

    return { root, fixtureDir, binDir, installDir, curlLog, mnemotecaInstallerLog, os, arch, assets };
}

/**
 * @param {Awaited<ReturnType<typeof createFixture>>} fixture
 * @param {{ extraPathDir?: string, requestedVersion?: string | null, noninteractive?: boolean, extraEnv?: Record<string, string>, unsetEnv?: string[] }} [options]
 */
export async function runInstaller(fixture, options = {}) {
    const pathPrefix = options.extraPathDir ? `${bashFixturePath(options.extraPathDir)}:` : "";
    /** @type {Record<string, string>} */
    const env = {
        ...{ ...process.env },
        WLD_FIXTURE_PATH: `${pathPrefix}${bashFixturePath(fixture.binDir)}:/usr/bin:/bin`,
        HOME: fixture.root,
        WLD_INSTALL_DIR: bashFixturePath(fixture.installDir),
        WLD_TEST_UNAME_S: fixture.os,
        WLD_TEST_UNAME_M: fixture.arch,
        ...options.extraEnv,
    };
    for (const key of options.unsetEnv ?? []) delete env[key];
    if (options.noninteractive !== false) env.WLD_NONINTERACTIVE = "1";
    const args = ["-c", 'export PATH="$WLD_FIXTURE_PATH"; exec /bin/bash "$@"', "installer-fixture", bashFixturePath(repoPath("install.sh"))];
    if (options.requestedVersion !== null) args.push(options.requestedVersion ?? VERSIONS.runwield);
    const output = await captureScriptProcess(bashFixtureExecutable(), {
        args,
        cwd: REPO_ROOT,
        env,
        clearEnv: true,
        stdout: "piped",
        stderr: "piped",
    });
    return {
        code: output.code,
        stdout: new TextDecoder().decode(output.stdout),
        stderr: new TextDecoder().decode(output.stderr),
    };
}

/**
 * @param {Awaited<ReturnType<typeof createFixture>>} fixture
 * @param {string} input
 * @param {{ extraEnv?: Record<string, string> }} [options]
 */
export async function runInstallerInPseudoTty(fixture, input, options = {}) {
    const scriptPath = repoPath("install.sh");
    const command = `PATH=${quoteShell(`${bashFixturePath(fixture.binDir)}:/usr/bin:/bin`)} HOME=${
        quoteShell(bashFixturePath(fixture.root))
    } WLD_INSTALL_DIR=${quoteShell(bashFixturePath(fixture.installDir))} WLD_NONINTERACTIVE=0 WLD_TEST_UNAME_S=${
        quoteShell(fixture.os)
    } WLD_TEST_UNAME_M=${quoteShell(fixture.arch)} ${
        Object.entries(options.extraEnv ?? {}).map(([key, value]) => `${key}=${quoteShell(key === "WLD_FILTER_LOG" ? bashFixturePath(value) : value)}`).join(" ")
    } /bin/bash ${quoteShell(bashFixturePath(scriptPath))} ${quoteShell(VERSIONS.runwield)}`;
    if (process.versions.bun) {
        // macOS `script` rejects Bun's socket-backed stdin; attach an actual PTY directly.
        /** @type {import("./terminal-fixture.ts").TerminalRuntime} */
        const bun = Reflect.get(globalThis, String("Bun"));
        const decoder = new TextDecoder();
        let stdout = "";
        const child = bun.spawn([bashFixtureExecutable(), "-lc", command], {
            cwd: REPO_ROOT,
            timeout: 30_000,
            terminal: {
                cols: 100,
                rows: 30,
                data(_terminal, data) {
                    stdout += decoder.decode(data, { stream: true });
                },
            },
        });
        try {
            child.terminal.write(process.platform === "win32" ? input.replaceAll("\n", "\r") : input);
            const code = await child.exited;
            stdout += decoder.decode();
            return { code, stdout, stderr: "" };
        } finally {
            child.terminal.close();
        }
    }
    const scriptArgs = process.platform === "linux"
        ? ["-q", "-c", command, "/dev/null"]
        : ["-q", "/dev/null", "/bin/bash", "-lc", command];
    const output = await captureForegroundProcess("script", {
        args: scriptArgs,
        cwd: REPO_ROOT,
        stdinText: input,
    });
    return {
        code: output.code,
        stdout: new TextDecoder().decode(output.stdout),
        stderr: new TextDecoder().decode(output.stderr),
    };
}

/**
 * @param {string} value
 */
function quoteShell(value) {
    return quoteBashFixture(value);
}

/**
 * @param {string} curlLog
 */
export async function readCurlLog(curlLog) {
    try {
        return await fsReadFile(curlLog, "utf8");
    } catch (error) {
        if ((error instanceof Error && "code" in error && error.code === "ENOENT")) return "";
        throw error;
    }
}
