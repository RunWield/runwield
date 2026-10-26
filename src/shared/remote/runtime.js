import { getCwd } from "../../constants.js";
import { spawnNativeProcess } from "../foreground-process.ts";
import { readFile as fsReadFile } from "node:fs/promises";
import { verifyBuildArtifact } from "../../../scripts/build-metadata.ts";
import { fixedPythonCommand } from "./target.ts";
import { assertRemoteHostSupported } from "./host-prerequisites.ts";

/** @param {{os: string, arch: string}} platform */
export function linuxTarget(platform) {
    assertRemoteHostSupported(platform);
    return platform.arch === "x86_64" ? "x86_64-unknown-linux-gnu" : "aarch64-unknown-linux-gnu";
}

/**
 * Compare the artifact metadata with the identity embedded in this launcher.
 * The generated identity is absent in source runs without an explicit build.
 * @param {string} artifact
 * @param {{os: string, arch: string}} platform
 */
export async function verifyRemoteRuntimeArtifact(artifact, platform) {
    const target = linuxTarget(platform);
    let identity;
    try {
        identity = await import("../build-identity.js");
    } catch (error) {
        if (!(error instanceof TypeError && error.message.includes("build-identity.js"))) throw error;
        throw new Error("No launcher build identity. Build the launcher and matching Linux artifact explicitly.");
    }
    if (!/^[a-f0-9]{64}$/.test(identity.BUILD_ID) || !Number.isInteger(identity.REMOTE_PROTOCOL_VERSION)) {
        throw new Error("Invalid launcher build identity");
    }
    let metadata;
    try {
        metadata = await verifyBuildArtifact(artifact);
    } catch (error) {
        if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") {
            throw new Error(
                `Missing ${target} artifact: build it with bun run compile --target ${target} --output ${artifact}`,
            );
        }
        throw error;
    }
    if (
        (metadata.target !== target &&
            metadata.target !== `bun-linux-${platform.arch === "aarch64" ? "arm64" : "x64"}`) ||
        metadata.buildId !== identity.BUILD_ID ||
        metadata.protocol !== identity.REMOTE_PROTOCOL_VERSION
    ) {
        throw new Error(`Remote artifact does not match launcher build, protocol or ${target} target`);
    }
    const { VERSION } = await import("../version.js");
    if (metadata.version !== VERSION) throw new Error("Remote artifact VERSION does not match launcher");
    // Cache layout and the fixed remote preparation protocol use GNU target names.
    return { ...metadata, target };
}

// The fixed remote source reads a JSON header then exact artifact bytes. Nothing
// supplied by the user is included in the SSH remote command line.
const PREPARE_SOURCE = String.raw`import fcntl, hashlib, json, os, re, shutil, stat, subprocess, sys, tempfile

def private_directory(path):
    if os.path.lexists(path):
        info = os.lstat(path)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
            raise ValueError('Unsafe remote runtime cache directory: ' + path)
        os.chmod(path, 0o700)
    else:
        try:
            os.mkdir(path, 0o700)
        except FileExistsError:
            private_directory(path)

def preflight(path, request):
    helper = request.get('kind') == 'helper'
    result = subprocess.run([path, '--help' if helper else '--remote-preflight'], capture_output=True, text=True, timeout=15)
    if result.returncode != 0:
        raise ValueError('Remote runtime/helper preflight failed: ' + (result.stderr.strip() or str(result.returncode)))
    if helper:
        return
    try:
        facts = json.loads(result.stdout)
    except ValueError:
        raise ValueError('Remote runtime preflight returned invalid identity')
    for field in ('buildId', 'protocol', 'version'):
        if facts.get(field) != request[field]:
            raise ValueError('Remote runtime embedded identity or protocol mismatch: ' + field)

def valid_file(path, checksum, executable):
    if not os.path.lexists(path):
        return False
    info = os.lstat(path)
    if info.st_uid != os.getuid():
        raise ValueError('Unsafe remote runtime cache file: ' + path)
    if not stat.S_ISREG(info.st_mode):
        return False
    if info.st_mode & 0o077 or (executable and not info.st_mode & stat.S_IXUSR):
        return False
    digest = hashlib.sha256()
    with open(path, 'rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest() == checksum

def remove_stage(path):
    info = os.lstat(path)
    if info.st_uid != os.getuid() or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
        raise ValueError('Unsafe remote runtime stage file')
    if stat.S_ISDIR(info.st_mode):
        shutil.rmtree(path)
    else:
        os.unlink(path)

stage = None
lock = None
try:
    request = json.loads(sys.stdin.buffer.readline())
    if request.get('kind') == 'helper':
        parts, files = request['cacheParts'], request['files']
        if not isinstance(parts, list) or not parts or parts[0] != 'helpers' or not all(isinstance(p, str) and re.fullmatch(r'[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,100}', p) for p in parts):
            raise ValueError('Invalid helper cache locator')
        if len(files) != 2 or files[0]['name'] not in ('cymbal', 'ketch') or files[1]['name'] != 'LICENSE' or files[0]['executable'] is not True or files[1]['executable'] is not False:
            raise ValueError('Invalid helper files')
    else:
        build_id, checksum, target, protocol, version, size = (request[key] for key in ('buildId', 'sha256', 'target', 'protocol', 'version', 'size'))
        if not all(isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value) for value in (build_id, checksum)):
            raise ValueError('Invalid runtime identity or checksum')
        if target not in ('x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu') or not isinstance(protocol, int) or not isinstance(version, str) or not version or len(version) > 100:
            raise ValueError('Invalid remote runtime header')
        parts = ['runtime', build_id, target, checksum]
        files = [{'name': 'wld', 'sha256': checksum, 'size': size, 'executable': True}]
    for item in files:
        if not isinstance(item['sha256'], str) or not re.fullmatch(r'[a-f0-9]{64}', item['sha256']) or not isinstance(item['size'], int) or item['size'] < 0:
            raise ValueError('Invalid remote file header')
    parent = os.path.realpath(os.path.expanduser('~'))
    for name in ['.cache', 'runwield'] + parts[:-1]:
        parent = os.path.join(parent, name)
        private_directory(parent)
    cache = os.path.join(parent, parts[-1])
    lock = os.open(os.path.join(parent, '.' + parts[-1] + '.prepare.lock'), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    if not stat.S_ISREG(os.fstat(lock).st_mode) or os.fstat(lock).st_uid != os.getuid():
        raise ValueError('Unsafe remote runtime lock file')
    fcntl.flock(lock, fcntl.LOCK_EX)
    prefix = '.stage-' + parts[-1] + '-'
    for name in os.listdir(parent):
        if name.startswith(prefix):
            remove_stage(os.path.join(parent, name))
    if os.path.lexists(cache):
        private_directory(cache)
        for name in os.listdir(cache):
            if name.startswith('.stage-'):
                remove_stage(os.path.join(cache, name))
    executable = os.path.join(cache, files[0]['name'])
    reused = all(valid_file(os.path.join(cache, item['name']), item['sha256'], item['executable']) for item in files)
    if reused:
        try:
            preflight(executable, request)
        except (OSError, ValueError, subprocess.TimeoutExpired):
            reused = False
    if reused:
        print(json.dumps({'ok': True, 'path': executable, 'reused': True}), flush=True)
        sys.exit(0)
    print(json.dumps({'send': True}), flush=True)
    stage = tempfile.mkdtemp(prefix=prefix, dir=parent)
    for item in files:
        digest = hashlib.sha256()
        size = item['size']
        path = os.path.join(stage, item['name'])
        with open(path, 'xb') as output:
            while size:
                chunk = sys.stdin.buffer.read(min(size, 1024 * 1024))
                if not chunk:
                    raise ValueError('Incomplete remote runtime transfer')
                digest.update(chunk)
                output.write(chunk)
                size -= len(chunk)
            output.flush()
            os.fsync(output.fileno())
        if digest.hexdigest() != item['sha256']:
            raise ValueError('Remote runtime transfer checksum mismatch')
        os.chmod(path, 0o700 if item['executable'] else 0o600)
    preflight(os.path.join(stage, files[0]['name']), request)
    # All files pass before promotion. Retire the old directory under the lock;
    # an interrupted promotion is repaired on the next connection.
    if os.path.lexists(cache):
        retired = tempfile.mkdtemp(prefix=prefix, dir=parent)
        os.rmdir(retired)
        os.replace(cache, retired)
        remove_stage(retired)
    os.replace(stage, cache)
    stage = None
    print(json.dumps({'ok': True, 'path': executable, 'reused': False}))
except Exception as error:
    print(json.dumps({'ok': False, 'error': str(error)}))
    sys.exit(1)
finally:
    if stage and os.path.exists(stage):
        remove_stage(stage)
    if lock is not None:
        os.close(lock)
`;

export const REMOTE_PREPARE_COMMAND = fixedPythonCommand(PREPARE_SOURCE);

/**
 * @typedef {Object} RemotePreparationResult
 * @property {string} path
 * @property {boolean} reused
 */

/**
 * Verify the local bytes, send them through SSH stdin, and let the fixed remote
 * source atomically stage and preflight the executable. The returned path is a
 * remote locator; callers must not use laptop path utilities on it.
 * @param {string} host
 * @param {{os: string, arch: string}} platform
 * @param {string} artifact
 * @param {string} [sshExecutable] External subprocess boundary.
 * @param {AbortSignal} [signal] Connection cancellation.
 * @returns {Promise<RemotePreparationResult>}
 */
export async function prepareRemoteRuntime(host, platform, artifact, sshExecutable = "ssh", signal) {
    const metadata = await verifyRemoteRuntimeArtifact(artifact, platform);
    const bytes = await fsReadFile(artifact);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    if (digest !== metadata.sha256) throw new Error("Build artifact changed during transfer");
    return prepareRemoteFiles(host, { ...metadata, size: bytes.length }, [bytes], sshExecutable, signal);
}

/**
 * @typedef {Object} RemoteTransferFile
 * @property {string} name
 * @property {string} sha256
 * @property {number} size
 * @property {boolean} executable
 */
/**
 * @typedef {Object} HelperPreparation
 * @property {string} kind
 * @property {string[]} cacheParts
 * @property {RemoteTransferFile[]} files
 */
/**
 * @typedef {Object} RuntimePreparation
 * @property {string} buildId
 * @property {string} sha256
 * @property {string} target
 * @property {number} protocol
 * @property {string} version
 * @property {number} size
 */
/**
 * Shared two-phase preparation transport. Remote cache ownership stays with each artifact owner.
 * @param {string} host
 * @param {HelperPreparation | RuntimePreparation} header
 * @param {Uint8Array[]} payloads
 * @param {string} [sshExecutable] External subprocess boundary.
 * @param {AbortSignal} [signal]
 * @returns {Promise<RemotePreparationResult>}
 */
export async function prepareRemoteFiles(host, header, payloads, sshExecutable = "ssh", signal) {
    // deno-lint-ignore no-control-regex -- SSH destinations must not contain control or whitespace characters.
    if (!host || host.startsWith("-") || /[\x00-\x20\x7f]/.test(host)) throw new Error("Invalid SSH destination");
    const process = spawnNativeProcess(sshExecutable, {
        cwd: getCwd(),
        args: ["-T", "--", host, REMOTE_PREPARE_COMMAND],
        signal,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
    });
    const output = Promise.all([process.status, new Response(process.stderr).text()]);
    const reader = process.stdout.getReader();
    const writer = process.stdin.getWriter();
    let stdout = "";
    try {
        await writer.write(new TextEncoder().encode(JSON.stringify(header) + "\n"));
        while (!stdout.includes("\n") && stdout.length < 16_384) {
            const { done, value } = await reader.read();
            if (done) break;
            stdout += new TextDecoder().decode(value);
        }
        const newline = stdout.indexOf("\n");
        if (newline < 0) {
            const [status, stderr] = await output;
            throw new Error(`Remote runtime setup failed: ${stderr.trim() || stdout.trim() || status.code}`);
        }
        const first = JSON.parse(stdout.slice(0, newline));
        let transferError;
        if (first.send === true) {
            try {
                for (const bytes of payloads) await writer.write(bytes);
            } catch (error) {
                transferError = error;
            }
        }
        await writer.close().catch(() => undefined);
        stdout = stdout.slice(newline + 1);
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            stdout += new TextDecoder().decode(value);
        }
        const [status, stderr] = await output;
        let reply = first;
        if (first.send === true) {
            try {
                reply = JSON.parse(stdout.trim());
            } catch {
                throw new Error(
                    `Remote runtime setup failed: ${stderr.trim() || String(transferError || status.code)}`,
                );
            }
        }
        if (!status.success || !reply.ok || transferError) {
            throw new Error(
                `Remote runtime setup failed: ${reply.error || stderr.trim() || String(transferError || status.code)}`,
            );
        }
        return { path: reply.path, reused: reply.reused };
    } catch (error) {
        try {
            process.kill();
        } catch {
            /* Already exited. */
        }
        await output.catch(() => undefined);
        throw error;
    } finally {
        reader.releaseLock();
    }
}
