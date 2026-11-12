import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
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
            const savedId = await page.getByLabel("Saved Session ID").inputValue();
            ok(savedId);
            const prompt = "Remember native token amber-931 for continuation.";
            await page.getByLabel("Message", { exact: true }).fill(prompt);
            await page.getByRole("button", { name: "Send", exact: true }).click();
            const live = page.getByText("Native live first chunk.", { exact: true });
            await live.waitFor();
            const liveBox = await live.boundingBox();
            const conversationBox = await page.getByRole("region", { name: "Conversation", exact: true }).boundingBox();
            ok(
                liveBox &&
                    conversationBox &&
                    liveBox.y >= conversationBox.y &&
                    liveBox.y + liveBox.height <= conversationBox.y + conversationBox.height,
                "the latest streamed chunk is in the visible conversation viewport before completion",
            );
            equal(await page.getByRole("button", { name: "Send", exact: true }).isDisabled(), true);
            equal(await page.getByRole("button", { name: "Stop", exact: true }).isDisabled(), false);
            equal(fixture.provider.requests.length, 1);
            ok(JSON.stringify(fixture.provider.requests[0].messages).includes(prompt));
            equal(fixture.provider.requests[0].authorization, "Bearer fixture-key");
            fixture.provider.release();
            await page.getByText("Ready", { exact: true }).waitFor();
            await page.getByRole("button", { name: "Close Session", exact: true }).click();
            await page.getByText("No Session open", { exact: true }).waitFor();
            await desktop.close();
            const reopened = await launchDesktop(fixture);
            desktops.push(reopened);
            await reopened.page.getByLabel("Saved Session ID").fill(savedId);
            await reopened.page.getByRole("button", { name: "Load", exact: true }).click();
            await reopened.page.getByText("Ready", { exact: true }).waitFor();
            await reopened.page.getByText("Native live first chunk.", { exact: true }).waitFor();
            equal(await reopened.page.getByText(prompt, { exact: true }).count(), 1);
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
            const saved = await desktop.page.getByLabel("Saved Session ID").inputValue();
            await desktop.page.getByLabel("Message", { exact: true }).fill("Ask a question before closing.");
            await desktop.page.getByRole("button", { name: "Send", exact: true }).click();
            await desktop.page.getByRole("heading", { name: "Close while I wait", exact: true }).waitFor();
            await desktop.close();
            equal(
                fixture.provider.requests.length,
                1,
                "shutdown does not accept the question or call the provider again",
            );
            const reopened = await launchDesktop(fixture);
            desktops.push(reopened);
            await reopened.page.getByLabel("Saved Session ID").fill(saved);
            await reopened.page.getByRole("button", { name: "Load", exact: true }).click();
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
            process.kill(desktop.runtimePid, "SIGKILL");
            await page.getByText("Disconnected", { exact: true }).waitFor();
            equal(await page.getByRole("button", { name: "Send", exact: true }).isDisabled(), true);
            equal(await page.getByText("Ready", { exact: true }).count(), 0);
            equal(fixture.provider.requests.length, 1);
            equal(await page.getByLabel("Message", { exact: true }).inputValue(), "Do not replay this prompt.");
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
