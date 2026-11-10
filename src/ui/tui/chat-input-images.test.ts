import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setCustomSetting } from "../../shared/settings.ts";
import { test } from "node:test";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { NO_OPEN_BROWSER_PORT } from "../../shared/browser-port.ts";
import { createChatView } from "./chat-view.ts";
import { createChatInputController } from "./chat-input-controller.ts";
import { createManagedSessionSyncController, SYSTEM_MANAGED_SESSION_TIMER } from "./managed-session-sync.ts";
import { VirtualTerminal } from "./testing/virtual-terminal.ts";

async function waitFor(check: () => boolean) {
    const deadline = Date.now() + 5000;
    while (!check()) {
        if (Date.now() > deadline) throw new Error("Input did not settle");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

async function createImageInput(projectRoot: string) {
    const runtime = createSessionRuntime();
    const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot });
    const terminal = new VirtualTerminal({ columns: 120, rows: 40 });
    const tui = new TuiAltScreen(terminal);
    const view = await createChatView({
        tui,
        browser: NO_OPEN_BROWSER_PORT,
        documentLinks: null,
        getSessionId: () => sessionId,
        sessionRuntime: runtime,
        suppressStartupHeader: true,
        setActiveModel: async (model, provider) => {
            await runtime.setSessionModel(sessionId, model, provider);
            return { status: "active" };
        },
    });
    const sync = createManagedSessionSyncController({
        runtime,
        getSessionId: () => sessionId,
        timer: SYSTEM_MANAGED_SESSION_TIMER,
    });
    const controller = createChatInputController({
        view,
        uiAPI: view.uiAPI,
        runtime,
        getSessionId: () => sessionId,
        getProjectRoot: () => projectRoot,
        managedSyncController: sync,
        shouldBlockForModelSetup: () => false,
        isModelSetupRecoveryCommand: () => false,
        isInitCommandAvailable: () => false,
        getPromptTemplateByName: () => new Map(),
        getSkills: () => [],
        sessionStartedAt: new Date().toISOString(),
        chatPromptAgentName: "operator",
        replaceRuntimeSession: () => {
            throw new Error("unexpected Session replacement");
        },
        markCtrlCPendingExit: () => {},
        isCtrlCPendingExit: () => false,
    });
    tui.start();
    view.focusEditor();
    return { runtime, sessionId, terminal, tui, view, sync, controller };
}

test("rejected image submissions preserve exact drafts and previews until a supported model sends them once", async () => {
    await withRuntimeCommandFixture("tui-image-rejection-", async ({ projectRoot, setModelResponseFactory }) => {
        const requests: string[] = [];
        setModelResponseFactory((context) => {
            requests.push(JSON.stringify(context.messages));
            return fauxAssistantMessage(fauxText("Image accepted."));
        });
        await setCustomSetting(
            "agents",
            { operator: { model: "agy-cli/gemini-3.8-flash" }, router: { model: "agy-cli/gemini-3.8-flash" } },
            "project",
            projectRoot,
        );
        const { runtime, sessionId, terminal, tui, view, sync, controller } = await createImageInput(projectRoot);
        try {
            const image = {
                base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                mimeType: "image/png",
            };
            view.addPastedImagePreview(image);
            const preflight = await runtime.preflightUserTurnImages(sessionId, {
                initialRequest: "inspect image",
                initialImages: [image],
            });
            assertEquals(
                preflight.ok,
                false,
                JSON.stringify({ preflight, snapshot: runtime.getSessionSnapshot(sessionId)?.activeModel }),
            );
            for (const draft of [
                "  keep exact draft  ",
                "",
                "   \t  ",
                "before\n" + "pasted content\n".repeat(25) + "after",
            ]) {
                view.editor.setText(draft);
                await Promise.resolve();
                const expectedDraft = view.editor.getExpandedText();
                const warnings = () =>
                    view.messageList.render(120).join("\n").split("do not support image attachments").length;
                const beforeWarnings = warnings();
                terminal.pressEnter();
                await waitFor(
                    () => warnings() > beforeWarnings && view.editor.getExpandedText() === expectedDraft,
                ).catch((error) => {
                    throw new Error(
                        `${error.message}: ${JSON.stringify({ draft, actual: view.editor.getExpandedText(), messages: view.messageList.render(120), model: runtime.getSessionSnapshot(sessionId)?.activeModel })}`,
                    );
                });
                assertEquals(view.editor.getExpandedText(), expectedDraft);
                assertEquals(view.pastedImages, [image]);
                assertEquals(view.previewImages.children.length > 0, true);
                assertEquals(requests.length, 0);
                assertStringIncludes(view.messageList.render(120).join("\n"), "image");
            }
            view.editor.setText("");
            terminal.input("\x7f");
            assertEquals(view.pastedImages, []);
            assertEquals(view.previewImages.children.length, 0);
            view.addPastedImagePreview(image);
            await setCustomSetting(
                "agents",
                {
                    operator: { model: "runtime-command-fixture/fixture-model" },
                    router: { model: "runtime-command-fixture/fixture-model" },
                },
                "project",
                projectRoot,
            );
            await runtime.setSessionModel(sessionId, "fixture-model", "runtime-command-fixture");
            view.editor.setText("describe corrected image");
            terminal.pressEnter();
            await waitFor(() => requests.length === 1 && !controller.isProcessingSubmission());
            assertStringIncludes(requests[0], "describe corrected image");
            assertStringIncludes(requests[0], "image/png");
            assertEquals(view.pastedImages, []);
            assertEquals(view.editor.getText(), "");
        } finally {
            await controller.dispose();
            await sync.dispose();
            view.dispose();
            tui.stop();
            await runtime.closeAllSessionsWhenIdle();
        }
    });
});

test("rejected image steering restores the draft and preview without queuing another turn", async () => {
    await withRuntimeCommandFixture(
        "tui-image-steering-rejection-",
        async ({ projectRoot, homeDir, setModelResponseFactories }) => {
            const modelsPath = join(homeDir, ".wld", "models.json");
            const models = JSON.parse(await readFile(modelsPath, "utf8"));
            models.providers["runtime-command-fixture"].models[0].input = ["text"];
            await writeFile(modelsPath, JSON.stringify(models));
            const entered = Promise.withResolvers<void>();
            const release = Promise.withResolvers<void>();
            const requests: string[] = [];
            const modelInputs: string[][] = [];
            setModelResponseFactories([
                async (context, options, _state, model) => {
                    modelInputs.push(model.input);
                    requests.push(JSON.stringify(context.messages));
                    options?.signal?.addEventListener("abort", () => release.resolve(), { once: true });
                    entered.resolve();
                    await release.promise;
                    return fauxAssistantMessage(fauxText("Initial request finished."));
                },
                (context) => {
                    requests.push(JSON.stringify(context.messages));
                    return fauxAssistantMessage(fauxText("Corrected image accepted."));
                },
            ]);
            const { runtime, sessionId, terminal, tui, view, sync, controller } = await createImageInput(projectRoot);
            try {
                view.editor.setText("Start the first request");
                terminal.pressEnter();
                await entered.promise;
                assertEquals(runtime.getSessionSnapshot(sessionId)?.busy, true);
                const image = {
                    base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                    mimeType: "image/png",
                };
                const draft = "  revise after inspecting this image  ";
                view.addPastedImagePreview(image);
                view.editor.setText(draft);
                terminal.pressEnter();
                await waitFor(
                    () =>
                        view.messageList.render(120).join("\n").includes("model setup is not ready") &&
                        view.editor.getExpandedText() === draft,
                ).catch((error) => {
                    throw new Error(
                        `${error.message}: ${JSON.stringify({ modelInputs, draft: view.editor.getExpandedText(), images: view.pastedImages, queue: runtime.getQueuedMessages(sessionId), messages: view.messageList.render(120) })}`,
                    );
                });
                assertEquals(modelInputs, [["text"]]);
                assertEquals(view.pastedImages, [image]);
                assertEquals(view.previewImages.children.length > 0, true);
                assertEquals(runtime.getQueuedMessages(sessionId), []);
                assertEquals(requests.length, 1);
                release.resolve();
                await waitFor(
                    () => !runtime.getSessionSnapshot(sessionId)?.busy && !controller.isProcessingSubmission(),
                );
                assertEquals(requests.length, 1, "Rejected steering must not fall back to a queued model turn");
                assertEquals(view.editor.getExpandedText(), draft);
                assertEquals(view.pastedImages, [image]);
                // After the running turn settles, choose a vision-capable model through
                // the real registry and Session model setting, then retry the same draft.
                models.providers["runtime-command-fixture"].models[0].input = ["text", "image"];
                await writeFile(modelsPath, JSON.stringify(models));
                const { getModelRegistry } = await import("../../shared/models/model-registry.ts");
                await getModelRegistry().refresh();
                await runtime.setSessionModel(sessionId, "fixture-model", "runtime-command-fixture");
                terminal.pressEnter();
                await waitFor(() => requests.length === 2 && !controller.isProcessingSubmission());
                assertStringIncludes(requests[1], draft.trim());
                assertStringIncludes(requests[1], "image/png");
                assertEquals(view.editor.getText(), "");
                assertEquals(view.pastedImages, []);
                assertEquals(runtime.getQueuedMessages(sessionId), []);
            } finally {
                release.resolve();
                await controller.dispose();
                await sync.dispose();
                view.dispose();
                tui.stop();
                await runtime.closeAllSessionsWhenIdle();
            }
        },
    );
});
