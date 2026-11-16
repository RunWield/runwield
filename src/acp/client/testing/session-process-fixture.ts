import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { defineCommittedGitFixture } from "../../../shared/git-test-fixture.ts";
import type { InterviewQuestion } from "../../../tools/user-interview.ts";
import { AcpWorkspaceSessionClient } from "../workspace-session-client.ts";
import type { SessionBinding, SessionClientView } from "../../../ui/workspace/client/session-client.ts";

interface ProviderContent {
    type: string;
    text?: string;
}
export interface ProviderMessage {
    role: string;
    content: string | ProviderContent[] | null;
    tool_call_id?: string;
}
interface ProviderRequestBody {
    messages: ProviderMessage[];
}
export interface RecordedProviderRequest {
    raw: string;
    messages: ProviderMessage[];
    authorization: string | undefined;
}
export interface ProviderStep {
    text?: string;
    question?: InterviewQuestion;
    hold?: boolean;
}

/** A real HTTP boundary. Held streams have already emitted their first chunk. */
export async function startSessionProvider() {
    const requests: RecordedProviderRequest[] = [];
    const steps: ProviderStep[] = [];
    const held = new Set<() => void>();
    const failures: string[] = [];
    const server = createServer(async (request, response) => {
        try {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const raw = Buffer.concat(chunks).toString("utf8");
            const body = JSON.parse(raw) as ProviderRequestBody;
            requests.push({ raw, messages: body.messages, authorization: request.headers.authorization });
            if (request.headers.authorization !== "Bearer fixture-key") {
                response.writeHead(401).end();
                return;
            }
            const step = steps.shift();
            if (!step) {
                failures.push("Unexpected provider request");
                response.writeHead(500).end();
                return;
            }
            response.writeHead(200, { "content-type": "text/event-stream" });
            const write = (delta: ProviderDelta, finish: string | null = null) => writeChunk(response, delta, finish);
            if (step.question) {
                write({
                    role: "assistant",
                    tool_calls: [
                        {
                            index: 0,
                            id: `interview-${requests.length}`,
                            type: "function",
                            function: {
                                name: "user_interview",
                                arguments: JSON.stringify({ question: step.question }),
                            },
                        },
                    ],
                });
            } else write({ role: "assistant", content: step.text ?? "Provider turn complete." });
            const finish = () => {
                held.delete(finish);
                if (!response.destroyed) {
                    write({}, step.question ? "tool_calls" : "stop");
                    response.end("data: [DONE]\n\n");
                }
            };
            if (step.hold) {
                held.add(finish);
                response.once("close", () => held.delete(finish));
            } else finish();
        } catch (error) {
            failures.push(error instanceof Error ? error.message : String(error));
            response.destroy();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Provider did not bind TCP.");
    return {
        server,
        requests,
        failures,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        enqueue: (...next: ProviderStep[]) => steps.push(...next),
        release: () => {
            for (const finish of [...held]) finish();
        },
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}
interface ProviderToolCall {
    index: number;
    id: string;
    type: string;
    function: { name: string; arguments: string };
}
interface ProviderDelta {
    role?: string;
    content?: string;
    tool_calls?: ProviderToolCall[];
}
function writeChunk(response: ServerResponse, delta: ProviderDelta, finish_reason: string | null) {
    response.write(
        `data: ${JSON.stringify({ id: "fixture-response", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
}
const gitProject = defineCommittedGitFixture();
export const sourceCliPath = fileURLToPath(new URL("../../../cli.ts", import.meta.url));

export async function waitForSession(
    predicate: () => boolean,
    diagnostics: () => string = () => "",
    timeout = 20_000,
): Promise<void> {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`Session wait timed out. ${diagnostics()}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

/** Private credentials and paths can also be passed to the real Electron host. */
export async function makeSessionProcessFixture() {
    const home = await mkdtemp(join(tmpdir(), "workspace-session-home-"));
    const project = await gitProject.checkout();
    const provider = await startSessionProvider();
    const state = join(home, ".wld");
    const temporary = join(home, "tmp");
    const database = join(home, "memory.db");
    await mkdir(state);
    await mkdir(temporary);
    // Use the supported user Agent override, not a substituted tool implementation.
    await mkdir(join(state, "agents"));
    await writeFile(
        join(state, "agents", "router.md"),
        "---\nname: Router\ndescription: Local provider interview fixture\nsharedPractice: [user-authority]\ntools: [user_interview]\n---\nFollow the user's request. Ask structured questions when needed.\n",
    );
    await writeFile(
        join(state, "settings.json"),
        JSON.stringify({
            defaultProvider: "fixture",
            defaultModel: "fixture",
            notifications: { enabled: false },
            onboardingTutorialOfferHandled: true,
        }),
        { mode: 0o600 },
    );
    await writeFile(join(state, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "fixture-key" } }), {
        mode: 0o600,
    });
    await writeFile(
        join(state, "models.json"),
        JSON.stringify({
            providers: {
                fixture: {
                    name: "Local fixture",
                    baseUrl: provider.baseUrl,
                    apiKey: "fixture-key",
                    api: "openai-completions",
                    models: [
                        {
                            id: "fixture",
                            name: "Fixture",
                            api: "openai-completions",
                            reasoning: false,
                            input: ["text"],
                            contextWindow: 128000,
                            maxTokens: 4096,
                        },
                    ],
                },
            },
        }),
        { mode: 0o600 },
    );
    const env: NodeJS.ProcessEnv = {
        HOME: home,
        USERPROFILE: home,
        TMPDIR: temporary,
        TEMP: temporary,
        TMP: temporary,
        MNEMOTECA_DB_PATH: database,
        PATH: process.env.PATH || "/usr/bin:/bin",
        NO_COLOR: "1",
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    };
    const runtimes: SessionProcess[] = [];
    return {
        home,
        project,
        temporary,
        database,
        env,
        provider,
        sourceCliPath,
        bunExecutable: process.execPath,
        launch: () => {
            const runtime = launchSessionProcess(project, env);
            runtimes.push(runtime);
            return runtime;
        },
        cleanup: async () => {
            try {
                for (const runtime of runtimes) await runtime.shutdown();
            } finally {
                await provider.close();
                await rm(home, { recursive: true, force: true });
                await rm(project, { recursive: true, force: true });
            }
        },
    };
}
export interface SessionProcess {
    child: ChildProcessWithoutNullStreams;
    client: AcpWorkspaceSessionClient;
    view: () => SessionClientView;
    binding: () => SessionBinding;
    stderr: () => string;
    wait: (predicate: (view: SessionClientView) => boolean) => Promise<void>;
    shutdown: () => Promise<void>;
}
function launchSessionProcess(project: string, env: NodeJS.ProcessEnv): SessionProcess {
    const child = spawn(process.execPath, [sourceCliPath, "acp"], {
        cwd: project,
        env,
        stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-16000);
    });
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const client = new AcpWorkspaceSessionClient({
        connectionId: `process-${child.pid}`,
        project,
        input: new ReadableStream<Uint8Array>({
            start(controller) {
                child.stdout.on("data", (chunk: Buffer) => controller.enqueue(chunk));
                child.stdout.once("end", () => controller.close());
                child.stdout.once("error", (error) => controller.error(error));
            },
            cancel() {
                child.stdout.destroy();
            },
        }),
        output: Writable.toWeb(child.stdin),
    });
    let current: SessionClientView;
    client.observe((view) => {
        current = view;
    });
    return {
        child,
        client,
        view: () => current,
        binding: () => ({ connectionId: current.connectionId, project, sessionId: current.sessionId }),
        stderr: () => stderr,
        wait: (predicate) =>
            waitForSession(
                () => predicate(current),
                () => `${JSON.stringify(current)}\n${stderr}`,
            ),
        shutdown: async () => {
            const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
            try {
                await client.dispose();
            } catch {
                child.kill("SIGKILL");
            } finally {
                child.stdin.end();
                await exited;
                clearTimeout(timer);
            }
        },
    };
}
