import { test } from "node:test";
import { equal, ok, rejects } from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openFileSessionStore } from "./file-session-store.ts";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { makeSessionProcessFixture, waitForSession } from "../../acp/client/testing/session-process-fixture.ts";

interface Reply {
    id: number;
    value: string;
}

test(
    "idle TUI and ACP owners continue the same durable Session and enforce writer exclusion",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        await writeFile(
            join(fixture.home, ".wld", "agents", "engineer.md"),
            "---\nname: Engineer\ndescription: Cross-owner fixture\nsharedPractice: [user-authority]\ntools: [user_interview, background_task, bash]\n---\nCROSS_OWNER_ENGINEER. Follow the user.\n",
        );
        const models = join(fixture.home, ".wld", "models.json");
        const alternate = {
            id: "fixture-alt",
            name: "Alternate fixture",
            api: "openai-completions",
            reasoning: false,
            input: ["text", "image"],
            contextWindow: 128000,
            maxTokens: 4096,
        };
        await writeFile(
            models,
            (await readFile(models, "utf8")).replace('"models":[', '"models":[' + JSON.stringify(alternate) + ","),
        );
        const png = {
            mimeType: "image/png",
            base64: (await readFile(new URL("../../ui/workspace/static/pwa/icon-192.png", import.meta.url))).toString(
                "base64",
            ),
        };
        function launchRuntimeProcess() {
            const pending = new Map<number, (reply: string) => void>();
            let sequence = 0;
            const child = spawn(
                fixture.bunExecutable,
                [fileURLToPath(new URL("./testing/continuation-runtime-process.ts", import.meta.url))],
                { cwd: fixture.project, env: fixture.env, stdio: ["pipe", "pipe", "pipe"] },
            );
            let stderr = "";
            child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
            createInterface({ input: child.stdout }).on("line", (line) => {
                if (!line.startsWith("RUNTIME:")) return;
                const reply: Reply = JSON.parse(line.slice(8));
                pending.get(reply.id)?.(reply.value);
                pending.delete(reply.id);
            });
            const command = (action: string, sessionId?: string, text?: string) =>
                new Promise<string>((resolve, reject) => {
                    const id = ++sequence;
                    const timer = setTimeout(() => reject(new Error(stderr || "Runtime command timed out")), 20000);
                    pending.set(id, (reply) => {
                        clearTimeout(timer);
                        resolve(reply);
                    });
                    child.stdin.write(JSON.stringify({ id, action, sessionId, text }) + "\n");
                });
            return { child, command };
        }
        const { child, command } = launchRuntimeProcess();
        const observer = launchRuntimeProcess();
        try {
            const desktop = fixture.launch(true);
            const registered = await desktop.client.registerProject({ root: fixture.project });
            ok(registered.status === "ok");
            const { context } = await desktop.client.openProject({ projectId: registered.project.projectId });
            await desktop.client.create();
            fixture.provider.enqueue({ text: "Desktop initial." });
            await desktop.client.sendImages(desktop.binding(), "Initial desktop token.", [png]);
            const durable = desktop.view().durableSessionId;
            equal(await command("open", durable), "opened");
            for (let index = 0; index < 3; index++) {
                fixture.provider.enqueue({ text: `Remote projection ${index}`, hold: true });
                const requestsBefore = fixture.provider.requests.length;
                const turn = command("prompt", undefined, `Projection turn ${index}`);
                await waitForSession(() => fixture.provider.requests.length > requestsBefore);
                await desktop.wait((view) => view.phase === "streaming" && Boolean(view.operationId));
                const observed = await observer.command("observe", durable, registered.project.projectId);
                ok(!observed.startsWith("error:"), observed);
                const active = JSON.parse(observed);
                equal(active.state, "active");
                equal(active.running, 1, "superseded projections must not remain running");
                fixture.provider.release();
                equal(await turn, "completed");
                // Skip the first idle read to prove that canonical supersession also drains the old projection.
                if (index === 0) continue;
                const idle = JSON.parse(await observer.command("observe", durable, registered.project.projectId));
                equal(idle.state, "idle");
                equal(idle.operation, null);
                equal(idle.running, 0, "canonical settlement drains remote projections");
                ok(idle.retained <= 128);
            }
            fixture.provider.enqueue({ text: "Desktop with idle TUI." });
            await desktop.client.send(desktop.binding(), "Continue while TUI is idle.");
            equal(await command("thinking"), "configured");
            equal(await command("configuration"), "configured");

            fixture.provider.enqueue({ text: "TUI held writer.", hold: true });
            const held = command("prompt", undefined, "TUI exact durable continuation.");
            await waitForSession(() => fixture.provider.requests.length === 6);
            await desktop.wait((view) => view.phase === "streaming");
            await rejects(
                desktop.client.configure({
                    context,
                    sessionId: durable,
                    requestId: "contended",
                    expectedGeneration: (await desktop.client.history({ context, sessionId: durable })).generation,
                    thinkingLevel: "off",
                }),
            );
            fixture.provider.release();
            equal(await held, "completed");
            await desktop.wait(
                (view) =>
                    view.phase === "idle" &&
                    view.items.some((item) => item.text.includes("TUI exact durable continuation.")),
            );
            const history = await desktop.client.history({ context, sessionId: durable });
            equal(history.configuration.thinkingLevel, "off");
            // A TUI continuation must retain the newer saved model.
            equal(history.configuration.model, "fixture-alt");
            equal(history.events.filter((event) => event.type === "user_message").length, 6);
            equal(desktop.view().durableSessionId, durable);
            equal(await command("configuration"), "configured");
            const configured = await desktop.client.history({ context, sessionId: durable });
            equal(configured.configuration.agentName.toLowerCase(), "engineer");
            equal(configured.configuration.model, "fixture-alt");
            fixture.provider.enqueue({ text: "Desktop after TUI." });
            await desktop.client.send(desktop.binding(), "Fresh generation after another owner.");
            equal(
                (await desktop.client.history({ context, sessionId: durable })).events.filter(
                    (event) => event.type === "user_message",
                ).length,
                7,
            );
            ok(fixture.provider.requests.at(-1)!.raw.includes('"model":"fixture-alt"'));
            ok(fixture.provider.requests.at(-1)!.raw.includes("CROSS_OWNER_ENGINEER"));
            fixture.provider.enqueue(
                { question: { type: "text", prompt: "Answer across the process boundary?" } },
                { text: "Cross-owner answer accepted." },
            );
            const questioned = command("prompt", undefined, "Ask from the TUI owner.");
            await desktop.wait((view) => view.phase === "awaiting_answer");
            await desktop.client.answer(desktop.binding(), {
                requestId: desktop.view().question!.requestId,
                action: "accept",
                answer: "Exact cross-owner answer.",
            });
            equal(await questioned, "completed");
            await desktop.wait(
                (view) =>
                    view.phase === "idle" &&
                    view.items.some((item) => item.text.includes("Cross-owner answer accepted.")),
            );
            ok(fixture.provider.requests.at(-1)!.raw.includes("Exact cross-owner answer."));
            fixture.provider.enqueue({ text: "TUI steering held.", hold: true }, { text: "Steered across owner." });
            const steered = command("prompt", undefined, "TUI work for remote steering.");
            const beforeSteer = fixture.provider.requests.length;
            await waitForSession(() => fixture.provider.requests.length > beforeSteer);
            await desktop.wait((view) => view.phase === "streaming");
            await desktop.client.send(desktop.binding(), "Cross-owner steering token.");
            fixture.provider.release();
            equal(await steered, "completed");
            ok(fixture.provider.requests.at(-1)!.raw.includes("Cross-owner steering token."));
            await desktop.wait((view) => view.phase === "idle");
            fixture.provider.enqueue({ text: "TUI cancel held.", hold: true });
            const canceled = command("prompt", undefined, "TUI work for remote Stop.");
            const beforeCancel = fixture.provider.requests.length;
            await waitForSession(() => fixture.provider.requests.length > beforeCancel);
            await desktop.wait((view) => view.phase === "streaming");
            await desktop.client.cancel(desktop.binding());
            equal(await canceled, "completed");
            await desktop.wait((view) => view.phase === "idle");
            equal(await command("roll"), "rolled");
            equal(await command("configuration"), "configured");
            await desktop.client.close(desktop.binding());
            await desktop.shutdown();
            const successor = fixture.launch(true);
            const successorContext = (await successor.client.openProject({ projectId: registered.project.projectId }))
                .context;
            await successor.client.load(durable);
            fixture.provider.enqueue({ text: "Successor image response." });
            await successor.client.sendImages(successor.binding(), "Image in successor segment.", [png]);
            const rolledHistory = await successor.client.history({ context: successorContext, sessionId: durable });
            const store = openFileSessionStore({ baseDir: join(fixture.home, ".wld", "sessions") });
            equal(store.listSessionTranscriptSegments(durable).length, 2);
            equal(
                rolledHistory.events.filter(
                    (event) => event.type === "user_message" && Array.isArray(event.images) && event.images.length > 0,
                ).length,
                2,
            );
            equal(new Set(rolledHistory.events.map((event) => event.eventId)).size, rolledHistory.events.length);
            store.close();
            ok(
                rolledHistory.events.some(
                    (event) =>
                        Array.isArray(event.images) &&
                        event.images.some(
                            (image) =>
                                image && typeof image === "object" && "base64" in image && image.base64 === png.base64,
                        ),
                ),
                "the image in the sealed segment remains visible",
            );
            equal(await command("close"), "closed");
        } finally {
            child.kill("SIGKILL");
            child.stdin.destroy();
            observer.child.kill("SIGKILL");
            observer.child.stdin.destroy();
            await fixture.cleanup();
        }
    },
);
