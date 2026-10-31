/**
 * Opt-in macOS/sct production qualification driver. Never imported by the test inventory.
 * bun src/shared/remote/verify-remote-reviews.ts /tmp/matching-artifacts/wld
 * The matching wld-x86_64-unknown-linux-gnu and both .build.json files must be adjacent.
 * Optional arguments: existing remote project, then existing isolated laptop HOME.
 * Prints an owned evidence directory. Append terminal bytes to input; newline becomes Enter.
 * QUALIFY_EXPLAIN requests a reply only; QUALIFY_REVISE requests a reviewed-content change.
 * response.json and response-text in the evidence root can override only the synthetic provider.
 * Use headed agent-browser --session remote-reviews-df8a7ec8 for browser checks.
 * Only the HTTP model provider is synthetic; the compiled launcher and supervisor are unchanged.
 */
import { equal, ok } from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
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
    ok(process.argv[2], "Supply the compiled local executable.");
    const executable = resolve(process.argv[2]);
    const linux = join(dirname(executable), "wld-x86_64-unknown-linux-gnu");
    const localMetadata: Metadata = JSON.parse(await readFile(executable + ".build.json", "utf8"));
    const remoteMetadata: Metadata = JSON.parse(await readFile(linux + ".build.json", "utf8"));
    equal(localMetadata.buildId, remoteMetadata.buildId);
    const root = await mkdtemp(join(tmpdir(), "wld-remote-reviews-"));
    const ssh = (shell: string) =>
        execFileSync("/usr/bin/ssh", ["-T", "-o", "BatchMode=yes", "sct", shell], { encoding: "utf8" }).trim();
    const remote = process.argv[3] || ssh("umask 077; mktemp -d /tmp/wld-remote-reviews-XXXXXXXXXX");
    ok(/^\/tmp\/wld-remote-reviews-[a-zA-Z0-9]+$/.test(remote));
    if (!process.argv[3])
        ssh(
            `cd ${remote} && git init -q -b main && git config user.email qualification@example.invalid && git config user.name Qualification && printf 'remote-only sentinel\\n' > sentinel.txt && printf '# Remote document\\n' > document.md && git add . && git commit -qm fixture`,
        );
    if (!process.argv[3])
        ssh(
            `cd ${remote} && mkdir -p .wld && printf '%s' '{"verification_command":"test -s sentinel.txt","codereview":"always"}' > .wld/settings.json && printf '.wld/\\n' > .gitignore && git add .gitignore && git commit -qm settings && git init --bare -q ${remote}/../$(basename ${remote})-published.git && git remote add origin ${remote}/../$(basename ${remote})-published.git && git push -qu origin main`,
        );
    const home = process.argv[4] || join(root, "home");
    await mkdir(join(home, ".wld"), { recursive: true });
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
    await writeFile(join(root, "input"), "");
    // A real PTY is required by the production terminal UI. The helper owns exactly one child.
    const helper = join(root, "terminal-driver.py");
    await writeFile(
        helper,
        `import os,pty,sys,time,select,fcntl,termios,struct,signal\nroot,exe,target=sys.argv[1:]\npid,fd=pty.fork()\nif pid==0:\n os.chdir(root)\n os.execv(exe,[exe,'remote',target])\nfcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',40,150,0,0))\nopen(root+'/launcher.pid','w').write(str(pid))\nsignal.signal(signal.SIGTERM,lambda signum,frame: sys.exit(0))\npos=0\ntry:\n with open(root+'/terminal.log','ab',buffering=0) as log:\n  while True:\n   if select.select([fd],[],[],0.1)[0]:\n    try: data=os.read(fd,65536)\n    except OSError: break\n    if not data: break\n    log.write(data)\n   with open(root+'/input','rb') as inp:\n    inp.seek(pos); data=inp.read(); pos=inp.tell()\n   if data: os.write(fd,data.replace(b'\\n',b'\\r'))\nfinally:\n try: os.kill(pid,signal.SIGTERM)\n except ProcessLookupError: pass\n os.waitpid(pid,0)\n`,
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
            MNEMOTECA_DB_PATH: join(home, "memory.db"),
            // Advertise OSC 8 support through SSH's TERM propagation for real PTY link clicks.
            TERM: "xterm-ghostty",
        },
        stdio: "inherit",
    });
    await writeFile(
        join(root, "qualification.json"),
        JSON.stringify(
            { root, remote, buildId: localMetadata.buildId, executable, linux, session: "remote-reviews-df8a7ec8" },
            null,
            2,
        ),
    );
    console.log(JSON.stringify({ root, remote, buildId: localMetadata.buildId }));
    const stop = () => child.kill("SIGTERM");
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    const deadline = setTimeout(stop, 20 * 60_000);
    try {
        await new Promise<void>((done) => child.once("exit", () => done()));
    } finally {
        clearTimeout(deadline);
        server.closeAllConnections();
        server.close();
    }
}
