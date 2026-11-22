import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import {
    makeSessionProcessFixture,
    waitForSession,
    launchContinuationOwner,
} from "./client/testing/session-process-fixture.ts";

const png = {
    mimeType: "image/png",
    base64: readFileSync(new URL("../ui/workspace/static/pwa/icon-192.png", import.meta.url)).toString("base64"),
};

test(
    "negotiated turns preserve receipts, reject stale generation and malformed images before effects",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        try {
            const runtime = fixture.launch(true);
            const registered = await runtime.client.registerProject({ root: fixture.project });
            ok(registered.status === "ok");
            const projectId = registered.project.projectId;
            const { context } = await runtime.client.openProject({ projectId });
            await runtime.client.create();
            fixture.provider.enqueue({ text: "Vision accepted." });
            await runtime.client.sendImages(runtime.binding(), "", [png], "create-vision");
            const durable = runtime.view().durableSessionId;
            const generation = runtime.view().generation!;
            ok(durable);
            ok(generation >= 0, JSON.stringify(runtime.view()));
            equal(fixture.provider.requests.length, 1);
            await runtime.client.sendImages(runtime.binding(), "", [png], "create-vision", 0);
            equal(fixture.provider.requests.length, 1, "the initial create receipt replays on its original binding");
            ok(fixture.provider.requests[0].raw.includes("image_url"), fixture.provider.requests[0].raw);
            await rejects(
                runtime.client.sendImages(
                    runtime.binding(),
                    "Bad image",
                    [{ mimeType: "image/png", base64: "not bytes" }],
                    "retry-image",
                ),
            );
            equal(fixture.provider.requests.length, 1);
            fixture.provider.enqueue({ text: "Continued exactly once." });
            await runtime.client.sendImages(runtime.binding(), "Continue once", [], "stable-continuation", generation);
            const committed = await runtime.client.history({ context, sessionId: durable });
            await runtime.client.sendImages(runtime.binding(), "Continue once", [], "stable-continuation", generation);
            equal(fixture.provider.requests.length, 2, "same receipt must not repeat provider work");
            await rejects(
                runtime.client.sendImages(
                    runtime.binding(),
                    "Conflicting content",
                    [],
                    "stable-continuation",
                    generation,
                ),
            );
            await rejects(
                runtime.client.sendImages(runtime.binding(), "Stale generation", [], "new-stale", generation),
            );
            equal(fixture.provider.requests.length, 2);
            equal((await runtime.client.history({ context, sessionId: durable })).generation, committed.generation);
            await runtime.client.close(runtime.binding());
            await runtime.shutdown();
            const restarted = fixture.launch(true);
            await restarted.client.openProject({ projectId });
            await restarted.client.load(durable);
            await restarted.client.sendImages(
                restarted.binding(),
                "Continue once",
                [],
                "stable-continuation",
                generation,
            );
            equal(fixture.provider.requests.length, 2, "receipt identity survives process restart");
            equal(
                (
                    await restarted.client.history({
                        context: (await restarted.client.readProject({ projectId })).context,
                        sessionId: durable,
                    })
                ).events.filter((event) => event.type === "user_message" && event.text === "Continue once").length,
                1,
            );
        } finally {
            await fixture.cleanup();
        }
    },
);

test("sidebar read contexts do not retarget a bound question or unsent queue", { timeout: 60000 }, async () => {
    const fixture = await makeSessionProcessFixture();
    try {
        const runtime = fixture.launch(true);
        const a = await runtime.client.registerProject({ root: fixture.project });
        ok(a.status === "ok");
        const proposed = await runtime.client.registerProject({ root: fixture.home });
        const b =
            proposed.status === "confirmation_required"
                ? await runtime.client.registerProject({
                      root: fixture.home,
                      directoryConfirmation: proposed.confirmation,
                  })
                : proposed;
        ok(b.status === "ok");
        await runtime.client.openProject({ projectId: a.project.projectId });
        await runtime.client.create();
        fixture.provider.enqueue(
            { question: { type: "text", prompt: "Keep the destination?" } },
            { text: "Answer kept." },
        );
        const turn = runtime.client.send(runtime.binding(), "Ask a question.");
        await runtime.wait((view) => view.phase === "awaiting_answer");
        const binding = runtime.binding();
        runtime.client.queue(binding, { requestId: "local-unsent", text: "Editable queued draft", images: [png] });
        const context = await runtime.client.readProject({ projectId: b.project.projectId });
        equal((await runtime.client.listSessions({ context: context.context })).sessions.length, 0);
        equal(runtime.binding().sessionId, binding.sessionId);
        equal(runtime.binding().project, binding.project);
        equal(runtime.view().queued?.[0].requestId, "local-unsent");
        runtime.client.removeQueued(binding, "local-unsent");
        await runtime.client.answer(binding, {
            requestId: runtime.view().question!.requestId,
            action: "accept",
            answer: "Same Project.",
        });
        await turn;
        equal(runtime.view().queued?.length, 0);
        equal(fixture.provider.requests.length, 2);
    } finally {
        await fixture.cleanup();
    }
});

test(
    "observation retains background work after end_turn and Stop cancels it without another foreground Promise",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        try {
            const runtime = fixture.launch(true);
            const registered = await runtime.client.registerProject({ root: fixture.project });
            ok(registered.status === "ok");
            await runtime.client.openProject({ projectId: registered.project.projectId });
            await runtime.client.create();
            fixture.provider.enqueue(
                { background: "sleep 1; printf 'delayed subprocess result\\n'" },
                { text: "Foreground ended." },
                { text: "Background result continued." },
            );
            await runtime.client.send(runtime.binding(), "Start delayed work.");
            equal(fixture.provider.requests.length, 2);
            await runtime.wait((view) => view.phase === "streaming");
            await runtime.wait((view) => view.items.some((item) => item.text.includes("Background result continued.")));
            equal(fixture.provider.requests.length, 3);
            equal(runtime.view().items.filter((item) => item.text.includes("Background result continued.")).length, 1);
            await runtime.wait((view) => view.phase === "idle");
            fixture.provider.enqueue(
                {
                    background: `printf '%s' $$ > '${join(fixture.home, "retained.pid")}'; sleep 30; printf 'must not resume\\n'`,
                },
                { text: "Another foreground ended." },
            );
            await runtime.client.send(runtime.binding(), "Start work to stop.");
            const retainedPid = Number(await readFile(join(fixture.home, "retained.pid"), "utf8"));
            ok(retainedPid > 0);
            process.kill(retainedPid, 0);
            await runtime.wait((view) => view.phase === "streaming");
            await runtime.client.cancel(runtime.binding());
            await runtime.wait((view) => view.phase === "idle");
            await waitForSession(() => {
                try {
                    process.kill(retainedPid, 0);
                    return false;
                } catch (error) {
                    return error instanceof Error && "code" in error && error.code === "ESRCH";
                }
            });
            const { context } = await runtime.client.readProject({ projectId: registered.project.projectId });
            const drained = await runtime.client.snapshot({ context, sessionId: runtime.view().durableSessionId });
            equal(drained.state, "idle");
            equal(drained.operation, null);
            equal(fixture.provider.requests.length, 5);
        } finally {
            await fixture.cleanup();
        }
    },
);

test(
    "an unsent queue dispatches once and a closed Session clears saved configuration",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        try {
            const runtime = fixture.launch(true);
            const registered = await runtime.client.registerProject({ root: fixture.project });
            ok(registered.status === "ok");
            const { context } = await runtime.client.openProject({ projectId: registered.project.projectId });
            await runtime.client.create();
            fixture.provider.enqueue(
                { text: "Held foreground.", hold: true },
                { text: "Queued follow-up done.", hold: true },
            );
            const foreground = runtime.client.send(runtime.binding(), "Hold for local intent.");
            await runtime.wait((view) => Boolean(view.durableSessionId));
            runtime.client.queue(runtime.binding(), {
                requestId: "removed-intent",
                text: "Never accepted.",
                images: [],
            });
            runtime.client.removeQueued(runtime.binding(), "removed-intent");
            runtime.client.queue(runtime.binding(), {
                requestId: "dispatch-once",
                text: "One queued message.",
                images: [],
            });
            await waitForSession(() => fixture.provider.requests.length === 1);
            fixture.provider.release();
            await foreground;
            await runtime.wait(
                (view) =>
                    view.phase === "streaming" &&
                    view.items.some((item) => item.text.includes("Queued follow-up done.")),
            );
            fixture.provider.emit(" Still live while queued.");
            await runtime.wait((view) => view.items.some((item) => item.text.includes("Still live while queued.")));
            fixture.provider.release();
            await runtime.wait(
                (view) =>
                    view.phase === "idle" &&
                    view.queued?.length === 0 &&
                    view.items.some((item) => item.text.includes("Queued follow-up done.")),
            );
            const history = await runtime.client.history({ context, sessionId: runtime.view().durableSessionId });
            equal(
                history.events.filter((event) => event.type === "user_message" && event.text === "One queued message.")
                    .length,
                1,
            );
            equal(
                history.events.filter((event) => event.type === "user_message" && event.text === "Never accepted.")
                    .length,
                0,
            );
            equal(fixture.provider.requests.length, 2);
            await runtime.client.close(runtime.binding());
            equal(runtime.view().generation, null);
            equal(runtime.view().configuration, undefined);
            await runtime.client.create();
            equal(runtime.view().durableSessionId, "");
            equal(runtime.view().archivedAt, null);
        } finally {
            await fixture.cleanup();
        }
    },
);

test("busy archive refuses until explicit confirmation and preserves saved identity", { timeout: 60000 }, async () => {
    const fixture = await makeSessionProcessFixture();
    try {
        const runtime = fixture.launch(true);
        const registered = await runtime.client.registerProject({ root: fixture.project });
        ok(registered.status === "ok");
        const { context } = await runtime.client.openProject({ projectId: registered.project.projectId });
        await runtime.client.create();
        fixture.provider.enqueue({ text: "Saved before archive." });
        await runtime.client.send(runtime.binding(), "Establish committed history.");
        fixture.provider.enqueue({ text: "Interrupted archive work.", hold: true });
        const turn = runtime.client.send(runtime.binding(), "Archive this busy conversation.");
        await waitForSession(() => fixture.provider.requests.length === 2);
        await runtime.wait((view) => Boolean(view.durableSessionId));
        const sessionId = runtime.view().durableSessionId;
        await rejects(runtime.client.archive({ context, sessionId }), (error: Error) => {
            ok(/busy.*Confirm/.test(error.message), error.message);
            ok("data" in error && JSON.stringify(error.data).includes("session_busy_confirmation_required"));
            ok(!JSON.stringify(error).includes("fixture-key"));
            return true;
        });
        equal((await runtime.client.history({ context, sessionId })).archivedAt, null);
        await runtime.client.archive({ context, sessionId }, true);
        await turn;
        const archived = await runtime.client.history({ context, sessionId });
        ok(archived.archivedAt);
        equal(archived.sessionId, sessionId);
        equal((await runtime.client.listSessions({ context })).sessions.length, 0);
        await runtime.client.unarchive({ context, sessionId });
        equal((await runtime.client.history({ context, sessionId })).archivedAt, null);
    } finally {
        await fixture.cleanup();
    }
});

test(
    "bounded observation gaps and repeated snapshots refresh canonical messages without replay",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        try {
            // Keep this transport-bound test below the provider's context-compaction threshold.
            const models = join(fixture.home, ".wld", "models.json");
            await writeFile(
                models,
                (await readFile(models, "utf8")).replace('"contextWindow":128000', '"contextWindow":8000000'),
            );
            const runtime = fixture.launch(true);
            const registered = await runtime.client.registerProject({ root: fixture.project });
            ok(registered.status === "ok");
            const { context } = await runtime.client.openProject({ projectId: registered.project.projectId });
            await runtime.client.create();
            fixture.provider.enqueue({ text: "Before bounded observation." });
            await runtime.client.send(runtime.binding(), "Canonical initial prompt.");
            const sessionId = runtime.view().durableSessionId;
            const initial = await runtime.client.snapshot({ context, sessionId });
            const chunks = ["bounded-output:" + "x".repeat(2 * 1024 * 1024 + 1024)];
            fixture.provider.enqueue({ chunks, hold: true });
            const turn = runtime.client.send(runtime.binding(), "One prompt despite overlapping snapshots.");
            await waitForSession(() => fixture.provider.requests.length === 2);
            let gap = await runtime.client.snapshot({ context, sessionId, cursor: initial.cursor });
            const deadline = Date.now() + 10000;
            while (!gap.gap && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 20));
                gap = await runtime.client.snapshot({ context, sessionId, cursor: initial.cursor });
            }
            ok(gap.gap, "the real operation must exceed the observation bound");
            ok(Array.isArray(gap.operation?.events) && gap.operation.events.length <= 500);
            for (let index = 0; index < 4; index++) {
                const repeated = await runtime.client.snapshot({ context, sessionId, cursor: gap.cursor });
                ok(repeated.gap);
                equal(repeated.cursor, gap.cursor);
            }
            // Observe real outgoing ACP frames, not a replaced client method.
            const historyReads = () =>
                runtime.sentMethods.filter((method) => method === "_dev.runwield/workspace/sessions/history").length;
            const beforeRefresh = historyReads();
            await waitForSession(() => historyReads() > beforeRefresh);
            await new Promise((resolve) => setTimeout(resolve, 600));
            fixture.provider.emit(" LIVE_AFTER_GAP_749 ");
            await runtime.wait((view) => view.items.some((item) => item.text.includes("LIVE_AFTER_GAP_749")));
            equal(runtime.view().phase, "streaming");
            equal(runtime.view().items.filter((item) => item.text.includes("LIVE_AFTER_GAP_749")).length, 1);
            equal(fixture.provider.requests.length, 2);
            fixture.provider.release();
            await turn;
            await runtime.wait(
                (view) => view.phase === "idle" && view.items.some((item) => item.text.includes(chunks.join(""))),
            );
            await new Promise((resolve) => setTimeout(resolve, 600));
            equal(
                runtime.view().items.filter((item) => item.text === "One prompt despite overlapping snapshots.").length,
                1,
            );
            equal(runtime.view().items.filter((item) => item.text.includes(chunks.join(""))).length, 1);
            const history = await runtime.client.history({ context, sessionId });
            equal(
                history.events.filter(
                    (event) =>
                        event.type === "user_message" && event.text === "One prompt despite overlapping snapshots.",
                ).length,
                1,
            );
            equal(fixture.provider.requests.length, 2);
            await runtime.wait((view) => view.phase === "idle" && !view.operationId);
        } finally {
            await fixture.cleanup();
        }
    },
);

test(
    "remote Core questions preserve defaults, descriptions, Other and exact approval outcomes",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        const owner = launchContinuationOwner(fixture);
        try {
            const desktop = fixture.launch(true);
            const registered = await desktop.client.registerProject({ root: fixture.project });
            ok(registered.status === "ok");
            await desktop.client.openProject({ projectId: registered.project.projectId });
            await desktop.client.create();
            fixture.provider.enqueue({ text: "Saved for owner questions." });
            await desktop.client.send(desktop.binding(), "Save the Session.");
            equal(await owner.command("open", desktop.view().durableSessionId), "opened");
            let approvalSeen = false;
            for (const kind of ["text", "select", "approval", "approval"] as const) {
                const waiting = owner.command("interaction", undefined, kind);
                await desktop.wait((view) => view.phase === "awaiting_answer");
                const question = desktop.view().question!;
                equal(question.prompt, "Exact owner question");
                equal(question.interactionId, question.requestId);
                ok(question.interactionId);
                equal(question.required, true);
                equal(question.placeholder, "Owner placeholder");
                equal(question.defaultValue, kind === "text" ? "Saved text default" : "approve");
                equal(question.mode, kind);
                equal(question.allowOther, kind !== "text");
                if (kind !== "text")
                    deepEqual(question.choices, [
                        { value: "approve", label: "Approve exactly", description: "Owner choice description" },
                        { value: "decline", label: "Decline exactly" },
                        { value: "other", label: "Other" },
                    ]);
                const decline: boolean = kind === "approval" && approvalSeen;
                await desktop.client.answer(desktop.binding(), {
                    requestId: question.requestId,
                    action: "accept",
                    answer:
                        kind === "text"
                            ? question.defaultValue
                            : kind === "select"
                              ? "other"
                              : decline
                                ? "decline"
                                : "approve",
                    ...(kind === "select" ? { otherAnswer: "Exact custom Other" } : {}),
                });
                const result = JSON.parse(await waiting);
                if (kind === "text") {
                    equal(result.outcome, "text");
                    equal(result.value, "Saved text default");
                } else if (kind === "select") {
                    equal(result.outcome, "selected");
                    equal(result.value, "other");
                    equal(result.otherText, "Exact custom Other");
                    equal(result.valueLabel, "Other");
                } else {
                    equal(result.outcome, decline ? "canceled" : "accepted");
                    equal(result.value, !decline);
                    equal(result.valueLabel, decline ? "Decline exactly" : "Approve exactly");
                    approvalSeen = true;
                }
                await desktop.wait((view) => view.phase === "idle");
            }
            equal(fixture.provider.requests.length, 1, "public owner questions need no provider or fake tool");
            equal(await owner.command("close"), "closed");
        } finally {
            await owner.shutdown();
            await fixture.cleanup();
        }
    },
);

test("first-turn configuration stages in the local owner", { timeout: 60000 }, async () => {
    const fixture = await makeSessionProcessFixture();
    try {
        await writeFile(
            join(fixture.home, ".wld", "agents", "engineer.md"),
            "---\nname: Engineer\ndescription: Staged Agent\nsharedPractice: [user-authority]\ntools: []\n---\nFollow the user.\n",
        );
        const runtime = fixture.launch(true);
        const registered = await runtime.client.registerProject({ root: fixture.project });
        ok(registered.status === "ok");
        const { context } = await runtime.client.openProject({ projectId: registered.project.projectId });
        await runtime.client.create();
        fixture.provider.enqueue({ text: "First turn held.", hold: true });
        const turn = runtime.client.send(runtime.binding(), "Stage during creation.");
        await runtime.wait(
            (view) =>
                Boolean(view.durableSessionId) && view.items.some((item) => item.text.includes("First turn held.")),
        );
        await runtime.client.stageConfiguration(runtime.binding(), { agentName: "engineer" });
        const live = await runtime.client.snapshot({ context, sessionId: runtime.view().durableSessionId });
        equal(
            live.operation?.pendingConfiguration && JSON.stringify(live.operation.pendingConfiguration),
            JSON.stringify({ agentName: "engineer" }),
        );
        fixture.provider.release();
        await turn;
        equal(runtime.view().configuration?.agentName.toLowerCase(), "engineer");
        equal(fixture.provider.requests.length, 1);
    } finally {
        await fixture.cleanup();
    }
});

test("a lost process receipt cannot acknowledge an uncertain prompt", { timeout: 60000 }, async () => {
    const fixture = await makeSessionProcessFixture();
    try {
        const runtime = fixture.launch(true);
        const registered = await runtime.client.registerProject({ root: fixture.project });
        ok(registered.status === "ok");
        const projectId = registered.project.projectId;
        await runtime.client.openProject({ projectId });
        await runtime.client.create();
        fixture.provider.enqueue({ text: "Committed before process loss." });
        await runtime.client.send(runtime.binding(), "Save before loss.");
        const durable = runtime.view().durableSessionId;
        const generation = runtime.view().generation!;
        await runtime.client.close(runtime.binding());
        await runtime.shutdown();
        // A durable running receipt without a live owner is the process-loss boundary.
        const orphan = spawnSync(
            fixture.bunExecutable,
            [
                fileURLToPath(new URL("../shared/session/testing/history-runtime-process.ts", import.meta.url)),
                "orphan-receipt",
                durable,
            ],
            { cwd: fixture.project, env: fixture.env, encoding: "utf8" },
        );
        equal(orphan.status, 0, orphan.stderr);
        const restarted = fixture.launch(true);
        await restarted.client.openProject({ projectId });
        await restarted.client.load(durable);
        await rejects(
            restarted.client.sendImages(restarted.binding(), "Keep uncertain draft.", [], "lost-receipt", generation),
            /unknown|uncertain|refresh/i,
        );
        equal(fixture.provider.requests.length, 1, "an uncertain receipt must not repeat work");
        ok(restarted.view().error);
    } finally {
        await fixture.cleanup();
    }
});
