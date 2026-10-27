import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { type Component, Image } from "@earendil-works/pi-tui";
import { initRunWieldTheme } from "../theme/theme.js";
import { type KeybindingsContext, installKeybindings } from "./keybindings.ts";

import type { ImageAttachment } from "../../shared/session/types.js";

interface FixtureEditor extends Pick<
    KeybindingsContext["editor"],
    "handleInput" | "setText" | "getText" | "insertTextAtCursor"
> {
    isEditorEmpty?: () => boolean;
}

type FixturePreviewChild = Component | string;
type ContextOverrides = Partial<
    Omit<KeybindingsContext, "editor" | "tui" | "uiAPI" | "pastedImages" | "previewImages" | "generationGuard">
>;

interface FixturePreviewImages extends Pick<KeybindingsContext["previewImages"], "addChild" | "removeChild"> {
    children: FixturePreviewChild[];
}

interface FixtureStats {
    systemMessages: string[];
    originalInputs: string[];
    readonly renderCount: number;
    readonly text: string;
    readonly newlineCount: number;
    readonly toolToggles: number;
    readonly keyboardHelpRequests: number;
    readonly keyboardHelpHides: number;
    readonly thinkingCycles: number;
    readonly promptDismissals: number;
    readonly runtimeCancels: number;
    readonly resets: number;
    readonly invalidations: number;
    readonly dequeues: number;
    readonly recalls: number;
    dequeueResult: boolean;
}

interface FixtureContext extends Omit<
    KeybindingsContext,
    "editor" | "tui" | "uiAPI" | "previewImages" | "generationGuard"
> {
    editor: FixtureEditor;
    tui: Pick<KeybindingsContext["tui"], "requestRender">;
    uiAPI: Pick<KeybindingsContext["uiAPI"], "appendSystemMessage" | "toggleToolOutputsExpanded">;
    previewImages: FixturePreviewImages;
    generationGuard: Pick<KeybindingsContext["generationGuard"], "invalidateAll">;
    stats: FixtureStats;
}

type FixtureInstaller = (context: FixtureContext) => ReturnType<typeof installKeybindings>;
type FixtureKeybindingInstaller = typeof installKeybindings & FixtureInstaller;

// The partial editor fixture exposes a hook that is private in the SDK Editor type.
const installFixtureKeybindings = installKeybindings as FixtureKeybindingInstaller;

const RAW_KEY = {
    escape: "\x1b",
    ctrlC: "\x03",
    ctrlO: "\x0f",
    ctrlV: "\x16",
    shiftEnter: "\x1b[13;2u",
    altEnter: "\x1b[13;3u",
    backspace: "\x7f",
    shiftTab: "\x1b[Z",
    up: "\x1b[A",
};

function makeContext(overrides: ContextOverrides = {}): FixtureContext {
    const systemMessages: string[] = [];
    const originalInputs: string[] = [];
    let renderCount = 0;
    let text = "";
    let newlineCount = 0;
    let toolToggles = 0;
    let keyboardHelpRequests = 0;
    let keyboardHelpHides = 0;
    let thinkingCycles = 0;
    let promptDismissals = 0;
    let runtimeCancels = 0;
    let resets = 0;
    let invalidations = 0;
    let dequeues = 0;
    let recalls = 0;
    let pendingExit = false;
    let dequeueResult = false;

    const editor: FixtureEditor = {
        handleInput: (data: string) => originalInputs.push(data),
        setText: (value: string) => {
            text = value;
        },
        getText: () => text,
        insertTextAtCursor: (value: string) => {
            if (value === "\n") newlineCount++;
            else text += value;
        },
        isEditorEmpty: () => text.length === 0,
    };
    const previewImages: FixturePreviewImages = {
        children: [],
        addChild(child: FixturePreviewChild) {
            this.children.push(child);
        },
        removeChild(child: FixturePreviewChild) {
            const index = this.children.indexOf(child);
            if (index >= 0) this.children.splice(index, 1);
        },
    };
    const ctx: FixtureContext = {
        editor,
        tui: { requestRender: () => renderCount++ },
        uiAPI: {
            appendSystemMessage: (message: string) => systemMessages.push(message),
            toggleToolOutputsExpanded: () => {
                toolToggles++;
            },
        },
        pastedImages: [],
        previewImages,
        generationGuard: { invalidateAll: () => invalidations++ },
        cancelRuntimeSession: () => {
            runtimeCancels++;
            return false;
        },
        dismissActivePrompt: () => {
            promptDismissals++;
        },
        dequeueLastSubmission: () => {
            dequeues++;
            return dequeueResult;
        },
        recallQueuedSubmissionsToEditor: () => {
            recalls++;
        },
        forceResetUI: () => {
            resets++;
        },
        markCtrlCPendingExit: () => {
            pendingExit = true;
        },
        isCtrlCPendingExit: () => pendingExit,
        requestKeyboardHelp: () => {
            keyboardHelpRequests++;
        },
        hideKeyboardHelp: () => {
            keyboardHelpHides++;
        },
        cycleThinkingLevel: () => {
            thinkingCycles++;
        },
        readClipboardImage: () => Promise.resolve(null),
        stats: {
            systemMessages,
            originalInputs,
            get renderCount() {
                return renderCount;
            },
            get text() {
                return text;
            },
            get newlineCount() {
                return newlineCount;
            },
            get toolToggles() {
                return toolToggles;
            },
            get keyboardHelpRequests() {
                return keyboardHelpRequests;
            },
            get keyboardHelpHides() {
                return keyboardHelpHides;
            },
            get thinkingCycles() {
                return thinkingCycles;
            },
            get promptDismissals() {
                return promptDismissals;
            },
            get runtimeCancels() {
                return runtimeCancels;
            },
            get resets() {
                return resets;
            },
            get invalidations() {
                return invalidations;
            },
            get dequeues() {
                return dequeues;
            },
            get recalls() {
                return recalls;
            },
            set dequeueResult(value: boolean) {
                dequeueResult = value;
            },
        },
    };
    return Object.assign(ctx, overrides);
}

test("installKeybindings recalls queued submissions before Escape cancellation", async () => {
    let runtimeCancelCalls = 0;
    const events: string[] = [];
    const ctx = makeContext({
        recallQueuedSubmissionsToEditor: () => {
            events.push("recall");
            ctx.editor.setText("oldest\nnewest");
        },
        cancelRuntimeSession: () => {
            events.push("cancel");
            runtimeCancelCalls++;
            return true;
        },
    });
    installFixtureKeybindings(ctx);

    await ctx.editor.handleInput(RAW_KEY.escape);

    assertEquals(events, ["recall", "cancel"]);
    assertEquals(ctx.stats.text, "oldest\nnewest");
    assertEquals(ctx.stats.invalidations, 1);
    assertEquals(runtimeCancelCalls, 1);
    assertEquals(ctx.stats.resets, 1);
    assertEquals(ctx.stats.systemMessages, []);
    assertEquals(ctx.stats.renderCount, 1);
});

test("installKeybindings Ctrl+C clears input and pasted previews without cancelling runtime work", async () => {
    const ctx = makeContext();
    ctx.pastedImages.push({ base64: "a", mimeType: "image/png" });
    ctx.previewImages.children.push("preview");
    ctx.editor.setText("draft");
    installFixtureKeybindings(ctx);

    await ctx.editor.handleInput(RAW_KEY.ctrlC);

    assertEquals(ctx.stats.text, "");
    assertEquals(ctx.pastedImages, []);
    assertEquals(ctx.previewImages.children, []);
    assertEquals(ctx.stats.invalidations, 0);
    assertEquals(ctx.stats.promptDismissals, 0);
    assertEquals(ctx.stats.runtimeCancels, 0);
    assertEquals(ctx.stats.resets, 0);
});

test("installKeybindings toggles tool groups on Ctrl+O", async () => {
    const ctx = makeContext();
    installFixtureKeybindings(ctx);

    await ctx.editor.handleInput(RAW_KEY.ctrlO);

    assertEquals(ctx.stats.keyboardHelpRequests, 0);
    assertEquals(ctx.stats.toolToggles, 1);
    assertEquals(ctx.stats.renderCount, 1);
});

test("installKeybindings requests keyboard help only for exact empty-editor question mark", async () => {
    const ctx = makeContext();
    installFixtureKeybindings(ctx);

    await ctx.editor.handleInput("?");
    ctx.editor.setText("why");
    await ctx.editor.handleInput("?");
    ctx.editor.setText("");
    ctx.pastedImages.push({ base64: "a", mimeType: "image/png" });
    await ctx.editor.handleInput("?");
    ctx.pastedImages.length = 0;
    await ctx.editor.handleInput("??");

    assertEquals(ctx.stats.keyboardHelpRequests, 1);
    assertEquals(ctx.stats.originalInputs, ["?", "?", "??"]);
});

test("installKeybindings hides keyboard help on Esc and forwarded input", async () => {
    const ctx = makeContext();
    installFixtureKeybindings(ctx);

    await ctx.editor.handleInput(RAW_KEY.escape);
    await ctx.editor.handleInput("x");

    assertEquals(ctx.stats.keyboardHelpHides, 2);
    assertEquals(ctx.stats.originalInputs, ["x"]);
    assertEquals(ctx.stats.invalidations, 1);
});

test("installKeybindings handles newline, image removal, thinking cycle, queue recall, and fallback input", async () => {
    const ctx = makeContext();
    ctx.pastedImages.push({ base64: "a", mimeType: "image/png" });
    ctx.previewImages.children.push("preview");
    ctx.stats.dequeueResult = true;
    const original = installFixtureKeybindings(ctx);

    await ctx.editor.handleInput(RAW_KEY.shiftEnter);
    await ctx.editor.handleInput(RAW_KEY.altEnter);
    await ctx.editor.handleInput(RAW_KEY.backspace);
    await ctx.editor.handleInput(RAW_KEY.shiftTab);
    await ctx.editor.handleInput(RAW_KEY.up);
    await ctx.editor.handleInput("x");

    assertEquals(typeof original, "function");
    assertEquals(ctx.stats.newlineCount, 2);
    assertEquals(ctx.pastedImages, []);
    assertEquals(ctx.previewImages.children, []);
    assertEquals(ctx.stats.thinkingCycles, 1);
    assertEquals(ctx.stats.originalInputs, ["x"]);
});

test("installKeybindings checks editor emptiness through public getText", async () => {
    const ctx = makeContext();
    delete ctx.editor.isEditorEmpty;
    ctx.pastedImages.push({ base64: "a", mimeType: "image/png" });
    ctx.previewImages.children.push("preview");
    ctx.stats.dequeueResult = true;
    installFixtureKeybindings(ctx);

    await ctx.editor.handleInput(RAW_KEY.backspace);
    await ctx.editor.handleInput(RAW_KEY.up);

    assertEquals(ctx.pastedImages, []);
    assertEquals(ctx.previewImages.children, []);
    assertEquals(ctx.stats.dequeues, 1);
    assertEquals(ctx.stats.originalInputs, []);
});

test("installKeybindings asks dequeue callback for up-arrow even without submission queue", async () => {
    const ctx = makeContext();
    ctx.stats.dequeueResult = true;
    installFixtureKeybindings(ctx);

    await ctx.editor.handleInput(RAW_KEY.up);

    assertEquals(ctx.stats.dequeues, 1);
    assertEquals(ctx.stats.originalInputs, []);
});

test("installKeybindings previews pasted images before paste processing finishes", async () => {
    initRunWieldTheme();
    let finishPasteProcessing = () => {};
    const pasteProcessingDone = new Promise<void>((resolve) => {
        finishPasteProcessing = () => resolve(undefined);
    });
    const handled: ImageAttachment[] = [];
    const ctx = makeContext({
        readClipboardImage: () => Promise.resolve({ base64: "YQ==", mimeType: "image/png" }),
        handleImagePaste: async (image: ImageAttachment) => {
            handled.push(image);
            await pasteProcessingDone;
            Object.assign(image, { ref: "attachment:abc" });
            return image;
        },
    });
    installFixtureKeybindings(ctx);

    await ctx.editor.handleInput(RAW_KEY.ctrlV);

    assertEquals(handled, [{ base64: "YQ==", mimeType: "image/png" }]);
    assertEquals(ctx.pastedImages, [{ base64: "YQ==", mimeType: "image/png" }]);
    assertEquals(ctx.previewImages.children.length, 1);
    assertEquals(ctx.previewImages.children[0] instanceof Image, true);
    assertEquals(ctx.stats.renderCount, 1);

    finishPasteProcessing();
    await pasteProcessingDone;
    await Promise.resolve();
    assertEquals(ctx.pastedImages, [{ base64: "YQ==", mimeType: "image/png", ref: "attachment:abc" }]);
});

test("installKeybindings removes previews when handleImagePaste blocks", async () => {
    let finishPasteProcessing = () => {};
    const pasteProcessingDone = new Promise<null>((resolve) => {
        finishPasteProcessing = () => resolve(null);
    });
    const ctx = makeContext({
        readClipboardImage: () => Promise.resolve({ base64: "YQ==", mimeType: "image/png" }),
        handleImagePaste: () => pasteProcessingDone,
    });
    installFixtureKeybindings(ctx);

    await ctx.editor.handleInput(RAW_KEY.ctrlV);
    assertEquals(ctx.pastedImages, [{ base64: "YQ==", mimeType: "image/png" }]);
    assertEquals(ctx.previewImages.children.length, 1);

    finishPasteProcessing();
    await pasteProcessingDone;
    await Promise.resolve();
    assertEquals(ctx.pastedImages, []);
    assertEquals(ctx.previewImages.children, []);
    assertEquals(ctx.stats.renderCount, 2);
});

test("installKeybindings reports pasted image handler failures instead of throwing", async () => {
    const ctx = makeContext({
        readClipboardImage: () => Promise.resolve({ base64: "YQ==", mimeType: "image/png" }),
        handleImagePaste: () => Promise.reject(new Error("managed_unsupported")),
    });
    installFixtureKeybindings(ctx);

    await ctx.editor.handleInput(RAW_KEY.ctrlV);
    assertEquals(ctx.pastedImages, [{ base64: "YQ==", mimeType: "image/png" }]);
    assertEquals(ctx.previewImages.children.length, 1);

    await Promise.resolve();
    assertEquals(ctx.pastedImages, []);
    assertEquals(ctx.previewImages.children, []);
    assertEquals(ctx.stats.systemMessages, ["Cannot attach pasted image: managed_unsupported"]);
    assertEquals(ctx.stats.renderCount, 2);
});

test("Ctrl-V reports a missing image only when the explicit read returns no image", async () => {
    for (const image of [null, { base64: "YQ==", mimeType: "image/png" }]) {
        let missing = 0;
        const ctx = makeContext({
            readClipboardImage: () => Promise.resolve(image),
            onClipboardImageMissing: () => missing++,
        });
        installFixtureKeybindings(ctx);
        await ctx.editor.handleInput(RAW_KEY.ctrlV);
        assertEquals(missing, image ? 0 : 1);
        assertEquals(ctx.previewImages.children.length, image ? 1 : 0);
    }
});
