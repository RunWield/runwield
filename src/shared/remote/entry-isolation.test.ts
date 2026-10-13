import type { TerminalRuntime } from "../../../scripts/terminal-fixture.ts";
import process from "node:process";
import { readdir } from "node:fs/promises";
import { captureForegroundProcess } from "../captured-process.ts";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { dirname, join } from "node:path";
import { fileURLToPath as fromFileUrl } from "node:url";

const cli = fromFileUrl(new URL("../../cli.ts", import.meta.url));
const projectRoot = dirname(dirname(dirname(cli)));
const pty = String.raw`import fcntl, json, os, pty, select, subprocess, sys, termios, time, tty
cli, cwd, home, runtime, runtime_args = sys.argv[1:]
master, slave = pty.openpty()
tty.setraw(slave)  # The supervisor makes the SSH terminal raw before starting the view.
env = dict(os.environ, HOME=home, WLD_TEST_SANDBOX_HOME=home, MNEMOTECA_DB_PATH=os.path.join(home, 'mnemoteca.db'))
def terminal_session():
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
child = subprocess.Popen([runtime] + json.loads(runtime_args) + [cli, '--remote-view'], cwd=cwd, env=env, stdin=slave, stdout=slave, stderr=slave, preexec_fn=terminal_session)
os.close(slave)
config = dict(host='isolated-host', cwd=cwd, status='Connected', trust='SSH verified', readiness='No user turns')
os.write(master, (json.dumps(config) + '\n').encode())
output = b''
deadline = time.monotonic() + 20
try:
    while b'Press q' not in output and time.monotonic() < deadline:
        if select.select([master], [], [], .2)[0]:
            try: output += os.read(master, 65536)
            except OSError: break
    if b'Press q' in output:
        for data in (b'hello\r', b'\x1b[200~pasted text\x1b[201~', b'/settings\r', b'! touch BAD\r', b'@secret.txt\r'):
            os.write(master, data)
            time.sleep(.2)
        time.sleep(.5)
    if b'Press q' in output: os.write(master, b'q')
    time.sleep(.2)
    if child.poll() is None: child.kill()
    child.wait(timeout=5)
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    os.close(master)
print(json.dumps({'code': child.returncode, 'screen': output.decode(errors='replace')}))`;

/** Exercise the native PTY (ConPTY on Windows), never piped stand-in input. */
async function nativeTerminalSession(project: string, home: string): Promise<{ code: number; screen: string }> {
    const bun: TerminalRuntime = Reflect.get(globalThis, String("Bun"));
    const decoder = new TextDecoder();
    let screen = "";
    let exited = false;
    const child = bun.spawn([process.execPath, "run", cli, "--remote-view"], {
        cwd: project,
        env: { ...process.env, HOME: home, WLD_TEST_SANDBOX_HOME: home, MNEMOTECA_DB_PATH: join(home, "mnemoteca.db") },
        timeout: 30_000,
        terminal: {
            cols: 100,
            rows: 30,
            data(_terminal, data) {
                screen += decoder.decode(data, { stream: true });
            },
        },
    });
    const finished = child.exited.then((code) => {
        exited = true;
        return code;
    });
    try {
        child.terminal.setRawMode(true);
        child.terminal.write(
            JSON.stringify({
                host: "isolated-host",
                cwd: project,
                status: "Connected",
                trust: "SSH verified",
                readiness: "No user turns",
            }) + (process.platform === "win32" ? "\r" : "\n"),
        );
        const deadline = Date.now() + 20_000;
        while (!screen.includes("Press q") && !exited && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (!screen.includes("Press q")) throw new Error(`Remote view did not become ready: ${screen}`);
        for (const input of [
            "hello\r",
            "\x1b[200~pasted text\x1b[201~",
            "/settings\r",
            "! touch BAD\r",
            "@secret.txt\r",
        ]) {
            child.terminal.write(input);
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        child.terminal.write("q");
        const code = await finished;
        screen += decoder.decode();
        return { code, screen };
    } finally {
        if (!exited) child.kill("SIGKILL");
        await finished;
        child.terminal.close();
    }
}

async function files(root: string): Promise<string[]> {
    const found: string[] = [];
    async function visit(path: string, relative: string) {
        for await (const entry of await readdir(path, { withFileTypes: true })) {
            const name = join(relative, entry.name);
            found.push(name);
            if (entry.isDirectory()) await visit(join(path, entry.name), name);
        }
    }
    await visit(root, "");
    return found.sort();
}

for (const populated of [false, true]) {
    test(`private remote view rejects input in ${populated ? "sentinel" : "empty"} home under a pseudo-terminal`, async () => {
        const root = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
        const home = join(root, "home");
        const project = join(root, "project");
        try {
            await fsMkdir(home);
            await fsMkdir(project);
            await fsWriteFile(join(project, "secret.txt"), "project sentinel");
            await fsMkdir(join(project, ".wld"));
            await fsWriteFile(join(project, ".wld/settings.json"), "project settings sentinel");
            if (populated) {
                for (const directory of [".wld", ".wld/skills", ".wld/credentials"]) {
                    await fsMkdir(join(home, directory));
                }
                await fsWriteFile(join(home, ".wld/settings.json"), "settings sentinel");
                await fsWriteFile(join(home, ".wld/skills/skill.md"), "skill sentinel");
                await fsWriteFile(join(home, ".wld/credentials/key"), "credential sentinel");
            }
            const before = await files(home);
            const projectBefore = await files(project);
            const { code, screen } = process.versions.bun
                ? await nativeTerminalSession(project, home)
                : await (async () => {
                      const result = await captureForegroundProcess("python3", {
                          args: ["-c", pty, cli, project, home, process.execPath, JSON.stringify(["run", ...[]])],
                          cwd: projectRoot,
                      });
                      assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
                      return JSON.parse(new TextDecoder().decode(result.stdout));
                  })();
            assertEquals([0, -9].includes(code), true, screen);
            assertStringIncludes(screen, "isolated-host");
            // The terminal wraps long absolute directories across rows.
            assertStringIncludes(
                // deno-lint-ignore no-control-regex -- Strip terminal hyperlink controls before comparing wrapped text.
                screen.replaceAll(/\x1b\]8;;\x07|\s/g, ""),
                project.replaceAll(/\s/g, "").slice(0, 70),
            );
            assertStringIncludes(screen, "No user turns");
            assertEquals(await files(home), before);
            assertEquals(await files(project), projectBefore);
            assertEquals(await fsReadFile(join(project, "secret.txt"), "utf8"), "project sentinel");
            assertEquals(await fsReadFile(join(project, ".wld/settings.json"), "utf8"), "project settings sentinel");
            assertEquals(
                await fsStat(join(project, "BAD")).then(
                    () => true,
                    () => false,
                ),
                false,
            );
            if (populated) {
                assertEquals(await fsReadFile(join(home, ".wld/settings.json"), "utf8"), "settings sentinel");
                assertEquals(await fsReadFile(join(home, ".wld/skills/skill.md"), "utf8"), "skill sentinel");
                assertEquals(await fsReadFile(join(home, ".wld/credentials/key"), "utf8"), "credential sentinel");
            }
        } finally {
            await fsRm(root, { recursive: true });
        }
    });
}
