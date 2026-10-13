import { getCwd } from "../../constants.js";
import { spawnNativeProcess } from "../foreground-process.ts";
import { readFile as fsReadFile } from "node:fs/promises";
import { verifyBuildArtifact } from "../../../scripts/build-metadata.js";
import { fixedPythonCommand } from "./target.ts";

/** @param {{os: string, arch: string}} platform */
export function linuxTarget(platform) {
    if (platform.os !== "Linux") throw new Error(`Unsupported remote OS: ${platform.os}`);
    if (platform.arch === "x86_64") return "x86_64-unknown-linux-gnu";
    if (platform.arch === "aarch64") return "aarch64-unknown-linux-gnu";
    throw new Error(`Unsupported remote CPU: ${platform.arch}`);
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
const PREPARE_SOURCE = String.raw`import fcntl, hashlib, json, os, stat, subprocess, sys, tempfile

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
            # A second preparation may have created it after lexists().
            private_directory(path)

def preflight(path, build_id, protocol, version):
    result = subprocess.run([path, '--remote-preflight'], capture_output=True, text=True, timeout=15)
    if result.returncode != 0:
        raise ValueError('Remote runtime preflight failed: ' + (result.stderr.strip() or str(result.returncode)))
    try:
        facts = json.loads(result.stdout)
    except ValueError:
        raise ValueError('Remote runtime preflight returned invalid identity')
    expected = {'buildId': build_id, 'protocol': protocol, 'version': version}
    for field, value in expected.items():
        if facts.get(field) != value:
            raise ValueError('Remote runtime embedded identity or protocol mismatch: ' + field)

def valid_file(path, checksum):
    if not os.path.lexists(path):
        return False
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        raise ValueError('Unsafe remote runtime cache file: ' + path)
    digest = hashlib.sha256()
    with open(path, 'rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest() == checksum

stage = None
lock = None
try:
    request = json.loads(sys.stdin.buffer.readline())
    build_id, checksum, target, protocol, version, size = (request[key] for key in ('buildId', 'sha256', 'target', 'protocol', 'version', 'size'))
    if not all(isinstance(value, str) and len(value) == 64 and all(c in '0123456789abcdef' for c in value) for value in (build_id, checksum)):
        raise ValueError('Invalid runtime identity or checksum')
    if target not in ('x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu') or not isinstance(protocol, int) or not isinstance(version, str) or not version or len(version) > 100 or not isinstance(size, int) or size < 0:
        raise ValueError('Invalid remote runtime header')
    home = os.path.realpath(os.path.expanduser('~'))
    cache = home
    for name in ('.cache', 'runwield', 'runtime', build_id, target, checksum):
        cache = os.path.join(cache, name)
        private_directory(cache)
    # Lock this private cache entry while removing abandoned stages and promoting.
    # The kernel releases this lock if a previous connection died mid-transfer.
    lock_path = os.path.join(cache, '.prepare.lock')
    lock = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    if not stat.S_ISREG(os.fstat(lock).st_mode) or os.fstat(lock).st_uid != os.getuid():
        raise ValueError('Unsafe remote runtime lock file')
    fcntl.flock(lock, fcntl.LOCK_EX)
    for name in os.listdir(cache):
        if name.startswith('.stage-'):
            abandoned = os.path.join(cache, name)
            info = os.lstat(abandoned)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                raise ValueError('Unsafe remote runtime stage file')
            os.unlink(abandoned)
    executable = os.path.join(cache, 'wld')
    # Revalidate the cache under the preparation lock. A good executable does
    # not need another full transfer on reconnect.
    reused = valid_file(executable, checksum)
    if reused:
        try:
            preflight(executable, build_id, protocol, version)
        except (OSError, ValueError, subprocess.TimeoutExpired):
            reused = False
    if reused:
        print(json.dumps({'ok': True, 'path': executable, 'reused': True}), flush=True)
        sys.exit(0)
    print(json.dumps({'send': True}), flush=True)
    digest = hashlib.sha256()
    fd, stage = tempfile.mkstemp(prefix='.stage-', dir=cache)
    with os.fdopen(fd, 'wb') as output:
        while size:
            chunk = sys.stdin.buffer.read(min(size, 1024 * 1024))
            if not chunk:
                raise ValueError('Incomplete remote runtime transfer')
            digest.update(chunk)
            output.write(chunk)
            size -= len(chunk)
        output.flush()
        os.fsync(output.fileno())
    if digest.hexdigest() != checksum:
        raise ValueError('Remote runtime transfer checksum mismatch')
    os.chmod(stage, 0o700)
    preflight(stage, build_id, protocol, version)
    os.replace(stage, executable)
    stage = None
    print(json.dumps({'ok': True, 'path': executable, 'reused': False}))
except Exception as error:
    print(json.dumps({'ok': False, 'error': str(error)}))
    sys.exit(1)
finally:
    if stage and os.path.exists(stage):
        os.unlink(stage)
    if lock is not None:
        os.close(lock)
`;

export const REMOTE_PREPARE_COMMAND = fixedPythonCommand(PREPARE_SOURCE);

/**
 * Verify the local bytes, send them through SSH stdin, and let the fixed remote
 * source atomically stage and preflight the executable. The returned path is a
 * remote locator; callers must not use laptop path utilities on it.
 * @param {string} host
 * @param {{os: string, arch: string}} platform
 * @param {string} artifact
 * @param {string} [sshExecutable] External subprocess boundary.
 * @param {AbortSignal} [signal] Connection cancellation.
 * @returns {Promise<{path: string, reused: boolean}>}
 */
export async function prepareRemoteRuntime(host, platform, artifact, sshExecutable = "ssh", signal) {
    // deno-lint-ignore no-control-regex -- SSH destinations must not contain control or whitespace characters.
    if (!host || host.startsWith("-") || /[\x00-\x20\x7f]/.test(host)) throw new Error("Invalid SSH destination");
    const metadata = await verifyRemoteRuntimeArtifact(artifact, platform);
    const bytes = await fsReadFile(artifact);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    if (digest !== metadata.sha256) throw new Error("Build artifact changed during transfer");
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
        await writer.write(new TextEncoder().encode(JSON.stringify({ ...metadata, size: bytes.length }) + "\n"));
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
                await writer.write(bytes);
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
