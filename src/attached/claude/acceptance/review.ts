import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { field, jsonMap, type JsonMap, type Phase } from "./evidence.ts";

class RefusedConnection extends Error {}

function reviewActionId(result: JsonMap) {
    const kind = field(result, "workflow", "nextAction", "kind");
    if (kind === "code_review") return field(result, "workflow", "nextAction", "actionId");
    if (kind === "review") return field(result, "workflow", "review", "actionId");
    return undefined;
}

/** Uses the same authenticated HTTP endpoints as the browser. No lifecycle or record-store access. */
export class ReviewPage {
    readonly conversationUrl: string;
    private page: URL;
    private actionId: string;
    constructor(
        private root: string,
        result: JsonMap,
    ) {
        const url = field(result, "review", "url");
        const actionId = reviewActionId(result);
        if (typeof url !== "string" || typeof actionId !== "string" || !actionId)
            throw new Error("Missing hosted review identity");
        this.page = new URL(url);
        if (
            this.page.protocol !== "http:" ||
            this.page.hostname !== "127.0.0.1" ||
            !this.page.searchParams.get("token")
        )
            throw new Error("Review URL must be authenticated loopback HTTP");
        this.actionId = actionId;
        this.conversationUrl = this.api("conversation");
    }
    private api(endpoint: string): string {
        return new URL(`/api/review/${endpoint}${this.page.search}`, this.page).href;
    }
    private async request(phase: Phase, kind: string, endpoint: string, payload?: JsonMap): Promise<JsonMap> {
        const row: JsonMap = {
            phase,
            kind,
            actionId: this.actionId,
            url: this.api(endpoint),
            method: payload ? "POST" : "GET",
            status: null,
        };
        try {
            const response = await fetch(String(row.url), {
                method: String(row.method),
                headers: { "content-type": "application/json" },
                body: payload ? JSON.stringify(payload) : undefined,
                signal: AbortSignal.timeout(30_000),
            });
            row.status = response.status;
            if (payload) row.request = payload;
            const body = jsonMap(await response.json());
            if (response.status !== 200 || !body) throw new Error("Review HTTP request failed");
            if (payload && body.ok !== true) throw new Error("Review decision was not accepted");
            // Keep only acceptance and identity. Never persist response text, prompts, or conversation content.
            if (payload) {
                row.response = { ok: true };
                for (const key of ["operationId", "workflowId", "actionId", "attemptId", "generation", "decisionKey"]) {
                    if (typeof body[key] === "string") row.response[key] = body[key];
                }
            }
            return body;
        } catch (error) {
            const code = error instanceof Error && "code" in error ? error.code : undefined;
            const cause =
                error instanceof Error && error.cause instanceof Error && "code" in error.cause
                    ? error.cause.code
                    : undefined;
            row.errorCode =
                code === "ECONNREFUSED" || code === "ConnectionRefused" || cause === "ECONNREFUSED"
                    ? "ECONNREFUSED"
                    : "unknown";
            if (row.errorCode === "ECONNREFUSED") throw new RefusedConnection();
            throw error;
        } finally {
            appendFileSync(join(this.root, "logs/http.jsonl"), JSON.stringify(row) + "\n");
        }
    }
    acceptsReply(result: JsonMap): boolean {
        return result.ok === true && result.operation === "review_reply" && reviewActionId(result) === this.actionId;
    }
    conversation(phase: Phase): Promise<JsonMap> {
        return this.request(phase, "conversation", "conversation");
    }
    async send(phase: Phase, kind: "question" | "change" | "feedback", message: string): Promise<void> {
        const revision = (await this.conversation(phase)).reviewRevision;
        if (typeof revision !== "number") throw new Error("Missing browser review revision");
        await this.request(phase, kind, "deny", {
            feedback: message,
            annotations: [],
            reviewRevision: revision,
            ...(kind !== "feedback" ? { conversationTurn: true } : {}),
        });
    }
    async approve(phase: "plan-approved" | "code-approved"): Promise<void> {
        const revision = (await this.conversation(phase)).reviewRevision;
        if (typeof revision !== "number") throw new Error("Missing browser review revision");
        await this.request(phase, "approve", "decision", {
            reviewRevision: revision,
            ...(phase === "plan-approved"
                ? {
                      approvalAction: "run",
                      executionAgent: "engineer",
                      collaborationRecommendation: "autonomous",
                  }
                : { approved: true }),
        });
    }
    async requireStopped(): Promise<void> {
        for (let attempt = 0; attempt < 20; attempt++) {
            try {
                await this.request("plan-killed", "liveness", "conversation");
            } catch (error) {
                // HTTP errors and timeouts do not prove that the listener stopped.
                if (error instanceof RefusedConnection) return;
            }
            await delay(250);
        }
        throw new Error("Old review listener did not prove shutdown");
    }
}
