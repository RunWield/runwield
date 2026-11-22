import { test } from "node:test";
import { deepEqual, equal, match, ok } from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { makeSessionProcessFixture } from "../../acp/client/testing/session-process-fixture.ts";
import { openFileSessionStore } from "../../shared/session/file-session-store.ts";
import { launchDesktop } from "./testing/desktop-fixture.ts";

test(
    "Electron streams live source output, closes, reloads canonical history, and continues",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        const desktops: Awaited<ReturnType<typeof launchDesktop>>[] = [];
        try {
            fixture.provider.enqueue(
                { text: "Native context paragraph.\n\n".repeat(30) + "Native live first chunk.", hold: true },
                { text: "Native continuation complete." },
            );
            const desktop = await launchDesktop(fixture);
            desktops.push(desktop);
            const { page } = desktop;
            equal(page.url(), "runwield://app/");
            equal(
                await realpath(await desktop.application.evaluate(({ app }) => app.getPath("userData"))),
                await realpath(join(fixture.home, "electron-profile")),
            );
            deepEqual(
                await page.evaluate(() => ({
                    node: "process" in globalThis || "require" in globalThis,
                    ipc: "ipcRenderer" in globalThis,
                })),
                { node: false, ipc: false },
            );
            const sandbox = await desktop.application.evaluate(({ app }) => ({
                platform: process.platform,
                renderers: app
                    .getAppMetrics()
                    .filter((metric) => metric.type === "Tab")
                    .map((metric) => metric.sandboxed),
            }));
            ok(sandbox.renderers.length);
            if (sandbox.platform === "darwin" || sandbox.platform === "win32")
                ok(sandbox.renderers.every((value) => value === true));
            ok(desktop.runtimePid !== desktop.application.process().pid && desktop.runtimePid !== process.pid);
            await page.getByRole("button", { name: "New Session", exact: true }).click();
            await page.getByText("Ready", { exact: true }).waitFor();
            await page.waitForFunction(() => document.activeElement?.id === "session-message", undefined, {
                timeout: 2000,
            });
            equal(
                await page.getByLabel("Saved Session ID").inputValue(),
                "",
                "opening a composer does not save a Session",
            );
            const prompt = "Remember native token amber-931 for continuation.";
            await page.getByLabel("Message", { exact: true }).fill(prompt);
            await page.getByRole("button", { name: "Send", exact: true }).click();
            const live = page.getByText("Native live first chunk.", { exact: true });
            await live.waitFor();
            await page.waitForFunction(() => {
                const panel = document.querySelector('[aria-label="Conversation"]');
                const message = [...document.querySelectorAll(".session-client-conversation p")].find(
                    (element) => element.textContent === "Native live first chunk.",
                );
                const bounds = panel?.getBoundingClientRect();
                const content = message?.getBoundingClientRect();
                return bounds && content && content.top >= bounds.top && content.bottom <= bounds.bottom;
            });
            const liveBox = await live.boundingBox();
            const conversationBox = await page.getByRole("region", { name: "Conversation", exact: true }).boundingBox();
            ok(
                liveBox &&
                    conversationBox &&
                    liveBox.y >= conversationBox.y &&
                    liveBox.y + liveBox.height <= conversationBox.y + conversationBox.height,
                "the latest streamed chunk is in the visible conversation viewport before completion",
            );
            equal(await page.getByRole("button", { name: "Steer", exact: true }).isDisabled(), true);
            equal(await page.getByRole("button", { name: "Stop", exact: true }).isDisabled(), false);
            equal(fixture.provider.requests.length, 1);
            ok(JSON.stringify(fixture.provider.requests[0].messages).includes(prompt));
            equal(fixture.provider.requests[0].authorization, "Bearer fixture-key");
            fixture.provider.release();
            await page.getByText("Ready", { exact: true }).waitFor();
            await page.waitForFunction(() =>
                [...document.querySelectorAll("button")].some(
                    (button) => button.textContent === "Stop" && button.disabled,
                ),
            );
            for (const command of ["/help", "/context"]) {
                await page.getByLabel("Message", { exact: true }).fill(command);
                await page.getByRole("button", { name: "Send", exact: true }).click();
                await page.waitForFunction(
                    () => (document.querySelector("#session-message") as HTMLTextAreaElement)?.value === "",
                );
                equal(fixture.provider.requests.length, 1, "native commands do not create provider turns");
            }
            await page.getByText("Context Usage", { exact: false }).first().waitFor();
            const savedId = await page.getByLabel("Saved Session ID").inputValue();
            ok(savedId);
            await page.getByRole("button", { name: "Close Session", exact: true }).click();
            await page.getByText("No Session open", { exact: true }).waitFor();
            await desktop.close();
            const reopened = await launchDesktop(fixture);
            desktops.push(reopened);
            await reopened.page.getByLabel("Saved Session ID").fill(savedId);
            await reopened.page.getByRole("button", { name: "Load", exact: true }).click();
            await reopened.page.getByText("Ready", { exact: true }).waitFor();
            await reopened.page.getByText("Native live first chunk.", { exact: true }).waitFor();
            equal(
                await reopened.page
                    .getByRole("region", { name: "Conversation", exact: true })
                    .getByText(prompt, { exact: true })
                    .count(),
                1,
            );
            const canonicalId = await reopened.page.getByLabel("Saved Session ID").inputValue();
            await reopened.page
                .getByLabel("Message", { exact: true })
                .fill("Continue with the remembered native token.");
            await reopened.page.getByRole("button", { name: "Send", exact: true }).click();
            await reopened.page.getByText("Native continuation complete.", { exact: true }).waitFor();
            await reopened.page.getByText("Ready", { exact: true }).waitFor();
            const context = JSON.stringify(fixture.provider.requests[1].messages);
            ok(context.includes(prompt));
            ok(context.includes("Native live first chunk."));
            await reopened.close();
            const canonical = openFileSessionStore({ baseDir: join(fixture.home, ".wld", "sessions") });
            try {
                const saved = canonical.getSessionById(canonicalId);
                ok(saved);
                equal(saved.runwieldSessionId, canonicalId);
                const segment = canonical.getCurrentSessionSegment(canonicalId);
                ok(segment);
                const history = await readFile(segment.transcriptPath, "utf8");
                ok(history.includes(prompt));
                ok(history.includes("Native continuation complete."));
            } finally {
                canonical.close();
            }
            deepEqual(desktop.errors, []);
            deepEqual(reopened.errors, []);
            deepEqual(fixture.provider.failures, []);
        } finally {
            try {
                for (const desktop of desktops) await desktop.close();
            } finally {
                await fixture.cleanup();
            }
        }
    },
);

interface InterviewResult {
    answers: { value: string; otherText?: string }[];
}
for (const selection of [
    { label: "Friendly label", value: "precise-value", other: "" },
    { label: "Other", value: "other", other: "Native exact Other 731" },
]) {
    test(
        `Electron delivers ${selection.value} through the real interview and next provider request`,
        { timeout: 40000 },
        async () => {
            const fixture = await makeSessionProcessFixture();
            let desktop: Awaited<ReturnType<typeof launchDesktop>> | undefined;
            try {
                fixture.provider.enqueue(
                    {
                        question: {
                            type: "multiple_choice",
                            prompt: "Choose a native answer",
                            choices: [
                                { value: "precise-value", label: "Friendly label" },
                                { value: "second", label: "Second label" },
                            ],
                        },
                    },
                    { text: "Native answer received." },
                );
                desktop = await launchDesktop(fixture);
                const { page } = desktop;
                await page.getByRole("button", { name: "New Session", exact: true }).click();
                await page.getByText("Ready", { exact: true }).waitFor();
                await page.getByLabel("Message", { exact: true }).fill("Ask the native interview.");
                await page.getByRole("button", { name: "Send", exact: true }).click();
                await page.getByRole("heading", { name: "Choose a native answer", exact: true }).waitFor();
                await page.getByRole("radio", { name: selection.label, exact: true }).check();
                if (selection.other) await page.getByLabel("Other answer", { exact: true }).fill(selection.other);
                await page.getByRole("button", { name: "Submit answer", exact: true }).click();
                await page.getByText("Native answer received.", { exact: true }).waitFor();
                await page.getByText("Ready", { exact: true }).waitFor();
                equal(fixture.provider.requests.length, 2);
                const results = fixture.provider.requests[1].messages.filter((message) => message.role === "tool");
                equal(results.length, 1);
                const content = results[0].content;
                ok(typeof content === "string");
                const marker = "interview_result_json:\n";
                ok(content.includes(marker));
                const evidence: InterviewResult = JSON.parse(content.slice(content.indexOf(marker) + marker.length));
                equal(evidence.answers.length, 1);
                equal(evidence.answers[0].value, selection.value);
                equal(evidence.answers[0].otherText || "", selection.other);
                equal(await page.getByRole("heading", { name: "Choose a native answer", exact: true }).count(), 0);
                deepEqual(desktop.errors, []);
                deepEqual(fixture.provider.failures, []);
            } finally {
                try {
                    await desktop?.close();
                } finally {
                    await fixture.cleanup();
                }
            }
        },
    );
}

for (const pendingQuestion of [false, true]) {
    test(
        `Electron Stop settles ${pendingQuestion ? "a pending question" : "a held stream"} and accepts another prompt`,
        { timeout: 40000 },
        async () => {
            const fixture = await makeSessionProcessFixture();
            let desktop: Awaited<ReturnType<typeof launchDesktop>> | undefined;
            try {
                fixture.provider.enqueue(
                    pendingQuestion
                        ? { question: { type: "text", prompt: "Question to stop" } }
                        : { text: "Native held output.", hold: true },
                    { text: "Native next turn succeeded." },
                );
                desktop = await launchDesktop(fixture);
                const { page } = desktop;
                await page.getByRole("button", { name: "New Session", exact: true }).click();
                await page.getByText("Ready", { exact: true }).waitFor();
                await page.getByLabel("Message", { exact: true }).fill("Run work that I will stop.");
                await page.getByRole("button", { name: "Send", exact: true }).click();
                await page
                    .getByText(pendingQuestion ? "Question to stop" : "Native held output.", { exact: true })
                    .waitFor();
                await page.getByRole("button", { name: "Stop", exact: true }).click();
                await page.getByText("Ready", { exact: true }).waitFor();
                equal(await page.getByRole("button", { name: "Submit answer", exact: true }).count(), 0);
                equal(fixture.provider.requests.length, 1);
                await page.getByLabel("Message", { exact: true }).fill("Native next prompt.");
                await page.getByRole("button", { name: "Send", exact: true }).click();
                await page.getByText("Native next turn succeeded.", { exact: true }).waitFor();
                await page.getByText("Ready", { exact: true }).waitFor();
                equal(await page.getByText("Native next prompt.", { exact: true }).count(), 1);
                equal(fixture.provider.requests.length, 2);
                deepEqual(fixture.provider.failures, []);
                deepEqual(desktop.errors, []);
            } finally {
                try {
                    await desktop?.close();
                } finally {
                    await fixture.cleanup();
                }
            }
        },
    );
}

test(
    "closing the native application settles a pending question and preserves a loadable Session",
    { timeout: 40000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        const desktops: Awaited<ReturnType<typeof launchDesktop>>[] = [];
        try {
            fixture.provider.enqueue(
                { question: { type: "text", prompt: "Close while I wait" } },
                { text: "Continued after native shutdown." },
            );
            const desktop = await launchDesktop(fixture);
            desktops.push(desktop);
            await desktop.page.getByRole("button", { name: "New Session", exact: true }).click();
            await desktop.page.getByText("Ready", { exact: true }).waitFor();
            await desktop.page.getByLabel("Message", { exact: true }).fill("Ask a question before closing.");
            await desktop.page.getByRole("button", { name: "Send", exact: true }).click();
            await desktop.page.getByRole("heading", { name: "Close while I wait", exact: true }).waitFor();
            const saved = await desktop.page.getByLabel("Saved Session ID").inputValue();
            ok(saved);
            await desktop.close();
            equal(
                fixture.provider.requests.length,
                1,
                "shutdown does not accept the question or call the provider again",
            );
            const reopened = await launchDesktop(fixture);
            desktops.push(reopened);
            equal(await reopened.page.getByLabel("Saved Session ID").inputValue(), saved);
            await reopened.page.getByText("Ready", { exact: true }).waitFor();
            await reopened.page.getByLabel("Message", { exact: true }).fill("Continue after closing the globalThis.");
            await reopened.page.getByRole("button", { name: "Send", exact: true }).click();
            await reopened.page.getByText("Continued after native shutdown.", { exact: true }).waitFor();
            await reopened.page.getByText("Ready", { exact: true }).waitFor();
            deepEqual(reopened.errors, []);
            deepEqual(fixture.provider.failures, []);
        } finally {
            try {
                for (const desktop of desktops) await desktop.close();
            } finally {
                await fixture.cleanup();
            }
        }
    },
);

test(
    "native runtime death shows interruption without a success state or automatic resubmission",
    { timeout: 40000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        let desktop: Awaited<ReturnType<typeof launchDesktop>> | undefined;
        try {
            fixture.provider.enqueue({ text: "Output before runtime death.", hold: true });
            desktop = await launchDesktop(fixture);
            const { page } = desktop;
            await page.getByRole("button", { name: "New Session", exact: true }).click();
            await page.getByText("Ready", { exact: true }).waitFor();
            await page.getByLabel("Message", { exact: true }).fill("Do not replay this prompt.");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.getByText("Output before runtime death.", { exact: true }).waitFor();
            const savedId = await page.getByLabel("Saved Session ID").inputValue();
            process.kill(desktop.runtimePid, "SIGKILL");
            await page.getByText("Disconnected", { exact: true }).waitFor();
            equal(await page.getByRole("button", { name: "Send", exact: true }).isDisabled(), true);
            equal(await page.getByText("Ready", { exact: true }).count(), 0);
            equal(fixture.provider.requests.length, 1);
            equal(await page.getByLabel("Message", { exact: true }).inputValue(), "Do not replay this prompt.");
            const quitFailure = await desktop.application.evaluate(
                ({ app, dialog }) =>
                    new Promise<string>((resolve) => {
                        dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
                        dialog.showErrorBox = (title, message) => resolve(`${title}: ${message}`);
                        app.quit();
                    }),
            );
            match(quitFailure, /still open/i);
            process.kill(desktop.application.process().pid!, 0);
            await page.getByRole("button", { name: "Restart runtime", exact: true }).click();
            await page.waitForFunction(
                (savedId) => document.querySelector<HTMLInputElement>("#saved-session-id")?.value === savedId,
                savedId,
            );
            equal(await page.getByLabel("Saved Session ID").inputValue(), savedId);
            await page
                .getByRole("region", { name: "Conversation", exact: true })
                .getByText("Do not replay this prompt.", { exact: true })
                .waitFor();
            equal(fixture.provider.requests.length, 1, "runtime recovery reads history without sending input");
            await desktop.close();
        } finally {
            try {
                await desktop?.close();
            } finally {
                await fixture.cleanup();
            }
        }
    },
);

test(
    "native shared composer selects, pastes and drops bounded images and retains rejected drafts",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        let desktop: Awaited<ReturnType<typeof launchDesktop>> | undefined;
        try {
            fixture.provider.enqueue(
                { text: "Selected image received." },
                { text: "Pasted image received." },
                { text: "Dropped image received." },
            );
            desktop = await launchDesktop(fixture);
            const { page } = desktop;
            await page.getByRole("button", { name: "New Session", exact: true }).click();
            await page.getByText("Ready", { exact: true }).waitFor();
            const png = await readFile(new URL("../workspace/static/pwa/icon-192.png", import.meta.url));
            const input = page.locator('.session-composer input[type="file"]');
            await input.setInputFiles({ name: "selected.png", mimeType: "image/png", buffer: png });
            await page.getByRole("list", { name: "Attached images", exact: true }).getByRole("img").waitFor();
            equal(await page.getByLabel("Message", { exact: true }).inputValue(), "");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.getByText("Selected image received.", { exact: true }).waitFor();
            await page.getByText("Ready", { exact: true }).waitFor();
            ok(fixture.provider.requests[0].raw.includes("image_url"));
            await page.evaluate(
                (bytes) => {
                    const transfer = new DataTransfer();
                    transfer.items.add(new File([Uint8Array.from(bytes)], "pasted.png", { type: "image/png" }));
                    transfer.setData("text/plain", "Text accompanying paste.");
                    document
                        .getElementById("session-message")!
                        .dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: transfer }));
                },
                [...png],
            );
            await page.getByRole("list", { name: "Attached images", exact: true }).getByRole("img").waitFor();
            equal(await page.getByLabel("Message", { exact: true }).inputValue(), "Text accompanying paste.");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.getByText("Pasted image received.", { exact: true }).waitFor();
            await page.getByText("Ready", { exact: true }).waitFor();
            await page.evaluate(
                (bytes) => {
                    const transfer = new DataTransfer();
                    transfer.items.add(new File([Uint8Array.from(bytes)], "dropped.png", { type: "image/png" }));
                    document
                        .querySelector(".session-composer")!
                        .dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
                },
                [...png],
            );
            await page.getByRole("list", { name: "Attached images", exact: true }).getByRole("img").waitFor();
            await page.getByLabel("Message", { exact: true }).fill("Keep this draft and valid image.");
            await input.setInputFiles({
                name: "oversized.png",
                mimeType: "image/png",
                buffer: Buffer.alloc(7 * 1024 * 1024 + 1),
            });
            await page.getByRole("alert").filter({ hasText: "7 MiB" }).waitFor();
            equal(await page.getByLabel("Message", { exact: true }).inputValue(), "Keep this draft and valid image.");
            equal(await page.getByRole("list", { name: "Attached images", exact: true }).getByRole("img").count(), 1);
            await page.getByRole("button", { name: "Remove", exact: true }).click();
            equal(await page.getByRole("list", { name: "Attached images", exact: true }).count(), 0);
            await input.setInputFiles({ name: "replacement.png", mimeType: "image/png", buffer: png });
            await page.getByRole("list", { name: "Attached images", exact: true }).getByRole("img").waitFor();
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.getByText("Dropped image received.", { exact: true }).waitFor();
            await page.getByText("Ready", { exact: true }).waitFor();
            equal(fixture.provider.requests.length, 3);
            equal(fixture.provider.requests.filter((request) => request.raw.includes("image_url")).length, 3);
            deepEqual(fixture.provider.failures, []);
            deepEqual(desktop.errors, []);
        } finally {
            try {
                await desktop?.close();
            } finally {
                await fixture.cleanup();
            }
        }
    },
);

test(
    "native queue stays unsent during a question, supports edit and removal, then dispatches once",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        let desktop: Awaited<ReturnType<typeof launchDesktop>> | undefined;
        try {
            fixture.provider.enqueue(
                { question: { type: "text", prompt: "Answer before queued work" } },
                { text: "Question settled." },
                { text: "Queued follow-up ran." },
            );
            desktop = await launchDesktop(fixture);
            const { page } = desktop;
            await page.getByRole("button", { name: "New Session", exact: true }).click();
            await page.getByText("Ready", { exact: true }).waitFor();
            await page.getByLabel("Message", { exact: true }).fill("Ask before queue dispatch.");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.getByRole("heading", { name: "Answer before queued work", exact: true }).waitFor();
            await page.getByLabel("Message", { exact: true }).fill("A removable follow-up");
            await page.getByRole("button", { name: "Queue", exact: true }).click();
            const queue = page.getByRole("list", { name: "Unsent follow-ups", exact: true });
            await queue.getByText("A removable follow-up", { exact: true }).waitFor();
            equal(fixture.provider.requests.length, 1);
            await queue.getByRole("button", { name: "Edit", exact: true }).click();
            equal(await page.getByLabel("Message", { exact: true }).inputValue(), "A removable follow-up");
            await page.getByLabel("Message", { exact: true }).fill("Remove this edited follow-up");
            await page.getByRole("button", { name: "Queue", exact: true }).click();
            await queue.getByText("Remove this edited follow-up", { exact: true }).waitFor();
            await queue.getByRole("button", { name: "Remove queued message", exact: true }).click();
            await queue.waitFor({ state: "hidden" });
            await page.getByLabel("Message", { exact: true }).fill("Dispatch this exact queued follow-up once");
            await page.getByRole("button", { name: "Queue", exact: true }).click();
            await queue.getByText("Dispatch this exact queued follow-up once", { exact: true }).waitFor();
            await page.getByRole("textbox", { name: "Answer", exact: true }).fill("Exact native answer.");
            await page.getByRole("button", { name: "Submit answer", exact: true }).click();
            await page.getByText("Queued follow-up ran.", { exact: true }).waitFor();
            await page.getByText("Ready", { exact: true }).waitFor();
            equal(fixture.provider.requests.length, 3);
            const conversation = page.getByRole("region", { name: "Conversation", exact: true });
            equal(
                await conversation.getByText("Dispatch this exact queued follow-up once", { exact: true }).count(),
                1,
            );
            equal(await conversation.getByText("Remove this edited follow-up", { exact: true }).count(), 0);
            deepEqual(fixture.provider.failures, []);
            deepEqual(desktop.errors, []);
        } finally {
            try {
                await desktop?.close();
            } finally {
                await fixture.cleanup();
            }
        }
    },
);

test(
    "native configuration stages before creation and background Stop remains available after foreground return",
    { timeout: 60000 },
    async () => {
        const fixture = await makeSessionProcessFixture();
        let desktop: Awaited<ReturnType<typeof launchDesktop>> | undefined;
        try {
            fixture.provider.enqueue(
                { background: "sleep 30; printf 'must not continue\n'" },
                { text: "Foreground returned while background runs." },
            );
            desktop = await launchDesktop(fixture);
            const { page } = desktop;
            await page.getByRole("button", { name: "New Session", exact: true }).click();
            await page.getByText("Ready", { exact: true }).waitFor();
            await page.waitForFunction(
                () =>
                    !document.querySelector<HTMLSelectElement>('.session-composer select[aria-label="Agent"]')
                        ?.disabled,
            );
            await page.getByRole("combobox", { name: "Agent", exact: true }).selectOption("ideator");
            await page.waitForFunction(
                () =>
                    document.querySelector<HTMLSelectElement>('.session-composer select[aria-label="Agent"]')?.value ===
                    "ideator",
            );
            await page.getByRole("button", { name: "Session context", exact: true }).click();
            await page
                .getByRole("complementary", { name: "Session context" })
                .getByText("ideator", { exact: true })
                .waitFor();
            equal(
                await page.getByLabel("Saved Session ID").inputValue(),
                "",
                "staging choices must not save an empty Session",
            );
            await page.getByLabel("Message", { exact: true }).fill("Start background work with the chosen Agent.");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page
                .getByRole("region", { name: "Conversation", exact: true })
                .getByText("Foreground returned while background runs.", { exact: true })
                .waitFor();
            equal(fixture.provider.requests.length, 2);
            equal(await page.getByRole("button", { name: "Stop", exact: true }).isEnabled(), true);
            await page.getByRole("button", { name: "Stop", exact: true }).click();
            await page.getByText("Ready", { exact: true }).waitFor();
            await page.waitForFunction(() =>
                [...document.querySelectorAll<HTMLButtonElement>("button")].some(
                    (button) => button.textContent === "Stop" && button.disabled,
                ),
            );
            equal(await page.getByRole("button", { name: "Stop", exact: true }).isDisabled(), true);
            equal(fixture.provider.requests.length, 2);
            const tool = page.locator("details.session-tool").first();
            await tool.waitFor();
            await tool.evaluate((element) => element.setAttribute("data-retention-marker", "expanded-tool"));
            await tool.locator("summary").focus();
            await page.keyboard.press("Enter");
            equal(await tool.getAttribute("open"), "");
            fixture.provider.enqueue({ text: "Next committed turn preserves expanded evidence." });
            await page.getByLabel("Message", { exact: true }).fill("Continue without folding earlier evidence.");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.getByText("Next committed turn preserves expanded evidence.", { exact: true }).waitFor();
            await page.getByText("Ready", { exact: true }).waitFor();
            equal(await tool.getAttribute("data-retention-marker"), "expanded-tool");
            equal(await tool.getAttribute("open"), "");
            equal(fixture.provider.requests.length, 3);
            deepEqual(fixture.provider.failures, []);
            deepEqual(desktop.errors, []);
        } finally {
            try {
                await desktop?.close();
            } finally {
                await fixture.cleanup();
            }
        }
    },
);
