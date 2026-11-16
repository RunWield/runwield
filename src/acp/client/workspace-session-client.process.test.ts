import { test } from "node:test";
import { equal, deepEqual, ok, rejects } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { openFileSessionStore } from "../../shared/session/file-session-store.ts";
import { makeSessionProcessFixture, waitForSession } from "./testing/session-process-fixture.ts";
import type { RecordedProviderRequest } from "./testing/session-process-fixture.ts";

interface InterviewEvidenceAnswer {
    value: string;
    otherText?: string;
}
interface InterviewEvidence {
    answers: InterviewEvidenceAnswer[];
}
interface OptionalInterviewEvidence extends InterviewEvidence {
    status: string;
}
function interviewEvidence(request: RecordedProviderRequest): InterviewEvidence {
    const text = toolResult(request);
    const marker = "interview_result_json:\n";
    ok(text.includes(marker), text);
    return JSON.parse(text.slice(text.indexOf(marker) + marker.length)) as InterviewEvidence;
}

function toolResult(request: RecordedProviderRequest): string {
    const results = request.messages.filter((message) => message.role === "tool");
    equal(results.length, 1, "the next provider request contains exactly one interview result");
    const content = results[0].content;
    ok(typeof content === "string");
    return content;
}

test("streams before provider release and reloads durable history in a new runtime", { timeout: 60000 }, async () => {
    const fixture = await makeSessionProcessFixture();
    try {
        fixture.provider.enqueue({ text: "Live first chunk.", hold: true }, { text: "Continuation complete." });
        const runtime = fixture.launch();
        await runtime.wait(
            (view) =>
                view.connection === "ready" || view.connection === "disconnected" || view.connection === "incompatible",
        );
        equal(runtime.view().connection, "ready", runtime.stderr());
        await runtime.client.create();
        ok(runtime.child.pid && runtime.child.pid !== process.pid);
        const durable = runtime.view().durableSessionId;
        ok(durable);
        const prompt = "Remember the exact token cobalt-482 for the next turn.";
        const turn = runtime.client.send(runtime.binding(), prompt);
        await runtime.wait((view) =>
            view.items.some((item) => item.kind === "assistant" && item.text === "Live first chunk."),
        );
        equal(runtime.view().phase, "streaming");
        equal(fixture.provider.requests.length, 1);
        const user = fixture.provider.requests[0].messages.filter((message) => message.role === "user");
        ok(
            user.some((message) =>
                typeof message.content === "string"
                    ? message.content === prompt
                    : message.content?.some((part) => part.type === "text" && part.text === prompt),
            ),
        );
        equal(fixture.provider.requests[0].authorization, "Bearer fixture-key");
        fixture.provider.release();
        await turn;
        await runtime.client.close(runtime.binding());
        await runtime.shutdown();
        const reopened = fixture.launch();
        await reopened.client.load(durable);
        ok(reopened.view().items.some((item) => item.kind === "user" && item.text === prompt));
        ok(reopened.view().items.some((item) => item.kind === "assistant" && item.text === "Live first chunk."));
        await reopened.client.send(reopened.binding(), "Continue using the remembered token.");
        const context = JSON.stringify(fixture.provider.requests[1].messages);
        ok(context.includes(prompt));
        ok(context.includes("Live first chunk."));
        equal(reopened.view().phase, "idle");
        deepEqual(fixture.provider.failures, []);
        equal(reopened.view().sessionId, durable, "load retains its requested wire locator");
        const managedId = reopened.view().durableSessionId;
        ok(managedId, "load returns the canonical managed identity, not the initial segment locator");
        await reopened.client.close(reopened.binding());
        await reopened.shutdown();
        const third = fixture.launch();
        await third.client.load(managedId);
        equal(third.view().sessionId, managedId);
        equal(third.view().durableSessionId, managedId, "the managed identity survives another process restart");
        equal(third.view().items.filter((item) => item.kind === "user" && item.text === prompt).length, 1);
        const canonical = openFileSessionStore({ baseDir: join(fixture.home, ".wld", "sessions") });
        try {
            const saved = canonical.getSessionById(managedId);
            ok(saved);
            equal(saved.runwieldSessionId, managedId);
            const manifest = canonical.readSessionManifest(managedId, saved.projectId);
            ok(manifest);
            equal(manifest.runwieldSessionId, third.view().durableSessionId);
            const segment = canonical.getCurrentSessionSegment(managedId);
            ok(segment);
            const committed = await readFile(segment.transcriptPath, "utf8");
            ok(committed.includes(prompt));
            ok(committed.includes("Live first chunk."));
            ok(committed.includes("Continuation complete."));
        } finally {
            canonical.close();
        }
    } finally {
        await fixture.cleanup();
    }
});

for (const answer of [
    { value: "precise-value", other: undefined },
    { value: "other", other: "Custom exact answer 731" },
]) {
    test(`interview ${answer.value} reaches the next provider request`, { timeout: 40000 }, async () => {
        const fixture = await makeSessionProcessFixture();
        try {
            fixture.provider.enqueue(
                {
                    question: {
                        type: "multiple_choice",
                        prompt: "Choose an exact value",
                        choices: [
                            { value: "precise-value", label: "Friendly label" },
                            { value: "second", label: "Second label" },
                        ],
                    },
                },
                { text: "Answer received." },
            );
            const runtime = fixture.launch();
            await runtime.wait(
                (view) =>
                    view.connection === "ready" ||
                    view.connection === "disconnected" ||
                    view.connection === "incompatible",
            );
            equal(runtime.view().connection, "ready", runtime.stderr());
            await runtime.client.create();
            const turn = runtime.client.send(runtime.binding(), "Ask the interview question.");
            await runtime.wait((view) => view.phase === "awaiting_answer");
            const question = runtime.view().question;
            ok(question);
            ok(question.choices.some((choice) => choice.value === answer.value));
            const response = {
                requestId: question.requestId,
                action: "accept" as const,
                answer: answer.value,
                ...(answer.other ? { otherAnswer: answer.other } : {}),
            };
            await rejects(
                runtime.client.answer({ ...runtime.binding(), project: `${fixture.project}-wrong` }, response),
                /active Project/,
            );
            equal(fixture.provider.requests.length, 1);
            await runtime.client.answer(runtime.binding(), response);
            await rejects(runtime.client.answer(runtime.binding(), response), /no longer waiting/);
            await turn;
            const result = interviewEvidence(fixture.provider.requests[1]);
            equal(result.answers.length, 1);
            equal(result.answers[0].value, answer.value);
            equal(result.answers[0].otherText, answer.other);
            deepEqual(fixture.provider.failures, []);
        } finally {
            await fixture.cleanup();
        }
    });
}

test("required text refuses whitespace and delivers the valid answer", { timeout: 40000 }, async () => {
    const fixture = await makeSessionProcessFixture();
    try {
        fixture.provider.enqueue(
            { question: { type: "text", prompt: "Required name", allowEmpty: false } },
            { text: "Text received." },
        );
        const runtime = fixture.launch();
        await runtime.wait(
            (view) =>
                view.connection === "ready" || view.connection === "disconnected" || view.connection === "incompatible",
        );
        equal(runtime.view().connection, "ready", runtime.stderr());
        await runtime.client.create();
        const turn = runtime.client.send(runtime.binding(), "Ask for required text.");
        await runtime.wait((view) => view.phase === "awaiting_answer");
        const question = runtime.view().question;
        ok(question?.required);
        await rejects(
            runtime.client.answer(runtime.binding(), {
                requestId: question.requestId,
                action: "accept",
                answer: " \t\n ",
            }),
            /required/,
        );
        equal(runtime.view().phase, "awaiting_answer");
        equal(fixture.provider.requests.length, 1);
        await runtime.client.answer(runtime.binding(), {
            requestId: question.requestId,
            action: "accept",
            answer: "Exact valid name",
        });
        await turn;
        ok(toolResult(fixture.provider.requests[1]).includes("Exact valid name"));
    } finally {
        await fixture.cleanup();
    }
});

for (const pendingQuestion of [false, true]) {
    test(
        `stop ${pendingQuestion ? "pending question" : "held stream"} settles and permits another prompt`,
        { timeout: 40000 },
        async () => {
            const fixture = await makeSessionProcessFixture();
            try {
                fixture.provider.enqueue(
                    pendingQuestion
                        ? { question: { type: "text", prompt: "Do not answer this" } }
                        : { text: "Stream to stop.", hold: true },
                    { text: "Next prompt succeeded." },
                );
                const runtime = fixture.launch();
                await runtime.wait(
                    (view) =>
                        view.connection === "ready" ||
                        view.connection === "disconnected" ||
                        view.connection === "incompatible",
                );
                equal(runtime.view().connection, "ready", runtime.stderr());
                await runtime.client.create();
                const turn = runtime.client.send(runtime.binding(), "Start cancellable turn.");
                await runtime.wait((view) =>
                    pendingQuestion
                        ? view.phase === "awaiting_answer"
                        : view.items.some((item) => item.text === "Stream to stop."),
                );
                const stale = runtime.view().question?.requestId || "stale-stream-question";
                await runtime.client.cancel(runtime.binding());
                await turn;
                equal(runtime.view().phase, "idle");
                equal(runtime.view().question, null);
                await rejects(
                    runtime.client.answer(runtime.binding(), {
                        requestId: stale,
                        action: "accept",
                        answer: "Late answer",
                    }),
                    /no longer waiting/,
                );
                await runtime.client.send(runtime.binding(), "This is the next prompt.");
                equal(runtime.view().phase, "idle");
                equal(fixture.provider.requests.length, 2);
                ok(runtime.view().items.some((item) => item.text === "Next prompt succeeded."));
                equal(
                    runtime
                        .view()
                        .items.filter((item) => item.kind === "user" && item.text === "This is the next prompt.")
                        .length,
                    1,
                );
                ok(!fixture.provider.requests[1].raw.includes("Late answer"));
                deepEqual(fixture.provider.failures, []);
            } finally {
                await fixture.cleanup();
            }
        },
    );
}

test("unexpected runtime death interrupts without resubmitting input", { timeout: 40000 }, async () => {
    const fixture = await makeSessionProcessFixture();
    try {
        fixture.provider.enqueue({ text: "Before unexpected exit.", hold: true });
        const runtime = fixture.launch();
        await runtime.wait(
            (view) =>
                view.connection === "ready" || view.connection === "disconnected" || view.connection === "incompatible",
        );
        equal(runtime.view().connection, "ready", runtime.stderr());
        await runtime.client.create();
        const turn = runtime.client.send(runtime.binding(), "Never resubmit this prompt.");
        const failed = rejects(turn);
        await runtime.wait((view) => view.items.some((item) => item.text === "Before unexpected exit."));
        runtime.child.kill("SIGKILL");
        await failed;
        await runtime.wait((view) => view.connection === "disconnected");
        equal(runtime.view().phase, "interrupted");
        ok(runtime.view().error);
        await rejects(runtime.client.send(runtime.binding(), "Refuse disconnected input."));
        await waitForSession(() => fixture.provider.requests.length === 1);
        equal(fixture.provider.requests.length, 1);
    } finally {
        await fixture.cleanup();
    }
});

for (const action of ["accept", "decline"] as const) {
    test(`optional text ${action} settles through the real provider`, { timeout: 40000 }, async () => {
        const fixture = await makeSessionProcessFixture();
        try {
            fixture.provider.enqueue(
                {
                    question: {
                        type: "text",
                        prompt: "Optional note",
                        allowEmpty: true,
                        default: "Do not submit this default",
                    },
                },
                { text: "Optional question settled." },
            );
            const runtime = fixture.launch();
            await runtime.client.create();
            const turn = runtime.client.send(runtime.binding(), "Ask for the optional note.");
            await runtime.wait((view) => view.phase === "awaiting_answer");
            const question = runtime.view().question;
            ok(question);
            equal(question.required, false);
            await runtime.client.answer(runtime.binding(), { requestId: question.requestId, action, answer: "" });
            await turn;
            const text = toolResult(fixture.provider.requests[1]);
            const result = JSON.parse(
                text.slice(text.indexOf("interview_result_json:\n") + "interview_result_json:\n".length),
            ) as OptionalInterviewEvidence;
            if (action === "accept") {
                equal(result.status, "completed");
                equal(result.answers[0].value, "");
            } else {
                equal(result.status, "canceled");
            }
            ok(!text.includes("Do not submit this default"));
            deepEqual(fixture.provider.failures, []);
        } finally {
            await fixture.cleanup();
        }
    });
}
