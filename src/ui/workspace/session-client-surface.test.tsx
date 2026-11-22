import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Window } from "happy-dom";
import { act } from "react";
import {
    launchContinuationOwner,
    makeSessionProcessFixture,
} from "../../acp/client/testing/session-process-fixture.ts";
import type { SessionProcess } from "../../acp/client/testing/session-process-fixture.ts";
import type { SessionClientView } from "./client/session-client.ts";

/** Only the browser environment is substituted. The client owns a real source CLI process. */
async function mountSurface(runtime: SessionProcess, saved = false) {
    const browser = new Window({ url: "http://localhost/session" });
    const globals = {
        window: browser,
        document: browser.document,
        navigator: browser.navigator,
        HTMLElement: browser.HTMLElement,
        HTMLInputElement: browser.HTMLInputElement,
        HTMLTextAreaElement: browser.HTMLTextAreaElement,
        HTMLButtonElement: browser.HTMLButtonElement,
        FormData: browser.FormData,
        FileReader: browser.FileReader,
        requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
        Event: browser.Event,
        SubmitEvent: browser.SubmitEvent,
        IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = new Map(
        Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
    );
    for (const [name, value] of Object.entries(globals)) {
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    const restore = async () => {
        try {
            await browser.happyDOM.close();
        } finally {
            for (const [name, descriptor] of previous) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            }
        }
    };
    try {
        // React DOM must detect the installed DOM, not the initial server environment.
        const { createRoot } = await import("react-dom/client");
        const { SessionClientSurface } = await import("./react/SessionClientSurface.tsx");
        const container = browser.document.createElement("div");
        browser.document.body.append(container);
        const root = createRoot(container);
        await act(() =>
            root.render(<SessionClientSurface client={runtime.client} projects={saved ? runtime.client : undefined} />),
        );
        const button = (label: string) => {
            const element = [...container.querySelectorAll("button")].find(
                (item) => (item.getAttribute("aria-label") || item.textContent) === label,
            );
            assert.ok(element, `Missing button: ${label}`);
            return element;
        };
        const field = (selector: string) => {
            const element = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
            assert.ok(element, `Missing field: ${selector}`);
            return element;
        };
        return {
            browser,
            container,
            button,
            field,
            async fill(selector: string, value: string) {
                const element = field(selector);
                const prototype =
                    element.tagName === "TEXTAREA"
                        ? browser.HTMLTextAreaElement.prototype
                        : browser.HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
                assert.ok(setter);
                await act(() => {
                    setter.call(element, value);
                    element.dispatchEvent(new browser.Event("input", { bubbles: true }));
                });
            },
            async click(label: string) {
                await act(() => button(label).click());
            },
            async waitFor(predicate: () => boolean) {
                const deadline = Date.now() + 10000;
                while (!predicate()) {
                    if (Date.now() > deadline)
                        throw new Error(container.querySelector('[role="alert"]')?.textContent || "DOM wait timed out");
                    await act(async () => {
                        await new Promise((resolve) => setTimeout(resolve, 10));
                    });
                }
            },
            async wait(predicate: (view: SessionClientView) => boolean) {
                await act(async () => {
                    await runtime.wait(predicate);
                    // Let operation continuations (composer/error state) settle with the observed update.
                    await new Promise((resolve) => setTimeout(resolve, 0));
                });
            },
            async cleanup() {
                try {
                    await act(() => root.unmount());
                } finally {
                    await restore();
                }
            },
        };
    } catch (error) {
        await restore();
        throw error;
    }
}

async function openSurface(runtime: SessionProcess) {
    const surface = await mountSurface(runtime);
    await surface.wait((view) => view.connection !== "connecting");
    assert.equal(runtime.view().connection, "ready", runtime.stderr());
    await surface.click("New Session");
    await surface.wait((view) => view.phase === "idle");
    return surface;
}

test("held output is visible while working, and close/load retains the conversation", { timeout: 60000 }, async () => {
    const fixture = await makeSessionProcessFixture();
    const runtime = fixture.launch();
    const surface = await openSurface(runtime);
    try {
        fixture.provider.enqueue({ text: "Visible before completion 482.", hold: true });
        assert.notEqual(runtime.child.pid, process.pid);
        await surface.fill("#session-message", "Remember cobalt-482.");
        assert.equal(surface.button("Send").disabled, false);
        await surface.click("Send");
        await surface.wait((view) => view.items.some((item) => item.text === "Visible before completion 482."));
        assert.match(surface.container.textContent, /Visible before completion 482\./);
        assert.match(surface.container.querySelector('[role="status"]')?.textContent ?? "", /Working/);
        assert.equal(surface.button("Stop").disabled, false);
        assert.equal(surface.button("Send").disabled, true);
        assert.equal(surface.field("#session-message").disabled, true);
        assert.equal(fixture.provider.requests.length, 1);
        assert.ok(fixture.provider.requests[0].raw.includes("Remember cobalt-482."));
        fixture.provider.release();
        await surface.wait((view) => view.phase === "idle");
        assert.match(surface.container.querySelector('[role="status"]')?.textContent ?? "", /Ready/);
        assert.equal(surface.button("Stop").disabled, true);
        const durable = runtime.view().durableSessionId;
        assert.ok(durable);
        await surface.click("Close Session");
        await surface.wait((view) => view.phase === "empty");
        assert.equal(surface.field("#saved-session-id").value, durable);
        await surface.click("Load");
        await surface.wait((view) => view.phase === "idle");
        assert.match(surface.container.textContent, /Remember cobalt-482\./);
        assert.match(surface.container.textContent, /Visible before completion 482\./);
        assert.equal(fixture.provider.requests.length, 1, "loading must not resubmit a prompt");
        assert.deepEqual(fixture.provider.failures, []);
    } finally {
        await surface.cleanup();
        await fixture.cleanup();
    }
});

test("Stop settles a held turn and enables the composer again", { timeout: 40000 }, async () => {
    const fixture = await makeSessionProcessFixture();
    const runtime = fixture.launch();
    const surface = await openSurface(runtime);
    try {
        fixture.provider.enqueue({ text: "Cancelable live output.", hold: true });
        await surface.fill("#session-message", "Start work to stop.");
        await surface.click("Send");
        await surface.wait((view) => view.items.some((item) => item.text === "Cancelable live output."));
        await surface.click("Stop");
        await surface.wait((view) => view.phase === "idle");
        assert.match(surface.container.querySelector('[role="status"]')?.textContent ?? "", /Ready/);
        assert.equal(surface.button("Stop").disabled, true);
        assert.equal(surface.field("#session-message").disabled, false);
        assert.match(surface.container.textContent, /Cancelable live output\./);
        assert.equal(fixture.provider.requests.length, 1);
    } finally {
        await surface.cleanup();
        await fixture.cleanup();
    }
});

test(
    "required question text rejects whitespace and sends the exact corrected answer to the provider",
    { timeout: 40000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        const runtime = fixture.launch();
        const surface = await openSurface(runtime);
        try {
            fixture.provider.enqueue(
                { question: { type: "text", prompt: "Enter the exact release name", allowEmpty: false } },
                { text: "Release name received." },
            );
            await surface.fill("#session-message", "Ask for the release name.");
            await surface.click("Send");
            await surface.wait((view) => view.phase === "awaiting_answer");
            assert.match(surface.container.textContent, /Answer needed/);
            assert.match(surface.container.textContent, /Enter the exact release name/);
            assert.equal(surface.button("Stop").disabled, false);
            await surface.fill('[name="answer"]', " \t\n ");
            await surface.click("Submit answer");
            assert.match(surface.container.querySelector('[role="alert"]')?.textContent ?? "", /An answer is required/);
            assert.equal(fixture.provider.requests.length, 1);
            assert.equal(runtime.view().phase, "awaiting_answer");
            assert.doesNotMatch(surface.container.textContent, /close this browser tab|waiting command|sign in/i);
            await surface.fill('[name="answer"]', "Exact release cobalt-731");
            await surface.click("Submit answer");
            await surface.wait((view) => view.phase === "idle");
            assert.match(surface.container.textContent, /Release name received\./);
            const results = fixture.provider.requests[1].messages.filter((message) => message.role === "tool");
            assert.equal(results.length, 1);
            assert.equal(typeof results[0].content, "string");
            const text = String(results[0].content);
            const marker = "interview_result_json:\n";
            assert.ok(text.includes(marker));
            interface InterviewResult {
                answers: { value: string }[];
            }
            const result = JSON.parse(text.slice(text.indexOf(marker) + marker.length)) as InterviewResult;
            assert.deepEqual(
                result.answers.map((answer) => answer.value),
                ["Exact release cobalt-731"],
            );
            assert.deepEqual(fixture.provider.failures, []);
        } finally {
            await surface.cleanup();
            await fixture.cleanup();
        }
    },
);

test(
    "missing provider shows the Core prerequisite without Workspace login instructions",
    { timeout: 40000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        await writeFile(
            join(fixture.home, ".wld", "settings.json"),
            JSON.stringify({ notifications: { enabled: false }, onboardingTutorialOfferHandled: true }),
        );
        await rm(join(fixture.home, ".wld", "models.json"));
        await rm(join(fixture.home, ".wld", "auth.json"));
        const runtime = fixture.launch();
        const surface = await mountSurface(runtime);
        try {
            await surface.wait((view) => view.connection === "ready");
            await surface.click("New Session");
            await surface.wait((view) => Boolean(view.error) || view.phase === "idle");
            if (runtime.view().phase === "idle") {
                await surface.fill("#session-message", "Needs a configured provider.");
                await surface.click("Send");
                await surface.wait((view) => Boolean(view.error));
            }
            const error = surface.container.querySelector('[role="alert"]')?.textContent ?? "";
            assert.match(error, /provider|model|API key/i);
            assert.doesNotMatch(surface.container.textContent, /sign in|log in|Workspace account/i);
            assert.equal(fixture.provider.requests.length, 0);
        } finally {
            await surface.cleanup();
            await fixture.cleanup();
        }
    },
);

test(
    "unexpected disconnect retains the draft and never resubmits the interrupted prompt",
    { timeout: 40000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        const runtime = fixture.launch();
        const surface = await openSurface(runtime);
        try {
            fixture.provider.enqueue({ text: "Output before runtime loss.", hold: true });
            const draft = "Never automatically resubmit cobalt-994.";
            await surface.fill("#session-message", draft);
            await surface.click("Send");
            await surface.wait((view) => view.items.some((item) => item.text === "Output before runtime loss."));
            await act(async () => {
                runtime.child.kill("SIGKILL");
                await runtime.wait((view) => view.connection === "disconnected");
                await new Promise((resolve) => setTimeout(resolve, 0));
            });
            assert.equal(runtime.view().phase, "interrupted");
            assert.match(surface.container.querySelector('[role="status"]')?.textContent ?? "", /Disconnected/);
            assert.ok(surface.container.querySelector('[role="alert"]')?.textContent);
            assert.match(surface.container.textContent, /Output before runtime loss\./);
            assert.equal(surface.field("#session-message").value, draft);
            assert.equal(surface.button("Send").disabled, true);
            assert.equal(surface.button("Stop").disabled, true);
            await surface.click("Send");
            assert.equal(fixture.provider.requests.length, 1);
            assert.equal(runtime.view().items.filter((item) => item.kind === "user" && item.text === draft).length, 1);
        } finally {
            await surface.cleanup();
            await fixture.cleanup();
        }
    },
);

test("an image read cannot cross a closed Session binding", { timeout: 40000 }, async () => {
    const fixture = await makeSessionProcessFixture();
    const runtime = fixture.launch(true);
    await runtime.wait((view) => view.connection === "ready");
    const registered = await runtime.client.registerProject({ root: fixture.project });
    assert.ok(registered.status === "ok");
    await runtime.client.openProject({ projectId: registered.project.projectId });
    const surface = await mountSurface(runtime, true);
    try {
        await surface.click("New Session");
        await surface.wait((view) => view.phase === "idle");
        let releaseRead = () => {};
        const gate = new Promise<void>((resolve) => {
            releaseRead = resolve;
        });
        let started = false;
        const RealReader = surface.browser.FileReader;
        class DelayedReader extends RealReader {
            readAsDataURL(file: Parameters<InstanceType<typeof RealReader>["readAsDataURL"]>[0]) {
                started = true;
                void gate.then(() => super.readAsDataURL(file));
            }
        }
        Object.defineProperty(globalThis, "FileReader", { configurable: true, value: DelayedReader });
        const input = surface.container.querySelector('input[type="file"]');
        assert.ok(input);
        Object.defineProperty(input, "files", {
            configurable: true,
            value: [new surface.browser.File(["image bytes"], "old.png", { type: "image/png" })],
        });
        await act(() => input.dispatchEvent(new surface.browser.Event("change", { bubbles: true })));
        assert.equal(started, true);
        await surface.click("Close Session");
        await surface.wait((view) => view.phase === "empty");
        await surface.click("New Session");
        await surface.wait((view) => view.phase === "idle");
        await surface.fill("#session-message", "New binding draft");
        await act(async () => {
            releaseRead();
            await new Promise((resolve) => setTimeout(resolve, 100));
        });
        assert.equal(surface.container.querySelector('[aria-label="Attached images"]'), null);
        assert.equal(surface.field("#session-message").value, "New binding draft");
        assert.equal(surface.container.querySelector('[role="alert"]'), null);
        assert.equal(fixture.provider.requests.length, 0);
        // Normal selection still uses the same real reader and handler.
        Object.defineProperty(globalThis, "FileReader", { configurable: true, value: RealReader });
        await act(() => input.dispatchEvent(new surface.browser.Event("change", { bubbles: true })));
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 100));
        });
        assert.match(surface.container.textContent || "", /old.png/);
        let failRead = () => {};
        const failureGate = new Promise<void>((resolve) => {
            failRead = resolve;
        });
        // File IO is an external boundary. Delay a browser read error across another binding.
        class FailedReader extends RealReader {
            readAsDataURL() {
                void failureGate.then(() => this.dispatchEvent(new surface.browser.ProgressEvent("error")));
            }
        }
        Object.defineProperty(globalThis, "FileReader", { configurable: true, value: FailedReader });
        await act(() => input.dispatchEvent(new surface.browser.Event("change", { bubbles: true })));
        await surface.click("Close Session");
        await surface.wait((view) => view.phase === "empty");
        await surface.click("New Session");
        await surface.wait((view) => view.phase === "idle");
        await act(async () => {
            failRead();
            await new Promise((resolve) => setTimeout(resolve, 100));
        });
        assert.equal(
            surface.container.querySelector('[role="alert"]'),
            null,
            "stale read errors do not enter a new Session",
        );
    } finally {
        await surface.cleanup();
        await fixture.cleanup();
    }
});

test(
    "saved Session commands execute without provider turns and preserve history and rejected drafts",
    { timeout: 40000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        await writeFile(
            join(fixture.home, ".wld", "agents", "engineer.md"),
            "---\nname: Engineer\ndescription: Command selection fixture\nsharedPractice: [user-authority]\ntools: []\n---\nFollow the user.\n",
        );
        const models = join(fixture.home, ".wld", "models.json");
        await writeFile(
            models,
            (await readFile(models, "utf8")).replace(
                '"models":[',
                '"models":[' +
                    JSON.stringify({
                        id: "fixture-alt",
                        name: "Alternate fixture",
                        api: "openai-completions",
                        reasoning: false,
                        input: ["text", "image"],
                        contextWindow: 128000,
                        maxTokens: 4096,
                    }) +
                    ",",
            ),
        );

        const runtime = fixture.launch(true);
        await runtime.wait((view) => view.connection === "ready");
        const registered = await runtime.client.registerProject({ root: fixture.project });
        assert.ok(registered.status === "ok");
        const { context } = await runtime.client.openProject({ projectId: registered.project.projectId });
        const surface = await mountSurface(runtime, true);
        try {
            await surface.click("New Session");
            await surface.wait((view) => view.phase === "idle");
            fixture.provider.enqueue({ text: "Keep command history.", hold: true });
            await surface.fill("#session-message", "Saved before commands.");
            await surface.click("Send");
            await surface.wait(
                (view) =>
                    view.phase === "streaming" &&
                    Boolean(view.operationId) &&
                    view.items.some((item) => item.text === "Keep command history."),
            );
            assert.equal(surface.button("Stop").disabled, false);
            fixture.provider.release();
            await surface.wait((view) => view.phase === "idle" && Boolean(view.durableSessionId) && !view.operationId);
            assert.equal(surface.button("Stop").disabled, true, "Core settlement disables Stop");
            assert.match(surface.container.querySelector('[role="status"]')?.textContent || "", /Ready/);
            const durable = runtime.view().durableSessionId;
            for (const command of ["/agent engineer", "/models fixture/fixture-alt"]) {
                await surface.fill("#session-message", command);
                await surface.waitFor(() => {
                    const send = surface.container.querySelector<HTMLButtonElement>(".session-send-button");
                    return send?.getAttribute("aria-label") === "Send" && !send.disabled;
                });
                await surface.click("Send");
                await surface.waitFor(() => surface.field("#session-message").value === "");
                assert.equal(fixture.provider.requests.length, 1);
            }
            assert.equal(runtime.view().configuration?.agentName.toLowerCase(), "engineer");
            assert.equal(runtime.view().configuration?.model, "fixture-alt");
            let history = await runtime.client.history({ context, sessionId: durable });
            for (const command of ["/help", "/context"]) {
                const before = runtime.view().items.filter((item) => item.kind === "system").length;
                await surface.fill("#session-message", command);
                await surface.click("Send");
                await surface.wait((view) => view.items.filter((item) => item.kind === "system").length > before);
                assert.equal(surface.field("#session-message").value, "");
                assert.equal(fixture.provider.requests.length, 1);
            }
            const contextMessage = runtime
                .view()
                .items.find((item) => item.kind === "system" && item.text.includes("Context Usage"));
            assert.ok(contextMessage);
            assert.match(contextMessage.text, /engineer/);
            assert.match(contextMessage.text, /fixture-alt/);
            const commandMessages = runtime.view().items.filter((item) => item.kind === "system");
            await act(() => runtime.client.stageConfiguration(runtime.binding(), { thinkingLevel: "off" }));
            assert.deepEqual(
                runtime.view().items.filter((item) => item.kind === "system"),
                commandMessages,
                "canonical refresh preserves local command output",
            );
            const refreshed = await runtime.client.history({ context, sessionId: durable });
            assert.deepEqual(
                refreshed.events.filter(
                    (event) => event.type === "user_message" || event.type === "assistant_text_delta",
                ),
                history.events.filter(
                    (event) => event.type === "user_message" || event.type === "assistant_text_delta",
                ),
            );
            history = refreshed;
            const options = await runtime.client.sessionOptions(context);
            assert.deepEqual(
                options.commands
                    .filter((command) => command.kind === "action")
                    .map((command) => command.name)
                    .sort(),
                ["agent", "context", "help", "model", "new"],
            );
            assert.ok(
                !runtime.view().items.find((item) => item.kind === "system" && /\n\s+settings\s/.test(item.text)),
                "help does not advertise unsupported actions",
            );
            await surface.fill("#session-message", "/settings");
            await surface.waitFor(() => {
                const send = surface.container.querySelector<HTMLButtonElement>(".session-send-button");
                return send?.getAttribute("aria-label") === "Send" && !send.disabled;
            });
            await surface.click("Send");
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 100));
            });
            assert.ok(surface.container.querySelector('[role="alert"]'));
            assert.equal(surface.field("#session-message").value, "/settings");
            assert.equal(fixture.provider.requests.length, 1);
            assert.equal(
                (await runtime.client.history({ context, sessionId: durable })).generation,
                history.generation,
            );
            await surface.fill("#session-message", "/new");
            const oldBinding = runtime.binding().sessionId;
            await surface.waitFor(() => {
                const send = surface.container.querySelector<HTMLButtonElement>(".session-send-button");
                return send?.getAttribute("aria-label") === "Send" && !send.disabled;
            });
            await surface.click("Send");
            await surface.wait((view) => view.phase === "idle" && view.sessionId !== oldBinding);
            assert.equal(runtime.view().durableSessionId, "");
            assert.equal(surface.field("#session-message").value, "");
            assert.equal(fixture.provider.requests.length, 1);
            assert.deepEqual((await runtime.client.history({ context, sessionId: durable })).events, history.events);
        } finally {
            await surface.cleanup();
            await fixture.cleanup();
        }
    },
);

test("standard text elicitation displays and submits its saved default", { timeout: 40000 }, async () => {
    const fixture = await makeSessionProcessFixture();
    const runtime = fixture.launch();
    const surface = await openSurface(runtime);
    try {
        fixture.provider.enqueue(
            { question: { type: "text", prompt: "Keep the default?", default: "Exact standard default" } },
            { text: "Default received." },
        );
        await surface.fill("#session-message", "Ask for a default.");
        await surface.click("Send");
        await surface.wait((view) => view.phase === "awaiting_answer");
        assert.equal(runtime.view().question!.defaultValue, "Exact standard default");
        assert.equal(surface.field('[name="answer"]').value, "Exact standard default");
        assert.match(surface.container.textContent, new RegExp(runtime.view().question!.interactionId));
        await surface.click("Submit answer");
        await surface.wait((view) => view.phase === "idle");
        const results = fixture.provider.requests[1].messages.filter((message) => message.role === "tool");
        assert.match(String(results[0].content), /Exact standard default/);
        assert.deepEqual(fixture.provider.failures, []);
    } finally {
        await surface.cleanup();
        await fixture.cleanup();
    }
});

test(
    "remote owner form displays default choice, descriptions and submits exact Other and approval",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        const owner = launchContinuationOwner(fixture);
        const runtime = fixture.launch(true);
        const registered = await runtime.client.registerProject({ root: fixture.project });
        assert.ok(registered.status === "ok");
        await runtime.client.openProject({ projectId: registered.project.projectId });
        const surface = await openSurface(runtime);
        try {
            fixture.provider.enqueue({ text: "Saved for UI questions." });
            await surface.fill("#session-message", "Save for owner.");
            await surface.click("Send");
            await surface.wait((view) => Boolean(view.durableSessionId) && view.phase === "idle");
            assert.equal(await owner.command("open", runtime.view().durableSessionId), "opened");
            for (const kind of ["select", "approval"] as const) {
                const waiting = owner.command("interaction", undefined, kind);
                await surface.wait((view) => view.phase === "awaiting_answer");
                assert.equal((surface.field('[value="approve"]') as HTMLInputElement).checked, true);
                assert.match(surface.container.textContent, /Owner choice description/);
                assert.equal(surface.field('[value="approve"]').required, true);
                assert.match(surface.container.textContent, new RegExp(runtime.view().question!.interactionId));
                if (kind === "select") {
                    await act(() => surface.field('[value="other"]').click());
                    assert.equal((surface.field('[value="other"]') as HTMLInputElement).checked, true);
                    assert.equal((surface.field('[value="approve"]') as HTMLInputElement).checked, false);
                    await surface.fill('[name="customAnswer"]', "Exact browser Other");
                }
                await surface.click("Submit answer");
                await surface.waitFor(
                    () => !surface.container.querySelector(".rw-question-error") && runtime.view().phase === "idle",
                );
                const result = JSON.parse(await waiting);
                if (kind === "select") {
                    assert.equal(result.outcome, "selected");
                    assert.equal(result.value, "other");
                    assert.equal(result.otherText, "Exact browser Other");
                } else {
                    assert.equal(result.outcome, "accepted");
                    assert.equal(result.value, true);
                    assert.equal(result.valueLabel, "Approve exactly");
                }
                await surface.wait((view) => view.phase === "idle");
            }
            assert.equal(fixture.provider.requests.length, 1);
            assert.equal(await owner.command("close"), "closed");
        } finally {
            await surface.cleanup();
            await owner.shutdown();
            await fixture.cleanup();
        }
    },
);

test("generation refresh retains paged history and the reader's position", { timeout: 60000 }, async () => {
    const fixture = await makeSessionProcessFixture();
    const runtime = fixture.launch(true);
    let surface: Awaited<ReturnType<typeof mountSurface>> | undefined;
    try {
        const registered = await runtime.client.registerProject({ root: fixture.project });
        assert.ok(registered.status === "ok");
        const { context } = await runtime.client.openProject({ projectId: registered.project.projectId });
        const seeded = spawnSync(
            fixture.bunExecutable,
            [
                fileURLToPath(new URL("../../shared/session/testing/history-runtime-process.ts", import.meta.url)),
                "seed",
                registered.project.projectId,
                "450",
            ],
            { cwd: fixture.project, env: fixture.env, encoding: "utf8" },
        );
        assert.equal(seeded.status, 0, seeded.stderr);
        const { sessionId }: { sessionId: string } = JSON.parse(seeded.stdout);
        await runtime.client.load(sessionId);
        surface = await mountSurface(runtime, true);
        await surface.waitFor(() => Boolean(surface!.container.textContent?.includes("History message 449.")));
        await surface.waitFor(() =>
            [...surface!.container.querySelectorAll("button")].some(
                (button) => button.textContent === "Load older history",
            ),
        );
        assert.doesNotMatch(surface.container.textContent, /History message 300\./);
        await surface.click("Load older history");
        await surface.waitFor(() => Boolean(surface!.container.textContent?.includes("History message 300.")));
        const panel = surface.container.querySelector<HTMLElement>('[aria-label="Conversation"]')!;
        // DOM geometry is a browser boundary; model a reader away from the live edge.
        Object.defineProperty(panel, "scrollHeight", { configurable: true, value: 5000 });
        Object.defineProperty(panel, "clientHeight", { configurable: true, value: 500 });
        panel.scrollTop = 123;
        await act(() => panel.dispatchEvent(new surface!.browser.Event("scroll")));
        const generation = runtime.view().generation!;
        await act(() =>
            runtime.client.configure({
                context,
                sessionId,
                requestId: "history-generation-change",
                expectedGeneration: generation,
                thinkingLevel: "off",
            }),
        );
        await surface.waitFor(
            () => runtime.view().generation! > generation && !surface!.button("Load older history").disabled,
        );
        // Wait for the surface's history refresh, not just the client's generation projection.
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 600));
        });
        assert.match(surface.container.textContent, /History message 300\./);
        assert.equal(panel.scrollTop, 123);
        await surface.click("Load older history");
        await surface.waitFor(() => Boolean(surface!.container.textContent?.includes("History message 100.")));
        assert.equal(surface.container.querySelector('[role="alert"]'), null);
        assert.equal(fixture.provider.requests.length, 0);
    } finally {
        await surface?.cleanup();
        await fixture.cleanup();
    }
});

test("parallel composers keep equal drafts isolated when a background send settles", { timeout: 60000 }, async () => {
    const fixture = await makeSessionProcessFixture();
    const runtime = fixture.launch(true);
    await runtime.wait((view) => view.connection === "ready");
    const registered = await runtime.client.registerProject({ root: fixture.project });
    assert.ok(registered.status === "ok");
    await runtime.client.openProject({ projectId: registered.project.projectId });
    await runtime.client.create();
    const first = runtime.binding();
    const surface = await mountSurface(runtime, true);
    try {
        fixture.provider.enqueue({ text: "First binding held.", hold: true });
        await surface.fill("#session-message", "Identical text must not clear another draft.");
        await surface.click("Send");
        await surface.wait((view) => view.items.some((item) => item.text === "First binding held."));
        await surface.click("New Session");
        await surface.wait((view) => view.phase === "idle" && view.sessionId !== first.sessionId);
        const second = runtime.binding();
        await surface.fill("#session-message", "Identical text must not clear another draft.");
        fixture.provider.release();
        await surface.wait(
            (view) => view.bindings?.find((binding) => binding.sessionId === first.sessionId)?.phase === "idle",
        );
        assert.equal(surface.field("#session-message").value, "Identical text must not clear another draft.");
        await act(() => runtime.client.load(first.sessionId));
        await surface.wait((view) => view.sessionId === first.sessionId);
        await surface.waitFor(() => surface.field("#session-message").value === "");
        await act(() => runtime.client.load(second.sessionId));
        assert.equal(surface.field("#session-message").value, "Identical text must not clear another draft.");
        assert.equal(runtime.view().bindings?.length, 2);
        assert.equal(fixture.provider.requests.length, 1);
    } finally {
        fixture.provider.release();
        try {
            await surface.cleanup();
        } finally {
            await fixture.cleanup();
        }
    }
});

test("first accepted held turn waits for committed history without a transient error", { timeout: 60000 }, async () => {
    const fixture = await makeSessionProcessFixture();
    const runtime = fixture.launch(true);
    const registered = await runtime.client.registerProject({ root: fixture.project });
    assert.ok(registered.status === "ok");
    await runtime.client.openProject({ projectId: registered.project.projectId });
    const surface = await mountSurface(runtime, true);
    const alerts: string[] = [];
    const views: SessionClientView[] = [];
    const stop = runtime.client.observe((view) => views.push(view));
    const observer = new surface.browser.MutationObserver(() => {
        for (const alert of surface.container.querySelectorAll('[role="alert"]')) alerts.push(alert.textContent || "");
    });
    observer.observe(surface.container, { subtree: true, childList: true, characterData: true });
    try {
        await surface.click("New Session");
        await surface.wait((view) => view.phase === "idle" && Boolean(view.sessionId));
        fixture.provider.enqueue({ text: "First accepted held response.", hold: true });
        await surface.fill("#session-message", "First accepted held prompt.");
        await surface.waitFor(() => !surface.button("Send").disabled);
        await surface.click("Send");
        await surface.wait((view) => view.items.some((item) => item.text === "First accepted held response."));
        assert.ok(runtime.view().durableSessionId);
        assert.equal(runtime.view().generation, null, "saved identity is not a committed generation");
        assert.equal(
            runtime.sentMethods.filter((method) => method === "_dev.runwield/workspace/sessions/history").length,
            0,
            "the surface must wait for committed evidence, not just the durable identity",
        );
        assert.deepEqual(alerts, []);
        fixture.provider.release();
        await surface.wait((view) => view.phase === "idle" && view.generation !== null);
        await surface.waitFor(() => runtime.sentMethods.includes("_dev.runwield/workspace/sessions/history"));
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 100));
        });
        const conversation = surface.container.querySelector('[aria-label="Conversation"]')!;
        for (const text of ["First accepted held prompt.", "First accepted held response."]) {
            assert.equal(
                conversation.textContent?.split(text).length,
                2,
                `${text} appears once after canonical refresh`,
            );
            for (const view of views) assert.ok(view.items.filter((item) => item.text === text).length <= 1);
        }
        assert.deepEqual(views.map((view) => view.error).filter(Boolean), []);
        assert.deepEqual(alerts, [], "no intermediate render may show a history error");
        assert.equal(fixture.provider.requests.length, 1);
    } finally {
        observer.disconnect();
        stop();
        fixture.provider.release();
        await surface.cleanup();
        await fixture.cleanup();
    }
});

test("a delayed history response cannot enter another selected Session", { timeout: 60000 }, async () => {
    const fixture = await makeSessionProcessFixture();
    const runtime = fixture.launch(true);
    let surface: Awaited<ReturnType<typeof mountSurface>> | undefined;
    try {
        const registered = await runtime.client.registerProject({ root: fixture.project });
        assert.ok(registered.status === "ok");
        await runtime.client.openProject({ projectId: registered.project.projectId });
        fixture.provider.enqueue(
            { text: "History only for the first binding." },
            { text: "History only for the second binding." },
        );
        await runtime.client.create();
        await runtime.client.send(runtime.binding(), "First binding prompt.");
        const first = runtime.binding();
        await runtime.client.create();
        await runtime.client.send(runtime.binding(), "Second binding prompt.");
        const second = runtime.binding();
        await runtime.client.load(first.sessionId);
        const delayed = runtime.delayNextResponse("_dev.runwield/workspace/sessions/history");
        surface = await mountSurface(runtime, true);
        await delayed.received;
        const secondHistory = runtime.delayNextResponse("_dev.runwield/workspace/sessions/history");
        await act(() => runtime.client.load(second.sessionId));
        await secondHistory.received;
        await act(async () => {
            secondHistory.release();
            await new Promise((resolve) => setTimeout(resolve, 100));
        });
        await surface.waitFor(() =>
            Boolean(surface!.container.textContent?.includes("History only for the second binding.")),
        );
        await act(async () => {
            delayed.release();
            await new Promise((resolve) => setTimeout(resolve, 100));
        });
        const conversation = surface.container.querySelector('[aria-label="Conversation"]')!;
        assert.doesNotMatch(conversation.textContent || "", /History only for the first binding|First binding prompt/);
        assert.equal(conversation.textContent?.split("History only for the second binding.").length, 2);
        assert.equal(surface.container.querySelector('[role="alert"]'), null);
        assert.equal(runtime.view().sessionId, second.sessionId);
        assert.equal(fixture.provider.requests.length, 2);
    } finally {
        await surface?.cleanup();
        await fixture.cleanup();
    }
});
