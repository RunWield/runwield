import { mkdtemp as fsMkdtemp, rm as fsRm } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { NO_OPEN_BROWSER_PORT } from "../../shared/browser-port.ts";
import { createTuiInteractionAdapter as createAdapterImplementation } from "./runtime-interaction-adapter.js";
import { getStoredPlanPath, savePlan } from "../../plan-store.js";
import { createScriptedReviewBrowser } from "../review/review-test-fixture.ts";
import { RuntimeInteractionTypes } from "../../shared/session/session-runtime-interactions.js";
import { ToolExecutionBlock } from "./blocks.js";
import { initRunWieldTheme } from "../theme/theme.js";

import type { SelectOption, UiAPI } from "./types.js";
import type { RuntimeInteractionRequest } from "../../shared/session/session-runtime-interactions.js";
import type { ReviewSurface } from "../review/review-launcher.ts";

interface ReviewUiState {
    busyValues?: boolean[];
    outputs?: string[];
    ended?: boolean[];
}

type InteractionFixtureUi = Pick<UiAPI, "promptSelect" | "promptText" | "setBusy" | "startToolExecution"> &
    Partial<Pick<UiAPI, "abortActivePrompt">>;
type FixtureAdapterFactory = (
    uiAPI: InteractionFixtureUi,
    ports: Parameters<typeof createAdapterImplementation>[1],
) => ReturnType<typeof createAdapterImplementation>;

const createAdapter = createAdapterImplementation as FixtureAdapterFactory;

type PromptResolver = (value: string | null) => void;
type ReviewLink = Pick<ReviewSurface, "url">;

initRunWieldTheme();

function createTuiInteractionAdapter(uiAPI: InteractionFixtureUi) {
    return createAdapter(uiAPI, { browser: NO_OPEN_BROWSER_PORT });
}

function makeUi(selection: string | null, state: ReviewUiState = {}): InteractionFixtureUi {
    return {
        promptSelect: () => Promise.resolve(selection),
        promptText: () => Promise.resolve(null),
        setBusy: (busy: boolean) => state.busyValues?.push(busy),
        startToolExecution: () => ({
            setOutput: (text: string) => state.outputs?.push(text),
            endExecution: (error: boolean) => state.ended?.push(error),
            startTime: 0,
        }),
    };
}

test("TUI Plan review resumes progress after feedback and review failures", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-review-progress-"));
    const busyValues: boolean[] = [];
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
        } satisfies RuntimeInteractionRequest;
        const response = await adapter.requestInteraction(request);
        assertEquals(response.outcome, "selected");
        assertEquals(response._meta?.feedback, "Add a test");
        assertEquals(busyValues, [false, true]);

        await fsRm(request._meta.planPath);
        await assertRejects(async () => await adapter.requestInteraction(request));
        assertEquals(busyValues, [false, true, false, true]);
    } finally {
        await fsRm(cwd, { recursive: true });
    }
});

test("TUI interaction adapter closes a question answered on another surface", async () => {
    let resolvePrompt: PromptResolver = () => {};
    let promptClosed = false;
    const uiAPI: InteractionFixtureUi = {
        promptSelect: () => new Promise((resolve) => (resolvePrompt = resolve)),
        promptText: () => Promise.resolve(null),
        abortActivePrompt: () => {
            promptClosed = true;
            resolvePrompt(null);
        },
    };
    const adapter = createTuiInteractionAdapter(uiAPI);
    const controller = new AbortController();
    const responsePromise = adapter.requestInteraction(
        {
            type: "select",
            prompt: "Pick",
            options: [{ value: "valid", label: "Valid" }],
        },
        controller.signal,
    );

    controller.abort();
    await Promise.resolve();

    assertEquals(promptClosed, true);
    assertEquals((await responsePromise).outcome, "canceled");
});

test("TUI interaction adapter rejects invalid selected options", async () => {
    const adapter = createTuiInteractionAdapter(makeUi("invalid"));
    const response = await adapter.requestInteraction({
        type: "select",
        prompt: "Pick",
        options: [{ value: "valid", label: "Valid" }],
    });

    assertEquals(response.outcome, "unsupported");
    assertEquals(response.message, "Select prompt returned invalid option: invalid");
});

test("TUI interaction adapter maps declined approval choices to canceled outcome", async () => {
    const adapter = createTuiInteractionAdapter(makeUi("deny"));
    const response = await adapter.requestInteraction({
        type: "approval",
        prompt: "Approve?",
        options: [
            { value: "approve", label: "Approve" },
            { value: "deny", label: "Deny" },
        ],
    });

    assertEquals(response.outcome, "canceled");
    assertEquals(response.value, false);
});

test("TUI interaction adapter does not auto-accept arbitrary single approval options", async () => {
    const adapter = createTuiInteractionAdapter(makeUi("deny"));
    const response = await adapter.requestInteraction({
        type: "approval",
        prompt: "Approve?",
        options: [{ value: "deny", label: "Deny" }],
    });

    assertEquals(response.outcome, "canceled");
    assertEquals(response.value, false);
});

test("TUI interaction adapter maps approval prompts to accepted outcome", async () => {
    const adapter = createTuiInteractionAdapter(makeUi("approve"));
    const response = await adapter.requestInteraction({
        type: "approval",
        prompt: "Approve?",
        options: [{ value: "approve", label: "Approve" }],
    });

    assertEquals(response.outcome, "accepted");
    assertEquals(response.value, true);
});

test("TUI interaction adapter advertises browser-backed review capabilities", () => {
    const adapter = createTuiInteractionAdapter(makeUi(null));

    assertEquals(adapter.supportsInteraction?.("pair_checkpoint"), false);
    assertEquals(adapter.supportsInteraction?.("plan_deviation_confirmation"), true);
    assertEquals(adapter.supportsInteraction?.("artifact_review"), true);
    assertEquals(adapter.supportsInteraction?.("select"), false);
    assertEquals(adapter.supportsInteraction?.("text"), false);
});

test("TUI interaction adapter confirms Plan Deviations explicitly", async () => {
    let prompt = "";
    let options: SelectOption[] = [];
    const adapter = createTuiInteractionAdapter({
        promptSelect: (value: string, promptOptions: SelectOption[]) => {
            prompt = value;
            options = promptOptions;
            return Promise.resolve("confirm");
        },
        promptText: () => Promise.resolve(null),
    });

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
    assertEquals(
        prompt,
        "Plan Deviation confirmation\n\n" +
            [
                "Confirm this Plan Deviation before I treat it as authority.",
                "Superseded requirement: Replace nav.",
                "Replacement requirement: Keep nav.",
                "Confirmed text will be saved in the Plan and Work Record.",
            ].join("\n"),
    );
    assertEquals(options, [
        { value: "confirm", label: "Confirm Plan Deviation" },
        { value: "cancel", label: "Cancel; keep original" },
    ]);
});

test("TUI interaction adapter shows the full Plan Deviation confirmation prompt", async () => {
    let prompt = "";
    const tail = "This persistence warning must stay visible.";
    const adapter = createTuiInteractionAdapter({
        promptSelect: (value: string) => {
            prompt = value;
            return Promise.resolve("confirm");
        },
        promptText: () => Promise.resolve(null),
    });

    await adapter.requestInteraction({
        type: "plan_deviation_confirmation",
        prompt: `${"x".repeat(650)}\n${tail}`,
    });

    assertEquals(prompt.includes(tail), true);
    assertEquals(prompt.endsWith("..."), false);
});

test("TUI interaction adapter returns canceled Plan Deviation confirmation", async () => {
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

test("TUI interaction adapter does not open a form for Pair checkpoints", async () => {
    let promptCount = 0;
    const adapter = createTuiInteractionAdapter({
        promptSelect: () => {
            promptCount += 1;
            return Promise.resolve("continue");
        },
        promptText: () => {
            promptCount += 1;
            return Promise.resolve("feedback");
        },
    });

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

test("TUI code review exposes each real surface URL without browser opening and clears settled links", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-tui-code-link-"));
    const state: Required<ReviewUiState> = {
        busyValues: [],
        outputs: [],
        ended: [],
    };
    const scripted = createScriptedReviewBrowser("decision", { approved: true }, false);
    const adapter = createAdapter(makeUi(null, state), { browser: scripted.browser });
    const callbacks: string[] = [];
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
                    onSurfaceReady: hasCallback ? (surface: ReviewLink) => callbacks.push(surface.url) : undefined,
                },
            });
            assertEquals(response.outcome, "accepted");
        }
        assertEquals(callbacks, [scripted.urls[0]]);
        assertEquals(state.busyValues, [false, true, false, true]);
        assertEquals(state.ended, [false, false]);
        assertEquals(scripted.urls[0] === scripted.urls[1], false);
        for (let index = 0; index < 2; index++) {
            assertEquals(state.outputs[index * 3], "Waiting for Code Review. Opening browser review UI.");
            assertStringIncludes(state.outputs[index * 3 + 1], `Review Code: \x1b]8;;${scripted.urls[index]}\x07`);
            assertStringIncludes(state.outputs[index * 3 + 1], "Waiting for Code Review.");
            assertStringIncludes(state.outputs[index * 3 + 1], "Open the review link to continue.");
            assertEquals(state.outputs[index * 3 + 2], "Code Review approved.");
        }
    } finally {
        await fsRm(cwd, { recursive: true });
    }
});

test("TUI keeps the waiting message and clickable Code Review link visible until cancellation", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-tui-code-wait-"));
    const controller = new AbortController();
    const block = new ToolExecutionBlock("code_review", "Code Review");
    const ui = makeUi(null);
    ui.startToolExecution = () => block;
    const adapter = createAdapter(ui, { browser: NO_OPEN_BROWSER_PORT });
    let checked = false;
    try {
        const response = await adapter.requestInteraction(
            {
                type: RuntimeInteractionTypes.CODE_REVIEW,
                prompt: "Review",
                _meta: {
                    planName: "feature",
                    diffText: "diff --git a/a b/a\n",
                    executionCwd: cwd,
                    onSurfaceReady: (surface: ReviewLink) => {
                        for (const width of [60, 120]) {
                            const rendered = block.render(width).join("\n");
                            assertStringIncludes(rendered, "Waiting for Code Review");
                            assertStringIncludes(rendered, `\x1b]8;;${surface.url}\x07`);
                            assertStringIncludes(rendered, "\x1b]8;;\x07");
                            assertEquals(block.ended, false);
                        }
                        checked = true;
                        controller.abort();
                    },
                },
            },
            controller.signal,
        );
        assertEquals(checked, true);
        assertEquals(response.outcome, "canceled");
        assertEquals(block.render(120).join("\n").includes("\x1b]8;;"), false);
    } finally {
        controller.abort();
        await fsRm(cwd, { recursive: true });
    }
});

test("TUI code review closes the live link and restores progress on cancellation", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-tui-code-cancel-"));
    const state: Required<ReviewUiState> = {
        busyValues: [],
        outputs: [],
        ended: [],
    };
    const controller = new AbortController();
    const adapter = createAdapter(makeUi(null, state), { browser: NO_OPEN_BROWSER_PORT });
    try {
        const response = await adapter.requestInteraction(
            {
                type: RuntimeInteractionTypes.CODE_REVIEW,
                prompt: "Review",
                _meta: {
                    planName: "feature",
                    diffText: "diff --git a/a b/a\n",
                    executionCwd: cwd,
                    onSurfaceReady: () => controller.abort(),
                },
            },
            controller.signal,
        );
        assertEquals(response.outcome, "canceled");
        assertEquals(
            state.outputs.at(-1),
            "Code Review canceled; approval is still pending. Retry or /load-plan feature to reopen it.",
        );
        assertEquals(state.busyValues, [false, true]);
        assertEquals(state.ended, [false]);
    } finally {
        await fsRm(cwd, { recursive: true });
    }
});

test("TUI review setup failure closes its block as an error", async () => {
    const state: Required<ReviewUiState> = {
        busyValues: [],
        outputs: [],
        ended: [],
    };
    const adapter = createAdapter(makeUi(null, state), { browser: NO_OPEN_BROWSER_PORT });
    await assertRejects(
        async () =>
            await adapter.requestInteraction({
                type: RuntimeInteractionTypes.CODE_REVIEW,
                prompt: "Review",
                _meta: { planName: "feature", diffText: "", executionCwd: "" },
            }),
    );
    assertEquals(state.outputs.at(-1), "Code Review could not be opened.");
    assertEquals(state.ended, [true]);
    assertEquals(state.busyValues, [false, true]);
});
