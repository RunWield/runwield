/**
 * Opt-in macOS/sct production qualification driver. Never imported by the test inventory.
 * bun src/shared/remote/verify-remote-reviews.ts /tmp/matching-artifacts/wld
 * The matching wld-x86_64-unknown-linux-gnu and both .build.json files must be adjacent.
 * Release input: --archives <directory> <VERSION> [remote-project] [laptop-HOME].
 * Compiled input: <executable> [remote-project] [laptop-HOME].
 * WLD_QUALIFY_PROVIDER=real uses the selected HOME without writing its .wld profile.
 * Synthetic mode refuses the real laptop HOME; it defaults to a disposable HOME.
 * Prints an owned evidence directory. Append terminal bytes to input; newline becomes Enter.
 * QUALIFY_EXPLAIN requests a reply only; QUALIFY_REVISE requests a reviewed-content change.
 * response.json and response-text in the evidence root can override only the synthetic provider.
 * Use headed agent-browser --session remote-reviews-df8a7ec8 for browser checks.
 * Only the HTTP model provider is synthetic; the compiled launcher and supervisor are unchanged.
 */
import { equal, ok } from "node:assert/strict";
import { spawn, execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { Terminal } from "@xterm/headless";
import { buildValidationUserMessage } from "../workflow/validation-user-messages.ts";
import { getHomeDir } from "../../constants.js";
import { extractReleaseRuntime, releaseRuntimeCacheDirectory, releaseRuntimeName } from "./release-artifact.ts";
import { sha256Bytes } from "../../../scripts/build-metadata.ts";
import { deliveryPlan } from "./remote-runtime-workflows-fixture.ts";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
interface Metadata {
    buildId: string;
}
interface Tool {
    function: { name: string };
}
interface ContentPart {
    type: string;
    text?: string;
}
interface ProviderMessage {
    role: string;
    content?: string | ContentPart[];
    tool_calls?: ToolCall[];
}
interface ToolCall {
    id: string;
    type: string;
    function: { name: string; arguments: string };
}
interface ProviderRequest {
    tools?: Tool[];
    messages: ProviderMessage[];
}

if (import.meta.main) await main();
async function main(): Promise<void> {
    equal(process.platform, "darwin", "This pilot is macOS-only; Windows is deferred.");
    equal(process.versions.bun, "1.4.3");
    const args = process.argv.slice(2);
    let archives: string | undefined;
    if (args[0] === "--archives") {
        args.shift();
        ok(args[0], "Supply the release archive directory");
        archives = resolve(args.shift()!);
    }
    const version = archives ? args.shift() : undefined;
    const provider = process.env.WLD_QUALIFY_PROVIDER || "synthetic";
    ok(["real", "synthetic"].includes(provider), "WLD_QUALIFY_PROVIDER must be real or synthetic");
    const personalHome = getHomeDir();
    const root = await mkdtemp(join(tmpdir(), "wld-remote-reviews-"));
    const compiled = archives ? undefined : args.shift();
    ok(archives ? version : compiled, "Supply --archives <directory> <VERSION>, or a compiled executable.");
    const [project, selectedHome] = args;
    ok(args.length <= 2, "Expected optional remote project and laptop HOME");
    const home = resolve(selectedHome || (provider === "real" ? personalHome : join(root, "home")));
    await mkdir(home, { recursive: true });
    if (provider === "synthetic") {
        ok(
            (await realpath(home)) !== (await realpath(personalHome)),
            "Synthetic mode refuses the personal laptop HOME",
        );
        await mkdir(join(home, ".wld"), { recursive: true });
    }
    let executable: string;
    let linux: string;
    let localMetadata: Metadata;
    if (archives && version) {
        const localDirectory = join(root, "launcher");
        const linuxDirectory = join(root, "linux");
        await mkdir(localDirectory);
        await mkdir(linuxDirectory);
        const localName = releaseRuntimeName(version, "darwin-arm64");
        const linuxName = releaseRuntimeName(version, "linux-x64");
        for (const name of [localName, linuxName]) {
            equal(
                (await readFile(join(archives, `${name}.sha256`), "utf8")).trim(),
                `${await sha256Bytes(await readFile(join(archives, name)))}  ${name}`,
                "Archive checksum mismatch",
            );
        }
        const local = await extractReleaseRuntime(join(archives, localName), "darwin-arm64", null, localDirectory);
        equal(local.metadata.version, version);
        const remote = await extractReleaseRuntime(
            join(archives, linuxName),
            "linux-x64",
            local.metadata,
            linuxDirectory,
        );
        executable = local.artifact;
        linux = remote.artifact;
        localMetadata = local.metadata;
        // Only cache storage is changed. Real mode never writes personal .wld configuration.
        const previousHome = process.env.HOME;
        const previousProfile = process.env.USERPROFILE;
        try {
            process.env.HOME = home;
            process.env.USERPROFILE = home;
            const cache = releaseRuntimeCacheDirectory(version, "linux-x64");
            await mkdir(cache, { recursive: true });
            for (const name of [linuxName, `${linuxName}.sha256`])
                await copyFile(join(archives, name), join(cache, name));
        } finally {
            if (previousHome === undefined) delete process.env.HOME;
            else process.env.HOME = previousHome;
            if (previousProfile === undefined) delete process.env.USERPROFILE;
            else process.env.USERPROFILE = previousProfile;
        }
    } else {
        executable = resolve(compiled!);
        linux = join(dirname(executable), "wld-x86_64-unknown-linux-gnu");
        localMetadata = JSON.parse(await readFile(executable + ".build.json", "utf8"));
        const remoteMetadata: Metadata = JSON.parse(await readFile(linux + ".build.json", "utf8"));
        equal(localMetadata.buildId, remoteMetadata.buildId);
    }
    const ssh = (shell: string) =>
        execFileSync("/usr/bin/ssh", ["-T", "-o", "BatchMode=yes", "sct", shell], {
            encoding: "utf8",
            timeout: 30_000,
        }).trim();
    const remote = project || ssh("umask 077; mktemp -d /tmp/wld-remote-reviews-XXXXXXXXXX");
    ok(/^\/tmp\/wld-remote-reviews-[a-zA-Z0-9]+$/.test(remote));
    if (!project)
        ssh(
            `cd ${remote} && git init -q -b main && git config user.email qualification@example.invalid && git config user.name Qualification && printf 'remote-only sentinel\\n' > sentinel.txt && printf '# Remote document\\n' > document.md && git add . && git commit -qm fixture`,
        );
    if (!project)
        ssh(
            `cd ${remote} && mkdir -p .wld && printf '%s' '{"verification_command":"test -s sentinel.txt","codereview":"always"}' > .wld/settings.json && printf '.wld/\\n' > .gitignore && git add .gitignore && git commit -qm settings && git init --bare -q ${remote}/../$(basename ${remote})-published.git && git remote add origin ${remote}/../$(basename ${remote})-published.git && git push -qu origin main`,
        );
    const sentinel = join(root, basename(remote));
    await mkdir(sentinel);
    await writeFile(join(sentinel, "sentinel.txt"), "laptop-only sentinel\n");
    let revision = 0;
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString("utf8");
        await appendFile(join(root, "provider.jsonl"), body + "\n");
        equal(request.headers.authorization, "Bearer qualification-only");
        const parsed: ProviderRequest = JSON.parse(body);
        const names = parsed.tools?.map((tool) => tool.function.name) || [];
        const last = parsed.messages.at(-1);
        const previous = parsed.messages
            .filter((message) => message.tool_calls)
            .at(-1)
            ?.tool_calls?.at(-1)?.function.name;
        let call: ToolCall | undefined;
        const tool = (name: string, args: Record<string, JsonValue>) => ({
            id: `live-${Date.now()}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
        });
        const userContent = [...parsed.messages].reverse().find((message) => {
            const content = message.content;
            return (
                message.role === "user" ||
                (typeof content === "string" &&
                    (content.includes("## Plan review conversation:") || content.includes("Current message:\n")))
            );
        })?.content;
        const text =
            typeof userContent === "string"
                ? userContent
                : userContent?.map((part) => part.text || "").join("\n") || "";
        // Repair prompts include prior conversation. Only the current message controls revision intent.
        const turnText = (text.split("Current message:\n").at(-1) || text).split("### User message\n").at(-1) || text;
        if (names.includes("triage_report"))
            call = tool("triage_report", {
                routingIntent: "PLANNED_CHANGE",
                complexity: "LOW",
                summary: "Plan a remote-only sentinel change.",
            });
        else if (names.includes("plan_written")) {
            if (last?.role === "tool" && previous === "write")
                call = tool("plan_written", {
                    planName: "remote-delivery",
                    executionAgent: "engineer",
                    collaborationRecommendation: "autonomous",
                });
            else if (
                turnText.includes("QUALIFY_REVISE") ||
                (!text.includes("Plan review conversation") && revision === 0)
            ) {
                revision++;
                call = tool("write", {
                    path: "docs/plans/remote-delivery.md",
                    content: deliveryPlan + `\n## Live revision ${revision}\n\nRemote browser qualification.\n`,
                });
            }
        } else if (names.includes("task_completed")) {
            if (last?.role === "tool" && previous === "write")
                call = tool("task_completed", {
                    message: "Implemented remote sentinel and document link [Remote document](document.md).",
                });
            else if (turnText.includes("QUALIFY_REVISE") || !turnText.includes("QUALIFY_EXPLAIN"))
                call = tool("write", {
                    path: "sentinel.txt",
                    content: turnText.includes("QUALIFY_REVISE") ? "remote revised\n" : "remote delivered\n",
                });
        } else if (names.includes("review_complete")) {
            const calls = parsed.messages
                .flatMap((message) => message.tool_calls || [])
                .filter((entry) => entry.function.name === "review_diff");
            const inspected = calls.map((entry) => JSON.parse(entry.function.arguments) as Record<string, string>);
            const listingText = parsed.messages
                .filter((message) => message.role === "tool")
                .map((message) => (typeof message.content === "string" ? message.content : ""))
                .join("\n");
            const paths = [...listingText.matchAll(/`([^`]+)` \|/g)].map((match) => match[1]);
            for (const scope of ["full", "repair"]) {
                if (!inspected.some((entry) => entry.command === "list" && entry.scope === scope)) {
                    call = tool("review_diff", { command: "list", scope });
                    break;
                }
                const missing = paths.find(
                    (path) =>
                        !inspected.some(
                            (entry) => entry.command === "show" && entry.scope === scope && entry.path === path,
                        ),
                );
                if (missing) {
                    call = tool("review_diff", { command: "show", scope, path: missing });
                    break;
                }
            }
            if (!call) call = tool("review_complete", { approved: true, findings: [], advisories: [] });
        } else if (names.includes("boundary_scenario")) {
            if (previous !== "boundary_scenario") call = tool("boundary_scenario", {});
        } else if (names.includes("manual_qa_completed")) {
            call = tool("manual_qa_completed", {
                checklistMarkdown: "Manual verification steps\n- [ ] Inspect the remote sentinel.",
            });
        } else if (names.includes("work_record_completed")) {
            call = tool("work_record_completed", { title: "Remote delivery", summary: "Deliver the remote sentinel." });
        } else if (names.includes("read") && !(last?.role === "tool" && previous === "read")) {
            call = tool("read", { path: "sentinel.txt" });
        }
        let assistantContent = "Remote qualification response complete.";
        if (text.includes("You are generating a RunWield Guided Review Explainer")) {
            const changedFiles =
                text
                    .split("Changed files:\n")
                    .at(-1)
                    ?.split("\n\nDiff:")[0]
                    .split("\n")
                    .filter((line) => line.startsWith("- "))
                    .map((line) => line.slice(2)) || [];
            assistantContent = JSON.stringify({
                schemaVersion: "1.0",
                title: "Remote sentinel guide",
                intent: "Deliver the remote sentinel.",
                sections: [
                    {
                        title: "Remote delivery",
                        role: "core",
                        blocks: [
                            { type: "prose", markdown: "The laptop model read sentinel.txt from the remote worktree." },
                            ...changedFiles.map((file) => ({
                                type: "diff",
                                file,
                                summary: "Review the remote change.",
                            })),
                        ],
                    },
                ],
                everythingElse: [],
            });
        }
        const override = await readFile(join(root, "response.json"), "utf8").catch(() => "");
        if (override) call = JSON.parse(override);
        const delta = call
            ? { role: "assistant", tool_calls: [{ index: 0, ...call }] }
            : {
                  role: "assistant",
                  content: await readFile(join(root, "response-text"), "utf8").catch(() => assistantContent),
              };
        response.writeHead(200, { "content-type": "text/event-stream" });
        const packet = (value: string) => `data: ${value}\n\n`;
        response.write(
            packet(
                JSON.stringify({
                    id: "live",
                    object: "chat.completion.chunk",
                    created: 1,
                    model: "fixture",
                    choices: [{ index: 0, delta, finish_reason: null }],
                }),
            ),
        );
        response.write(
            packet(
                JSON.stringify({
                    id: "live",
                    object: "chat.completion.chunk",
                    created: 1,
                    model: "fixture",
                    choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }],
                }),
            ),
        );
        response.end(packet("[DONE]"));
    });
    if (provider === "synthetic") {
        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
        const address = server.address();
        ok(address && typeof address !== "string");
        const state = join(home, ".wld");
        await writeFile(
            join(state, "models.json"),
            JSON.stringify({
                providers: {
                    fixture: {
                        name: "Laptop qualification",
                        baseUrl: `http://127.0.0.1:${address.port}/v1`,
                        apiKey: "qualification-only",
                        api: "openai-completions",
                        models: [
                            {
                                id: "fixture",
                                name: "Fixture",
                                api: "openai-completions",
                                reasoning: false,
                                input: ["text", "image"],
                                contextWindow: 128000,
                                maxTokens: 4096,
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
    }
    await writeFile(join(root, "input"), "");
    // A real PTY is required by the production terminal UI. The helper owns exactly one child.
    const helper = join(root, "terminal-driver.py");
    await writeFile(
        helper,
        `import os,pty,sys,time,select,fcntl,termios,struct,signal,json\nroot,exe,target=sys.argv[1:]\npid,fd=pty.fork()\nif pid==0:\n os.chdir(root+'/'+target.rsplit('/',1)[1])\n os.execv(exe,[exe,'remote',target])\nfcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',40,150,0,0))\nopen(root+'/launcher.pid','w').write(str(pid))\nsignal.signal(signal.SIGTERM,lambda signum,frame: sys.exit(0))\npos=0\ntry:\n with open(root+'/terminal.log','ab',buffering=0) as log:\n  while True:\n   if select.select([fd],[],[],0.1)[0]:\n    try: data=os.read(fd,65536)\n    except OSError: break\n    if not data: break\n    log.write(data)\n   with open(root+'/input','rb') as inp:\n    inp.seek(pos); data=inp.read(); pos=inp.tell()\n   if data: os.write(fd,data.replace(b'\\n',b'\\r'))\nfinally:\n exited,status=os.waitpid(pid,os.WNOHANG)\n termination_requested=not bool(exited)\n if termination_requested:\n  try: os.kill(pid,signal.SIGTERM)\n  except ProcessLookupError: pass\n  _,status=os.waitpid(pid,0)\n with open(root+'/launcher-exit.json','w') as receipt:\n  json.dump(dict(pid=pid,exitCode=os.waitstatus_to_exitcode(status),terminationRequested=termination_requested,observedAt=time.time()),receipt)\n`,
    );
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(
        join(bin, "open"),
        `#!/bin/sh\nprintf '%s\\n' "$1" >> '${root}/browser-urls'\nexport AGENT_BROWSER_SOCKET_DIR=/tmp/ab-df8a7ec8\nexec /opt/homebrew/bin/agent-browser --headed --session remote-reviews-df8a7ec8 open "$1" >> '${root}/browser.log' 2>&1\n`,
        { mode: 0o700 },
    );
    const child = spawn("/usr/bin/python3", [helper, root, executable, `sct:${remote}`], {
        env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            HOME: home,
            USERPROFILE: home,
            ...(provider === "synthetic" ? { MNEMOTECA_DB_PATH: join(home, "memory.db") } : {}),
            // Advertise OSC 8 support through SSH's TERM propagation for real PTY link clicks.
            TERM: "xterm-ghostty",
        },
        stdio: "inherit",
    });
    const qualification = {
        root,
        remote,
        home,
        provider,
        buildId: localMetadata.buildId,
        executable,
        linux,
        sentinel,
        session: "remote-reviews-df8a7ec8",
        launcherPid: 0,
        sshPids: [] as number[],
        sftpPids: [] as number[],
        diagnostics: [] as string[],
    };
    const publicationMessages = (
        [
            "preparing",
            "reading_target",
            "using_local_target",
            "updating_target",
            "combining_work",
            "publishing",
            "verifying",
            "cleanup",
        ] as const
    ).map(
        (phase) =>
            new RegExp(
                buildValidationUserMessage({ kind: "publication_progress", phase, targetBranch: "__WLD_TARGET__" })
                    .split("__WLD_TARGET__")
                    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
                    .join("\\S+"),
            ),
    );
    const observedPublicationMessages = new Set<string>();
    const remoteCommand = promisify(execFile);
    const terminalScreen = new Terminal({ cols: 150, rows: 40, allowProposedApi: true, scrollback: 0 });
    let monitoring = false;
    let publicationSince = 0;
    let publicationCaptured = false;
    let terminalOffset = 0;
    const monitor = setInterval(async () => {
        if (monitoring) return;
        monitoring = true;
        try {
            qualification.launcherPid = Number(await readFile(join(root, "launcher.pid"), "utf8"));
            const processes = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" })
                .trim()
                .split("\n")
                .map((line) => {
                    const [pid, parent, ...command] = line.trim().split(/\s+/);
                    return { pid: Number(pid), parent: Number(parent), command: command.join(" ") };
                });
            const owned = new Set([qualification.launcherPid]);
            for (let size = -1; size !== owned.size;) {
                size = owned.size;
                for (const entry of processes) if (owned.has(entry.parent)) owned.add(entry.pid);
            }
            for (const entry of processes.filter((entry) => owned.has(entry.pid))) {
                const list =
                    basename(entry.command) === "ssh"
                        ? qualification.sshPids
                        : basename(entry.command) === "sftp-server"
                          ? qualification.sftpPids
                          : undefined;
                if (list && !list.includes(entry.pid)) list.push(entry.pid);
            }
            const terminal = await readFile(join(root, "terminal.log"));
            const added = terminal.subarray(terminalOffset);
            terminalOffset = terminal.length;
            if (added.length) await new Promise<void>((done) => terminalScreen.write(added, done));
            const buffer = terminalScreen.buffer.active;
            const screen = Array.from(
                { length: terminalScreen.rows },
                (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) || "",
            ).join("\n");
            if (!/● Publication\b/.test(screen)) {
                publicationSince = 0;
                publicationCaptured = false;
                observedPublicationMessages.clear();
            } else {
                if (!publicationSince) publicationSince = Date.now();
                for (const pattern of publicationMessages) {
                    const message = screen.match(pattern)?.[0];
                    if (!message || observedPublicationMessages.has(message)) continue;
                    observedPublicationMessages.add(message);
                    publicationSince = Date.now();
                    publicationCaptured = false;
                }
            }
            if (publicationSince && !publicationCaptured && Date.now() - publicationSince > 60_000) {
                publicationCaptured = true;
                const path = join(root, `stall-${qualification.diagnostics.length + 1}.txt`);
                try {
                    const script = `import os,sys,subprocess,json,datetime
project=sys.argv[1]
print("OBSERVED_AT",datetime.datetime.now(datetime.timezone.utc).isoformat(),flush=True)
print("GIT PROCESSES",flush=True)
processes=subprocess.run(["ps","-eo","pid,ppid,stat,etime,comm,args"],capture_output=True,text=True,check=True)
for line in processes.stdout.splitlines():
 fields=line.split(None,5)
 if len(fields)>4 and (fields[0]=="PID" or fields[4].startswith("git")): print(line,flush=True)
result=subprocess.run(["git","-C",project,"worktree","list","--porcelain"],capture_output=True,text=True,check=True)
roots=[line[9:] for line in result.stdout.splitlines() if line.startswith("worktree ")]
git_roots=set()
for worktree in roots:
 for flag in ("--absolute-git-dir","--git-common-dir"):
  result=subprocess.run(["git","-C",worktree,"rev-parse","--path-format=absolute",flag],capture_output=True,text=True,check=True)
  git_roots.add(result.stdout.strip())
try: kernel_locks=open("/proc/locks").read().splitlines()
except OSError as error:
 print("UNAVAILABLE /proc/locks",str(error),flush=True)
 kernel_locks=[]
for pid in os.listdir("/proc"):
 if not pid.isdigit(): continue
 try:
  if os.readlink("/proc/"+pid+"/cwd") not in roots: continue
  if b"--remote-view" not in open("/proc/"+pid+"/cmdline","rb").read().split(b"\\0"): continue
  env=open("/proc/"+pid+"/environ","rb").read().split(b"\\0")
  roots.extend(item[7:].decode() for item in env if item.startswith(b"TMPDIR=/tmp/wld-remote-"))
 except (FileNotFoundError,PermissionError): pass
for root in roots+sorted(git_roots):
 for directory,dirs,files in os.walk(root):
  excluded={"node_modules",".git"}
  if root in git_roots: excluded.update(("objects","hooks","logs","worktrees"))
  dirs[:]=[name for name in dirs if name not in excluded]
  for name in files:
   if not (name.endswith(".lock") or name == "validation-errors.jsonl" or name.endswith(".log")): continue
   path=os.path.join(directory,name)
   print("FILE",path,flush=True)
   try:
    info=os.stat(path)
    print("STAT",info)
    if name.endswith(".lock"):
     key=f"{os.major(info.st_dev):02x}:{os.minor(info.st_dev):02x}:{info.st_ino}"
     for line in kernel_locks:
      if key in line.split(): print("KERNEL LOCK",line)
    else: print(open(path).read()[-16000:])
   except OSError as error: print("UNAVAILABLE",str(error))
`;
                    const { stdout, stderr } = await remoteCommand(
                        "/usr/bin/ssh",
                        [
                            "-T",
                            "-o",
                            "BatchMode=yes",
                            "-o",
                            "ConnectTimeout=15",
                            "sct",
                            `python3 -c '${script.replaceAll("'", "'\\''")}' ${remote}`,
                        ],
                        { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
                    );
                    const diagnostics = `${stdout}\n${stderr}`;
                    await writeFile(path, diagnostics);
                } catch (error) {
                    await writeFile(path, `Diagnostics could not complete: ${String(error)}`);
                }
                qualification.diagnostics.push(path);
            }
            await writeFile(join(root, "qualification.json"), JSON.stringify(qualification, null, 2));
        } catch (error) {
            await appendFile(join(root, "monitor-errors.log"), `${new Date().toISOString()} ${String(error)}\n`);
        } finally {
            monitoring = false;
        }
    }, 500);
    await writeFile(join(root, "qualification.json"), JSON.stringify(qualification, null, 2));
    console.log(JSON.stringify({ root, remote, buildId: localMetadata.buildId }));
    const stop = () => child.kill("SIGTERM");
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    const deadline = setTimeout(stop, 60 * 60_000);
    try {
        await new Promise<void>((done) => child.once("exit", () => done()));
    } finally {
        clearTimeout(deadline);
        clearInterval(monitor);
        while (monitoring) await new Promise<void>((done) => setTimeout(done, 10));
        terminalScreen.dispose();
        server.closeAllConnections();
        server.close();
    }
}
