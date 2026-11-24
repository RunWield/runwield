import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { parseProjectId, projects } from "@runwield/projects";
import { withRuntimeCommandFixture } from "../cmd/testing/runtime-command-fixture.ts";
import type { JsonRecord } from "../shared/jsonc.ts";
import { executeFactoryRouter, parseFactoryRouterRequest, type FactoryRouterRequest } from "./factory-router.ts";
import { parseFactoryGitHubPublication } from "./factory-github-publication.ts";

interface ApiRequest {
    method: string;
    path: string;
}

interface GitHubFixture {
    input: FactoryRouterRequest;
    calls: ApiRequest[];
    comments: JsonRecord[];
    mode: "ok" | "lost" | "lost-empty" | "reject";
    issueId: number;
    actorId: number;
    paginate: boolean;
    rateLimit: boolean;
    modelCalls: number;
    homeDir: string;
}

async function fixture(run: (value: GitHubFixture) => Promise<void> | void): Promise<void> {
    await withRuntimeCommandFixture("factory-github-publication-", async (runtime) => {
        const originalFetch = globalThis.fetch;
        const originalPath = process.env.WLD_FACTORY_GITHUB_TOKEN_FILE;
        const originalProjectId = process.env.WLD_FACTORY_PROJECT_ID;
        const token = "fake-token-must-not-leak";
        const credentialPath = join(runtime.homeDir, "github-token");
        await writeFile(credentialPath, token);
        const registry = projects.registrations.open();
        const project = registry.register({ root: runtime.projectRoot });
        registry.close();
        const value: GitHubFixture = {
            input: {
                version: 1,
                operationId: "github-run:router",
                projectId: project.projectId,
                loop: "router",
                cwd: runtime.alternateRoot,
                input: { prompt: "Classify the issue; do not implement it." },
                publication: {
                    kind: "github-issue-comment",
                    repository: "RunWield/runwield",
                    repositoryId: "100",
                    issueNumber: 7,
                    issueId: "700",
                },
            },
            calls: [],
            comments: [],
            mode: "ok",
            issueId: 700,
            actorId: 9,
            paginate: false,
            rateLimit: false,
            modelCalls: 0,
            homeDir: runtime.homeDir,
        };
        runtime.setModelResponseFactory(() => {
            value.modelCalls++;
            return fauxAssistantMessage(
                fauxToolCall("triage_report", {
                    routingIntent: "QUICK_FIX",
                    complexity: "LOW",
                    summary: "Fix @someone <script> and ![external](url).",
                }),
            );
        });
        const handle = async (input: Parameters<typeof fetch>[0], options?: RequestInit): Promise<Response> => {
            const url = new URL(String(input));
            assert.equal(url.origin, "https://api.github.com");
            assert.equal(options?.redirect, "error");
            assert.equal(new Headers(options?.headers).get("Authorization"), `Bearer ${token}`);
            const method = options?.method ?? "GET";
            value.calls.push({ method, path: url.pathname + url.search });
            if (value.rateLimit) return new Response("", { status: 429, headers: { "retry-after": "600" } });
            if (method === "GET" && url.pathname === "/repos/RunWield/runwield") {
                return Response.json({ id: 100, full_name: "RunWield/runwield" });
            }
            if (method === "GET" && url.pathname === "/repos/RunWield/runwield/issues/7") {
                return Response.json({ id: value.issueId, number: 7 });
            }
            if (method === "GET" && url.pathname === "/user") return Response.json({ id: value.actorId });
            if (url.pathname === "/repos/RunWield/runwield/issues/7/comments") {
                if (method === "GET") {
                    if (value.paginate && url.searchParams.get("page") !== "2") {
                        return Response.json(
                            value.comments.map((comment) => ({ ...comment, id: 123, user: { id: 99 } })),
                            {
                                headers: {
                                    link: '<https://api.github.com/repos/RunWield/runwield/issues/7/comments?per_page=100&page=2>; rel="next"',
                                },
                            },
                        );
                    }
                    return Response.json(value.comments);
                }
                assert.equal(method, "POST");
                assert.equal(typeof options?.body, "string");
                const posted: JsonRecord = JSON.parse(String(options?.body));
                const key = createHash("sha256").update(value.input.operationId).digest("hex");
                const routing: JsonRecord = JSON.parse(
                    await readFile(join(runtime.homeDir, ".wld", "factory", `${key}.json`), "utf8"),
                );
                assert(routing.result, "Typed routing must be durable before POST");
                assert.equal(routing.response, undefined, "POST must precede completed ACP receipt");
                const intent: JsonRecord = JSON.parse(
                    await readFile(join(runtime.homeDir, ".wld", "factory", `${key}.publication.json`), "utf8"),
                );
                assert.equal(intent.phase, "posting", "Publication intent must be durable before POST");
                if (value.mode === "reject") return new Response("rejected", { status: 422 });
                const comment = {
                    id: 800,
                    body: posted.body,
                    user: { id: value.actorId },
                    issue_url: "https://api.github.com/repos/RunWield/runwield/issues/7",
                    html_url: "https://github.com/RunWield/runwield/issues/7#issuecomment-800",
                };
                if (value.mode !== "lost-empty") value.comments.push(comment);
                if (value.mode === "lost" || value.mode === "lost-empty")
                    throw new Error(`Transport error with ${token}`);
                return Response.json(comment, { status: 201 });
            }
            throw new Error(`Unexpected mocked GitHub request: ${method} ${url.pathname}`);
        };
        globalThis.fetch = Object.assign(handle, { preconnect: originalFetch.preconnect });
        try {
            process.env.WLD_FACTORY_GITHUB_TOKEN_FILE = credentialPath;
            process.env.WLD_FACTORY_PROJECT_ID = project.projectId;
            await run(value);
        } finally {
            globalThis.fetch = originalFetch;
            if (originalPath === undefined) delete process.env.WLD_FACTORY_GITHUB_TOKEN_FILE;
            else process.env.WLD_FACTORY_GITHUB_TOKEN_FILE = originalPath;
            if (originalProjectId === undefined) delete process.env.WLD_FACTORY_PROJECT_ID;
            else process.env.WLD_FACTORY_PROJECT_ID = originalProjectId;
        }
    });
}

test("Factory publication reconciles a lost POST response across pages without rerouting or duplicate comments", async () => {
    await fixture(async (f) => {
        f.mode = "lost";
        await assert.rejects(executeFactoryRouter(f.input), (error: Error) => {
            assert(!error.message.includes("fake-token"));
            return /acknowledgement unavailable/.test(error.message);
        });
        assert.equal(f.modelCalls, 1);
        f.paginate = true;
        const result = await executeFactoryRouter(f.input);
        assert.deepEqual(result.publication, {
            commentId: "800",
            url: "https://github.com/RunWield/runwield/issues/7#issuecomment-800",
        });
        assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
        assert(f.calls.some((call) => call.path.includes("page=2")));
        assert.equal(f.modelCalls, 1);
        const calls = f.calls.length;
        delete process.env.WLD_FACTORY_GITHUB_TOKEN_FILE;
        assert.deepEqual(await executeFactoryRouter(f.input), result);
        assert.equal(f.calls.length, calls, "Completed response replay must not need GitHub or credentials");
        assert(String(f.comments[0].body).includes("&#64;someone &lt;script&gt;"));
    });
});

test("Factory publication preserves ambiguous POST intent instead of blindly retrying creation", async () => {
    await fixture(async (f) => {
        f.mode = "lost-empty";
        await assert.rejects(executeFactoryRouter(f.input), /acknowledgement unavailable/);
        await assert.rejects(executeFactoryRouter(f.input), /acknowledgement is ambiguous/);
        assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
        assert.equal(f.modelCalls, 1);
    });
});

test("Factory publication retries an explicitly rejected creation using the saved routing result", async () => {
    await fixture(async (f) => {
        f.mode = "reject";
        await assert.rejects(executeFactoryRouter(f.input), /HTTP 422/);
        f.mode = "ok";
        assert((await executeFactoryRouter(f.input)).publication);
        assert.equal(f.calls.filter((call) => call.method === "POST").length, 2);
        assert.equal(f.comments.length, 1);
        assert.equal(f.modelCalls, 1);
    });
});

test("Factory publication refuses changed issue identity before any write", async () => {
    await fixture(async (f) => {
        f.issueId = 701;
        await assert.rejects(executeFactoryRouter(f.input), /issue identity changed/);
        assert.equal(f.calls.filter((call) => call.method === "POST").length, 0);
        assert(!f.calls.some((call) => call.path === "/user"));
        f.issueId = 700;
        assert((await executeFactoryRouter(f.input)).publication);
        assert.equal(f.modelCalls, 1);
    });
});

test("Factory publication refuses a changed repository or authenticated author", async () => {
    await fixture(async (f) => {
        assert(f.input.publication);
        f.input.publication.repositoryId = "101";
        await assert.rejects(executeFactoryRouter(f.input), /repository identity changed/);
        assert.equal(f.calls.length, 1);
        assert.equal(f.calls[0].method, "GET");
    });
    await fixture(async (f) => {
        f.mode = "lost-empty";
        await assert.rejects(executeFactoryRouter(f.input), /acknowledgement unavailable/);
        f.actorId = 10;
        await assert.rejects(executeFactoryRouter(f.input), /credential owner changed/);
        assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
    });
});

test("Factory publication rejects unsafe targets before credentials or network access", async () => {
    await fixture((f) => {
        process.env.WLD_FACTORY_GITHUB_TOKEN_FILE = "/missing/secret";
        for (const target of [
            { ...f.input.publication, repository: "https://attacker.example/repo" },
            { ...f.input.publication, repository: "owner/.." },
            { ...f.input.publication, repositoryId: "-100" },
            { ...f.input.publication, issueNumber: 1.2 },
            { ...f.input.publication, credentialPath: "/another/secret" },
        ]) {
            assert.throws(() => parseFactoryRouterRequest({ ...f.input, publication: target }), /Invalid GitHub/);
            assert.throws(() => parseFactoryGitHubPublication(target), /Invalid GitHub/);
        }
        assert.equal(f.calls.length, 0);
    });
});

test("Factory publication rejects a different Project binding before model or GitHub access", async () => {
    await fixture(async (f) => {
        const projectId = parseProjectId(crypto.randomUUID());
        assert(projectId);
        await assert.rejects(executeFactoryRouter({ ...f.input, projectId }), /does not match the worker binding/);
        assert.equal(f.modelCalls, 0);
        assert.deepEqual(f.calls, []);
    });
});

test("Factory publication honors durable rate backoff without repeatedly calling GitHub", async () => {
    await fixture(async (f) => {
        f.rateLimit = true;
        await assert.rejects(executeFactoryRouter(f.input), /HTTP 429/);
        const calls = f.calls.length;
        await assert.rejects(executeFactoryRouter(f.input), /backoff is pending/);
        assert.equal(f.calls.length, calls);
        assert.equal(f.modelCalls, 1);
    });
});
