import { test } from "node:test";
import { ok as assert, deepStrictEqual as equal, rejects, throws } from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { withProject, submitReview, runOperation } from "../../../shared/attached/attached-test-fixture.ts";
import { ensureReviewHosted, stopHostedAttachedReviews } from "../../../shared/attached/review-host.ts";
import { NO_OPEN_BROWSER_PORT } from "../../../shared/browser-port.ts";
import { reply, pendingChat } from "../../../shared/attached/review-chat-test-fixture.ts";
import { attachedValidationFixture } from "../../../shared/attached/validation-test-fixture.ts";
import { toDelivery } from "../../../shared/attached/delivery-test-fixture.ts";
import { ReviewPage } from "./review.ts";
import { type JsonMap } from "./evidence.ts";

async function withPage(
    run: (page: ReviewPage, root: string, workflowId: string, result: JsonMap) => Promise<void>,
): Promise<void> {
    await withProject(async (root) => {
        try {
            await mkdir(join(root, "logs"));
            const workflow = await submitReview(root);
            const review = await ensureReviewHosted(root, workflow, NO_OPEN_BROWSER_PORT);
            assert(review);
            const current = await runOperation("status", root, { workflowId: workflow.workflowId });
            assert(current.ok);
            const result: JsonMap = JSON.parse(JSON.stringify({ ...current, review }));
            await run(new ReviewPage(root, result), root, workflow.workflowId, result);
        } finally {
            await stopHostedAttachedReviews();
        }
    });
}

test("question and change messages reach real Core review chat without a decision", async () => {
    await withPage(async (page, root, workflowId) => {
        await page.send("plan-chat", "question", "What is tested?");
        await page.send("plan-change", "change", "Please change the title.");
        const current = await runOperation("status", root, { workflowId });
        assert(current.ok && current.workflow.nextAction.kind === "review");
        equal(current.workflow.nextAction.chat?.message, "What is tested?");
        const rows = (await readFile(join(root, "logs/http.jsonl"), "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        equal(
            rows.filter((row) => row.method === "POST").map((row) => row.kind),
            ["question", "change"],
        );
        assert(rows.every((row) => row.status === 200 && row.actionId === current.workflow.review?.actionId));
    });
});

test("Plan chat accepts a real successful answer without the change-only reply envelope", async () => {
    await withPage(async (page, root, workflowId) => {
        await page.send("plan-chat", "question", "What is tested?");
        const current = await runOperation("status", root, { workflowId });
        assert(current.ok);
        const answered = await reply(root, current.workflow, {
            turnId: pendingChat(current.workflow).turnId,
            text: "The test command checks the feature.",
        });
        assert(answered.ok);
        const result: JsonMap = JSON.parse(JSON.stringify(answered));
        equal(result.reviewReply, undefined);
        equal(page.acceptsReply(result), true);
        equal(page.acceptsReply({ ...result, ok: false }), false);
        equal(page.acceptsReply({ ...result, operation: "status" }), false);
        const unrelated: JsonMap = JSON.parse(JSON.stringify(answered));
        (unrelated.workflow as JsonMap).review = { actionId: "another-round" };
        equal(page.acceptsReply(unrelated), false);
        const live = await page.conversation("plan-chat");
        assert(JSON.stringify(live).includes("The test command checks the feature."));
    });
});

test("Code chat accepts a real successful answer for the current diff without a change envelope", async () => {
    const fixture = await attachedValidationFixture();
    try {
        const started = await toDelivery(fixture);
        const review = await ensureReviewHosted(fixture.root, started.workflow, NO_OPEN_BROWSER_PORT);
        assert(review);
        await mkdir(join(fixture.root, "logs"));
        const result: JsonMap = JSON.parse(JSON.stringify({ ...started, review }));
        const page = new ReviewPage(fixture.root, result);
        await page.send("code-chat", "question", "Which checks passed?");
        const current = await fixture.status();
        const answered = await reply(fixture.root, current, {
            turnId: pendingChat(current).turnId,
            text: "Core recorded successful checks.",
        });
        assert(answered.ok);
        const response: JsonMap = JSON.parse(JSON.stringify(answered));
        equal(response.reviewReply, undefined);
        equal(page.acceptsReply(response), true);
        const unrelated: JsonMap = JSON.parse(JSON.stringify(answered));
        (unrelated.workflow as JsonMap).nextAction = { kind: "code_review", actionId: "another-diff" };
        equal(page.acceptsReply(unrelated), false);
        const live = await page.conversation("code-chat");
        assert(JSON.stringify(live).includes("Core recorded successful checks."));
    } finally {
        await stopHostedAttachedReviews();
        await fixture.close();
    }
});

test("structured Feedback returns real Core to planning", async () => {
    await withPage(async (page, root, workflowId) => {
        await page.send("plan-feedback", "feedback", "Include an error case.");
        const current = await runOperation("status", root, { workflowId });
        assert(current.ok);
        equal(current.workflow.nextAction.kind, "plan");
    });
});

test("approval through the real decision endpoint makes the Plan ready", async () => {
    await withPage(async (page, root, workflowId) => {
        await page.approve("plan-approved");
        const current = await runOperation("status", root, { workflowId });
        assert(current.ok);
        equal(current.workflow.state, "plan_ready");
    });
});

test("shutdown proof requires an actually refused connection", async () => {
    await withPage(async (page, root) => {
        await page.conversation("plan-feedback");
        await stopHostedAttachedReviews();
        await page.requireStopped();
        const rows = (await readFile(join(root, "logs/http.jsonl"), "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        equal(rows.at(-1).status, null);
        equal(rows.at(-1).errorCode, "ECONNREFUSED");
        equal(rows[0].url, rows.at(-1).url);
    });
});

test("wrong-token HTTP errors do not prove listener shutdown", async () => {
    await withPage(async (_page, root, _workflowId, result) => {
        const url = new URL(String((result.review as JsonMap).url));
        url.searchParams.set("token", "wrong");
        const page = new ReviewPage(root, { ...result, review: { url: url.href } });
        await rejects(page.conversation("plan-review"));
        await rejects(page.requireStopped(), /did not prove shutdown/);
    });
});

test("review requests refuse non-loopback URLs before sending tokens or content", () => {
    throws(
        () =>
            new ReviewPage("/unused", {
                review: { url: "https://example.invalid/review?token=private" },
                workflow: { nextAction: { kind: "review" }, review: { actionId: "action" } },
            }),
        /loopback/,
    );
    throws(() => new ReviewPage("/unused", {}), /identity/);
});

test("a transport error cannot become success even when it carries a valid Core response", async () => {
    await withPage(async (_page, root, _workflowId, result) => {
        const original = new URL(String((result.review as JsonMap).url));
        // Forward to the real Core listener; only the external transport status is faulted.
        const upstreamOrigin = original.origin;
        const proxy = createServer(async (request, response) => {
            const upstream = await fetch(new URL(request.url!, upstreamOrigin));
            response.writeHead(503, { "content-type": "application/json" });
            response.end(await upstream.text());
        });
        await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
        try {
            const address = proxy.address();
            assert(address && typeof address !== "string");
            original.port = String(address.port);
            const page = new ReviewPage(root, { ...result, review: { url: original.href } });
            await rejects(page.conversation("plan-review"), /HTTP request failed/);
        } finally {
            await new Promise<void>((resolve) => proxy.close(() => resolve()));
        }
    });
});

test("successful decision logs retain only receipt identity, not HTTP response content", async () => {
    await withPage(async (_page, root, _workflowId, result) => {
        const original = new URL(String((result.review as JsonMap).url));
        const secret = "private-response-prompt-and-content";
        const proxy = createServer(async (request, response) => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const upstream = await fetch(new URL(request.url!, original.origin), {
                method: request.method,
                body: request.method === "POST" ? Buffer.concat(chunks) : undefined,
            });
            const body = await upstream.json();
            response.writeHead(upstream.status, { "content-type": "application/json" });
            response.end(JSON.stringify({ ...body, prompt: secret, content: secret }));
        });
        await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
        try {
            const address = proxy.address();
            assert(address && typeof address !== "string");
            const url = new URL(original);
            url.port = String(address.port);
            const page = new ReviewPage(root, { ...result, review: { url: url.href } });
            await page.approve("plan-approved");
            const logs = await readFile(join(root, "logs/http.jsonl"), "utf8");
            equal(logs.includes(secret), false);
            const rows = logs
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line));
            equal(rows.at(-1).response, { ok: true });
            equal(rows[0].response, undefined);
        } finally {
            await new Promise<void>((resolve) => proxy.close(() => resolve()));
        }
    });
});
