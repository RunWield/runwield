import { getCwd } from "../../constants.js";
import { spawnNativeProcess } from "../foreground-process.ts";
/* Remote location resolution. This source is constant: only JSON on stdin contains user input.
 * OpenSSH still owns host configuration, authentication and host verification.
 */

const RESOLVE_SOURCE = String.raw`import json, os, platform, subprocess, sys

def git(cwd, *args):
    try:
        result = subprocess.run(['git', '-C', cwd, 'rev-parse', *args], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=10)
        return result.stdout.strip() if result.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None

try:
    request = json.loads(sys.stdin.readline())
    location = request['path']
    if location is not None and (not isinstance(location, str) or '\x00' in location):
        raise ValueError('Invalid remote path')
    home = os.path.realpath(os.path.expanduser('~'))
    if not os.path.isdir(home):
        raise ValueError('Remote home is not a directory')
    # Relative paths are relative to the remote account home, not the SSH server's cwd.
    if location is None or location == '' or location == '~':
        path = home
    elif location.startswith('~/'):
        path = os.path.join(home, location[2:])
    elif location.startswith('~'):
        raise ValueError('Only the remote account home may use ~')
    else:
        path = location if os.path.isabs(location) else os.path.join(home, location)
    cwd = os.path.realpath(path)
    if not os.path.isdir(cwd):
        raise ValueError('Remote target is not an existing directory: ' + path)
    if not os.access(cwd, os.R_OK | os.X_OK):
        raise ValueError('Remote target is not accessible: ' + path)
    root = git(cwd, '--show-toplevel') if git(cwd, '--is-inside-work-tree') == 'true' else None
    common = git(cwd, '--path-format=absolute', '--git-common-dir') if root else None
    git_dir = git(cwd, '--path-format=absolute', '--git-dir') if root else None
    root = os.path.realpath(root) if root else None
    common = os.path.realpath(common) if common else None
    git_dir = os.path.realpath(git_dir) if git_dir else None
    primary = None
    if common and os.path.basename(common) == '.git' and os.path.isdir(common):
        primary = os.path.realpath(os.path.dirname(common))
    elif root and common == git_dir:
        primary = root
    print(json.dumps({'ok': True, 'cwd': cwd, 'home': home, 'os': platform.system(), 'arch': platform.machine(), 'gitRoot': root, 'gitDir': git_dir, 'gitCommonDir': common, 'primaryRoot': primary, 'isWorktree': bool(root and common and git_dir and common != git_dir)}))
except Exception as error:
    print(json.dumps({'ok': False, 'error': str(error)}))
    sys.exit(1)
`;

export function fixedPythonCommand(source: string): string {
    // Shell escaping applies only to our own fixed code, never to target data.
    return `python3 -c '${source.replaceAll("'", "'\\''")}'`;
}

export const REMOTE_RESOLVE_COMMAND = fixedPythonCommand(RESOLVE_SOURCE);

export interface RemoteTarget {
    cwd: string;
    home: string;
    os: string;
    arch: string;
    gitRoot: string | null;
    gitDir: string | null;
    gitCommonDir: string | null;
    primaryRoot: string | null;
    isWorktree: boolean;
}

interface RemoteTargetSuccess extends RemoteTarget {
    ok: true;
    error?: string;
}

interface RemoteTargetFailure {
    ok: false;
    error: string;
}

type RemoteTargetResponse = RemoteTargetSuccess | RemoteTargetFailure;

/**
 * Run the fixed resolver through the user's OpenSSH configuration. `host` is
 * one literal destination operand, never an option or remote command.
 */
export async function resolveRemoteTarget(
    host: string,
    path: string | null = null,
    sshExecutable = "ssh",
    signal?: AbortSignal,
): Promise<RemoteTarget> {
    // deno-lint-ignore no-control-regex -- SSH destinations must not contain control or whitespace characters.
    if (!host || host.startsWith("-") || /[\x00-\x20\x7f]/.test(host)) {
        throw new Error("Invalid SSH destination");
    }
    if (path !== null && (typeof path !== "string" || path.includes("\0"))) throw new Error("Invalid remote path");
    const result = await spawnNativeProcess(sshExecutable, {
        cwd: getCwd(),
        args: ["-T", "--", host, REMOTE_RESOLVE_COMMAND],
        signal,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
    });
    const writer = result.stdin.getWriter();
    try {
        await writer.write(new TextEncoder().encode(JSON.stringify({ path }) + "\n"));
    } finally {
        await writer.close();
    }
    const [status, stdout, stderr] = await Promise.all([
        result.status,
        new Response(result.stdout).text(),
        new Response(result.stderr).text(),
    ]);
    let response: RemoteTargetResponse;
    try {
        response = JSON.parse(stdout.trim());
    } catch {
        throw new Error(`Remote resolution failed: ${stderr.trim() || stdout.trim() || status.code}`);
    }
    if (!status.success || !response.ok) {
        throw new Error(`Remote resolution failed: ${response.error || stderr.trim() || status.code}`);
    }
    return {
        cwd: response.cwd,
        home: response.home,
        os: response.os,
        arch: response.arch,
        gitRoot: response.gitRoot,
        gitDir: response.gitDir,
        gitCommonDir: response.gitCommonDir,
        primaryRoot: response.primaryRoot,
        isWorktree: response.isWorktree,
    };
}
