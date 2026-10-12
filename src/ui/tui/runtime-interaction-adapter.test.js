import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { NO_OPEN_BROWSER_PORT } from "../../shared/browser-port.ts";
import { createTuiInteractionAdapter as createAdapter } from "./runtime-interaction-adapter.js";
import { getStoredPlanPath, savePlan } from "../../plan-store.js";
import { createScriptedReviewBrowser } from "../review/review-test-fixture.ts";
import { RuntimeInteractionTypes } from "../../shared/session/session-runtime-interactions.js";

/** @param {import('./types.js').UiAPI} uiAPI */
function createTuiInteractionAdapter(uiAPI) {
    return createAdapter(uiAPI, { browser: NO_OPEN_BROWSER_PORT });
}

/**
 * @typedef {Object} ReviewUiState
 * @property {boolean[]} [busyValues]
 * @property {string[]} [outputs]
 * @property {boolean[]} [ended]
 */
/**
 * @param {string | null} selection
 * @param {ReviewUiState} [state]
 */
function makeUi(selection, state = {}) {
    return /** @type {any} */ ({
        promptSelect: () => Promise.resolve(selection),
        promptText: () => Promise.resolve(null),
        setBusy: (/** @type {boolean} */ busy) => state.busyValues?.push(busy),
        startToolExecution: () => ({
            setOutput: (/** @type {string} */ text) => state.outputs?.push(text),
            endExecution: (/** @type {boolean} */ error) => state.ended?.push(error),
            startTime: 0,
        }),
    });
}

Deno.test("TUI Plan review resumes progress after feedback and review failures", async () => {
    const cwd = await Deno.makeTempDir({ prefix: "runwield-review-progress-" });
    const busyValues = /** @type {boolean[]} */ ([]);
    const scripted = createScriptedReviewBrowser("deny", { feedback: "Add a test" });
    const adapter = createAdapter(makeUi(null, { busyValues }), { browser: scripted.browser });
    try {
        await savePlan(cwd, "plan", "# Plan\n\nDo the work.\n", {
            classification: "PLANNED_CHANGE",
            status: "draft",
        });
        const request = {
            type: RuntimeInteractionTypes.PLAN_REVIEW,
            prompt: "Review the Plan",
            _meta: { cwd, planName: "plan", planPath: getStoredPlanPath(cwd, "plan") },
        };
        const response = await adapter.requestInteraction(request);
        assertEquals(response.outcome, "selected");
        assertEquals(response._meta?.feedback, "Add a test");
        assertEquals(busyValues, [false, true]);

        await Deno.remove(request._meta.planPath);
        await assertRejects(async () => await adapter.requestInteraction(request));
        assertEquals(busyValues, [false, true, false, true]);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("TUI interaction adapter closes a question answered on another surface", async () => {
    let resolvePrompt = /** @type {(value: string | null) => void} */ (() => {});
    let promptClosed = false;
    const uiAPI = /** @type {any} */ ({
        promptSelect: () => new Promise((resolve) => resolvePrompt = resolve),
        promptText: () => Promise.resolve(null),
        abortActivePrompt: () => {
            promptClosed = true;
            resolvePrompt(null);
        },
    });
    const adapter = createTuiInteractionAdapter(uiAPI);
    const controller = new AbortController();
    const responsePromise = adapter.requestInteraction({
        type: "select",
        prompt: "Pick",
        options: [{ value: "valid", label: "Valid" }],
    }, controller.signal);

    controller.abort();
    await Promise.resolve();

    assertEquals(promptClosed, true);
    assertEquals((await responsePromise).outcome, "canceled");
});

Deno.test("TUI interaction adapter rejects invalid selected options", async () => {
    const adapter = createTuiInteractionAdapter(makeUi("invalid"));
    const response = await adapter.requestInteraction({
        type: "select",
        prompt: "Pick",
        options: [{ value: "valid", label: "Valid" }],
    });

    assertEquals(response.outcome, "unsupported");
    assertEquals(response.message, "Select prompt returned invalid option: invalid");
});

Deno.test("TUI interaction adapter maps declined approval choices to canceled outcome", async () => {
    const adapter = createTuiInteractionAdapter(makeUi("deny"));
    const response = await adapter.requestInteraction({
        type: "approval",
        prompt: "Approve?",
        options: [{ value: "approve", label: "Approve" }, { value: "deny", label: "Deny" }],
    });

    assertEquals(response.outcome, "canceled");
    assertEquals(response.value, false);
});

Deno.test("TUI interaction adapter does not auto-accept arbitrary single approval options", async () => {
    const adapter = createTuiInteractionAdapter(makeUi("deny"));
    const response = await adapter.requestInteraction({
        type: "approval",
        prompt: "Approve?",
        options: [{ value: "deny", label: "Deny" }],
    });

    assertEquals(response.outcome, "canceled");
    assertEquals(response.value, false);
});

Deno.test("TUI interaction adapter maps approval prompts to accepted outcome", async () => {
    const adapter = createTuiInteractionAdapter(makeUi("approve"));
    const response = await adapter.requestInteraction({
        type: "approval",
        prompt: "Approve?",
        options: [{ value: "approve", label: "Approve" }],
    });

    assertEquals(response.outcome, "accepted");
    assertEquals(response.value, true);
});

Deno.test("TUI interaction adapter advertises browser-backed review capabilities", () => {
    const adapter = createTuiInteractionAdapter(makeUi(null));

    assertEquals(adapter.supportsInteraction?.("pair_checkpoint"), false);
    assertEquals(adapter.supportsInteraction?.("plan_deviation_confirmation"), true);
    assertEquals(adapter.supportsInteraction?.("artifact_review"), true);
    assertEquals(adapter.supportsInteraction?.("select"), false);
    assertEquals(adapter.supportsInteraction?.("text"), false);
});

Deno.test("TUI interaction adapter confirms Plan Deviations explicitly", async () => {
    let prompt = "";
    let options = /** @type {Array<{ value: string, label: string }>} */ ([]);
    const adapter = createTuiInteractionAdapter(
        /** @type {any} */ ({
            promptSelect: (
                /** @type {string} */ value,
                /** @type {Array<{ value: string, label: string }>} */ promptOptions,
            ) => {
                prompt = value;
                options = promptOptions;
                return Promise.resolve("confirm");
            },
            promptText: () => Promise.resolve(null),
        }),
    );

    const response = await adapter.requestInteraction({
        type: "plan_deviation_confirmation",
        prompt: [
            "Confirm this Plan Deviation before I treat it as authority.",
            "Superseded requirement: Replace nav.",
            "Replacement requirement: Keep nav.",
            "Confirmed text will be saved in the Plan and Work Record.",
        ].join("\n"),
        options: [
            { value: "confirm", label: "Confirm Plan Deviation" },
            { value: "cancel", label: "Cancel; keep original" },
        ],
    });

    assertEquals(response, { outcome: "accepted", value: true });
    assertEquals(prompt.includes("Plan Deviation confirmation"), true);
    assertEquals(prompt.includes("Superseded requirement: Replace nav."), true);
    assertEquals(options, [
        { value: "confirm", label: "Confirm Plan Deviation" },
        { value: "cancel", label: "Cancel; keep original" },
    ]);
});

Deno.test("TUI interaction adapter shows the full Plan Deviation confirmation prompt", async () => {
    let prompt = "";
    const tail = "This persistence warning must stay visible.";
    const adapter = createTuiInteractionAdapter(
        /** @type {any} */ ({
            promptSelect: (/** @type {string} */ value) => {
                prompt = value;
                return Promise.resolve("confirm");
            },
            promptText: () => Promise.resolve(null),
        }),
    );

    await adapter.requestInteraction({
        type: "plan_deviation_confirmation",
        prompt: `${"x".repeat(650)}\n${tail}`,
    });

    assertEquals(prompt.includes(tail), true);
    assertEquals(prompt.endsWith("..."), false);
});

Deno.test("TUI interaction adapter returns canceled Plan Deviation confirmation", async () => {
    const adapter = createTuiInteractionAdapter(makeUi("cancel"));

    const response = await adapter.requestInteraction({
        type: "plan_deviation_confirmation",
        prompt: "Confirm?",
        options: [
            { value: "confirm", label: "Confirm Plan Deviation" },
            { value: "cancel", label: "Cancel; keep original" },
        ],
    });

    assertEquals(response, { outcome: "canceled" });
});

Deno.test("TUI interaction adapter does not open a form for Pair checkpoints", async () => {
    let promptCount = 0;
    const adapter = createTuiInteractionAdapter(
        /** @type {any} */ ({
            promptSelect: () => {
                promptCount += 1;
                return Promise.resolve("continue");
            },
            promptText: () => {
                promptCount += 1;
                return Promise.resolve("feedback");
            },
        }),
    );

    const response = await adapter.requestInteraction({
        type: "pair_checkpoint",
        prompt: "Rendered account card",
    });

    assertEquals(response, {
        outcome: "unsupported",
        message: "Unsupported interaction type: pair_checkpoint",
    });
    assertEquals(promptCount, 0);
});

Deno.test("TUI code review exposes each real surface URL without browser opening and clears settled links", async () => {
    const cwd = await Deno.makeTempDir({ prefix: "runwield-tui-code-link-" });
    const state = {
        busyValues: /** @type {boolean[]} */ ([]),
        outputs: /** @type {string[]} */ ([]),
        ended: /** @type {boolean[]} */ ([]),
    };
    const scripted = createScriptedReviewBrowser("decision", { approved: true }, false);
    const adapter = createAdapter(makeUi(null, state), { browser: scripted.browser });
    const callbacks = /** @type {string[]} */ ([]);
    try {
        // A resumed review creates a new surface; direct review has no caller callback.
        for (const hasCallback of [true, false]) {
            const response = await adapter.requestInteraction({
                type: RuntimeInteractionTypes.CODE_REVIEW,
                prompt: "Review",
                _meta: {
                    planName: "feature",
                    diffText: "diff --git a/a b/a\n",
                    executionCwd: cwd,
                    onSurfaceReady: hasCallback
                        ? (/** @type {{url: string}} */ surface) => callbacks.push(surface.url)
                        : undefined,
                },
            });
            assertEquals(response.outcome, "accepted");
        }
        assertEquals(callbacks, [scripted.urls[0]]);
        assertEquals(state.busyValues, [false, true, false, true]);
        assertEquals(state.ended, [false, false]);
        assertEquals(scripted.urls[0] === scripted.urls[1], false);
        for (let index = 0; index < 2; index++) {
            assertStringIncludes(state.outputs[index * 2], `Review Code: \x1b]8;;${scripted.urls[index]}\x07`);
            assertStringIncludes(state.outputs[index * 2], "Open the review link to continue.");
            assertEquals(state.outputs[index * 2 + 1], "Code Review approved.");
        }
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("TUI code review closes the live link and restores progress on cancellation", async () => {
    const cwd = await Deno.makeTempDir({ prefix: "runwield-tui-code-cancel-" });
    const state = {
        busyValues: /** @type {boolean[]} */ ([]),
        outputs: /** @type {string[]} */ ([]),
        ended: /** @type {boolean[]} */ ([]),
    };
    const controller = new AbortController();
    const adapter = createAdapter(makeUi(null, state), { browser: NO_OPEN_BROWSER_PORT });
    try {
        const response = await adapter.requestInteraction({
            type: RuntimeInteractionTypes.CODE_REVIEW,
            prompt: "Review",
            _meta: {
                planName: "feature",
                diffText: "diff --git a/a b/a\n",
                executionCwd: cwd,
                onSurfaceReady: () => controller.abort(),
            },
        }, controller.signal);
        assertEquals(response.outcome, "canceled");
        assertEquals(
            state.outputs.at(-1),
            "Code Review canceled; approval is still pending. Retry or /load-plan feature to reopen it.",
        );
        assertEquals(state.busyValues, [false, true]);
        assertEquals(state.ended, [false]);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("TUI review setup failure closes its block as an error", async () => {
    const state = {
        busyValues: /** @type {boolean[]} */ ([]),
        outputs: /** @type {string[]} */ ([]),
        ended: /** @type {boolean[]} */ ([]),
    };
    const adapter = createAdapter(makeUi(null, state), { browser: NO_OPEN_BROWSER_PORT });
    await assertRejects(async () =>
        await adapter.requestInteraction({
            type: RuntimeInteractionTypes.CODE_REVIEW,
            prompt: "Review",
            _meta: { planName: "feature", diffText: "", executionCwd: "" },
        })
    );
    assertEquals(state.outputs.at(-1), "Code Review could not be opened.");
    assertEquals(state.ended, [true]);
    assertEquals(state.busyValues, [false, true]);
});
