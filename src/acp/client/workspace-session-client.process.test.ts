import { test } from "node:test";
import { equal, deepEqual, ok, rejects } from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineCommittedGitFixture } from "../../shared/git-test-fixture.ts";
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

test(
    "one connection keeps three Sessions in two Projects isolated while work streams and a question waits",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        const secondProject = await defineCommittedGitFixture().checkout();
        try {
            const runtime = fixture.launch(true);
            const first = await runtime.client.registerProject({ root: fixture.project });
            const second = await runtime.client.registerProject({ root: secondProject });
            ok(first.status === "ok" && second.status === "ok");
            await runtime.client.openProject({ projectId: first.project.projectId });
            await runtime.client.create();
            const a1 = runtime.binding();
            fixture.provider.enqueue({ question: { type: "text", prompt: "Answer only Project A Session one" } });
            const questionTurn = runtime.client.send(a1, "Ask in A1.");
            await runtime.wait((view) => view.phase === "awaiting_answer");
            const question = runtime.view().question;
            ok(question);
            await waitForSession(() => Boolean(runtime.client.getBindingView(a1.sessionId)?.durableSessionId));
            const a1Durable = runtime.client.getBindingView(a1.sessionId)!.durableSessionId;

            await runtime.client.create();
            const a2 = runtime.binding();
            fixture.provider.enqueue({ text: "A2 held output", hold: true });
            const a2Turn = runtime.client.send(a2, "Stream in A2.");
            await runtime.wait((view) => view.items.some((item) => item.text === "A2 held output"));
            runtime.client.queue(a2, {
                requestId: "restored-a2",
                text: "Never auto send restored A2",
                images: [],
                restored: true,
            });
            await runtime.client.stageConfiguration(a2, { agentName: "router" });
            await runtime.client.send(a2, "Accepted Core steering in A2");
            await runtime.client.reattachViews();
            const a2Live = runtime.client.getBindingView(a2.sessionId)!;
            equal(a2Live.pendingConfiguration?.agentName, "router");
            ok(a2Live.sessionInfo);
            ok(a2Live.coreQueuedMessages?.some((message) => message.text === "Accepted Core steering in A2"));
            equal(
                a2Live.queued?.[0].text,
                "Never auto send restored A2",
                "Core messages and client intent remain distinct",
            );

            await runtime.client.openProject({ projectId: second.project.projectId });
            await runtime.client.create();
            const b1 = runtime.binding();
            fixture.provider.enqueue({ text: "B1 held output", hold: true });
            const b1Turn = runtime.client.send(b1, "Stream in B1.");
            await runtime.wait((view) => view.items.some((item) => item.text === "B1 held output"));
            equal(runtime.client.getBindingViews().length, 3);
            equal(runtime.view().bindings?.find((binding) => binding.sessionId === a1.sessionId)?.hasQuestion, true);
            equal(runtime.view().bindings?.find((binding) => binding.sessionId === a2.sessionId)?.phase, "streaming");
            equal(
                runtime.view().bindings?.find((binding) => binding.sessionId === b1.sessionId)?.projectId,
                second.project.projectId,
            );
            await rejects(
                runtime.client.answer(b1, {
                    requestId: question.requestId,
                    action: "accept",
                    answer: "Wrong destination",
                }),
                /no longer waiting/,
            );
            equal(fixture.provider.requests.length, 3);
            fixture.provider.enqueue({ text: "A1 answered exactly once" });
            await runtime.client.answer(a1, {
                requestId: question.requestId,
                action: "accept",
                answer: "Exact A1 answer",
            });
            await questionTurn;
            ok(toolResult(fixture.provider.requests[3]).includes("Exact A1 answer"));
            equal(runtime.view().sessionId, b1.sessionId, "a named background answer never selects or retargets B1");
            await runtime.client.cancel(a2);
            await a2Turn;
            equal(runtime.client.getBindingView(a2.sessionId)?.phase, "idle");
            equal(runtime.client.getBindingView(b1.sessionId)?.phase, "streaming");
            fixture.provider.emit(" Still only B1 streams.");
            await runtime.wait((view) => view.items.some((item) => item.text.includes("Still only B1 streams.")));
            await runtime.client.reattachViews();
            equal(runtime.client.getBindingView(a2.sessionId)?.queued?.[0]?.restored, true);
            const polls = runtime.sentMethods.filter(
                (method) => method === "_dev.runwield/workspace/sessions/snapshot",
            ).length;
            await waitForSession(
                () =>
                    runtime.sentMethods.filter((method) => method === "_dev.runwield/workspace/sessions/snapshot")
                        .length >=
                    polls + 6,
            );
            equal(fixture.provider.requests.length, 4, "restored intent remains unsent across idle observation cycles");
            const clone = runtime.client.getBindingViews();
            clone[0].items.length = 0;
            ok(runtime.client.getBindingView(a1.sessionId)!.items.length > 0, "binding reads are fresh clones");
            await runtime.client.openProject({ projectId: first.project.projectId });
            const loadsBefore = runtime.sentMethods.filter((method) => method === "session/load").length;
            await runtime.client.load(a1Durable);
            equal(runtime.view().sessionId, a1.sessionId);
            equal(runtime.sentMethods.filter((method) => method === "session/load").length, loadsBefore);
            fixture.provider.release();
            await b1Turn;
            await runtime.client.reattachViews();
            equal(
                fixture.provider.requests.length,
                4,
                "restored queued intent stays unsent after settlement and view reattach",
            );
            for (const [binding, own, foreign] of [
                [a1, "Ask in A1.", "Stream in B1."],
                [a2, "Stream in A2.", "Ask in A1."],
                [b1, "Stream in B1.", "Stream in A2."],
            ] as const) {
                const view = runtime.client.getBindingView(binding.sessionId)!;
                ok(view.items.some((item) => item.text === own));
                ok(!view.items.some((item) => item.text === foreign));
            }
            await runtime.client.close(a1);
            equal(runtime.client.getBindingView(a1.sessionId), undefined);
            equal(runtime.client.getBindingViews().length, 2);
            deepEqual(fixture.provider.failures, []);
        } finally {
            await fixture.cleanup();
            await rm(secondProject, { recursive: true, force: true });
        }
    },
);

test(
    "reattach rejects delayed history and earlier-epoch snapshots without publishing stale evidence",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        try {
            const runtime = fixture.launch(true);
            const project = await runtime.client.registerProject({ root: fixture.project });
            ok(project.status === "ok");
            await runtime.client.openProject({ projectId: project.project.projectId });
            await runtime.client.create();
            fixture.provider.enqueue({ text: "Generation one committed" });
            await runtime.client.send(runtime.binding(), "First saved turn");
            const binding = runtime.binding();
            const firstGeneration = runtime.view().generation!;
            const durable = runtime.view().durableSessionId;
            await runtime.client.create();
            const alternate = runtime.binding();
            await runtime.client.load(durable);
            await runtime.client.reattachViews();
            const history = runtime.delayNextResponse("_dev.runwield/workspace/sessions/history");
            const attaching = runtime.client.reattachViews();
            await history.received;
            let published = 0;
            const unobserve = runtime.client.observe(() => published++);
            await runtime.client.load(alternate.sessionId);
            fixture.provider.enqueue({ text: "Generation two committed" });
            await runtime.client.sendImages(binding, "Second saved turn", [], "second-turn-request", firstGeneration);
            const newer = runtime.client.getBindingView(binding.sessionId)!;
            ok(newer.generation! > firstGeneration);
            equal(published, 0, "a new listener receives no cached view before all bindings reconcile");
            history.release();
            await attaching;
            equal(
                runtime.client.getBindingView(binding.sessionId)?.generation,
                newer.generation,
                "old history cannot replace a newer generation",
            );
            equal(
                runtime.view().sessionId,
                alternate.sessionId,
                "delayed primary history never retargets the selected binding",
            );
            equal(runtime.view().items.length, 0);
            equal(published, 1);
            unobserve();
            await runtime.client.load(durable);
            equal(runtime.view().items.filter((item) => item.text === "Generation two committed").length, 1);
            await runtime.client.close(alternate);

            const oldSnapshot = runtime.delayNextResponse("_dev.runwield/workspace/sessions/snapshot");
            await oldSnapshot.received;
            fixture.provider.enqueue({ text: "Held live after reattach", hold: true });
            const turn = runtime.client.send(binding, "Third turn stays live");
            await waitForSession(() => fixture.provider.requests.length === 3);
            await runtime.client.reattachViews();
            await runtime.wait((view) => view.items.some((item) => item.text.includes("Held live after reattach")));
            const live = runtime.client.getBindingView(binding.sessionId)!;
            ok(live.operationId);
            equal(live.phase, "streaming");
            oldSnapshot.release();
            // A completed new snapshot proves transport delivery and a subsequent observation cycle.
            const nextSnapshot = runtime.delayNextResponse("_dev.runwield/workspace/sessions/snapshot");
            await nextSnapshot.received;
            equal(runtime.client.getBindingView(binding.sessionId)?.operationId, live.operationId);
            equal(runtime.client.getBindingView(binding.sessionId)?.phase, "streaming");
            nextSnapshot.release();
            fixture.provider.release();
            await turn;
            equal(fixture.provider.requests.length, 3);
            equal(runtime.view().items.filter((item) => item.text === "Generation one committed").length, 1);
            deepEqual(fixture.provider.failures, []);
        } finally {
            await fixture.cleanup();
        }
    },
);

test(
    "committed history replaces live output in every view before a delayed prompt response",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        try {
            const runtime = fixture.launch(true);
            const project = await runtime.client.registerProject({ root: fixture.project });
            ok(project.status === "ok");
            await runtime.client.openProject({ projectId: project.project.projectId });
            await runtime.client.create();
            const text = "Output at commit boundary.";
            fixture.provider.enqueue({ text: "Baseline for commit boundary" }, { text, hold: true });
            await runtime.client.send(runtime.binding(), "Create baseline");
            const generation = runtime.view().generation!;
            const response = runtime.delayNextResponse("session/prompt");
            const turn = runtime.client.send(runtime.binding(), "Keep this output once");
            await runtime.wait((view) => view.items.some((item) => item.text === text));
            await runtime.client.stageConfiguration(runtime.binding(), { agentName: "engineer" });
            // A populated user Agent directory keeps the real post-commit configuration
            // read yielding to snapshots before the local operation settles. No Core
            // operation, generation, or persistence method is replaced.
            await Promise.all(
                Array.from({ length: 128 }, (_, agent) =>
                    writeFile(
                        join(fixture.home, ".wld", "agents", `fixture-delay-${agent}.md`),
                        `---\nname: Fixture ${agent}\ndescription: Configuration read fixture\nsharedPractice: [user-authority]\n---\n${"Keep user work safe.\n".repeat(4000)}`,
                    ),
                ),
            );
            await runtime.wait((view) => view.items.some((item) => item.text === text));
            fixture.provider.release();
            const canonical = openFileSessionStore({ baseDir: join(fixture.home, ".wld", "sessions") });
            try {
                await waitForSession(() => {
                    const evidence = canonical.inspectSessionActivation(runtime.view().durableSessionId);
                    return evidence.generation!.generation > generation;
                });
            } finally {
                canonical.close();
            }
            const views: import("../../ui/workspace/client/session-client.ts").SessionClientView[] = [];
            const stop = runtime.client.observe((view) => views.push(view));
            const snapshot = runtime.delayNextResponse("_dev.runwield/workspace/sessions/snapshot");
            const history = runtime.delayNextResponse("_dev.runwield/workspace/sessions/history");
            const attaching = runtime.client.reattachViews();
            await snapshot.received;
            const operation = snapshot.result?.operation;
            ok(operation && typeof operation === "object" && !Array.isArray(operation));
            equal(operation.status, "running", "the local operation still retains its live buffer");
            equal(operation.eventsAfterGeneration, generation);
            ok(Number(snapshot.result?.generation) > generation, "canonical output is already committed");
            snapshot.release();
            await history.received;
            equal(history.result?.generation, snapshot.result?.generation, "history includes this live buffer");
            history.release();
            await attaching;
            await response.received;
            // History and snapshots are applied before the prompt acknowledgement.
            await runtime.client.reattachViews();
            response.release();
            await turn;
            stop();
            for (const view of views) {
                const output = view.items
                    .filter((item) => item.kind === "assistant")
                    .map((item) => item.text)
                    .join("\n");
                equal(
                    output.split(text).length - 1,
                    1,
                    `every published view contains output exactly once: ${JSON.stringify(view)}`,
                );
            }
            equal(fixture.provider.requests.length, 2);
            deepEqual(fixture.provider.failures, []);
        } finally {
            fixture.provider.release();
            await fixture.cleanup();
        }
    },
);
