import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { TriageOutcome } from "@runwield/tools";
import { getHomeDir } from "../constants.ts";
import type { JsonRecord, JsonValue } from "../shared/jsonc.ts";

export interface FactoryGitHubPublication {
    kind: "github-issue-comment";
    repository: string;
    repositoryId: string;
    issueNumber: number;
    issueId: string;
}

export interface FactoryGitHubCommentReceipt {
    commentId: string;
    url: string;
}

interface PublicationState {
    version: 1;
    operationId: string;
    target: FactoryGitHubPublication;
    body: string;
    phase: "prepared" | "posting" | "completed";
    actorId?: string;
    retryAt?: number;
    receipt?: FactoryGitHubCommentReceipt;
}

function record(value: JsonValue | undefined): JsonRecord {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid GitHub publication record");
    return value;
}

function id(value: JsonValue | undefined): string {
    if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return value;
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
    throw new Error("Invalid GitHub identity");
}

export function parseFactoryGitHubPublication(value: JsonValue): FactoryGitHubPublication {
    const target = record(value);
    if (
        target.kind !== "github-issue-comment" ||
        typeof target.repository !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/.test(target.repository) ||
        [".", ".."].includes(target.repository.split("/")[1]) ||
        typeof target.repositoryId !== "string" ||
        typeof target.issueId !== "string" ||
        typeof target.issueNumber !== "number" ||
        !Number.isSafeInteger(target.issueNumber) ||
        target.issueNumber < 1 ||
        Object.keys(target).some(
            (key) => !["kind", "repository", "repositoryId", "issueNumber", "issueId"].includes(key),
        )
    ) {
        throw new Error("Invalid GitHub issue publication target");
    }
    return {
        kind: "github-issue-comment",
        repository: target.repository,
        repositoryId: id(target.repositoryId),
        issueNumber: target.issueNumber,
        issueId: id(target.issueId),
    };
}

export function parseFactoryGitHubCommentReceipt(value: JsonValue): FactoryGitHubCommentReceipt {
    const receipt = record(value);
    if (typeof receipt.url !== "string") throw new Error("Invalid GitHub comment URL");
    const url = new URL(receipt.url);
    if (url.origin !== "https://github.com" || url.username || url.password || url.search) {
        throw new Error("Invalid GitHub comment URL");
    }
    const commentId = id(receipt.commentId);
    if (url.hash !== `#issuecomment-${commentId}`) throw new Error("Invalid GitHub comment identity");
    return { commentId, url: receipt.url };
}

async function save(path: string, state: PublicationState): Promise<void> {
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    try {
        const file = await open(temporary, "wx", 0o600);
        try {
            await file.writeFile(JSON.stringify(state));
            await file.sync();
        } finally {
            await file.close();
        }
        await rename(temporary, path);
        const directory = await open(dirname(path), "r");
        try {
            await directory.sync();
        } finally {
            await directory.close();
        }
    } finally {
        await unlink(temporary).catch((error) => {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        });
    }
}

function marker(operationId: string): string {
    return `<!-- runwield-factory:${createHash("sha256").update(operationId).digest("hex")} -->`;
}

function plainMarkdown(text: string): string {
    return text
        .replace(/[\\`*_{}\[\]()#+.!|~-]/g, "\\$&")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/@/g, "&#64;");
}

function commentBody(operationId: string, outcome: TriageOutcome): string {
    const body =
        `## RunWield routing\n\n**Routing intent:** ${outcome.routingIntent}\n\n` +
        `**Complexity:** ${outcome.complexity}\n\n**Summary:** ${plainMarkdown(outcome.summary)}\n\n${marker(operationId)}`;
    if (body.length > 60_000) throw new Error("Router summary exceeds GitHub comment capacity");
    return body;
}

class GitHubRequestFailure extends Error {
    constructor(
        readonly method: "GET" | "POST",
        readonly status: number,
        readonly retryAt?: number,
    ) {
        super(`GitHub ${method} returned HTTP ${status}; publication remains recoverable`);
    }
}

function retryAt(response: Response): number | undefined {
    if (response.status !== 403 && response.status !== 429) return undefined;
    const seconds = Number(response.headers.get("retry-after"));
    if (response.headers.has("retry-after") && Number.isFinite(seconds) && seconds >= 0)
        return Date.now() + seconds * 1000;
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    if (response.headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(reset) && reset > 0) {
        return Math.max(Date.now() + 1000, reset * 1000);
    }
    return Date.now() + 60_000;
}

/** Fixed origin and disabled redirects prevent caller input or API links from forwarding credentials elsewhere. */
async function github(token: string, path: string, method: "GET" | "POST" = "GET", body?: string): Promise<Response> {
    const url = new URL(path, "https://api.github.com");
    if (url.origin !== "https://api.github.com" || url.username || url.password || url.hash) {
        throw new Error("Invalid GitHub API destination");
    }
    let response: Response;
    try {
        response = await fetch(url, {
            method,
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
            headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${token}`,
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "RunWield-Factory",
                "Content-Type": "application/json",
            },
            ...(body === undefined ? {} : { body: JSON.stringify({ body }) }),
        });
    } catch {
        throw new Error("GitHub request acknowledgement unavailable; reconcile publication before retrying a write");
    }
    if (!response.ok) throw new GitHubRequestFailure(method, response.status, retryAt(response));
    return response;
}

async function json(response: Response): Promise<JsonValue> {
    try {
        return await response.json();
    } catch {
        throw new Error("Invalid GitHub API response");
    }
}

function verifiedComment(value: JsonValue, state: PublicationState): FactoryGitHubCommentReceipt {
    const comment = record(value);
    const issueUrl = typeof comment.issue_url === "string" ? new URL(comment.issue_url) : null;
    if (
        comment.body !== state.body ||
        id(record(comment.user).id) !== state.actorId ||
        !issueUrl ||
        issueUrl.origin !== "https://api.github.com" ||
        issueUrl.search ||
        issueUrl.hash ||
        issueUrl.pathname.toLowerCase() !==
            `/repos/${state.target.repository}/issues/${state.target.issueNumber}`.toLowerCase()
    ) {
        throw new Error("GitHub comment does not match the publication intent");
    }
    const receipt = parseFactoryGitHubCommentReceipt({ commentId: id(comment.id), url: comment.html_url ?? null });
    const url = new URL(receipt.url);
    if (url.pathname.toLowerCase() !== `/${state.target.repository}/issues/${state.target.issueNumber}`.toLowerCase()) {
        throw new Error("GitHub comment belongs to a different issue");
    }
    return receipt;
}

async function findPublished(token: string, state: PublicationState): Promise<FactoryGitHubCommentReceipt | undefined> {
    const path = `/repos/${state.target.repository}/issues/${state.target.issueNumber}/comments`;
    let next = `${path}?per_page=100`;
    const visited = new Set<string>();
    let found: FactoryGitHubCommentReceipt | undefined;
    while (next) {
        if (visited.has(next) || visited.size >= 100) throw new Error("GitHub comment reconciliation did not finish");
        visited.add(next);
        const response = await github(token, next);
        const comments = await json(response);
        if (!Array.isArray(comments)) throw new Error("Invalid GitHub comments response");
        for (const value of comments) {
            const comment = record(value);
            if (
                typeof comment.body !== "string" ||
                !comment.body.includes(marker(state.operationId)) ||
                id(record(comment.user).id) !== state.actorId
            )
                continue;
            const receipt = verifiedComment(value, state);
            if (found && found.commentId !== receipt.commentId)
                throw new Error("Ambiguous duplicate GitHub publication");
            found = receipt;
        }
        const link = response.headers
            .get("link")
            ?.split(",")
            .find((entry) => /;\s*rel="next"/.test(entry));
        const target = link?.match(/<([^>]+)>/)?.[1];
        if (link && !target) throw new Error("Invalid GitHub pagination link");
        if (target) {
            const url = new URL(target);
            if (
                url.origin !== "https://api.github.com" ||
                url.pathname.toLowerCase() !== path.toLowerCase() ||
                url.username ||
                url.password ||
                url.hash
            ) {
                throw new Error("Invalid GitHub pagination destination");
            }
            next = url.href;
        } else next = "";
    }
    return found;
}

/** Called only while the owning factory operation holds its native writer lock. */
export async function publishFactoryGitHubComment(
    operationId: string,
    target: FactoryGitHubPublication,
    outcome: TriageOutcome,
): Promise<FactoryGitHubCommentReceipt> {
    target = parseFactoryGitHubPublication({ ...target });
    const directory = join(getHomeDir(), ".wld", "factory");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${createHash("sha256").update(operationId).digest("hex")}.publication.json`);
    const expectedBody = commentBody(operationId, outcome);
    let state: PublicationState = { version: 1, operationId, target, body: expectedBody, phase: "prepared" };
    try {
        const saved = record(JSON.parse(await readFile(path, "utf8")));
        if (
            saved.version !== 1 ||
            saved.operationId !== operationId ||
            saved.body !== expectedBody ||
            JSON.stringify(parseFactoryGitHubPublication(saved.target ?? null)) !== JSON.stringify(target) ||
            !["prepared", "posting", "completed"].includes(String(saved.phase))
        ) {
            throw new Error("GitHub publication intent does not match the saved operation");
        }
        state = {
            ...state,
            phase: saved.phase as PublicationState["phase"],
            ...(saved.actorId === undefined ? {} : { actorId: id(saved.actorId) }),
            ...(saved.receipt === undefined ? {} : { receipt: parseFactoryGitHubCommentReceipt(saved.receipt) }),
        };
        if (saved.retryAt !== undefined) {
            if (typeof saved.retryAt !== "number" || !Number.isFinite(saved.retryAt))
                throw new Error("Invalid GitHub retry time");
            state.retryAt = saved.retryAt;
        }
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        await save(path, state);
    }
    if (state.phase === "completed") {
        if (!state.receipt) throw new Error("GitHub publication receipt is missing");
        return state.receipt;
    }
    if (state.retryAt && state.retryAt > Date.now())
        throw new Error("GitHub rate limit backoff is pending; retry this operation later");
    let token: string;
    try {
        const tokenPath = process.env.WLD_FACTORY_GITHUB_TOKEN_FILE;
        if (!tokenPath || !isAbsolute(tokenPath)) throw new Error("Missing token file");
        token = (await readFile(tokenPath, "utf8")).trim();
        if (!token || /\s/.test(token)) throw new Error("Invalid token");
    } catch {
        throw new Error("Factory GitHub credential is unavailable");
    }
    try {
        const repository = record(await json(await github(token, `/repos/${target.repository}`)));
        if (
            id(repository.id) !== target.repositoryId ||
            typeof repository.full_name !== "string" ||
            repository.full_name.toLowerCase() !== target.repository.toLowerCase()
        ) {
            throw new Error("GitHub repository identity changed; publication refused");
        }
        const issue = record(
            await json(await github(token, `/repos/${target.repository}/issues/${target.issueNumber}`)),
        );
        if (
            id(issue.id) !== target.issueId ||
            issue.number !== target.issueNumber ||
            issue.pull_request !== undefined
        ) {
            throw new Error("GitHub issue identity changed; publication refused");
        }
        const actorId = id(record(await json(await github(token, "/user"))).id);
        if (state.actorId && state.actorId !== actorId) throw new Error("GitHub publication credential owner changed");
        state.actorId = actorId;
        delete state.retryAt;
        const existing = await findPublished(token, state);
        if (existing) {
            state = { ...state, phase: "completed", receipt: existing };
            await save(path, state);
            return existing;
        }
        if (state.phase === "posting") {
            throw new Error(
                "GitHub publication acknowledgement is ambiguous; retry only reconciles comments and will not create another",
            );
        }
        state.phase = "posting";
        await save(path, state);
        const created = await github(
            token,
            `/repos/${target.repository}/issues/${target.issueNumber}/comments`,
            "POST",
            state.body,
        );
        const receipt = verifiedComment(await json(created), state);
        state = { ...state, phase: "completed", receipt };
        await save(path, state);
        return receipt;
    } catch (error) {
        if (error instanceof GitHubRequestFailure) {
            // These responses explicitly reject creation. Network failures and 5xx remain ambiguous.
            if (error.method === "POST" && [400, 401, 403, 404, 410, 422, 429].includes(error.status))
                state.phase = "prepared";
            if (error.retryAt) state.retryAt = error.retryAt;
            await save(path, state);
        }
        throw error;
    }
}
