import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { Image } from "@earendil-works/pi-tui";
import { initRunWieldTheme } from "../theme/theme.js";
import { installKeybindings } from "./keybindings.ts";

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

/**
 * @param {object} [overrides]
 * @returns {any}
 */
function makeContext(overrides = {}) {
    /** @type {string[]} */
    const systemMessages = [];
    /** @type {string[]} */
    const originalInputs = [];
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

    const editor = {
        handleInput: (/** @type {string} */ data) => originalInputs.push(data),
        setText: (/** @type {string} */ value) => {
            text = value;
        },
        getText: () => text,
        insertTextAtCursor: (/** @type {string} */ value) => {
            if (value === "\n") newlineCount++;
            else text += value;
        },
        isEditorEmpty: () => text.length === 0,
    };
    const previewImages = {
        children: /** @type {any[]} */ ([]),
        /** @param {any} child */
        addChild(child) {
            this.children.push(child);
        },
        /** @param {any} child */
        removeChild(child) {
            const index = this.children.indexOf(child);
            if (index >= 0) this.children.splice(index, 1);
        },
    };
    const ctx = {
        editor,
        tui: { requestRender: () => renderCount++ },
        uiAPI: {
            appendSystemMessage: (/** @type {string} */ message) => systemMessages.push(message),
            toggleToolOutputsExpanded: () => {
                toolToggles++;
            },
        },
        pastedImages: /** @type {any[]} */ ([]),
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
            /** @param {boolean} value */
            set dequeueResult(value) {
                dequeueResult = value;
            },
        },
    };
    return Object.assign(ctx, overrides);
}

test("installKeybindings recalls queued submissions before Escape cancellation", async () => {
    let runtimeCancelCalls = 0;
    /** @type {string[]} */
    const events = [];
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
    installKeybindings(ctx);

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
    installKeybindings(ctx);

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
    installKeybindings(ctx);

    await ctx.editor.handleInput(RAW_KEY.ctrlO);

    assertEquals(ctx.stats.keyboardHelpRequests, 0);
    assertEquals(ctx.stats.toolToggles, 1);
    assertEquals(ctx.stats.renderCount, 1);
});

test("installKeybindings requests keyboard help only for exact empty-editor question mark", async () => {
    const ctx = makeContext();
    installKeybindings(ctx);

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
    installKeybindings(ctx);

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
    const original = installKeybindings(ctx);

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
    installKeybindings(ctx);

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
    installKeybindings(ctx);

    await ctx.editor.handleInput(RAW_KEY.up);

    assertEquals(ctx.stats.dequeues, 1);
    assertEquals(ctx.stats.originalInputs, []);
});

test("installKeybindings previews pasted images before paste processing finishes", async () => {
    initRunWieldTheme();
    let finishPasteProcessing = () => {};
    const pasteProcessingDone = new Promise((resolve) => {
        finishPasteProcessing = () => resolve(undefined);
    });
    /** @type {any[]} */
    const handled = [];
    const ctx = makeContext({
        readClipboardImage: () => Promise.resolve({ base64: "YQ==", mimeType: "image/png" }),
        handleImagePaste: async (/** @type {any} */ image) => {
            handled.push(image);
            await pasteProcessingDone;
            Object.assign(image, { ref: "attachment:abc" });
            return image;
        },
    });
    installKeybindings(ctx);

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
    const pasteProcessingDone = new Promise((resolve) => {
        finishPasteProcessing = () => resolve(null);
    });
    const ctx = makeContext({
        readClipboardImage: () => Promise.resolve({ base64: "YQ==", mimeType: "image/png" }),
        handleImagePaste: () => pasteProcessingDone,
    });
    installKeybindings(ctx);

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
    installKeybindings(ctx);

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
        installKeybindings(ctx);
        await ctx.editor.handleInput(RAW_KEY.ctrlV);
        assertEquals(missing, image ? 0 : 1);
        assertEquals(ctx.previewImages.children.length, image ? 1 : 0);
    }
});
