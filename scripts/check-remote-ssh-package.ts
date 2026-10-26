/** Linux release qualification. Usage: bun scripts/check-remote-ssh-package.ts <archive-directory> <VERSION>
 * Requires non-interactive sudo. Installs system prerequisites; never removes system packages.
 * All accounts, SSH keys, caches and processes belong to this run. Evidence is retained.
 */
import { equal, ok } from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { getHomeDir } from "../src/constants.js";
import {
    extractReleaseRuntime,
    releaseRuntimeCacheDirectory,
    releaseRuntimeName,
} from "../src/shared/remote/release-artifact.ts";
import { remoteHelperPaths, remoteHelperPins } from "../src/shared/remote/helpers.ts";
import { sha256Bytes } from "./build-metadata.ts";

interface ProviderTool {
    function: { name: string };
}
interface ProviderMessage {
    role: string;
    content?: string | { type: string; text?: string }[];
}
export interface QualificationRequest {
    tools?: ProviderTool[];
    messages: ProviderMessage[];
}

/** The next request, not terminal echo or the request that caused the read, proves remote execution. */
export class SentinelExchange {
    requests = 0;
    verified = false;
    constructor(private readonly sentinel: string) {}
    reply(request: QualificationRequest): string {
        this.requests++;
        if (this.requests === 1) {
            ok(!JSON.stringify(request).includes(this.sentinel), "Sentinel leaked before remote read");
            ok(
                request.tools?.some((tool) => tool.function.name === "read"),
                "No real read tool offered",
            );
        } else {
            equal(this.requests, 2, "Unexpected extra provider request");
            ok(
                request.messages.some(
                    (message) =>
                        message.role === "tool" && (JSON.stringify(message.content) || "").includes(this.sentinel),
                ),
                "Next model request does not contain the remote-only sentinel tool result",
            );
            this.verified = true;
        }
        const call = this.requests === 1;
        const delta = call
            ? {
                  role: "assistant",
                  tool_calls: [
                      {
                          index: 0,
                          id: "remote-sentinel-read",
                          type: "function",
                          function: { name: "read", arguments: JSON.stringify({ path: "sentinel.txt" }) },
                      },
                  ],
              }
            : { role: "assistant", content: "SSH qualification complete." };
        const packet = (value: string) => `data: ${value}\n\n`;
        const chunk = (value: typeof delta | Record<string, never>, finish: string | null) =>
            packet(
                JSON.stringify({
                    id: "ssh-qualification",
                    object: "chat.completion.chunk",
                    created: 1,
                    model: "fixture",
                    choices: [{ index: 0, delta: value, finish_reason: finish }],
                }),
            );
        return chunk(delta, null) + chunk({}, call ? "tool_calls" : "stop") + packet("[DONE]");
    }
}

export function qualificationArguments(args: string[]): { directory: string; version: string; suffix: string } {
    if (args.length !== 2) {
        throw new Error("Usage: bun scripts/check-remote-ssh-package.ts <archive-directory> <VERSION>");
    }
    const suffix = process.arch === "arm64" ? "linux-arm64" : "linux-x64";
    releaseRuntimeName(args[1], suffix);
    return { directory: resolve(args[0]), version: args[1], suffix };
}

function command(executable: string, args: string[]): string {
    return execFileSync(executable, args, {
        encoding: "utf8",
        timeout: 120_000,
        stdio: ["ignore", "pipe", "pipe"],
    }).trim();
}
function sudo(...args: string[]): string {
    return command("sudo", ["-n", ...args]);
}
async function until(label: string, check: () => boolean | Promise<boolean>, milliseconds = 120_000): Promise<void> {
    const end = Date.now() + milliseconds;
    while (Date.now() < end) {
        if (await check()) return;
        await new Promise((done) => setTimeout(done, 150));
    }
    throw new Error(`Timed out: ${label}`);
}

// Same real Python PTY transport as verify-remote-reviews.ts. Only /exit is a successful shutdown.
const TERMINAL_DRIVER = String.raw`import os,pty,sys,time,select,fcntl,termios,struct,signal
root,exe,target=sys.argv[1:]
pid,fd=pty.fork()
if pid==0:
 os.chdir(root)
 os.execv(exe,[exe,'remote',target])
fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',40,150,0,0))
open(root+'/launcher.pid','w').write(str(pid))
signal.signal(signal.SIGTERM,lambda signum,frame: sys.exit(1))
pos=0
status=None
try:
 with open(root+'/terminal.log','ab',buffering=0) as log:
  end=time.monotonic()+165
  while time.monotonic()<end:
   if select.select([fd],[],[],0.1)[0]:
    try: data=os.read(fd,65536)
    except OSError: break
    if not data: break
    log.write(data)
   with open(root+'/input','rb') as inp:
    inp.seek(pos); data=inp.read(); pos=inp.tell()
   if data: os.write(fd,data.replace(b'\n',b'\r'))
  else: raise TimeoutError('PTY exceeded 165 seconds')
 # EOF must also be followed by a bounded real child exit.
 end=time.monotonic()+5
 while time.monotonic()<end:
  waited,status=os.waitpid(pid,os.WNOHANG)
  if waited: break
  status=None
  time.sleep(0.05)
 if status is None: raise TimeoutError('launcher did not exit after PTY EOF')
 open(root+'/exit-code','w').write(str(os.waitstatus_to_exitcode(status)))
finally:
 if status is None:
  try: os.kill(pid,signal.SIGKILL)
  except ProcessLookupError: pass
  os.waitpid(pid,0)
`;

export async function main(args = process.argv.slice(2)): Promise<void> {
    const { directory, version, suffix } = qualificationArguments(args);
    equal(process.platform, "linux", "SSH archive qualification requires Linux; it cannot be skipped on other systems");
    ok(["x64", "arm64"].includes(process.arch), "Only Linux x64 and ARM64 are supported");
    const root = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), "wld-remote-ssh-"));
    console.log(`SSH qualification evidence: ${root}`);
    await chmod(root, 0o755); // The disposable server account must traverse to its own HOME.
    const originalHome = process.env.HOME;
    const originalProfile = process.env.USERPROFILE;
    const home = join(root, "laptop");
    const remoteHome = join(root, "server");
    const account = `wldq${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    let createdAccount = false;
    let sshd: ChildProcess | undefined;
    let terminal: ChildProcess | undefined;
    let providerError: Error | undefined;
    let server: ReturnType<typeof createServer> | undefined;
    try {
        sudo("true");
        const distro = await readFile("/etc/os-release", "utf8");
        if (/^ID(?:_LIKE)?=.*(?:debian|ubuntu)/m.test(distro)) {
            sudo("env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "update", "-qq");
            sudo(
                "env",
                "DEBIAN_FRONTEND=noninteractive",
                "apt-get",
                "install",
                "-y",
                "openssh-server",
                "sshfs",
                "fuse3",
                "python3",
            );
        } else if (/^ID(?:_LIKE)?=.*(?:fedora|rhel|centos)/m.test(distro)) {
            sudo("dnf", "install", "-y", "openssh-server", "fuse-sshfs", "fuse3", "python3");
        } else throw new Error("Gate package setup supports Debian/Ubuntu and Fedora/RHEL only");
        command("test", ["-c", "/dev/fuse"]); // Never omit the real FUSE journey.
        await mkdir(home, { mode: 0o700 });
        process.env.HOME = home;
        process.env.USERPROFILE = home;
        equal(getHomeDir(), home, "Cache paths must use the isolated laptop HOME");
        const name = releaseRuntimeName(version, suffix);
        const cache = releaseRuntimeCacheDirectory(version, suffix);
        await mkdir(cache, { recursive: true });
        for (const file of [name, `${name}.sha256`]) await copyFile(join(directory, file), join(cache, file));
        equal(
            (await readFile(join(cache, `${name}.sha256`), "utf8")).trim(),
            `${await sha256Bytes(await readFile(join(cache, name)))}  ${name}`,
            "Candidate archive checksum mismatch",
        );
        const extracted = join(root, "extracted");
        await mkdir(extracted);
        const { artifact, metadata } = await extractReleaseRuntime(join(cache, name), suffix, null, extracted);
        equal(metadata.version, version);
        const embedded = JSON.parse(command(artifact, ["--remote-preflight"]));
        equal(embedded.buildId, metadata.buildId);
        equal(embedded.version, version);
        equal(embedded.protocol, metadata.protocol);

        sudo("useradd", "--user-group", "--no-create-home", "--home-dir", remoteHome, "--shell", "/bin/sh", account);
        createdAccount = true;
        // Locked accounts are rejected by sshd even for public keys with UsePAM=no.
        sudo("usermod", "--password", "*", account);
        sudo("mkdir", "-m", "700", remoteHome);
        sudo("chown", `${account}:${account}`, remoteHome);
        const uid = Number(command("id", ["-u", account]));
        const runRemote = (shell: string) =>
            sudo(
                "-u",
                account,
                "env",
                `HOME=${remoteHome}`,
                "PATH=/usr/bin:/bin",
                "sh",
                "-c",
                `cd '${remoteHome}' && ${shell}`,
            );
        equal(
            runRemote("command -v cymbal || command -v ketch || true"),
            "",
            "System helpers must not be on server PATH",
        );
        const project = `${remoteHome}/project`;
        const sentinel = `remote-only-${crypto.randomUUID()}`;
        runRemote(
            `umask 077; mkdir '${project}'; cd '${project}'; git init -q -b main; git config user.email qualification@example.invalid; git config user.name Qualification; printf '%s\\n' '${sentinel}' > sentinel.txt; git add .; git commit -qm fixture`,
        );
        await writeFile(join(root, "server-account.json"), JSON.stringify({ account, uid, remoteHome, project }));

        command("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(root, "client-key")]);
        command("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(root, "host-key")]);
        sudo("mkdir", "-m", "700", `${remoteHome}/.ssh`);
        sudo("cp", join(root, "client-key.pub"), `${remoteHome}/.ssh/authorized_keys`);
        sudo("chown", "-R", `${account}:${account}`, `${remoteHome}/.ssh`);
        sudo("chmod", "600", `${remoteHome}/.ssh/authorized_keys`);
        const wrapper = join(root, "remote-command");
        await writeFile(
            wrapper,
            `#!/bin/sh\nexport HOME='${remoteHome}'\nexport PATH=/usr/bin:/bin\nexport TMPDIR='${remoteHome}/tmp'\numask 077\nexec /bin/sh -c "$SSH_ORIGINAL_COMMAND"\n`,
            { mode: 0o755 },
        );
        runRemote(`mkdir -m 700 '${remoteHome}/tmp'`);
        // OpenSSH reads passwd HOME, not $HOME. Every external ssh invocation uses this -F config.
        const reservation = createServer();
        await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
        const address = reservation.address();
        ok(address && typeof address !== "string");
        const port = address.port;
        await new Promise<void>((done) => reservation.close(() => done()));
        const sshdConfig = join(root, "sshd_config");
        await writeFile(
            sshdConfig,
            `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${root}/host-key\nPidFile ${root}/sshd.pid\nAuthorizedKeysFile .ssh/authorized_keys\nAllowUsers ${account}\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nPermitRootLogin no\nStrictModes yes\nAllowTcpForwarding yes\nAllowStreamLocalForwarding yes\nPermitTTY yes\nForceCommand ${wrapper}\nLogLevel VERBOSE\n`,
        );
        sudo("mkdir", "-p", "/run/sshd");
        sudo("/usr/sbin/sshd", "-t", "-f", sshdConfig);
        // Reverse forwards use the laptop's port numbers. Give the server its own
        // loopback network without a route to the internet or host network changes.
        sshd = spawn(
            "sudo",
            [
                "-n",
                "unshare",
                "--net",
                "/bin/sh",
                "-c",
                `ip link set lo up && exec /usr/sbin/sshd -D -e -f '${sshdConfig}'`,
            ],
            {
                stdio: ["ignore", "pipe", "pipe"],
            },
        );
        sshd.stderr?.on("data", (data: Buffer) => void appendFile(join(root, "sshd.log"), data));
        let serverPid = "";
        await until(
            "isolated sshd",
            async () => {
                serverPid = (await readFile(join(root, "sshd.pid"), "utf8").catch(() => "")).trim();
                return /^\d+$/.test(serverPid);
            },
            15_000,
        );
        ok(sudo("cat", `/proc/${serverPid}/cmdline`).includes(sshdConfig), "Private sshd identity mismatch");
        const proxy = join(root, "ssh-proxy.py");
        await writeFile(
            proxy,
            `import socket,sys,threading\ns=socket.create_connection(('127.0.0.1',int(sys.argv[1])),3)\ns.settimeout(None)\ndef send():\n try:\n  while True:\n   data=sys.stdin.buffer.read1(65536)\n   if not data: break\n   s.sendall(data)\n finally: s.shutdown(socket.SHUT_WR)\nt=threading.Thread(target=send,daemon=True); t.start()\nwhile True:\n data=s.recv(65536)\n if not data: break\n sys.stdout.buffer.write(data); sys.stdout.buffer.flush()\n`,
        );
        const sshConfig = join(root, "ssh_config");
        await writeFile(
            sshConfig,
            `Host qualification\n HostName 127.0.0.1\n Port ${port}\n User ${account}\n IdentityFile ${root}/client-key\n IdentitiesOnly yes\n BatchMode yes\n StrictHostKeyChecking yes\n UserKnownHostsFile ${root}/known_hosts\n GlobalKnownHostsFile /dev/null\n ConnectTimeout 3\n ProxyCommand sudo -n nsenter --net=/proc/${serverPid}/ns/net /usr/bin/python3 ${proxy} %p\n`,
        );
        const hostKey = (await readFile(join(root, "host-key.pub"), "utf8")).trim();
        await writeFile(join(root, "known_hosts"), `[127.0.0.1]:${port} ${hostKey}\n`);
        const bin = join(root, "bin");
        await mkdir(bin);
        await writeFile(join(bin, "ssh"), `#!/bin/sh\nexec /usr/bin/ssh -F '${sshConfig}' "$@"\n`, { mode: 0o700 });
        await until(
            "loopback sshd",
            () => {
                try {
                    return command(join(bin, "ssh"), ["qualification", "printf ready"]) === "ready";
                } catch {
                    return false;
                }
            },
            15_000,
        );
        const mounts = () =>
            command("cat", ["/proc/self/mountinfo"])
                .split("\n")
                .filter((line) => line.includes(" - fuse.sshfs ") && line.includes(`user_id=${uid},`));
        equal(mounts().length, 0);
        const exchange = new SentinelExchange(sentinel);
        server = createServer(async (request, response) => {
            try {
                equal(request.headers.authorization, "Bearer qualification-only");
                const chunks: Buffer[] = [];
                for await (const chunk of request) chunks.push(Buffer.from(chunk));
                const body = Buffer.concat(chunks).toString("utf8");
                await appendFile(join(root, "provider.jsonl"), body + "\n");
                const reply = exchange.reply(JSON.parse(body));
                response.writeHead(200, { "content-type": "text/event-stream" });
                response.end(reply);
            } catch (error) {
                providerError = error instanceof Error ? error : new Error(String(error));
                response.writeHead(500);
                response.end(providerError.message);
            }
        });
        await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
        const providerAddress = server.address();
        ok(providerAddress && typeof providerAddress !== "string");
        const state = join(home, ".wld");
        await mkdir(state, { recursive: true });
        await writeFile(
            join(state, "models.json"),
            JSON.stringify({
                providers: {
                    fixture: {
                        name: "Laptop qualification",
                        baseUrl: `http://127.0.0.1:${providerAddress.port}/v1`,
                        apiKey: "qualification-only",
                        api: "openai-completions",
                        models: [
                            {
                                id: "fixture",
                                name: "Fixture",
                                api: "openai-completions",
                                reasoning: false,
                                input: ["text"],
                                contextWindow: 128000,
                                maxTokens: 1024,
                            },
                        ],
                    },
                },
            }),
        );
        await writeFile(
            join(state, "auth.json"),
            JSON.stringify({ fixture: { type: "api_key", key: "qualification-only" } }),
        );
        await writeFile(
            join(state, "settings.json"),
            JSON.stringify({
                defaultProvider: "fixture",
                defaultModel: "fixture",
                notifications: { enabled: false },
                onboardingTutorialOfferHandled: true,
            }),
        );
        await writeFile(join(root, "input"), "");
        await writeFile(join(root, "terminal-driver.py"), TERMINAL_DRIVER);
        terminal = spawn(
            "/usr/bin/python3",
            [join(root, "terminal-driver.py"), root, artifact, `qualification:${project}`],
            {
                env: {
                    ...process.env,
                    HOME: home,
                    USERPROFILE: home,
                    PATH: `${bin}:/usr/bin:/bin`,
                    MNEMOTECA_DB_PATH: join(home, "memory.db"),
                    TERM: "xterm-256color",
                },
                stdio: ["ignore", "pipe", "pipe"],
            },
        );
        terminal.stderr?.on("data", (data: Buffer) => void appendFile(join(root, "pty-error.log"), data));
        const screen = () => readFile(join(root, "terminal.log"), "utf8").catch(() => "");
        await until("remote TUI and real SSHFS mount", async () => {
            if (terminal!.exitCode !== null) throw new Error(`PTY ended early: ${await screen()}`);
            return (await screen()).includes("fixture") && mounts().length > 0;
        });
        await writeFile(join(root, "active-mounts.log"), mounts().join("\n"));
        await until("initial project offer", async () => (await screen()).includes("Would you like to run /init"));
        const offeredScreenLength = (await screen()).length;
        await appendFile(join(root, "input"), "\x1b[B\n");
        await until("project offer declined", async () => (await screen()).length > offeredScreenLength);
        await appendFile(join(root, "input"), "/agent operator\n");
        await until("Operator selected", async () => (await screen()).includes("Operator"));
        await appendFile(join(root, "input"), "Read sentinel.txt and report its contents.\n");
        await until(
            "sentinel in next model request and final terminal response",
            async () => {
                if (providerError) throw providerError;
                return exchange.verified && (await screen()).includes("SSH qualification complete.");
            },
            60_000,
        );
        await appendFile(join(root, "input"), "/exit\n");
        await until(
            "normal /exit",
            async () => (await readFile(join(root, "exit-code"), "utf8").catch(() => "")) === "0",
            20_000,
        );
        await until(
            "owned processes and SSHFS mounts cleaned",
            async () => {
                const processes = command("ps", ["-eo", "uid=,pid=,args="])
                    .split("\n")
                    .filter((line) => Number(line.trim().split(/\s+/)[0]) === uid);
                await writeFile(join(root, "remaining-processes.log"), processes.join("\n"));
                return (
                    !processes.some((line) => /--remote-(supervisor|view)|sshfs/.test(line)) && mounts().length === 0
                );
            },
            20_000,
        );
        const { listSavedRemoteSessions } = await import("../src/shared/remote/laptop-session-control.ts");
        const sessions = listSavedRemoteSessions();
        equal(sessions.length, 1, "Exactly one laptop Session must be saved");
        ok(sessions[0].contents.includes(sentinel));
        ok(sessions[0].contents.includes("SSH qualification complete."));
        // Ignore the live laptop resource mount: it is already proved absent above.
        equal(
            runRemote(
                `find '${remoteHome}' -type f \\( -name '*.jsonl' -o -name 'session.json' -o -name 'manifest.json' \\) -print`,
            ),
            "",
            "Remote transcript or Session manifest persisted",
        );
        for (const pin of remoteHelperPins({ os: "Linux", arch: process.arch === "x64" ? "x86_64" : "aarch64" })) {
            const path = remoteHelperPaths(pin, remoteHome).remote;
            for (const [file, digest] of [
                [pin.binary, pin.binarySha256],
                ["LICENSE", pin.licenseSha256],
            ]) {
                equal(runRemote(`sha256sum '${path}/${file}'`).split(/\s+/)[0], digest);
                equal(runRemote(`stat -c '%a %u' '${path}/${file}'`), `${file === pin.binary ? "700" : "600"} ${uid}`);
            }
            runRemote(`'${path}/${pin.binary}' --help >/dev/null`);
        }
        await writeFile(
            join(root, "result.json"),
            JSON.stringify({
                passed: true,
                version,
                target: metadata.target,
                buildId: metadata.buildId,
                requests: exchange.requests,
                sessions: sessions.length,
            }),
        );
        console.log(`SSH qualification passed: ${metadata.target}. Evidence: ${root}`);
    } finally {
        try {
            terminal?.kill("SIGTERM");
            server?.closeAllConnections();
            server?.close();
            sshd?.kill("SIGTERM");
            // sudo can retain its privileged child. The private PidFile identifies this sshd only.
            try {
                const pid = (await readFile(join(root, "sshd.pid"), "utf8")).trim();
                if (/^\d+$/.test(pid) && sudo("cat", `/proc/${pid}/cmdline`).includes(join(root, "sshd_config"))) {
                    sudo("kill", "-TERM", pid);
                }
            } catch {
                /* Already stopped. */
            } // Kill only the recorded disposable account's work, never a global name match.
            if (createdAccount) {
                try {
                    sudo("pkill", "-KILL", "-u", account);
                } catch {
                    /* No owned processes. */
                }
                // Only our account's TMPDIR can contain these mounts. Failure is not a passing gate.
                try {
                    const owned = sudo("findmnt", "-rn", "-t", "fuse.sshfs", "-o", "TARGET")
                        .split("\n")
                        .filter((path) => path.startsWith(`${remoteHome}/tmp/`));
                    for (const path of owned) sudo("umount", "-l", "--", path);
                } catch {
                    /* No mounts, or retain evidence for diagnosis. */
                }
                sudo("userdel", account);
            }
        } finally {
            if (originalHome === undefined) delete process.env.HOME;
            else process.env.HOME = originalHome;
            if (originalProfile === undefined) delete process.env.USERPROFILE;
            else process.env.USERPROFILE = originalProfile;
            console.log(`SSH qualification evidence retained: ${root}`);
        }
    }
}

if (import.meta.main) await main();
