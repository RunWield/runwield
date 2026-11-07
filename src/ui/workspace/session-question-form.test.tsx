import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { Window } from "happy-dom";
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import type { SessionQuestionFields } from "./client/session-client.ts";
import { SessionQuestionForm } from "./components/SessionQuestionForm.tsx";

type QuestionProps = ComponentProps<typeof SessionQuestionForm>;

async function mountQuestion(props: QuestionProps) {
    const browser = new Window({
        url: "http://localhost/question",
        settings: { fetch: { disableSameOriginPolicy: true } },
    });
    const globals = {
        window: browser,
        document: browser.document,
        navigator: browser.navigator,
        HTMLElement: browser.HTMLElement,
        HTMLButtonElement: browser.HTMLButtonElement,
        HTMLInputElement: browser.HTMLInputElement,
        HTMLTextAreaElement: browser.HTMLTextAreaElement,
        FormData: browser.FormData,
        Event: browser.Event,
        SubmitEvent: browser.SubmitEvent,
        fetch: browser.fetch.bind(browser),
        IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = new Map(
        Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
    );
    for (const [name, value] of Object.entries(globals)) {
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(() => root.render(<SessionQuestionForm {...props} />));
    function button(label: string) {
        const result = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
        assert.ok(result, `Missing button: ${label}`);
        return result;
    }
    function field(name: string) {
        const result = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`);
        assert.ok(result, `Missing field: ${name}`);
        return result;
    }
    return {
        browser,
        container,
        button,
        field,
        async fill(name: string, value: string) {
            await act(() => {
                field(name).value = value;
                field(name).dispatchEvent(new Event("input", { bubbles: true }));
            });
        },
        async choose(value: string) {
            const choice = container.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`);
            assert.ok(choice, `Missing choice: ${value}`);
            await act(() => choice.click());
        },
        async submit(label = "Submit answer") {
            await act(async () => {
                button(label).click();
                await browser.happyDOM.waitUntilComplete();
            });
        },
        async cleanup() {
            await act(() => root.unmount());
            await browser.happyDOM.close();
            for (const [name, descriptor] of previous) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            }
        },
    };
}

for (const mode of ["approval", "select"] as const) {
    test(`raw ${mode} preserves the exact string choice and separate Other text`, async () => {
        const answers: SessionQuestionFields[] = [];
        const legacy: string[] = [];
        const fixture = await mountQuestion({
            mode,
            host: "embedded",
            options: [
                { value: "approve-once", label: "Approve once" },
                { value: "reject", label: "Reject" },
            ],
            onRawResponse: (response) => {
                answers.push(response);
            },
            onResponse: (response) => {
                legacy.push(response.outcome);
            },
        });
        try {
            await fixture.choose("approve-once");
            await fixture.fill("customAnswer", "  Only this operation.  ");
            await fixture.submit();
            assert.deepEqual(answers, [
                { action: "accept", answer: "approve-once", otherAnswer: "  Only this operation.  " },
            ]);
            assert.deepEqual(legacy, []);
            assert.match(fixture.container.textContent, /Answer sent\./);
            assert.doesNotMatch(fixture.container.textContent, /browser|tab|waiting command/i);
        } finally {
            await fixture.cleanup();
        }
    });
}

test("raw required text rejects whitespace and preserves the field for correction", async () => {
    const answers: SessionQuestionFields[] = [];
    const fixture = await mountQuestion({
        mode: "text",
        onRawResponse: (response) => {
            answers.push(response);
        },
    });
    try {
        await fixture.fill("answer", " \n\t ");
        await fixture.submit();
        assert.deepEqual(answers, []);
        assert.match(fixture.container.querySelector('[role="alert"]')?.textContent ?? "", /An answer is required/);
        assert.equal(fixture.button("Submit answer").disabled, false);
        await fixture.fill("answer", "  Keep these spaces  ");
        await fixture.submit();
        assert.deepEqual(answers, [{ action: "accept", answer: "  Keep these spaces  " }]);
    } finally {
        await fixture.cleanup();
    }
});

test("raw optional text accepts an empty answer without substituting the suggested value", async () => {
    const answers: SessionQuestionFields[] = [];
    const fixture = await mountQuestion({
        mode: "text",
        allowEmpty: true,
        value: "Suggested answer",
        onRawResponse: (response) => {
            answers.push(response);
        },
    });
    try {
        assert.equal(fixture.field("answer").value, "");
        assert.deepEqual(answers, []);
        await fixture.submit();
        assert.deepEqual(answers, [{ action: "accept", answer: "" }]);
    } finally {
        await fixture.cleanup();
    }
});

test("raw choices hide unsupported Other and never silently choose a default", async () => {
    const answers: SessionQuestionFields[] = [];
    const fixture = await mountQuestion({
        mode: "select",
        value: "first",
        allowOther: false,
        options: [
            { value: "first", label: "First" },
            { value: "second", label: "Second" },
        ],
        onRawResponse: (response) => {
            answers.push(response);
        },
    });
    try {
        assert.equal(fixture.container.querySelector('[name="customAnswer"]'), null);
        assert.equal(fixture.container.querySelector("input:checked"), null);
        await fixture.submit();
        assert.deepEqual(answers, []);
        // Also cover submit events that bypass native constraint validation (for example an embedded host).
        await act(() =>
            fixture.container
                .querySelector("form")
                ?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true })),
        );
        assert.deepEqual(answers, []);
        assert.match(fixture.container.textContent, /Choose an answer/);
        await fixture.choose("second");
        await fixture.submit();
        assert.deepEqual(answers, [{ action: "accept", answer: "second" }]);
    } finally {
        await fixture.cleanup();
    }
});

test("embedded cancellation bypasses required input and has no browser-tab instructions", async () => {
    const answers: SessionQuestionFields[] = [];
    const fixture = await mountQuestion({
        mode: "text",
        host: "embedded",
        onRawResponse: (response) => {
            answers.push(response);
        },
    });
    try {
        await fixture.submit("Cancel");
        assert.deepEqual(answers, [{ action: "cancel" }]);
        assert.doesNotMatch(fixture.container.textContent, /browser|tab|waiting command/i);
    } finally {
        await fixture.cleanup();
    }
});

test("embedded submission errors are visible, permit retry, and do not give browser-tab instructions", async () => {
    let attempts = 0;
    const fixture = await mountQuestion({
        mode: "text",
        host: "embedded",
        onRawResponse: () => {
            if (++attempts === 1) throw new Error("The runtime disconnected. Try again.");
        },
    });
    try {
        await fixture.fill("answer", "Keep working");
        await fixture.submit();
        assert.match(fixture.container.querySelector('[role="alert"]')?.textContent ?? "", /runtime disconnected/);
        assert.equal(fixture.field("answer").value, "Keep working");
        assert.equal(fixture.button("Submit answer").disabled, false);
        assert.doesNotMatch(fixture.container.textContent, /browser|tab|waiting command/i);
        await fixture.submit();
        assert.equal(attempts, 2);
        assert.match(fixture.container.textContent, /Answer sent/);
    } finally {
        await fixture.cleanup();
    }
});

for (const selected of ["approve", "decline"]) {
    test(`legacy approval callback keeps its ${selected} boolean conversion`, async () => {
        const responses: Parameters<NonNullable<QuestionProps["onResponse"]>>[0][] = [];
        const fixture = await mountQuestion({
            mode: "approval",
            onResponse: (response) => {
                responses.push(response);
            },
        });
        try {
            await fixture.choose(selected);
            await fixture.submit();
            assert.deepEqual(responses, [
                {
                    outcome: selected === "approve" ? "accepted" : "canceled",
                    value: selected === "approve",
                    valueLabel: selected === "approve" ? "Approve" : "Decline",
                },
            ]);
            assert.match(fixture.container.textContent, /You can close this tab/);
        } finally {
            await fixture.cleanup();
        }
    });
}

test("legacy select callback still substitutes trimmed Other text", async () => {
    const responses: Parameters<NonNullable<QuestionProps["onResponse"]>>[0][] = [];
    const fixture = await mountQuestion({
        onResponse: (response) => {
            responses.push(response);
        },
    });
    try {
        await fixture.choose("guide");
        await fixture.fill("customAnswer", "  A different route  ");
        await fixture.submit();
        assert.deepEqual(responses, [{ outcome: "selected", value: "A different route", valueLabel: "Other" }]);
    } finally {
        await fixture.cleanup();
    }
});

test("HTTP form still posts Other answer and reports rejection before retry", async () => {
    const requests: string[] = [];
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        requests.push(Buffer.concat(chunks).toString());
        response.writeHead(requests.length === 1 ? 409 : 200);
        response.end(requests.length === 1 ? "Question is not ready. Retry." : "Saved");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const fixture = await mountQuestion({
        action: `http://127.0.0.1:${address.port}/answer`,
        sessionId: "saved",
        questionId: "question",
    });
    try {
        await fixture.choose("guide");
        await fixture.fill("customAnswer", "  Other route  ");
        await fixture.submit();
        // The network response completes outside the click's React act scope.
        await act(async () => {
            for (let count = 0; !fixture.container.querySelector('[role="alert"]') && count < 100; count++) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
        });
        assert.match(fixture.container.textContent, /Question is not ready/);
        assert.match(requests[0], /name="answer"\r\n\r\nOther route/);
        await fixture.submit();
        await act(async () => {
            for (let count = 0; !fixture.container.querySelector(".rw-question-complete") && count < 100; count++) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
        });
        assert.equal(requests.length, 2);
        assert.match(fixture.container.textContent, /Answer saved\. You can close this tab/);
    } finally {
        await fixture.cleanup();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
});

for (const host of ["browser", "embedded"] as const) {
    test(`${host} question uses the correct heading level for its host`, async () => {
        const fixture = await mountQuestion({ mode: "text", host });
        try {
            const heading = fixture.container.querySelector("h1, h2");
            assert.equal(heading?.tagName, host === "embedded" ? "H2" : "H1");
            assert.equal(Boolean(fixture.container.querySelector(".kicker")), host === "browser");
        } finally {
            await fixture.cleanup();
        }
    });
}
