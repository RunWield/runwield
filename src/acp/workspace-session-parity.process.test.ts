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
        const resolution = await restarted.client.resolveSubmission({
            context: (await restarted.client.readProject({ projectId })).context,
            sessionId: durable,
            requestId: "lost-receipt",
            kind: "prompt",
            expectedGeneration: generation,
        });
        equal(resolution.status, "unknown");
        equal(resolution.outcome, "running");
        equal(resolution.sessionId, durable);
        equal(fixture.provider.requests.length, 1, "uncertain receipt lookup must not execute the saved input");
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

for (const retained of [false, true]) {
    test(
        `negotiated close acknowledges canonical settlement with ${retained ? "retained" : "foreground"} work`,
        { timeout: 60000 },
        async () => {
            const fixture = await makeSessionProcessFixture();
            try {
                const runtime = fixture.launch(true);
                const registration = await runtime.client.registerProject({ root: fixture.project });
                ok(registration.status === "ok");
                const { context } = await runtime.client.openProject({ projectId: registration.project.projectId });
                await runtime.client.create();
                const pidFile = join(fixture.home, "close-task.pid");
                fixture.provider.enqueue(
                    { background: `printf '%s' $$ > '${pidFile}'; sleep 30` },
                    { text: "Task and operation are held.", hold: !retained },
                );
                const turn = runtime.client.send(runtime.binding(), "Keep the shell task until explicit close.");
                await runtime.wait((view) =>
                    view.items.some((item) => item.text.includes("Task and operation are held.")),
                );
                if (retained) await turn;
                const binding = runtime.binding();
                const sessionId = runtime.view().durableSessionId;
                const pid = Number(await readFile(pidFile, "utf8"));
                process.kill(pid, 0);
                const before = await runtime.client.snapshot({ context, sessionId });
                equal(before.state, "active");
                await runtime.client.create();
                fixture.provider.enqueue({ text: "Separate local binding stays held.", hold: true });
                const separateTurn = runtime.client.send(runtime.binding(), "Keep this other binding running.");
                await runtime.wait((view) =>
                    view.items.some((item) => item.text.includes("Separate local binding stays held.")),
                );
                const separateId = runtime.view().durableSessionId;
                await runtime.client.close(binding);
                // Read Core by durable identity after the binding has been removed. Neither
                // a cancellation notification nor disappearance of the view proves settlement.
                const after = await runtime.client.snapshot({ context, sessionId });
                equal(after.state, "idle");
                equal(after.operation, null);
                ok(after.generation !== null);
                let alive = true;
                try {
                    process.kill(pid, 0);
                } catch {
                    alive = false;
                }
                equal(alive, false, "the close response must follow Background Task process settlement");
                await turn;
                equal((await runtime.client.snapshot({ context, sessionId: separateId })).state, "active");
                fixture.provider.release();
                await separateTurn;
                equal(fixture.provider.requests.length, 3);
            } finally {
                await fixture.cleanup();
            }
        },
    );
}

test(
    "one acknowledged drain settles local work but leaves a separate continuation owner running",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        const owner = launchContinuationOwner(fixture);
        try {
            const runtime = fixture.launch(true);
            const registration = await runtime.client.registerProject({ root: fixture.project });
            ok(registration.status === "ok");
            const { context } = await runtime.client.openProject({ projectId: registration.project.projectId });
            await runtime.client.create();
            fixture.provider.enqueue({ text: "Saved for another owner." });
            await runtime.client.send(runtime.binding(), "Save external owner Session.");
            const externalId = runtime.view().durableSessionId;
            equal(await owner.command("open", externalId), "opened");
            fixture.provider.enqueue({ text: "External owner stays held.", hold: true });
            const externalTurn = owner.command("prompt", undefined, "Do not cancel this other owner.");
            await waitForSession(() => fixture.provider.requests.length === 2);
            await runtime.client.create();
            fixture.provider.enqueue({ text: "Local owner is held.", hold: true });
            const localTurn = runtime.client.send(runtime.binding(), "Cancel only this runtime's work.");
            await runtime.wait((view) => view.items.some((item) => item.text.includes("Local owner is held.")));
            const localId = runtime.view().durableSessionId;
            const first = runtime.client.drain();
            equal(runtime.client.drain(), first, "concurrent shutdowns must share one pending drain");
            await rejects(runtime.client.send(runtime.binding(), "No new dispatch during drain."), /draining/);
            const result = await first;
            equal(result.status, "settled", JSON.stringify(result));
            equal((await runtime.client.snapshot({ context, sessionId: localId })).state, "idle");
            equal((await runtime.client.snapshot({ context, sessionId: externalId })).state, "active");
            await localTurn;
            fixture.provider.emit(" Still externally owned.");
            fixture.provider.release();
            equal(await externalTurn, "completed");
            equal(fixture.provider.requests.length, 3);
            equal(await owner.command("close"), "closed");
        } finally {
            fixture.provider.release();
            await owner.shutdown();
            await fixture.cleanup();
        }
    },
);

test(
    "submission observers persist the original kind and generation before direct and queued dispatch",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        try {
            const runtime = fixture.launch(true);
            const registration = await runtime.client.registerProject({ root: fixture.project });
            ok(registration.status === "ok");
            const projectId = registration.project.projectId;
            const { context } = await runtime.client.openProject({ projectId });
            await runtime.client.create();
            let releaseWrite = () => {};
            const hostWrite = new Promise<void>((resolve) => {
                releaseWrite = resolve;
            });
            let queuedPrepared = false;
            const records: import("./workspace-contract.ts").WorkspaceSubmissionMetadata[] = [];
            const remove = runtime.client.onSubmission(async (event) => {
                if (event.phase !== "prepared") return;
                records.push(event.submission);
                await writeFile(join(fixture.home, "submitted.json"), JSON.stringify(records));
                if (event.submission.requestId === "durable-queue") {
                    queuedPrepared = true;
                    await hostWrite;
                }
            });
            fixture.provider.enqueue(
                { text: "Direct dispatch held.", hold: true },
                { text: "Queued dispatch complete." },
            );
            const direct = runtime.client.sendImages(
                runtime.binding(),
                "Original bootstrap.",
                [],
                "original-bootstrap",
            );
            await runtime.wait((view) => view.items.some((item) => item.text.includes("Direct dispatch held.")));
            equal(records[0].kind, "bootstrap");
            equal(records[0].expectedGeneration, 0);
            runtime.client.queue(runtime.binding(), {
                requestId: "durable-queue",
                text: "Original queue.",
                images: [],
            });
            fixture.provider.release();
            await direct;
            await waitForSession(() => queuedPrepared);
            equal(fixture.provider.requests.length, 1, "wire dispatch must wait for the real host's durable write");
            const queued = records[1];
            equal(queued.kind, "prompt");
            equal(queued.expectedGeneration, runtime.view().generation);
            const saved = await readFile(join(fixture.home, "submitted.json"), "utf8");
            ok(saved.includes('"requestId":"durable-queue"'));
            releaseWrite();
            await runtime.wait((view) => view.phase === "idle" && !view.queued?.length);
            equal(fixture.provider.requests.length, 2);
            const sessionId = runtime.view().durableSessionId;
            const bootstrap = await runtime.client.resolveSubmission({
                context,
                requestId: "original-bootstrap",
                kind: "bootstrap",
                expectedGeneration: 0,
            });
            equal(bootstrap.status, "accepted");
            equal(
                bootstrap.sessionId,
                sessionId,
                "bootstrap identity lookup discovers the durable Session without resending text",
            );
            const accepted = await runtime.client.resolveSubmission({
                context,
                sessionId,
                requestId: queued.requestId,
                kind: queued.kind,
                expectedGeneration: queued.expectedGeneration,
            });
            equal(accepted.status, "accepted");
            equal(accepted.outcome, "completed");
            const missing = await runtime.client.resolveSubmission({
                context,
                sessionId,
                requestId: "never-sent",
                kind: "prompt",
                expectedGeneration: queued.expectedGeneration,
            });
            equal(missing.status, "no_receipt");
            equal(fixture.provider.requests.length, 2, "receipt resolution is read-only");
            remove();
            await runtime.client.close(runtime.binding());
            await runtime.shutdown();
            const restarted = fixture.launch(true);
            const refreshed = (await restarted.client.openProject({ projectId })).context;
            equal(
                (
                    await restarted.client.resolveSubmission({
                        context: refreshed,
                        requestId: "original-bootstrap",
                        kind: "bootstrap",
                        expectedGeneration: 0,
                    })
                ).sessionId,
                sessionId,
            );
            equal(fixture.provider.requests.length, 2);
        } finally {
            await fixture.cleanup();
        }
    },
);

test(
    "event eviction advances a bounded observation cursor at unchanged length and keeps current question identity",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        try {
            const runtime = fixture.launch(true);
            const registration = await runtime.client.registerProject({ root: fixture.project });
            ok(registration.status === "ok");
            const { context } = await runtime.client.openProject({ projectId: registration.project.projectId });
            await runtime.client.create();
            fixture.provider.enqueue({ text: "Saved before eviction." });
            await runtime.client.send(runtime.binding(), "Committed before bounded events.");
            const sessionId = runtime.view().durableSessionId;
            fixture.provider.enqueue(
                { question: { type: "text", prompt: "Question survives eviction" }, hold: true },
                { text: "Question answered after eviction." },
            );
            const turn = runtime.client.send(runtime.binding(), "Evict live events, not history.");
            await waitForSession(() => fixture.provider.requests.length === 2);
            const emit = () => {
                for (let index = 0; index < 600; index++) {
                    fixture.provider.emit("live-text ");
                    fixture.provider.emitThinking("live-thought ");
                }
            };
            emit();
            let first = await runtime.client.snapshot({ context, sessionId });
            const deadline = Date.now() + 10000;
            while (Number(first.operation?.eventSequence || 0) < 1200 && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 10));
                first = await runtime.client.snapshot({ context, sessionId });
            }
            ok(Number(first.operation?.eventSequence) >= 1200, JSON.stringify(first.operation));
            ok(Array.isArray(first.operation?.events));
            const count = first.operation.events.length;
            equal(count, 500);
            const emitted = Number(first.operation.eventSequence);
            emit();
            let second = await runtime.client.snapshot({ context, sessionId, cursor: first.cursor });
            while (Number(second.operation?.eventEvictedThrough || 0) <= emitted && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 10));
                second = await runtime.client.snapshot({ context, sessionId, cursor: first.cursor });
            }
            ok(Number(second.operation?.eventEvictedThrough) > emitted);
            ok(Array.isArray(second.operation?.events));
            equal(second.operation.events.length, count, "length cannot detect this eviction");
            equal(second.generation, first.generation);
            equal(second.operation.operationId, first.operation.operationId);
            ok(second.cursor !== first.cursor, "the Core emitted sequence must advance at a fixed retained length");
            equal(second.gap, true);
            await runtime.client.stageConfiguration(runtime.binding(), { agentName: "router" });
            fixture.provider.release();
            await runtime.wait((view) => view.phase === "awaiting_answer");
            await runtime.client.reattachViews();
            const current = await runtime.client.snapshot({ context, sessionId, cursor: second.cursor });
            ok(current.operation?.liveInteraction);
            const question = runtime.view().question!;
            equal(question.prompt, "Question survives eviction");
            equal(runtime.view().pendingConfiguration?.agentName, "router");
            await runtime.client.answer(runtime.binding(), {
                requestId: question.requestId,
                action: "accept",
                answer: "Exact surviving answer",
            });
            await turn;
            await runtime.client.reattachViews();
            equal(runtime.view().items.filter((item) => item.text === "Evict live events, not history.").length, 1);
            equal(
                runtime.view().items.filter((item) => item.text.includes("Question answered after eviction.")).length,
                1,
            );
            equal(fixture.provider.requests.length, 3);
        } finally {
            await fixture.cleanup();
        }
    },
);

test(
    "steering receipts resolve after restart without converting the original input to a prompt",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        try {
            const runtime = fixture.launch(true);
            const registration = await runtime.client.registerProject({ root: fixture.project });
            ok(registration.status === "ok");
            const projectId = registration.project.projectId;
            const { context } = await runtime.client.openProject({ projectId });
            await runtime.client.create();
            fixture.provider.enqueue({ text: "Held for steering.", hold: true });
            const foreground = runtime.client.send(runtime.binding(), "Keep foreground live.");
            await runtime.wait((view) => view.items.some((item) => item.text.includes("Held for steering.")));
            const sessionId = runtime.view().durableSessionId;
            const prepared = await runtime.client.prepareSubmission(
                runtime.binding(),
                "Original steering.",
                [],
                "steer-once",
            );
            equal(prepared.kind, "steering");
            const identity = {
                context,
                sessionId,
                requestId: prepared.requestId,
                kind: prepared.kind,
                expectedGeneration: prepared.expectedGeneration,
            };
            equal((await runtime.client.resolveSubmission(identity)).status, "no_receipt");
            await runtime.client.submitPrepared(prepared);
            const accepted = await runtime.client.resolveSubmission(identity);
            equal(accepted.status, "accepted");
            equal(accepted.outcome, "completed");
            deepEqual(accepted.result, { ok: true, queued: true });
            equal(fixture.provider.requests.length, 1);
            const settlement = await runtime.client.drain();
            equal(settlement.status, "settled");
            await foreground;
            await runtime.shutdown();
            const restarted = fixture.launch(true);
            const refreshed = (await restarted.client.openProject({ projectId })).context;
            equal((await restarted.client.resolveSubmission({ ...identity, context: refreshed })).status, "accepted");
            equal(fixture.provider.requests.length, 1, "receipt resolution must not resend steering as a follow-up");
        } finally {
            await fixture.cleanup();
        }
    },
);

test(
    "unsettled canonical evidence survives drain retries and dispose leaves the connection open",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        try {
            const runtime = fixture.launch(true);
            const registration = await runtime.client.registerProject({ root: fixture.project });
            ok(registration.status === "ok");
            await runtime.client.openProject({ projectId: registration.project.projectId });
            await runtime.client.create();
            fixture.provider.enqueue({ text: "Saved before damaged evidence." });
            await runtime.client.send(runtime.binding(), "Preserve this work.");
            const sessionId = runtime.view().durableSessionId;
            await runtime.client.close(runtime.binding());
            const storeModule = fileURLToPath(new URL("../shared/owner-coordination/index.ts", import.meta.url));
            const damaged = spawnSync(
                fixture.bunExecutable,
                [
                    "-e",
                    `
            import { openOwnerCoordinationStore } from ${JSON.stringify(storeModule)};
            const store = openOwnerCoordinationStore();
            store.markSessionReconcileRequired({runwieldSessionId: ${JSON.stringify(sessionId)}, projectId: ${JSON.stringify(registration.project.projectId)}}, {reason: "test-interrupted-checkpoint"});
            store.close();
        `,
                ],
                { cwd: fixture.project, env: fixture.env, encoding: "utf8" },
            );
            equal(damaged.status, 0, damaged.stderr);
            equal((await runtime.client.drain()).status, "unsettled");
            equal(
                (await runtime.client.drain()).status,
                "unsettled",
                "a second empty Runtime snapshot is not settlement evidence",
            );
            await rejects(runtime.client.dispose(), /not settled/);
            equal(
                (await runtime.client.listProjects()).projects.length,
                1,
                "failed disposal must retain the live connection for recovery",
            );
        } finally {
            await fixture.cleanup();
        }
    },
);
