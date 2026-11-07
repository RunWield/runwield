import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Window } from "happy-dom";
import { act } from "react";
import { makeSessionProcessFixture } from "../../acp/client/testing/session-process-fixture.ts";
import type { SessionProcess } from "../../acp/client/testing/session-process-fixture.ts";
import type { SessionClientView } from "./client/session-client.ts";

/** Only the browser environment is substituted. The client owns a real source CLI process. */
async function mountSurface(runtime: SessionProcess) {
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
        await act(() => root.render(<SessionClientSurface client={runtime.client} />));
        const button = (label: string) => {
            const element = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
            assert.ok(element, `Missing button: ${label}`);
            return element;
        };
        const field = (selector: string) => {
            const element = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
            assert.ok(element, `Missing field: ${selector}`);
            return element;
        };
        return {
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
