import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, readFile, readdir, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeSessionProcessFixture } from "./client/testing/session-process-fixture.ts";
import { openOwnerCoordinationStore } from "../shared/owner-coordination/index.ts";
import {
    WORKSPACE_EXTENSION as key,
    WORKSPACE_PROJECT_PREFIX as prefix,
    type WorkspaceJsonRecord,
    type WorkspaceProjectContext,
} from "./workspace-contract.ts";

interface RpcError {
    code: number;
    message: string;
    data: WorkspaceJsonRecord;
}
interface RpcResponse {
    id: number;
    result?: WorkspaceJsonRecord;
    error?: RpcError;
}
interface Pending {
    resolve: (response: RpcResponse) => void;
    reject: (error: Error) => void;
}
type Fixture = Awaited<ReturnType<typeof makeSessionProcessFixture>>;
function launch(fixture: Fixture) {
    const questions: number[] = [];
    const child = spawn(fixture.bunExecutable, [fixture.sourceCliPath, "acp"], {
        cwd: fixture.project,
        env: fixture.env,
        stdio: ["pipe", "pipe", "pipe"],
    });
    const pending = new Map<number, Pending>();
    let id = 0;
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
        const response = JSON.parse(line) as RpcResponse & { method?: string };
        if (response.method === "elicitation/create") {
            questions.push(response.id);
            return;
        }
        if (!response.id) return;
        pending.get(response.id)?.resolve(response);
        pending.delete(response.id);
    });
    child.once("exit", () => {
        for (const request of pending.values()) request.reject(new Error(stderr || "ACP process exited"));
    });
    return {
        questions,
        answer(answer: string) {
            const id = questions.shift();
            ok(id !== undefined);
            child.stdin.write(
                JSON.stringify({ jsonrpc: "2.0", id, result: { action: "accept", content: { answer } } }) + "\n",
            );
        },
        async request(method: string, params: WorkspaceJsonRecord = {}): Promise<RpcResponse> {
            const current = ++id;
            return await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`Timed out: ${method}\n${stderr}`)), 20000);
                pending.set(current, {
                    resolve: (response) => {
                        clearTimeout(timer);
                        resolve(response);
                    },
                    reject: (error) => {
                        clearTimeout(timer);
                        reject(error);
                    },
                });
                child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: current, method, params }) + "\n");
            });
        },
        notify(method: string, params: WorkspaceJsonRecord) {
            child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
        },
        async close() {
            if (child.exitCode !== null || child.signalCode !== null) return;
            child.stdin.end();
            await new Promise<void>((resolve) => {
                child.once("exit", () => resolve());
                setTimeout(() => {
                    child.kill();
                    resolve();
                }, 2000).unref();
            });
        },
    };
}
function result(response: RpcResponse): WorkspaceJsonRecord {
    ok(!response.error, JSON.stringify(response));
    ok(response.result);
    return response.result;
}
function row(value: WorkspaceJsonRecord[string]): WorkspaceJsonRecord {
    ok(value && typeof value === "object" && !Array.isArray(value));
    return value;
}
function error(response: RpcResponse, code: string) {
    equal(response.error?.data?.code, code, JSON.stringify(response));
}
function meta(context: WorkspaceProjectContext): WorkspaceJsonRecord {
    return { [key]: { ...context } };
}
async function initialize(runtime: ReturnType<typeof launch>) {
    const response = result(
        await runtime.request("initialize", {
            protocolVersion: 1,
            clientCapabilities: { elicitation: { form: {} }, _meta: { [key]: { version: 1 } } },
        }),
    );
    const capability = row(row(response._meta)[key]);
    equal(capability.version, 1);
    deepEqual(capability.projects, { version: 1 });
    ok(typeof capability.connectionId === "string" && capability.connectionId.length > 0);
    return response;
}
async function register(runtime: ReturnType<typeof launch>, root: string): Promise<string> {
    const project = row(result(await runtime.request(prefix + "register", { root })).project);
    ok(typeof project.projectId === "string");
    return project.projectId;
}
async function open(runtime: ReturnType<typeof launch>, projectId: string): Promise<WorkspaceProjectContext> {
    const context = row(result(await runtime.request(prefix + "open", { projectId })).context);
    ok(
        typeof context.connectionId === "string" &&
            typeof context.projectId === "string" &&
            typeof context.canonicalRoot === "string",
    );
    return { connectionId: context.connectionId, projectId: context.projectId, canonicalRoot: context.canonicalRoot };
}
function store(fixture: Fixture) {
    return openOwnerCoordinationStore({
        dbPath: join(fixture.home, ".wld", "owner-coordination.sqlite3"),
        sessionBaseDir: join(fixture.home, ".wld", "sessions"),
    });
}

async function manifests(fixture: Fixture): Promise<Record<string, string>> {
    const base = join(fixture.home, ".wld", "sessions");
    const files = await readdir(base, { recursive: true }).catch(() => []);
    const saved: Record<string, string> = {};
    for (const file of files.sort())
        if (file.endsWith("/manifest.json")) saved[file] = await readFile(join(base, file), "utf8");
    return saved;
}

for (const withdrawal of ["disable", "remove", "relink"]) {
    test(`accepted pending question rechecks retained admission after ${withdrawal}`, { timeout: 60000 }, async () => {
        const fixture = await makeSessionProcessFixture();
        const runtime = launch(fixture);
        try {
            await initialize(runtime);
            const id = await register(runtime, fixture.project);
            const context = await open(runtime, id);
            const created = result(
                await runtime.request("session/new", {
                    cwd: context.canonicalRoot,
                    mcpServers: [],
                    _meta: meta(context),
                }),
            );
            const binding = { sessionId: created.sessionId, _meta: meta(context) };
            fixture.provider.enqueue(
                { question: { type: "text", prompt: "May I continue?" } },
                { text: "Unauthorized continuation" },
            );
            const turn = runtime.request("session/prompt", {
                ...binding,
                prompt: [{ type: "text", text: "Ask before effects." }],
            });
            for (let i = 0; i < 1500 && runtime.questions.length === 0; i++)
                await new Promise((resolve) => setTimeout(resolve, 10));
            equal(runtime.questions.length, 1);
            if (withdrawal === "disable")
                result(await runtime.request(prefix + "setEnabled", { projectId: id, enabled: false }));
            else if (withdrawal === "remove") result(await runtime.request(prefix + "remove", { projectId: id }));
            else {
                const next = join(fixture.home, "next");
                await mkdir(next);
                result(await runtime.request(prefix + "relink", { projectId: id, newRoot: next }));
            }
            runtime.answer("WITHDRAWN_ACCEPTED_SENTINEL");
            await turn;
            result(await runtime.request("session/close", binding));
            equal(fixture.provider.requests.length, 1, "withdrawn answer must not resume provider effects");
            const canonical = await manifests(fixture);
            equal(Object.keys(canonical).length, 1);
            const files = await readdir(join(fixture.home, ".wld", "sessions"), { recursive: true });
            for (const file of files.filter((file) => file.endsWith(".jsonl"))) {
                const text = await readFile(join(fixture.home, ".wld", "sessions", file), "utf8");
                ok(!text.includes("WITHDRAWN_ACCEPTED_SENTINEL"));
                ok(!text.includes("Unauthorized continuation"));
            }
        } finally {
            await runtime.close();
            await fixture.cleanup();
        }
    });
}

test(
    "Project operations use canonical registrations, confirmation, health, and non-destructive removal",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        const runtime = launch(fixture);
        try {
            await initialize(runtime);
            deepEqual(result(await runtime.request(prefix + "list")).projects, []);
            const confirmation = result(await runtime.request(prefix + "register", { root: fixture.home }));
            equal(confirmation.status, "confirmation_required");
            deepEqual(result(await runtime.request(prefix + "list")).projects, []);
            const changed = await runtime.request(prefix + "register", {
                root: "/",
                directoryConfirmation: confirmation.confirmation,
            });
            equal(result(changed).status, "confirmation_required");
            const homeId = row(
                result(
                    await runtime.request(prefix + "register", {
                        root: fixture.home,
                        directoryConfirmation: confirmation.confirmation,
                    }),
                ).project,
            ).projectId;
            result(await runtime.request(prefix + "remove", { projectId: homeId }));
            const id = await register(runtime, fixture.project);
            const alias = join(fixture.home, "alias");
            await symlink(fixture.project, alias);
            equal(await register(runtime, alias), id);
            const canonical = store(fixture);
            try {
                equal(canonical.listProjects().length, 1);
                equal(canonical.listProjectRootEvidence(id).length, 2);
            } finally {
                canonical.close();
            }
            const other = join(fixture.home, "other");
            await mkdir(other);
            const otherId = await register(runtime, other);
            error(await runtime.request(prefix + "relink", { projectId: id, newRoot: other }), "project_conflict");
            result(await runtime.request(prefix + "setEnabled", { projectId: id, enabled: false }));
            error(await runtime.request(prefix + "open", { projectId: id }), "project_unavailable");
            error(await runtime.request(prefix + "rescan", { projectId: id }), "project_unavailable");
            result(await runtime.request(prefix + "setEnabled", { projectId: id, enabled: true }));
            equal(result(await runtime.request(prefix + "rescan", { projectId: id })).cataloged, 0);
            const moved = fixture.project + "-moved";
            await rename(fixture.project, moved);
            try {
                const listed = result(await runtime.request(prefix + "list"));
                ok(!JSON.stringify(listed).includes(fixture.home));
                error(await runtime.request(prefix + "open", { projectId: id }), "project_unavailable");
                result(await runtime.request(prefix + "relink", { projectId: id, newRoot: moved }));
                equal((await open(runtime, id)).canonicalRoot, await realpath(moved));
                const before = await readFile(join(moved, ".git", "HEAD"), "utf8");
                result(await runtime.request(prefix + "remove", { projectId: id }));
                equal(await readFile(join(moved, ".git", "HEAD"), "utf8"), before);
                ok((await register(runtime, moved)) !== id);
            } finally {
                await rename(moved, fixture.project);
            }
            result(await runtime.request(prefix + "remove", { projectId: otherId }));
            error(
                await runtime.request(prefix + "setEnabled", { projectId: "missing", enabled: true }),
                "project_not_found",
            );
            error(
                await runtime.request(prefix + "register", { root: fixture.project, injected: true }),
                "invalid_params",
            );
        } finally {
            await runtime.close();
            await fixture.cleanup();
        }
    },
);

test(
    "Workspace admission rejects missing, foreign, stale, and withdrawn bindings before effects; Stop and close remain safe",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        const runtime = launch(fixture);
        try {
            await initialize(runtime);
            const emptyManifests = await manifests(fixture);
            error(
                await runtime.request("session/new", { cwd: fixture.project, mcpServers: [] }),
                "workspace_binding_invalid",
            );
            const id = await register(runtime, fixture.project);
            const context = await open(runtime, id);
            const request = { cwd: context.canonicalRoot, mcpServers: [], _meta: meta(context) };
            error(
                await runtime.request("session/new", {
                    ...request,
                    _meta: meta({ ...context, connectionId: "foreign" }),
                }),
                "workspace_binding_invalid",
            );
            error(await runtime.request("session/new", { ...request, cwd: fixture.home }), "workspace_binding_invalid");
            error(
                await runtime.request("session/new", {
                    ...request,
                    _meta: meta({ ...context, projectId: "unregistered" }),
                }),
                "project_not_found",
            );
            deepEqual(await manifests(fixture), emptyManifests);
            const session = result(await runtime.request("session/new", request));
            const sessionId = session.sessionId;
            ok(typeof sessionId === "string");
            const binding = { sessionId, _meta: meta(context) };
            error(
                await runtime.request("session/prompt", {
                    ...binding,
                    _meta: meta({ ...context, projectId: "wrong" }),
                    prompt: [{ type: "text", text: "No effect" }],
                }),
                "workspace_binding_invalid",
            );
            error(
                await runtime.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "No effect" }] }),
                "workspace_binding_invalid",
            );
            error(
                await runtime.request("session/set_config_option", { sessionId, configId: "thinking", value: "off" }),
                "workspace_binding_invalid",
            );
            error(
                await runtime.request("_session/steering", {
                    sessionId,
                    prompt: [{ type: "text", text: "No effect" }],
                }),
                "workspace_binding_invalid",
            );
            fixture.provider.enqueue({ text: "Held output", hold: true });
            const turn = runtime.request("session/prompt", {
                ...binding,
                prompt: [{ type: "text", text: "Hold a turn" }],
            });
            for (let i = 0; i < 500 && fixture.provider.requests.length === 0; i++)
                await new Promise((resolve) => setTimeout(resolve, 10));
            equal(fixture.provider.requests.length, 1);
            equal(fixture.provider.requests[0].authorization, "Bearer fixture-key");
            const relinked = join(fixture.home, "relinked");
            await mkdir(relinked);
            result(await runtime.request(prefix + "relink", { projectId: id, newRoot: relinked }));
            error(
                await runtime.request("session/set_config_option", { ...binding, configId: "thinking", value: "off" }),
                "workspace_binding_invalid",
            );
            result(await runtime.request(prefix + "relink", { projectId: id, newRoot: fixture.project }));
            result(await runtime.request(prefix + "setEnabled", { projectId: id, enabled: false }));
            error(await runtime.request("session/delete", binding), "project_unavailable");
            runtime.notify("session/cancel", binding);
            result(await turn);
            const savedBeforeRemoval = store(fixture);
            let transcriptPath = "";
            try {
                const saved = savedBeforeRemoval.findSessionByLocator({
                    piSessionId: row(row(session._meta).runwield).persistedSessionId as string,
                });
                ok(saved);
                const segment = savedBeforeRemoval.getCurrentSessionSegment(saved.runwieldSessionId);
                ok(segment);
                transcriptPath = segment.transcriptPath;
            } finally {
                savedBeforeRemoval.close();
            }
            const savedContent = await readFile(transcriptPath, "utf8");
            result(await runtime.request(prefix + "remove", { projectId: id }));
            result(await runtime.request("session/close", binding));
            equal(await readFile(transcriptPath, "utf8"), savedContent);
            equal(fixture.provider.requests.length, 1);
            const replacement = await register(runtime, fixture.project);
            const rebound = await open(runtime, replacement);
            const beforeDeniedNew = await manifests(fixture);
            equal(Object.keys(beforeDeniedNew).length, 1);
            error(await runtime.request("session/new", request), "project_not_found");
            deepEqual(await manifests(fixture), beforeDeniedNew);
            const other = join(fixture.home, "other");
            await mkdir(other);
            const otherId = await register(runtime, other);
            const foreign = await open(runtime, otherId);
            const durable = row(session._meta).runwield;
            const persisted = row(durable).persistedSessionId;
            ok(typeof persisted === "string");
            const beforeDeniedLoad = await manifests(fixture);
            error(
                await runtime.request("session/load", {
                    sessionId: persisted,
                    cwd: foreign.canonicalRoot,
                    mcpServers: [],
                    _meta: meta(foreign),
                }),
                "session_project_mismatch",
            );
            deepEqual(await manifests(fixture), beforeDeniedLoad);
            equal(Object.keys(beforeDeniedLoad).length, 1);
            const restarted = launch(fixture);
            try {
                await initialize(restarted);
                const fresh = await open(restarted, replacement);
                error(
                    await restarted.request("session/new", { ...request, _meta: meta(rebound) }),
                    "workspace_binding_invalid",
                );
                result(
                    await restarted.request("session/load", {
                        sessionId: persisted,
                        cwd: fresh.canonicalRoot,
                        mcpServers: [],
                        _meta: meta(fresh),
                    }),
                );
                result(await restarted.request("session/close", { sessionId: persisted, _meta: meta(fresh) }));
            } finally {
                await restarted.close();
            }
            const canonical = store(fixture);
            try {
                ok(canonical.getSessionById(persisted) || canonical.findSessionByLocator({ piSessionId: persisted }));
            } finally {
                canonical.close();
            }
        } finally {
            fixture.provider.release();
            await runtime.close();
            await fixture.cleanup();
        }
    },
);

test(
    "unsupported Workspace versions cannot fall back; ordinary ACP stays registration-free",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        const runtime = launch(fixture);
        const ordinary = launch(fixture);
        try {
            error(
                await runtime.request("initialize", {
                    protocolVersion: 1,
                    clientCapabilities: { elicitation: { form: {} }, _meta: { [key]: { version: 2 } } },
                }),
                "workspace_version_unsupported",
            );
            error(await runtime.request(prefix + "list"), "workspace_version_unsupported");
            error(
                await runtime.request("session/new", { cwd: fixture.project, mcpServers: [] }),
                "workspace_version_unsupported",
            );
            result(await ordinary.request("initialize", { protocolVersion: 1, clientCapabilities: {} }));
            error(await ordinary.request(prefix + "list"), "workspace_not_negotiated");
            const sessionId = result(
                await ordinary.request("session/new", { cwd: fixture.project, mcpServers: [] }),
            ).sessionId;
            result(await ordinary.request("session/close", { sessionId }));
            result(await ordinary.request("session/load", { sessionId, cwd: fixture.project, mcpServers: [] }));
            result(await ordinary.request("session/close", { sessionId }));
        } finally {
            await runtime.close();
            await ordinary.close();
            await fixture.cleanup();
        }
    },
);

test(
    "missing defaults report external wld setup while Project management stays available; restart reuses settings",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        await writeFile(
            join(fixture.home, ".wld", "settings.json"),
            JSON.stringify({ onboardingTutorialOfferHandled: true }),
        );
        const runtime = launch(fixture);
        try {
            await initialize(runtime);
            const id = await register(runtime, fixture.project);
            const context = await open(runtime, id);
            const response = await runtime.request("session/new", {
                cwd: context.canonicalRoot,
                mcpServers: [],
                _meta: meta(context),
            });
            error(response, "default_model_required");
            ok(response.error?.message.includes("wld login"));
            ok(response.error?.message.includes("restart desktop"));
            ok(!response.error?.message.includes("login and default model setup are required"));
            equal(fixture.provider.requests.length, 0);
            equal((result(await runtime.request(prefix + "list")).projects as WorkspaceJsonRecord[]).length, 1);
            const canonical = store(fixture);
            try {
                equal((await canonical.listProjectSessions(id)).sessions.length, 0);
            } finally {
                canonical.close();
            }
            await runtime.close();
            await writeFile(
                join(fixture.home, ".wld", "settings.json"),
                JSON.stringify({
                    defaultProvider: "fixture",
                    defaultModel: "fixture",
                    onboardingTutorialOfferHandled: true,
                }),
            );
            const restarted = launch(fixture);
            try {
                await initialize(restarted);
                const fresh = await open(restarted, id);
                const created = result(
                    await restarted.request("session/new", {
                        cwd: fresh.canonicalRoot,
                        mcpServers: [],
                        _meta: meta(fresh),
                    }),
                );
                result(await restarted.request("session/close", { sessionId: created.sessionId, _meta: meta(fresh) }));
            } finally {
                await restarted.close();
            }
        } finally {
            await runtime.close();
            await fixture.cleanup();
        }
    },
);

for (const linked of [false, true]) {
    test(
        `Session uses existing Project provider override${linked ? " from its linked worktree" : ""} without rewriting settings`,
        { timeout: 60000 },
        async () => {
            const fixture = await makeSessionProcessFixture();
            let runtime: ReturnType<typeof launch> | undefined;
            const linkedRoot = join(fixture.home, "linked");
            try {
                const settings = join(fixture.home, ".wld", "settings.json");
                const projectSettings = join(fixture.project, ".wld", "settings.json");
                await writeFile(
                    settings,
                    JSON.stringify({
                        defaultProvider: "missing",
                        defaultModel: "missing",
                        onboardingTutorialOfferHandled: true,
                    }),
                );
                await mkdir(join(fixture.project, ".wld"), { recursive: true });
                await writeFile(
                    projectSettings,
                    JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture" }),
                );
                if (linked) {
                    const git = Bun.spawnSync(
                        ["git", "-C", fixture.project, "worktree", "add", "-b", "provider-settings", linkedRoot],
                        { stdout: "pipe", stderr: "pipe" },
                    );
                    equal(git.exitCode, 0, git.stderr.toString());
                }
                const files = [
                    settings,
                    projectSettings,
                    join(fixture.home, ".wld", "auth.json"),
                    join(fixture.home, ".wld", "models.json"),
                ];
                const before = await Promise.all(files.map((path) => readFile(path, "utf8")));
                runtime = launch(fixture);
                await initialize(runtime);
                const id = await register(runtime, linked ? linkedRoot : fixture.project);
                const context = await open(runtime, id);
                const created = result(
                    await runtime.request("session/new", {
                        cwd: context.canonicalRoot,
                        mcpServers: [],
                        _meta: meta(context),
                    }),
                );
                fixture.provider.enqueue({ text: "Project override used." });
                result(
                    await runtime.request("session/prompt", {
                        sessionId: created.sessionId,
                        _meta: meta(context),
                        prompt: [{ type: "text", text: "Use existing Project credentials." }],
                    }),
                );
                result(await runtime.request("session/close", { sessionId: created.sessionId, _meta: meta(context) }));
                equal(fixture.provider.requests.length, 1);
                equal(fixture.provider.requests[0].authorization, "Bearer fixture-key");
                deepEqual(await Promise.all(files.map((path) => readFile(path, "utf8"))), before);
            } finally {
                await runtime?.close();
                if (linked) Bun.spawnSync(["git", "-C", fixture.project, "worktree", "remove", "--force", linkedRoot]);
                await fixture.cleanup();
            }
        },
    );
}
