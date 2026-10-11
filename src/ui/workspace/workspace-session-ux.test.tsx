import { Window } from "happy-dom";
import { readSessionDraft, saveSessionDraft } from "./browser/session-drafts.ts";
// @ts-nocheck: Deno test imports are checked by scripts/run-tests.js, not Astro check.
import { readWorkspaceStyles } from "./workspace-styles.ts";
import { assertEquals, assertStringIncludes } from "@std/assert";
import {
    activePlanProgressApiUrl,
    draftRecoveryDecision,
    isAtLiveScrollEdge,
    mergeLiveSessionInfo,
    newSessionDraftInstanceStorageKey,
    reduceOperationTransientItems,
    serializeSessionImageForRequest,
    sessionAttachmentsKey,
    SessionComposer,
    sessionDraftKey,
    sessionRequestKey,
    SessionSurface,
    shouldApplyOperationPoll,
    shouldRefreshSessionAvailability,
} from "./islands/SessionSurface.jsx";
import { deriveSessionAvailability } from "./components/SessionActivationStatus.tsx";
import { buildWorkflowPresentation } from "../../shared/workflow/workflow-presentation.ts";
import {
    compactToolLine,
    displayAgentName,
    formatSessionTimelineTime,
    mergeSessionTimelineItems,
    reduceSessionEvents,
    sessionInteractionChoiceResponse,
    sessionInteractionTypedResponse,
    SessionTimeline,
} from "./components/SessionTimeline.jsx";

Deno.test("Session composer keeps provider/model identities and opens slash choices before the first message", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const props = {
        id: "new-session-request-text",
        draft: "",
        disabled: false,
        canSend: false,
        submitting: false,
        agents: [{ name: "guide", displayName: "Guide" }],
        agentValue: "guide",
        models: [{ provider: "openai-codex", id: "gpt-5.6-luna", name: "Luna" }],
        modelValue: "openai-codex\u001fgpt-5.6-luna",
        thinkingLevels: ["low"],
        thinkingValue: "low",
        commands: [{ name: "model", description: "Switch AI model", kind: "action" }],
        onDraftChange() {},
        onSubmit() {},
        onAgentChange() {},
        onModelChange() {},
        onThinkingChange() {},
    };
    const empty = renderToStaticMarkup(createElement(SessionComposer, props));
    assertEquals(empty.includes("openai-codex/gpt-5.6-luna</option>"), true);
    assertEquals(empty.match(/<select[^>]*disabled/g), null);
    assertEquals(empty.includes('aria-label="Attach image"'), true);
    assertEquals(empty.includes('title="Send"'), true);
    assertEquals(empty.includes(">Guide · openai-codex/gpt-5.6-luna · low</span>"), true);
    const commands = renderToStaticMarkup(createElement(SessionComposer, { ...props, draft: "/mo", canSend: true }));
    assertEquals(commands.includes('role="listbox" aria-label="Commands"'), true);
    assertEquals(commands.includes('aria-expanded="false"'), true);
    assertEquals(commands.includes('aria-activedescendant="new-session-request-text-commands-0"'), true);
    assertEquals(commands.includes("<strong>/model</strong>"), true);
    const models = renderToStaticMarkup(
        createElement(SessionComposer, { ...props, draft: "/model luna", canSend: true }),
    );
    assertEquals(models.includes("<strong>openai-codex/gpt-5.6-luna</strong>"), true);
});

Deno.test("Session composer renders restored image draft previews ready for corrected send", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(
        createElement(SessionComposer, {
            id: "session-request-text",
            draft: "  describe again  ",
            disabled: false,
            canSend: true,
            submitting: false,
            imageAttachments: [{ id: "image-1", name: "draft.png", mimeType: "image/png", base64: btoa("img") }],
            onDraftChange() {},
            onSubmit() {},
            onRemoveImage() {},
        }),
    );

    assertEquals(html.includes("  describe again  "), true);
    assertEquals(html.includes('aria-label="Attached images"'), true);
    assertEquals(html.includes("draft.png · image/png"), true);
    assertEquals(html.includes('aria-label="Send"'), true);
    assertEquals(html.includes('aria-label="Sending"'), false);
});

Deno.test("Session surface retains an HTTP-rejected image draft and sends a corrected draft once", async () => {
    const browser = new Window({ url: "http://localhost" });
    const globals = [
        "window",
        "document",
        "location",
        "localStorage",
        "sessionStorage",
        "HTMLElement",
        "CustomEvent",
        "matchMedia",
        "EventSource",
    ];
    const previous = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const previousFetch = globalThis.fetch;
    const previousActFlag = globalThis.IS_REACT_ACT_ENVIRONMENT;
    const projectId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const draftKey = sessionDraftKey(projectId, sessionId);
    const attachmentsKey = sessionAttachmentsKey(projectId, sessionId);
    const requestKey = sessionRequestKey(projectId, sessionId);
    const images = [{ id: "image-1", name: "draft.png", mimeType: "image/png", base64: btoa("img") }];
    let mascot = false;
    const submissions = [];
    let renderer;
    const { createElement, act } = await import("react");
    const { create } = await import("react-test-renderer");
    try {
        for (const key of globals) {
            const value = key === "window"
                ? browser
                : key === "matchMedia"
                ? browser.matchMedia.bind(browser)
                : browser[key];
            Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
        }
        globalThis.IS_REACT_ACT_ENVIRONMENT = true;
        globalThis.fetch = (url, options = {}) =>
            Promise.resolve().then(() => {
                const path = String(url);
                if (options.method === "POST") {
                    submissions.push(JSON.parse(options.body));
                    return submissions.length === 1
                        ? Response.json({ error: "Antigravity CLI sessions do not support image attachments." }, {
                            status: 422,
                        })
                        : Response.json({ operationId: "accepted-image", status: "running" }, { status: 202 });
                }
                if (path.includes("session-options")) {
                    return Response.json({ mascot, agents: [], models: [], commands: [], defaults: {} });
                }
                if (path.includes("session-operations")) return Response.json({ status: "completed", events: [] });
                return Response.json({ state: "idle", generation: 0, events: [], complete: true, snapshot: {} });
            });
        await saveSessionDraft(draftKey, "  describe image  ");
        await saveSessionDraft(attachmentsKey, JSON.stringify(images));
        await act(() => {
            renderer = create(createElement(SessionSurface, { projectId, runwieldSessionId: sessionId }));
        });
        const composer = () => renderer.root.findByType(SessionComposer);
        assertEquals(composer().props.mascotVisible, false);
        assertEquals(composer().props.draft, "  describe image  ");
        await act(async () => {
            await composer().props.onSubmit();
        });
        assertEquals(submissions.length, 1);
        assertEquals(composer().props.draft, "  describe image  ");
        assertEquals(composer().props.imageAttachments, images);
        assertEquals(readSessionDraft(draftKey), "  describe image  ");
        assertEquals(JSON.parse(readSessionDraft(requestKey)).status, "validation-error");
        assertStringIncludes(
            JSON.stringify(renderer.toJSON()),
            "Antigravity CLI sessions do not support image attachments.",
        );
        assertEquals(JSON.stringify(renderer.toJSON()).includes("Message queued"), false);
        mascot = undefined;
        // Reload the real screen: persisted text/previews must still be recoverable.
        await act(() => renderer.unmount());
        await act(() => {
            renderer = create(createElement(SessionSurface, { projectId, runwieldSessionId: sessionId }));
        });
        assertEquals(composer().props.draft, "  describe image  ");
        assertEquals(composer().props.imageAttachments, images);
        assertEquals(composer().props.mascotVisible, true);
        await act(() => composer().props.onDraftChange("  corrected image request  "));
        await act(async () => {
            await composer().props.onSubmit();
        });
        assertEquals(submissions.map((item) => item.text), ["  describe image  ", "  corrected image request  "]);
        assertEquals(submissions[1].images, [{ base64: btoa("img"), mimeType: "image/png" }]);
        assertEquals(composer().props.draft, "");
        assertEquals(composer().props.imageAttachments, []);
    } finally {
        if (renderer) await act(() => renderer.unmount());
        globalThis.fetch = previousFetch;
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
        if (previousActFlag === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
        else globalThis.IS_REACT_ACT_ENVIRONMENT = previousActFlag;
        await browser.happyDOM.close();
    }
});

Deno.test("Session surface preserves drafts and replaces a lost live wait with one interruption line", () => {
    assertEquals(sessionDraftKey("project-1", "session-1"), "runwield:owner:project:project-1:session:session-1:draft");
    assertEquals(
        newSessionDraftInstanceStorageKey("project-1"),
        "runwield:owner:project:project-1:session:new:draft-instance",
    );
    assertEquals(draftRecoveryDecision({ status: "unknown" }), "idle");
    assertEquals(
        shouldApplyOperationPoll({ cancelled: false, currentOperationId: "new", polledOperationId: "new" }),
        true,
    );
    assertEquals(
        shouldApplyOperationPoll({ cancelled: false, currentOperationId: "new", polledOperationId: "old" }),
        false,
    );
    assertEquals(
        shouldApplyOperationPoll({ cancelled: true, currentOperationId: "new", polledOperationId: "new" }),
        false,
    );
    const items = reduceOperationTransientItems([
        { type: "interaction_requested", interactionId: "wait-1", interactionType: "text", prompt: "Answer?" },
    ]);
    assertEquals(items.length, 0);
    const reviewItems = reduceSessionEvents([
        {
            type: "interaction_requested",
            interactionId: "review-1",
            interactionType: "plan_review",
            prompt: "Review plan",
            review: {
                planId: "feature-a",
                planName: "Feature A",
                classification: "PLANNED_CHANGE",
                expectedStatus: "draft",
            },
        },
    ]);
    assertEquals(reviewItems[0]?.kind, "plan-review");
    assertEquals(reviewItems[0]?.request?.planReview?.planName, "Feature A");
    const interrupted = reduceSessionEvents([
        { type: "system_status", eventId: "status-1", message: "The agent was interrupted. Ask it to continue." },
    ]);
    assertEquals(interrupted[0]?.text, "The agent was interrupted. Ask it to continue.");
});

Deno.test("file-locked Sessions wait for the active surface without offering takeover", () => {
    const availability = deriveSessionAvailability({
        state: "active",
        activeSurface: "tui",
        generation: 0,
    });
    assertEquals(availability.key, "active");
    assertEquals(
        availability.explanation,
        "Steer the agent or queue a follow-up.",
    );
});

Deno.test("Session timeline labels transitions without inventing an initial Agent", () => {
    const items = reduceSessionEvents([
        {
            type: "user_message",
            eventId: "opaque-1",
            messageId: "m1",
            text: "Plan",
            segmentOrdinal: 0,
            segmentKind: "planning",
        },
        {
            type: "assistant_text_delta",
            eventId: "opaque-2",
            messageId: "m2",
            delta: "Work",
            segmentOrdinal: 1,
            segmentKind: "execution",
        },
        {
            type: "assistant_text_delta",
            eventId: "opaque-3",
            messageId: "m3",
            delta: "Repair",
            segmentOrdinal: 2,
            segmentKind: "semantic_repair",
        },
        { type: "recovery_event", eventId: "recover-1", message: "Recovered stale action." },
        { type: "recovery_event", eventId: "recover-2", message: "Restarted validation." },
    ]);
    const systemEvents = items.filter((item) => item.kind === "system-event");
    assertEquals(systemEvents.map((item) => item.text), [
        "Plan Engineer",
        "Semantic Repair",
        "Recovered stale action.\nRestarted validation.",
    ]);
    assertEquals(systemEvents.at(-1)?.lines, ["Recovered stale action.", "Restarted validation."]);
    assertEquals(items.some((item) => String(item.text || "").includes("segment-id")), false);
});

Deno.test("Session interaction answers preserve Runtime outcome identity", () => {
    assertEquals(
        sessionInteractionChoiceResponse("select", {
            type: "select",
            options: [{ value: "router", label: "Router" }],
        }, { value: "router", label: "Router" }),
        { outcome: "selected", value: "router", valueLabel: "Router" },
    );
    assertEquals(
        sessionInteractionChoiceResponse("approval", {
            type: "approval",
            options: [{ value: "approve", label: "Approve", _meta: { accepted: true } }],
        }, { value: "approve", label: "Approve" }),
        { outcome: "accepted", value: "approve", valueLabel: "Approve" },
    );
    assertEquals(sessionInteractionTypedResponse("select", "custom answer", true), {
        outcome: "selected",
        value: "custom answer",
        valueLabel: "Other",
    });
    assertEquals(sessionInteractionTypedResponse("text", "typed answer", false), {
        outcome: "text",
        value: "typed answer",
    });
});

Deno.test("Session availability observes idle Sessions too, so TUI turns appear automatically", () => {
    assertEquals(shouldRefreshSessionAvailability({ mode: "detail", state: "active" }), true);
    assertEquals(
        shouldRefreshSessionAvailability({ mode: "detail", state: "active", localOperationActive: true }),
        false,
    );
    assertEquals(shouldRefreshSessionAvailability({ mode: "detail", state: "idle" }), true);
    assertEquals(
        shouldRefreshSessionAvailability({ mode: "detail", state: "idle", queuedMessageCount: 1 }),
        true,
    );
    assertEquals(shouldRefreshSessionAvailability({ mode: "new", state: "active" }), false);
});

Deno.test("Session availability refreshes when a busy page becomes active again", async () => {
    const surface = await Deno.readTextFile(new URL("./islands/SessionSurface.jsx", import.meta.url));
    assertEquals(surface.includes('globalThis.addEventListener("focus", refresh)'), true);
    assertEquals(surface.includes('document.addEventListener("visibilitychange", refreshWhenVisible)'), true);
});

Deno.test("busy Session messages remain sendable and render above the Workspace composer", async () => {
    const surface = await Deno.readTextFile(new URL("./islands/SessionSurface.jsx", import.meta.url));
    const continuation = await Deno.readTextFile(new URL("./server/session-continuation.js", import.meta.url));
    const css = await readWorkspaceStyles(new URL("./static/workspace.css", import.meta.url));
    assertEquals(surface.includes('["active", "workspace-running"].includes(availability.key)'), true);
    assertEquals(surface.includes("const [queuedMessages, setQueuedMessages] = useState"), true);
    assertEquals(surface.includes("setQueuedMessages((current) => ["), true);
    assertEquals(surface.includes('if (freshTimeline.state === "active" || operationRef.current)'), true);
    assertEquals(surface.includes("const queued = queuedMessages[0]"), true);
    assertEquals(surface.includes("queuedMessages={queuedMessages}"), true);
    assertEquals(surface.includes("timeline.queuedMessages"), false);
    assertEquals(continuation.includes("Keep the message queued in this browser"), true);
    assertEquals(surface.includes('className="session-composer-queue"'), true);
    assertEquals(surface.indexOf('className="session-composer-queue"') < surface.indexOf("<textarea"), true);
    assertEquals(css.includes(".session-composer-queue"), true);
});

Deno.test("Workspace new Session creation uses Workspace navigation instead of remounting the shell", async () => {
    const surface = await Deno.readTextFile(new URL("./islands/SessionSurface.jsx", import.meta.url));
    assertEquals(surface.includes("function workspaceNavigate"), true);
    assertEquals(
        surface.includes(
            "workspaceNavigate(\n                    `/projects/${encodeURIComponent(projectId)}/sessions/${",
        ),
        true,
    );
    assertEquals(
        surface.includes(
            "workspaceNavigate(\n                `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(payload.runwieldSessionId)}`",
        ),
        true,
    );
    assertEquals(
        surface.includes(
            "globalThis.location.replace(\n                    `/projects/${encodeURIComponent(projectId)}/sessions/${",
        ),
        false,
    );
});

Deno.test("Workspace-owned Session operations use live updates instead of browser polling", async () => {
    const surface = await Deno.readTextFile(new URL("./islands/SessionSurface.jsx", import.meta.url));
    const server = await Deno.readTextFile(new URL("./server.js", import.meta.url));
    assertEquals(surface.includes("const freshTimeline = await loadTimeline();"), true);
    assertEquals(surface.includes("expectedGeneration: freshTimeline.generation"), true);
    assertEquals(surface.includes("pending-user:${envelope.requestId}"), true);
    assertEquals(surface.includes("resubmit explicitly when ready"), false);
    assertEquals(surface.includes("new EventSource("), true);
    assertEquals(
        surface.includes("/api/owner/session-operations/${encodeURIComponent(operation.operationId)}/stream"),
        true,
    );
    assertEquals(surface.includes("setOperationStreamFailed(true)"), true);
    assertEquals(surface.includes("/api/owner/session-operations/${encodeURIComponent(current.operationId)}"), true);
    assertEquals(surface.includes("Recover stale Session"), false);
    assertEquals(surface.includes("/force-recovery"), false);
    assertEquals(surface.includes("/plan-workflow"), true);
    assertEquals(server.includes("/api/owner/session-operations/:operationId/stream"), true);
});

Deno.test("Workspace Session UI uses the shared thinking dots loader", async () => {
    const surface = await Deno.readTextFile(new URL("./islands/SessionSurface.jsx", import.meta.url));
    const timeline = await Deno.readTextFile(new URL("./components/SessionTimeline.jsx", import.meta.url));
    const css = await Deno.readTextFile(new URL("../design-system/components.css", import.meta.url));
    const docs = await Deno.readTextFile(new URL("../../../docs/design-system.md", import.meta.url));
    assertEquals(surface.includes("RunWieldThinkingDots"), true);
    assertEquals(timeline.includes("RunWieldThinkingDots"), true);
    assertEquals(css.includes(".rw-thinking-dots"), true);
    assertEquals(docs.includes("Use `RunWieldThinkingDots`"), true);
});

Deno.test("Session timeline puts usage and stop time on the assistant block", () => {
    const completedAt = new Date(2026, 8, 1, 21, 56).toISOString();
    const items = reduceSessionEvents([
        { type: "user_message", eventId: "u1", messageId: "u1", text: "Do it", timestamp: "2026-09-01T01:54:00.000Z" },
        {
            type: "assistant_text_delta",
            eventId: "a1",
            messageId: "a1",
            delta: "Done.",
            agentName: "frontend-engineer",
            timestamp: "2026-09-01T01:55:00.000Z",
        },
        {
            type: "usage",
            eventId: "usage-1",
            messageId: "a1:usage",
            usage: { inputTokens: 1569, outputTokens: 74 },
            timestamp: completedAt,
        },
    ]);
    assertEquals(items.map((item) => item.kind), ["message", "message"]);
    assertEquals(displayAgentName(items[1]?.agentName), "Frontend Engineer");
    assertEquals(items[1]?.footerText, "Usage: 1569 in / 74 out tokens");
    assertEquals(items[1]?.completedTimestamp, completedAt);
    assertEquals(formatSessionTimelineTime(completedAt), "9:56pm");
});

Deno.test("Session timeline groups completed technical activity after agent content resumes", () => {
    const items = reduceSessionEvents([
        { type: "user_message", eventId: "u1", messageId: "u1", text: "Do it" },
        { type: "tool_start", eventId: "t1s", toolCallId: "t1", toolName: "read", title: "Read file" },
        { type: "tool_end", eventId: "t1e", toolCallId: "t1", toolName: "read", output: "src/app.js", isError: false },
        { type: "assistant_thinking_delta", eventId: "th1", messageId: "think-1", delta: "Checking" },
        { type: "assistant_thinking_end", eventId: "th2", messageId: "think-1" },
        { type: "assistant_text_delta", eventId: "a1", messageId: "a1", delta: "Done." },
    ]);
    assertEquals(items.map((item) => item.kind), ["message", "activity", "message"]);
    assertEquals(items[1]?.title, "Activity");
    assertEquals(items[1]?.count, 2);
    assertEquals(items[1]?.items?.map((item) => item.kind), ["tool", "thinking"]);
    assertEquals(items[1]?.items?.[0]?.output, "src/app.js");
});

Deno.test("Activity stays open as it grows and only synchronizes Thinking disclosures", async () => {
    const { createElement } = await import("react");
    const { create, act } = await import("react-test-renderer");
    const previousActFlag = globalThis.IS_REACT_ACT_ENVIRONMENT;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    let renderer;
    const activity = (extra = false) =>
        reduceSessionEvents([
            { type: "tool_start", eventId: "t1s", toolCallId: "t1", toolName: "read" },
            { type: "tool_end", eventId: "t1e", toolCallId: "t1", toolName: "read", output: "first file" },
            { type: "assistant_thinking_delta", eventId: "th1", messageId: "thinking-1", delta: "Checking" },
            { type: "assistant_thinking_end", eventId: "th1e", messageId: "thinking-1" },
            ...(extra
                ? [
                    { type: "tool_end", eventId: "t2e", toolCallId: "t2", toolName: "read", output: "second file" },
                    { type: "assistant_thinking_delta", eventId: "th2", messageId: "thinking-2", delta: "More checks" },
                    { type: "assistant_thinking_end", eventId: "th2e", messageId: "thinking-2" },
                ]
                : []),
            { type: "assistant_text_delta", eventId: "a1", messageId: "a1", delta: "Done" },
        ]).filter((item) => item.kind === "activity");
    const initial = activity();
    const expanded = activity(true);
    assertEquals(initial[0].key, expanded[0].key);
    const group = () => renderer.root.findByProps({ className: "session-activity-group" });
    const thinking = () =>
        renderer.root.findAllByType("details").filter((node) => node.props.className.includes("activity-thinking"));
    const tools = () =>
        renderer.root.findAllByType("details").filter((node) => node.props.className.includes("activity-tool"));
    const toggle = async (node, open) => {
        const target = { open };
        await act(() => node.props.onToggle({ currentTarget: target, target }));
    };
    try {
        await act(() => {
            renderer = create(createElement(SessionTimeline, { items: initial }));
        });
        const firstTool = tools()[0];
        assertEquals(group().props.open, false);
        await toggle(group(), true);
        assertEquals(thinking()[0].props.open, true);
        await toggle(thinking()[0], false);
        assertEquals(group().props.open, true);
        await act(() => renderer.update(createElement(SessionTimeline, { items: expanded })));
        assertEquals(group().props.open, true);
        assertEquals(thinking().map((node) => node.props.open), [false, true]);
        assertEquals(tools()[0] === firstTool, true);
        assertEquals(tools().every((node) => node.props.open === undefined && node.props.onToggle === undefined), true);
        await toggle(group(), false);
        assertEquals(thinking().map((node) => node.props.open), [false, false]);
        await toggle(group(), true);
        assertEquals(thinking().map((node) => node.props.open), [true, true]);
        // Nested toggle events must never change the parent disclosure.
        await act(() => group().props.onToggle({ currentTarget: { open: false }, target: {} }));
        assertEquals(group().props.open, true);
    } finally {
        if (renderer) await act(() => renderer.unmount());
        if (previousActFlag === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
        else globalThis.IS_REACT_ACT_ENVIRONMENT = previousActFlag;
    }
});

Deno.test("Session timeline keeps trailing or running technical activity visible", () => {
    const trailing = reduceSessionEvents([
        { type: "tool_start", eventId: "t1s", toolCallId: "t1", toolName: "read", title: "read src/app.js" },
        { type: "tool_end", eventId: "t1e", toolCallId: "t1", toolName: "read", output: "full file output" },
    ]);
    assertEquals(trailing.map((item) => item.kind), ["tool"]);
    assertEquals(compactToolLine(trailing[0]), "read src/app.js");

    const running = reduceSessionEvents([
        { type: "tool_start", eventId: "t2s", toolCallId: "t2", toolName: "edit", title: "edit src/app.js" },
        { type: "assistant_text_delta", eventId: "a1", messageId: "a1", delta: "Working." },
    ]);
    assertEquals(running.map((item) => item.kind), ["tool", "message"]);
    assertEquals(running[0]?.status, "running");
    assertEquals(compactToolLine(running[0]), "edit src/app.js running");
});

Deno.test("Session scroll follows only while the reader stays near the live edge", () => {
    assertEquals(isAtLiveScrollEdge({ scrollHeight: 1000, scrollTop: 553, clientHeight: 400 }), true);
    assertEquals(isAtLiveScrollEdge({ scrollHeight: 1000, scrollTop: 300, clientHeight: 400 }), false);
});

Deno.test("Existing Session route lets the shared chat shell own the page heading", async () => {
    const route = await Deno.readTextFile(
        new URL("./pages/projects/[projectId]/sessions/[runwieldSessionId].astro", import.meta.url),
    );
    assertEquals(route.includes("Session Continuation"), false);
    assertEquals(route.includes("Committed transcript history"), false);
    assertEquals(route.includes("SessionSurface"), true);
});

Deno.test("live Plan attachment updates sidebar state without replacing committed history", () => {
    const initial = {
        events: [{ eventId: "committed-1", text: "Start with Ideator" }],
        nextCursor: "committed-1",
        generation: 1,
        snapshot: {
            activeAgent: "ideator",
            workflowContext: null,
            planAssociations: [{ planName: "old-plan", planId: "plan-1" }],
        },
    };
    const planning = mergeLiveSessionInfo(initial, {
        activeAgent: "planner",
        activeModel: { provider: "openai", model: "planner-model" },
        thinkingLevel: "high",
        workflowContext: { planName: "new-plan" },
        planAssociations: [{ planName: "new-plan", planId: "plan-2" }],
        activeExecutionWorkflow: null,
    });
    assertEquals(
        activePlanProgressApiUrl("project", "session", planning.snapshot),
        "/api/owner/projects/project/plans/plan-2/progress?session=session",
    );
    assertEquals(planning.events, initial.events);
    assertEquals(planning.nextCursor, "committed-1");
    assertEquals(planning.generation, 1);
    assertEquals(planning.snapshot.activeAgent, "planner");
    assertEquals(planning.snapshot.planAssociations.map((item) => item.planId), ["plan-1", "plan-2"]);
    assertEquals(mergeLiveSessionInfo(planning, planning.snapshot).snapshot.planAssociations.length, 2);
    assertEquals(planning.snapshot.thinkingLevel, "high");
    const executing = mergeLiveSessionInfo(planning, {
        activeAgent: "engineer",
        activeExecutionWorkflow: { planName: "child-plan", triageMeta: { planId: "child-id" } },
    });
    assertEquals(
        activePlanProgressApiUrl("project", "session", executing.snapshot),
        "/api/owner/projects/project/plans/child-id/progress?session=session",
    );
    assertEquals(mergeLiveSessionInfo(executing, null), executing);
    assertEquals(initial.snapshot.activeAgent, "ideator");
});

Deno.test("Session workflow sidebar uses canonical progress stages", async () => {
    const surface = await Deno.readTextFile(new URL("./islands/SessionSurface.jsx", import.meta.url));
    assertEquals(
        activePlanProgressApiUrl("project-1", "session-1", {
            activeExecutionWorkflow: { planId: "plan-demo" },
        }),
        "/api/owner/projects/project-1/plans/plan-demo/progress?session=session-1",
    );
    assertEquals(
        activePlanProgressApiUrl("project-1", "session-1", {
            workflowContext: { planName: "readme-wording" },
            planAssociations: [{ planName: "readme-wording", planId: "plan-demo" }],
        }),
        "/api/owner/projects/project-1/plans/plan-demo/progress?session=session-1",
    );
    assertEquals(
        activePlanProgressApiUrl("project-1", "session-1", {
            workflowContext: { planName: "readme-wording" },
        }),
        "",
    );
    assertEquals(
        buildWorkflowPresentation({
            planName: "plan-demo",
            status: "validated_ci",
            progressFacts: [
                { kind: "validation_checkpoint", phase: "semantic", state: "running" },
            ],
        }).stages.map((stage) => stage.label),
        ["Planning", "Execution", "Verification Command", "AI review", "Code Review", "Publication", "Completion"],
    );
    assertEquals(surface.includes('ownerFetch(apiUrl, { method: "GET" })'), true);
    assertEquals(surface.includes("WorkflowSidebar"), true);
});

Deno.test("Persisted Sessions expose the shared context sidebar tabs", async () => {
    const surface = await Deno.readTextFile(new URL("./islands/SessionSurface.jsx", import.meta.url));
    assertEquals(surface.includes("SESSION_SIDEBAR_TABS.map"), true);
    assertEquals(surface.includes("session-context-tabs"), true);
    assertEquals(surface.includes("session-artifact-list"), true);
    assertEquals(surface.includes("defaultSessionSidebarTab"), true);
    assertEquals(surface.includes("presentation={workflowSidebar}"), true);
    assertEquals(surface.includes('title="Workflow"'), true);
});

Deno.test("Session sidebar adds current runtime settings to shared TUI fields", async () => {
    const surface = await Deno.readTextFile(new URL("./islands/SessionSurface.jsx", import.meta.url));
    assertEquals(
        surface.includes('sessionSidebarFields(sessionSidebar).filter((field) => field.label !== "Session")'),
        true,
    );
    assertEquals(surface.includes('label: "Agent"'), true);
    assertEquals(surface.includes('label: "Model"'), true);
    assertEquals(surface.includes('label: "Thinking"'), true);
    assertEquals(surface.includes('const currentAgent = timeline?.snapshot?.activeAgent || ""'), true);
    assertEquals(surface.includes("value: activeThinking"), true);
    assertEquals(surface.includes('[activeProvider, activeModelId].filter(Boolean).join("/")'), true);
    assertEquals(surface.includes("Execution Backend"), false);
    assertEquals(surface.includes("<dd>{displayedThinking}</dd>"), false);
    assertEquals(surface.includes("modelValue={stagedModelKey}"), true);
    assertEquals(surface.includes("thinkingValue={displayedThinking}"), true);
});

Deno.test("Session sidebar keeps one toggle and its tabs in the shared header", async () => {
    const surface = await Deno.readTextFile(new URL("./islands/SessionSurface.jsx", import.meta.url));
    const header = surface.slice(
        surface.indexOf("<WorkspaceHeaderActionsPortal>"),
        surface.indexOf("</WorkspaceHeaderActionsPortal>"),
    );
    assertEquals(
        header.indexOf("<RunWieldPanelToggle") < header.indexOf('className="rw-underline-tabs session-context-tabs"'),
        true,
    );
    assertEquals(header.includes("collapsed={contextCollapsed}"), true);
    assertEquals(surface.match(/<RunWieldPanelToggle/g)?.length, 1);
    const sidebar = surface.slice(surface.indexOf('id="session-context-sidebar"'));
    assertEquals(sidebar.includes('className="session-context-header"'), false);
    assertEquals(sidebar.includes('className="kicker"'), false);
});

Deno.test("mobile Session context keeps covered chat out of keyboard navigation", async () => {
    const browser = new Window({ url: "http://localhost" });
    const globals = [
        "window",
        "document",
        "location",
        "localStorage",
        "sessionStorage",
        "HTMLElement",
        "CustomEvent",
        "matchMedia",
        "ResizeObserver",
    ];
    const previous = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const previousFetch = globalThis.fetch;
    const previousActFlag = globalThis.IS_REACT_ACT_ENVIRONMENT;
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    let mobile = true;
    const listeners = new Set();
    const media = {
        get matches() {
            return mobile;
        },
        addEventListener(_event, listener) {
            listeners.add(listener);
        },
        removeEventListener(_event, listener) {
            listeners.delete(listener);
        },
    };
    const header = browser.document.createElement("div");
    header.setAttribute("data-workspace-header-actions", "");
    const container = browser.document.createElement("div");
    browser.document.body.append(header, container);
    let root;
    try {
        for (const key of globals) {
            const value = key === "window"
                ? browser
                : key === "matchMedia"
                ? (query) => query === "(max-width: 900px)" ? media : browser.matchMedia(query)
                : browser[key];
            Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
        }
        globalThis.IS_REACT_ACT_ENVIRONMENT = true;
        globalThis.fetch = (url) =>
            Promise.resolve().then(() =>
                String(url).includes("session-options")
                    ? Response.json({ agents: [], models: [], commands: [], defaults: {} })
                    : Response.json({ state: "idle", generation: 0, events: [], complete: true, snapshot: {} })
            );
        root = createRoot(container);
        await act(async () =>
            root.render(
                (await import("react")).createElement(SessionSurface, {
                    projectId: crypto.randomUUID(),
                    runwieldSessionId: crypto.randomUUID(),
                }),
            )
        );
        const stream = container.querySelector(".session-stream-panel");
        assertEquals(stream?.inert, false);
        await act(() => header.querySelector('[aria-label="Show Session sidebar"]').click());
        assertEquals(stream?.inert, true);
        const tabs = () => [...header.querySelectorAll('[role="tab"]')];
        assertEquals(tabs().map((tab) => tab.tabIndex), [-1, 0, -1]);
        assertEquals(tabs()[1].getAttribute("aria-controls"), "session-context-panel");
        assertEquals(container.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby"), tabs()[1].id);
        await act(() =>
            tabs()[1].dispatchEvent(new browser.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
        );
        assertEquals(tabs()[2].getAttribute("aria-selected"), "true");
        assertEquals(tabs().map((tab) => tab.tabIndex), [-1, -1, 0]);
        assertEquals(container.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby"), tabs()[2].id);
        await act(() => tabs()[2].dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Home", bubbles: true })));
        assertEquals(tabs()[0].getAttribute("aria-selected"), "true");
        await act(() =>
            tabs()[0].dispatchEvent(new browser.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }))
        );
        assertEquals(tabs()[2].getAttribute("aria-selected"), "true");
        await act(() => tabs()[2].dispatchEvent(new browser.KeyboardEvent("keydown", { key: "End", bubbles: true })));
        assertEquals(tabs()[2].getAttribute("aria-selected"), "true");
        await act(() => header.querySelector('[aria-label="Collapse Session sidebar"]').click());
        assertEquals(stream?.inert, false);
        await act(() => header.querySelector('[aria-label="Show Session sidebar"]').click());
        await act(() => {
            mobile = false;
            for (const listener of listeners) listener();
        });
        assertEquals(stream?.inert, false);
    } finally {
        if (root) await act(() => root.unmount());
        globalThis.fetch = previousFetch;
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
        if (previousActFlag === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
        else globalThis.IS_REACT_ACT_ENVIRONMENT = previousActFlag;
        await browser.happyDOM.close();
    }
});

Deno.test("Session image attachments use a Session-scoped draft key and request payload", () => {
    assertEquals(
        sessionAttachmentsKey("project-1", "session-1"),
        "runwield:owner:project:project-1:session:session-1:image-attachments",
    );
    assertEquals(
        serializeSessionImageForRequest({ id: "img-1", name: "paste.png", mimeType: "image/png", base64: "abc" }),
        { base64: "abc", mimeType: "image/png" },
    );
});

Deno.test("idle Sessions can continue with planning or execution history", () => {
    const planning = deriveSessionAvailability({
        state: "idle",
        generation: 4,
        snapshot: { activeAgent: "Planner", workflowContext: { planName: "feature-a" } },
    });
    assertEquals(planning.key, "available");
    assertEquals(planning.canContinue, true);

    const execution = deriveSessionAvailability({
        state: "idle",
        generation: 4,
        snapshot: { activeAgent: "Engineer", activeExecutionWorkflow: { planName: "feature-a" } },
    });
    assertEquals(execution.key, "available");
    assertEquals(execution.canContinue, true);
});

Deno.test("review_diff stays collapsed while review_complete is an expanded workflow step", async () => {
    const { SessionTimeline } = await import("./components/SessionTimeline.jsx");
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const started = { type: "tool_start", toolCallId: "diff", toolName: "review_diff" };
    const completed = { type: "tool_end", toolCallId: "diff", toolName: "review_diff", output: "README diff" };
    for (const events of [[started], [started, completed], [completed]]) {
        const items = reduceSessionEvents(events);
        assertEquals(items[0].kind, "tool");
        const html = renderToStaticMarkup(createElement(SessionTimeline, { items }));
        assertEquals(html.includes('<details class="session-tool '), true);
        assertEquals(html.includes(" open="), false);
        assertEquals(html.includes("rw-workflow-block"), false);
    }
    const items = reduceSessionEvents([
        completed,
        { type: "tool_end", toolCallId: "read", toolName: "read", output: "Plan requirements" },
        { type: "tool_end", toolCallId: "review", toolName: "review_complete", output: "Review approved." },
    ]);
    assertEquals(items.map((item) => item.kind), ["activity", "workflow"]);
    assertEquals(items[0].items.map((item) => item.toolName), ["review_diff", "read"]);
    assertEquals(items[1].workflowMessage, "review_complete");
});

Deno.test("all workflow tools remain expanded outside routine activity, with accepted reports preserved", async () => {
    const { WORKFLOW_TOOL_NAMES } = await import("../../tools/registry.ts");
    const { workflowToolMarkdown, SessionTimeline } = await import("./components/SessionTimeline.jsx");
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    for (const name of WORKFLOW_TOOL_NAMES) {
        const items = reduceSessionEvents([
            { type: "tool_start", toolCallId: "read-1", toolName: "read" },
            { type: "tool_end", toolCallId: "read-1", toolName: "read", output: "file" },
            { type: "tool_start", toolCallId: "workflow-1", toolName: name },
            {
                type: "tool_end",
                toolCallId: "workflow-1",
                toolName: name,
                output: "Full workflow decision with evidence.",
            },
            { type: "assistant_text_delta", messageId: "reply", delta: "Next step." },
        ]);
        const block = items.find((item) => item.workflowMessage === name);
        assertEquals(block?.kind, "workflow", name);
        assertEquals(block?.status, "completed", name);
        assertEquals(workflowToolMarkdown(block), "Full workflow decision with evidence.", name);
        const html = renderToStaticMarkup(createElement(SessionTimeline, { items: [block] }));
        assertEquals(html.includes('class="rw-workflow-block status-completed"'), true, name);
        assertEquals(html.includes("<details"), false, name);
        assertEquals(html.includes("Full workflow decision with evidence."), true, name);
    }
    const items = reduceSessionEvents([
        { type: "tool_start", toolCallId: "task", toolName: "task_completed" },
        {
            type: "assistant_text_delta",
            messageId: "completion",
            workflowMessage: "task_completed",
            delta: "**Task completed.**\n\nVerified.",
        },
        { type: "tool_end", toolCallId: "task", toolName: "task_completed", output: "Verified." },
    ]);
    assertEquals(items.length, 1);
    assertEquals(items[0].status, "completed");
    assertEquals(workflowToolMarkdown(items[0]), "**Task completed.**\n\nVerified.");
    const triage = reduceSessionEvents([
        {
            type: "tool_end",
            toolCallId: "triage",
            toolName: "triage_report",
            output: "Triage complete.",
            details: {
                routingIntent: "QUICK_FIX",
                complexity: "LOW",
                summary: "Fix image sending.",
            },
        },
    ])[0];
    assertEquals(workflowToolMarkdown(triage).includes("Fix image sending."), true);
    assertEquals(workflowToolMarkdown(triage).includes("QUICK_FIX"), true);
    const workRecord = reduceSessionEvents([
        { type: "tool_start", toolCallId: "record", toolName: "work_record_completed" },
        {
            type: "tool_end",
            toolCallId: "record",
            toolName: "work_record_completed",
            details: { title: "Image sending", summary: "Verified in browser and TUI.", deferredWork: "None." },
        },
        {
            type: "tool_end",
            toolCallId: "record",
            toolName: "work_record_completed",
            output: "Work Record sections accepted.",
            details: { accepted: true },
        },
    ])[0];
    assertEquals(workflowToolMarkdown(workRecord).includes("Verified in browser and TUI."), true);
    assertEquals(workflowToolMarkdown(workRecord).includes("Deferred work"), true);
    const review = {
        markdown: "Approved.",
        details: { advisories: [{ title: "Follow-up", detail: "Keep this visible." }] },
    };
    assertEquals(workflowToolMarkdown(review).includes("Keep this visible."), true);
    const checklist = {
        output: "Manual QA checklist saved.",
        details: { checklistMarkdown: "- [ ] Test on a phone." },
    };
    assertEquals(workflowToolMarkdown(checklist), "- [ ] Test on a phone.");
    const savedChecklist = reduceSessionEvents([
        {
            type: "assistant_text_delta",
            messageId: "qa-message",
            workflowMessage: "manual_qa_checklist",
            delta: "- [ ] Test on a phone.",
        },
        {
            type: "tool_end",
            toolCallId: "qa",
            toolName: "manual_qa_completed",
            details: { checklistMarkdown: "- [ ] Test on a phone." },
        },
    ]);
    assertEquals(savedChecklist.length, 1);
    assertEquals(savedChecklist[0].workflowMessage, "manual_qa_completed");
    const artifact = reduceSessionEvents([{
        type: "tool_end",
        toolCallId: "artifact",
        toolName: "artifact_written",
        output: "Report registered.",
        details: { artifact: { artifactId: "report-1", title: "Session findings" } },
    }]);
    const artifactHtml = renderToStaticMarkup(createElement(SessionTimeline, {
        items: artifact,
        sessionPath: "/projects/project-1/sessions/session-1",
    }));
    assertEquals(artifactHtml.includes('href="/projects/project-1/sessions/session-1/artifacts/report-1"'), true);
    assertEquals(artifactHtml.includes("Open Session findings"), true);
});

Deno.test("image-only user messages survive the browser timeline reducer", () => {
    const images = [{ base64: "aW1hZ2U=", mimeType: "image/png" }];
    const items = reduceSessionEvents([{ type: "user_message", messageId: "image", text: "", images }]);
    assertEquals(items[0].images, images);
    assertEquals(items[0].role, "user");
});

Deno.test("Core busy events show Working at the live edge before any assistant output and clear on idle", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const events = [
        { type: "user_message", messageId: "request", text: "Hello" },
        { type: "busy_changed", busy: true },
    ];
    let items = reduceOperationTransientItems(events);
    const html = renderToStaticMarkup(createElement(SessionTimeline, { items }));
    assertEquals(html.includes('aria-label="Working..."'), true);
    assertEquals(html.includes('class="rw-thinking-glyph"'), true);
    assertEquals(items.at(-1).kind, "busy");
    events.push({ type: "assistant_text_delta", messageId: "reply", delta: "Hello back" });
    events.push({ type: "busy_changed", busy: true });
    items = reduceOperationTransientItems(events);
    assertEquals(items.filter((item) => item.kind === "busy").length, 1);
    assertEquals(items.at(-1).kind, "busy");
    events.push({ type: "busy_changed", busy: false });
    assertEquals(reduceOperationTransientItems(events).some((item) => item.kind === "busy"), false);
    // An old busy event must not turn a reopened transcript into a running Session.
    assertEquals(reduceSessionEvents(events.slice(0, 2)).some((item) => item.kind === "busy"), false);
    assertEquals(reduceOperationTransientItems([]).length, 0);
});

Deno.test("Workspace displays a reported backend denial once", () => {
    const items = reduceSessionEvents([
        { type: "system_status", level: "error", message: "Blocked: read_file" },
        { type: "terminal_error", message: "Blocked: read_file", messageAlreadyReported: true },
        { type: "terminal_error", message: "A different failure" },
    ]);
    assertEquals(items.filter((item) => item.kind === "system-event").map((item) => item.text), [
        "Blocked: read_file\nA different failure",
    ]);
});

Deno.test("Workspace shows a saved provider interruption as history, not a running retry", () => {
    const items = reduceSessionEvents([
        {
            type: "terminal_error",
            eventId: "saved-eof",
            message: "The model service stopped responding before the reply was complete.",
            _meta: { replay: true },
        },
        { type: "assistant_text_delta", eventId: "answer", messageId: "answer", delta: "Recovered answer" },
    ]);
    const text = JSON.stringify(items);
    assertEquals(text.includes("The model service stopped responding before the reply was complete."), true);
    assertEquals(text.includes("Recovered answer"), true);
    assertEquals(text.includes("Retrying in"), false);
});

Deno.test("Session composer preserves drafts across focus changes and shares one Stop or Send action", async () => {
    const previousDocument = globalThis.document;
    const previousActFlag = globalThis.IS_REACT_ACT_ENVIRONMENT;
    globalThis.document = { getElementById: () => null };
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const { createElement } = await import("react");
    const { act, create } = await import("react-test-renderer");
    let renderer;
    let stopped = 0;
    let sent = 0;
    let focused = 0;
    const props = {
        id: "focus-composer",
        draft: "",
        disabled: false,
        canSend: false,
        submitting: false,
        agentValue: "planner",
        agents: [{ name: "planner", displayName: "Planner" }],
        modelValue: "openai\u001fgpt-model",
        thinkingValue: "high",
        onDraftChange() {},
        onSubmit() {
            sent++;
        },
        onStop() {
            stopped++;
        },
    };
    try {
        await act(() => {
            renderer = create(createElement(SessionComposer, props), {
                createNodeMock(element) {
                    return element.type === "textarea"
                        ? {
                            style: {},
                            scrollHeight: 48,
                            focus() {
                                focused++;
                            },
                        }
                        : null;
                },
            });
        });
        const form = () => renderer.root.findByType("form");
        const textarea = () => renderer.root.findByType("textarea");
        const primary = () =>
            renderer.root.findAllByType("button").find((button) =>
                button.props.className?.includes("session-send-button")
            );
        const summary = () => renderer.root.findByProps({ className: "session-composer-summary" });
        assertEquals(form().props["data-expanded"], false);
        assertEquals(textarea().props.hidden, true);
        assertEquals(summary().props.title, "Planner · openai/gpt-model · high");
        assertEquals(primary().props["aria-label"], "Stop");
        assertEquals(primary().props.disabled, false);
        await act(() => primary().props.onClick());
        assertEquals(stopped, 1);
        assertEquals(sent, 0);
        await act(() => summary().props.onFocus());
        assertEquals(form().props["data-expanded"], true);
        assertEquals(textarea().props.hidden, false);
        assertEquals(focused, 1);
        const settings = {};
        await act(() =>
            form().props.onBlurCapture({
                currentTarget: { contains: (target) => target === settings },
                relatedTarget: settings,
            })
        );
        assertEquals(form().props["data-expanded"], true);
        await act(() =>
            renderer.update(createElement(SessionComposer, {
                ...props,
                draft: "Keep this draft",
                canSend: true,
                imageAttachments: [{ id: "image-1", name: "draft.png", mimeType: "image/png", base64: "aW1n" }],
            }))
        );
        assertEquals(primary().props["aria-label"], "Send");
        assertEquals(primary().props.type, "submit");
        await act(() => form().props.onBlurCapture({ currentTarget: { contains: () => false }, relatedTarget: null }));
        assertEquals(form().props["data-expanded"], false);
        assertEquals(textarea().props.value, "Keep this draft");
        assertEquals(summary().children.length, 1);
        assertEquals(summary().children[0].children[0], "Planner · openai/gpt-model · high");
        assertEquals(summary().props["aria-label"], "Continue draft · Planner · openai/gpt-model · high");
        assertEquals(renderer.root.findByProps({ "aria-label": "Attached images" }).props.hidden, true);
        await act(() => summary().props.onClick());
        assertEquals(textarea().props.value, "Keep this draft");
        assertEquals(renderer.root.findByProps({ "aria-label": "Attached images" }).props.hidden, false);
        await act(() => form().props.onSubmit({ preventDefault() {} }));
        assertEquals(sent, 1);
        await act(() =>
            renderer.update(createElement(SessionComposer, {
                ...props,
                draft: " ",
                canSend: true,
                imageAttachments: [{ id: "image-1", name: "draft.png", mimeType: "image/png", base64: "aW1n" }],
            }))
        );
        assertEquals(primary().props["aria-label"], "Send");
        await act(() => renderer.update(createElement(SessionComposer, { ...props, draft: " " })));
        assertEquals(primary().props["aria-label"], "Stop");
    } finally {
        if (renderer) await act(() => renderer.unmount());
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
        if (previousActFlag === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
        else globalThis.IS_REACT_ACT_ENVIRONMENT = previousActFlag;
    }
});

Deno.test("saved and live reports reconcile by call and retain chronological Activity boundaries", () => {
    const time = (minute) => `2026-09-19T20:${minute}:00.000Z`;
    const report = (call, minute) => [
        { type: "tool_end", toolName: "task_completed", toolCallId: call, timestamp: time(minute) },
        {
            type: "assistant_text_delta",
            workflowMessage: "task_completed",
            toolCallId: call,
            messageId: `report-${call}`,
            delta: `Report ${call}`,
            timestamp: time(minute),
        },
    ];
    const tools = (prefix, minute) =>
        [1, 2].map((n) => ({
            type: "tool_end",
            toolName: "read",
            toolCallId: `${prefix}-${n}`,
            timestamp: time(minute),
        }));
    const saved = reduceSessionEvents([
        ...report("first", "24"),
        ...tools("saved", "25"),
        ...report("second", "53"),
    ]);
    const live = reduceSessionEvents([
        ...report("first", "24"),
        ...tools("saved", "25"),
        { type: "assistant_thinking_end", messageId: "review-thinking", timestamp: time("28") },
        ...tools("review", "29"),
        {
            type: "assistant_text_delta",
            workflowMessage: "review_complete",
            toolCallId: "review",
            messageId: "review-report",
            delta: "Repair required",
            timestamp: time("30"),
        },
        ...report("second", "53"),
    ], { source: "transient" });
    const items = mergeSessionTimelineItems(saved, live);
    assertEquals(items.map((item) => item.workflowMessage || item.kind), [
        "task_completed",
        "activity",
        "review_complete",
        "task_completed",
    ]);
    assertEquals(items.filter((item) => item.kind === "workflow").map((item) => item.timestamp), [
        time("24"),
        time("30"),
        time("53"),
    ]);
    assertEquals(items[1].items.map((item) => item.toolCallId || item.kind), [
        "saved-1",
        "saved-2",
        "thinking",
        "review-1",
        "review-2",
    ]);
    assertEquals(new Set(items[1].items.map((item) => item.key)).size, 5);
});

Deno.test("Activity never spans a user message or special report", () => {
    const tool = (id) => ({ type: "tool_end", toolName: "read", toolCallId: id });
    const items = reduceSessionEvents([
        tool("a"),
        tool("b"),
        { type: "user_message", messageId: "user", text: "Earlier request" },
        tool("c"),
        { type: "assistant_thinking_end", messageId: "thinking" },
        { type: "tool_end", toolName: "manual_qa_completed", toolCallId: "qa" },
        tool("d"),
        tool("e"),
        { type: "assistant_text_delta", messageId: "reply", delta: "Done" },
    ]);
    assertEquals(items.map((item) => item.kind), [
        "activity",
        "message",
        "activity",
        "workflow",
        "activity",
        "message",
    ]);
    assertEquals(
        items.filter((item) => item.kind === "activity").map((item) => item.items.map((entry) => entry.kind)),
        [["tool", "tool"], ["tool", "thinking"], ["tool", "tool"]],
    );
});

Deno.test("nested completion reports keep their call identity and accepted time after late results", () => {
    const time = (minute) => `2026-09-19T20:${minute}:00.000Z`;
    const items = reduceSessionEvents([
        { type: "tool_start", toolName: "task_completed", toolCallId: "outer", timestamp: time("23") },
        { type: "tool_start", toolName: "task_completed", toolCallId: "inner", timestamp: time("24") },
        {
            type: "assistant_text_delta",
            workflowMessage: "task_completed",
            toolCallId: "outer",
            messageId: "outer-report",
            delta: "Outer report",
            timestamp: time("25"),
        },
        {
            type: "assistant_text_delta",
            workflowMessage: "task_completed",
            toolCallId: "inner",
            messageId: "inner-report",
            delta: "Inner report",
            timestamp: time("26"),
        },
        { type: "tool_end", toolName: "task_completed", toolCallId: "outer", timestamp: time("53") },
        { type: "tool_end", toolName: "task_completed", toolCallId: "inner", timestamp: time("54") },
    ]);
    assertEquals(items.map((item) => [item.toolCallId, item.markdown, item.timestamp]), [[
        "outer",
        "Outer report",
        time("25"),
    ], ["inner", "Inner report", time("26")]]);
});

Deno.test("live updates finish saved running tools without dropping later repeated user text", () => {
    const saved = reduceSessionEvents([
        { type: "user_message", messageId: "saved-user", text: "Continue", timestamp: "2026-09-19T20:00:01Z" },
        { type: "tool_start", toolCallId: "call", toolName: "read", timestamp: "2026-09-19T20:01:00Z" },
    ]);
    const live = reduceSessionEvents([
        { type: "user_message", messageId: "live-user", text: "Continue", timestamp: "2026-09-19T20:00:00Z" },
        { type: "tool_end", toolCallId: "call", toolName: "read", output: "Result", timestamp: "2026-09-19T20:02:00Z" },
        { type: "user_message", messageId: "later-user", text: "Continue", timestamp: "2026-09-19T20:03:00Z" },
    ], { source: "transient" });
    const items = mergeSessionTimelineItems(saved, live);
    assertEquals(items.map((item) => item.kind), ["message", "tool", "message"]);
    assertEquals(items[1].status, "completed");
    assertEquals(items[1].output, "Result");
    assertEquals(items[2].timestamp, "2026-09-19T20:03:00Z");
});

Deno.test("Workflow Resume submits the committed version and reports progress and errors inside the mobile sidebar", async () => {
    const browser = new Window({ url: "http://localhost" });
    const globals = [
        "window",
        "document",
        "location",
        "localStorage",
        "sessionStorage",
        "HTMLElement",
        "CustomEvent",
        "matchMedia",
        "ResizeObserver",
    ];
    const previous = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const previousFetch = globalThis.fetch;
    const previousActFlag = globalThis.IS_REACT_ACT_ENVIRONMENT;
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const mobile = true;
    const listeners = new Set();
    const media = {
        get matches() {
            return mobile;
        },
        addEventListener(_event, listener) {
            listeners.add(listener);
        },
        removeEventListener(_event, listener) {
            listeners.delete(listener);
        },
    };
    const header = browser.document.createElement("div");
    header.setAttribute("data-workspace-header-actions", "");
    const container = browser.document.createElement("div");
    browser.document.body.append(header, container);
    let root;
    try {
        for (const key of globals) {
            const value = key === "window"
                ? browser
                : key === "matchMedia"
                ? (query) => query === "(max-width: 900px)" ? media : browser.matchMedia(query)
                : browser[key];
            Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
        }
        globalThis.IS_REACT_ACT_ENVIRONMENT = true;
        const submissions = [];
        let generation = 7;
        let planStatus = "implemented";
        let timelineReads = 0;
        let settle;
        let liveOperation = null;
        globalThis.fetch = (url, options = {}) => {
            const path = String(url);
            if (path.endsWith("/plan-workflow")) {
                submissions.push(JSON.parse(options.body));
                return new Promise((resolve) => {
                    settle = resolve;
                });
            }
            if (path.endsWith("/live")) {
                return Promise.resolve(
                    Response.json({ state: liveOperation ? "active" : "idle", generation, operation: liveOperation }),
                );
            }
            if (path.includes("/session-operations/")) return Promise.resolve(Response.json(liveOperation));
            if (path.includes("session-options")) {
                return Promise.resolve(Response.json({ agents: [], models: [], commands: [], defaults: {} }));
            }
            if (path.includes("/timeline?")) timelineReads++;
            return Promise.resolve(Response.json({
                state: "idle",
                plan: { status: planStatus },
                canResume: true,
                generation,
                events: [],
                complete: true,
                snapshot: {
                    workflowContext: { planId: "repair-plan", planName: "Repair Plan" },
                },
            }));
        };
        root = createRoot(container);
        await act(async () =>
            root.render(
                (await import("react")).createElement(SessionSurface, {
                    projectId: crypto.randomUUID(),
                    runwieldSessionId: crypto.randomUUID(),
                }),
            )
        );
        await act(() => header.querySelector('[aria-label="Show Session sidebar"]').click());
        const sidebar = () => container.querySelector('[aria-label="Workflow"]');
        const resume = () => sidebar().querySelector("button");
        const readsBefore = timelineReads;
        await act(() => resume().click());
        assertEquals(submissions.length, 1);
        assertEquals(submissions[0].action, "resume");
        assertEquals(submissions[0].planId, "repair-plan");
        assertEquals(submissions[0].expectedGeneration, 7);
        assertEquals(resume().disabled, true);
        assertStringIncludes(sidebar().querySelector('[role="status"]').textContent, "Resume in progress");
        await act(() => resume().click());
        assertEquals(submissions.length, 1);
        await act(() => {
            generation = 8;
            settle(Response.json({ kind: "paused", reason: "Code Review is ready." }, { status: 202 }));
        });
        assertEquals(resume().disabled, false);
        assertEquals(timelineReads > readsBefore, true);
        assertEquals(sidebar().querySelector('[role="status"]').textContent, "Code Review is ready.");
        await act(() => resume().click());
        assertEquals(submissions[1].expectedGeneration, 8);
        await act(() =>
            settle(Response.json({ error: "Session is busy. Try again when the turn finishes." }, { status: 409 }))
        );
        assertEquals(resume().disabled, false);
        assertStringIncludes(sidebar().querySelector('[role="alert"]').textContent, "Session is busy");
        await act(() => resume().click());
        await act(() => {
            liveOperation = {
                operationId: "resumed-validation",
                status: "running",
                remote: true,
                events: [{
                    type: "system_status",
                    message: "Running the tests in the execution worktree.",
                    validationProgress: {
                        kind: "workflow",
                        outcome: "running",
                        stage: "ci",
                        checks: { ci: "running", semanticReview: "pending", humanReview: "pending", merge: "pending" },
                    },
                }],
            };
            globalThis.dispatchEvent(new Event("focus"));
        });
        assertStringIncludes(sidebar().textContent, "Running the tests in the execution worktree.");
        assertEquals(sidebar().querySelector('li[aria-current="step"] span').textContent, "Verification Command");
        assertEquals(resume().textContent, "Open Session");
        await act(() => resume().click());
        assertEquals(container.querySelector(".session-stream-panel").inert, false);
        assertEquals(header.querySelector('[aria-label="Show Session sidebar"]') !== null, true);
        await act(() => settle(Response.json({ kind: "paused", reason: "Validation paused." }, { status: 202 })));
        liveOperation = null;
        planStatus = "ready_for_work";
        await act(async () =>
            root.render((await import("react")).createElement(SessionSurface, {
                key: "saved-plan",
                projectId: "project",
                runwieldSessionId: "saved-session",
            }))
        );
        await act(() => header.querySelector('[aria-label="Show Session sidebar"]').click());
        assertEquals(resume().textContent, "Review Plan");
        let navigated = "";
        browser.document.addEventListener("runwield:workspace-navigate", (event) => {
            navigated = event.detail.href;
            event.preventDefault();
        });
        await act(() => resume().click());
        assertEquals(submissions.at(-1).action, "review_plan");
        const reviewUrl = "/projects/project/plans/saved?session=saved-session&operation=review&interaction=approval";
        await act(() => settle(Response.json({ reviewUrl }, { status: 202 })));
        assertEquals(navigated, reviewUrl);
    } finally {
        if (root) await act(() => root.unmount());
        globalThis.fetch = previousFetch;
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
        if (previousActFlag === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
        else globalThis.IS_REACT_ACT_ENVIRONMENT = previousActFlag;
        await browser.happyDOM.close();
    }
});

Deno.test("mobile Answer agent reveals the waiting question", async () => {
    const browser = new Window({ url: "http://localhost" });
    const globals = [
        "window",
        "document",
        "location",
        "localStorage",
        "sessionStorage",
        "HTMLElement",
        "CustomEvent",
        "matchMedia",
        "ResizeObserver",
        "requestAnimationFrame",
    ];
    const previous = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const previousFetch = globalThis.fetch;
    const previousActFlag = globalThis.IS_REACT_ACT_ENVIRONMENT;
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const mobile = true;
    const listeners = new Set();
    const media = {
        get matches() {
            return mobile;
        },
        addEventListener(_event, listener) {
            listeners.add(listener);
        },
        removeEventListener(_event, listener) {
            listeners.delete(listener);
        },
    };
    const header = browser.document.createElement("div");
    header.setAttribute("data-workspace-header-actions", "");
    const container = browser.document.createElement("div");
    browser.document.body.append(header, container);
    let root;
    try {
        for (const key of globals) {
            const value = key === "window"
                ? browser
                : key === "matchMedia"
                ? (query) => query === "(max-width: 900px)" ? media : browser.matchMedia(query)
                : browser[key];
            Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
        }
        globalThis.IS_REACT_ACT_ENVIRONMENT = true;
        const generation = 7;
        const planStatus = "implemented";
        const liveOperation = {
            operationId: "question-operation",
            status: "running",
            remote: true,
            events: [],
            liveInteraction: { interactionId: "question", request: { type: "text", prompt: "Which option?" } },
        };
        globalThis.fetch = (url) => {
            const path = String(url);
            if (path.endsWith("/live")) {
                return Promise.resolve(
                    Response.json({ state: liveOperation ? "active" : "idle", generation, operation: liveOperation }),
                );
            }
            if (path.includes("/session-operations/")) return Promise.resolve(Response.json(liveOperation));
            if (path.includes("session-options")) {
                return Promise.resolve(Response.json({ agents: [], models: [], commands: [], defaults: {} }));
            }
            return Promise.resolve(Response.json({
                state: "idle",
                plan: { status: planStatus },
                canResume: true,
                generation,
                events: [],
                complete: true,
                snapshot: {
                    workflowContext: { planId: "repair-plan", planName: "Repair Plan" },
                },
            }));
        };
        root = createRoot(container);
        await act(async () =>
            root.render(
                (await import("react")).createElement(SessionSurface, {
                    projectId: crypto.randomUUID(),
                    runwieldSessionId: crypto.randomUUID(),
                }),
            )
        );
        await act(() => header.querySelector('[aria-label="Show Session sidebar"]').click());
        const sidebar = () => container.querySelector('[aria-label="Workflow"]');
        const answer = sidebar().querySelector("button");
        assertEquals(answer.textContent, "Answer agent");
        await act(() => answer.click());
        assertEquals(container.querySelector(".session-stream-panel").inert, false);
        assertEquals(container.querySelector("#session-context-sidebar").hidden, true);
    } finally {
        if (root) await act(() => root.unmount());
        globalThis.fetch = previousFetch;
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
        if (previousActFlag === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
        else globalThis.IS_REACT_ACT_ENVIRONMENT = previousActFlag;
        await browser.happyDOM.close();
    }
});

Deno.test("New Session selects a registered Project by route and creates only with destination defaults", async () => {
    const browser = new Window({ url: "http://localhost/projects/project-a/sessions/new" });
    const globals = [
        "window",
        "document",
        "location",
        "localStorage",
        "sessionStorage",
        "HTMLElement",
        "CustomEvent",
        "matchMedia",
    ];
    const previous = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const previousFetch = globalThis.fetch;
    const previousEventSource = globalThis.EventSource;
    const previousActFlag = globalThis.IS_REACT_ACT_ENVIRONMENT;
    const posts = [];
    const navigations = [];
    let failNavigation = true;
    let renderer;
    const { createElement, act } = await import("react");
    const { create } = await import("react-test-renderer");
    try {
        for (const key of globals) {
            Object.defineProperty(globalThis, key, {
                configurable: true,
                writable: true,
                value: key === "window"
                    ? browser
                    : key === "matchMedia"
                    ? browser.matchMedia.bind(browser)
                    : browser[key],
            });
        }
        globalThis.IS_REACT_ACT_ENVIRONMENT = true;
        globalThis.EventSource = class {
            close() {}
            addEventListener() {}
        };
        document.addEventListener("runwield:workspace-navigate", (event) => {
            event.preventDefault();
            navigations.push(event.detail.href);
            event.detail.onComplete?.(failNavigation ? new Error("Navigation failed") : undefined);
        });
        globalThis.fetch = (url, options = {}) => {
            const path = String(url);
            if (options.method === "POST") {
                posts.push({ path, body: JSON.parse(options.body) });
                return Promise.resolve(
                    Response.json({ operationId: "accepted-b", status: "running" }, { status: 202 }),
                );
            }
            if (path === "/api/owner/projects") {
                return Promise.resolve(Response.json({
                    projects: [
                        { projectId: "project-a", displayName: "A", enabled: true },
                        { projectId: "project-b", displayName: "B", enabled: true },
                        { projectId: "disabled", displayName: "Disabled", enabled: false },
                    ],
                }));
            }
            if (path.includes("session-options")) {
                return Promise.resolve(Response.json({
                    agents: [{ name: path.includes("project-b") ? "guide" : "router", displayName: "Agent" }],
                    models: [],
                    thinkingLevels: [],
                    defaults: { agentName: path.includes("project-b") ? "guide" : "router" },
                }));
            }
            if (path.includes("session-operations")) {
                return Promise.resolve(Response.json({ status: "running", events: [] }));
            }
            throw new Error(`Unexpected request: ${path}`);
        };
        await act(() => {
            renderer = create(createElement(SessionSurface, { projectId: "project-a", mode: "new" }));
        });
        const choice = () => renderer.root.findByProps({ id: "new-session-project" });
        const composer = () => renderer.root.findByType(SessionComposer);
        assertEquals(choice().props.value, "project-a");
        assertEquals(
            choice().props.children.flat(Infinity).some((option) => option?.props?.value === "disabled"),
            false,
        );
        assertEquals(composer().props.disabled, false);
        await act(() => choice().props.onChange({ currentTarget: { value: "project-b" } }));
        assertEquals(choice().props.value, "project-a");
        assertEquals(composer().props.disabled, false);
        failNavigation = false;
        await act(() => choice().props.onChange({ currentTarget: { value: "project-b" } }));
        assertEquals(navigations, ["/projects/project-b/sessions/new", "/projects/project-b/sessions/new"]);
        assertEquals(composer().props.disabled, true);
        await act(() => renderer.unmount());
        sessionStorage.setItem(newSessionDraftInstanceStorageKey("project-b"), "draft-b");
        await saveSessionDraft(sessionDraftKey("project-b", "draft-b"), "saved B");
        await act(() => {
            renderer = create(createElement(SessionSurface, { projectId: "project-b", mode: "new" }));
        });
        assertEquals(choice().props.value, "project-b");
        assertEquals(composer().props.agentValue, "guide");
        assertEquals(composer().props.draft, "saved B");
        assertEquals(choice().props.disabled, true);
        await act(() => choice().props.onChange({ currentTarget: { value: "project-a" } }));
        assertEquals(navigations.length, 2);
        await act(() => composer().props.onDraftChange("  "));
        assertEquals(choice().props.disabled, true);
        await act(() => composer().props.onDraftChange(""));
        assertEquals(choice().props.disabled, false);
        await act(() => composer().props.onDraftChange("Send in B"));
        await act(async () => {
            await composer().props.onSubmit();
        });
        assertEquals(posts.map((item) => item.path), ["/api/owner/projects/project-b/sessions"]);
        assertEquals(posts[0].body.agentName, "guide");
        assertEquals(posts[0].body.model, "");
        assertEquals(renderer.root.findAllByProps({ id: "new-session-project" }).length, 0);
    } finally {
        if (renderer) await act(() => renderer.unmount());
        globalThis.EventSource = previousEventSource;
        globalThis.fetch = previousFetch;
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
        if (previousActFlag === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
        else globalThis.IS_REACT_ACT_ENVIRONMENT = previousActFlag;
        await browser.happyDOM.close();
    }
});

// Exercise the New Session UI with a real mounted surface and only the browser/network boundaries replaced.
async function withNewSessionSurface(run, fetchResponse = defaultNewSessionResponse) {
    const browser = new Window({ url: "http://localhost/projects/project-a/sessions/new" });
    const keys = [
        "window",
        "document",
        "location",
        "localStorage",
        "sessionStorage",
        "HTMLElement",
        "CustomEvent",
        "matchMedia",
        "FileReader",
        "EventSource",
    ];
    const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const previousFetch = globalThis.fetch;
    const previousActFlag = globalThis.IS_REACT_ACT_ENVIRONMENT;
    const { createElement, act } = await import("react");
    const { create } = await import("react-test-renderer");
    let renderer;
    try {
        for (const key of keys) {
            Object.defineProperty(globalThis, key, {
                configurable: true,
                writable: true,
                value: key === "window"
                    ? browser
                    : key === "matchMedia"
                    ? browser.matchMedia.bind(browser)
                    : browser[key],
            });
        }
        globalThis.IS_REACT_ACT_ENVIRONMENT = true;
        globalThis.EventSource = class {
            close() {}
            addEventListener() {}
        };
        globalThis.fetch = (url, options = {}) => Promise.resolve().then(() => fetchResponse(String(url), options));
        const mount = async (projectId = "project-a", mode = "new") => {
            if (renderer) await act(() => renderer.unmount());
            await act(() => {
                renderer = create(createElement(SessionSurface, { projectId, mode }));
            });
        };
        const choice = () => renderer.root.findAllByProps({ id: "new-session-project" })[0];
        const composer = () => renderer.root.findByType(SessionComposer);
        await run({
            browser,
            mount,
            choice,
            composer,
            act,
            get renderer() {
                return renderer;
            },
        });
    } finally {
        if (renderer) await act(() => renderer.unmount());
        globalThis.fetch = previousFetch;
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
        if (previousActFlag === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
        else globalThis.IS_REACT_ACT_ENVIRONMENT = previousActFlag;
        await browser.happyDOM.close();
    }
}

function deferredResponse() {
    let resolve;
    let reject;
    const promise = new Promise((accept, decline) => {
        resolve = accept;
        reject = decline;
    });
    return { promise, resolve, reject };
}

Deno.test("New Session ignores a late create response after opening another surface", async () => {
    const pending = deferredResponse();
    const navigations = [];
    await withNewSessionSurface(async ({ mount, composer, act }) => {
        document.addEventListener("runwield:workspace-navigate", (event) => {
            event.preventDefault();
            navigations.push(event.detail.href);
        });
        await mount();
        await act(() => composer().props.onDraftChange("Start A"));
        let send;
        await act(() => {
            send = composer().props.onSubmit();
        });
        await mount("project-b"); // Sidebar navigation unmounts A before its POST settles.
        await act(async () => {
            pending.resolve(Response.json({ runwieldSessionId: "a-session" }, { status: 202 }));
            await send;
        });
        assertEquals(navigations, []);
        assertEquals(composer().props.disabled, false);
    }, (url, options) => options.method === "POST" ? pending.promise : defaultNewSessionResponse(url));
});

function defaultNewSessionResponse(url) {
    if (url === "/api/owner/projects") {
        return Response.json({
            projects: [
                { projectId: "project-a", displayName: "A", enabled: true },
                { projectId: "project-b", displayName: "B", enabled: true },
            ],
        });
    }
    if (url.includes("session-options")) return Response.json({ agents: [], models: [], defaults: {} });
    if (url.includes("session-operations")) return Response.json({ status: "running", events: [] });
    throw new Error(`Unexpected request: ${url}`);
}

Deno.test("New Session locks Project while an image is read and after it is attached or restored", async () => {
    await withNewSessionSurface(async ({ browser, mount, choice, composer, act }) => {
        await mount();
        let reader;
        globalThis.FileReader = class {
            readAsDataURL() {
                reader = this;
            }
        };
        let reading;
        await act(() => {
            reading = composer().props.onFiles([{ type: "image/png", size: 3, name: "shot.png" }]);
        });
        assertEquals(choice().props.disabled, true);
        await act(async () => {
            reader.result = "data:image/png;base64,aW1n";
            reader.onload();
            await reading;
        });
        assertEquals(composer().props.imageAttachments.length, 1);
        assertEquals(choice().props.disabled, true);
        await act(() => composer().props.onRemoveImage(composer().props.imageAttachments[0].id));
        assertEquals(choice().props.disabled, false);
        const storageId = "saved-b";
        browser.sessionStorage.setItem(newSessionDraftInstanceStorageKey("project-b"), storageId);
        await saveSessionDraft(sessionDraftKey("project-b", storageId), "");
        await saveSessionDraft(
            sessionAttachmentsKey("project-b", storageId),
            JSON.stringify([{ id: "restored", name: "old.png", mimeType: "image/png", base64: "aW1n" }]),
        );
        await mount("project-b");
        assertEquals(composer().props.imageAttachments.length, 1);
        assertEquals(choice().props.disabled, true);
    });
});

Deno.test("New Session waits for reads and ignores stale Project options", async () => {
    const projects = deferredResponse();
    const optionsA = deferredResponse();
    const optionsB = deferredResponse();
    let projectReads = 0;
    await withNewSessionSurface(
        async ({ mount, choice, composer, act }) => {
            await mount();
            assertEquals(choice().props.disabled, true);
            assertEquals(composer().props.disabled, true);
            await act(() => projects.resolve(defaultNewSessionResponse("/api/owner/projects")));
            assertEquals(composer().props.disabled, true);
            await mount("project-b");
            await act(() =>
                optionsB.resolve(Response.json({ agents: [{ name: "guide" }], defaults: { agentName: "guide" } }))
            );
            assertEquals(composer().props.agentValue, "guide");
            assertEquals(composer().props.disabled, false);
            await act(() =>
                optionsA.resolve(Response.json({ agents: [{ name: "old" }], defaults: { agentName: "old" } }))
            );
            assertEquals(composer().props.agentValue, "guide");
        },
        (url) =>
            url === "/api/owner/projects"
                ? ++projectReads === 1 ? projects.promise : defaultNewSessionResponse(url)
                : url.includes("project-a/session-options")
                ? optionsA.promise
                : url.includes("project-b/session-options")
                ? optionsB.promise
                : defaultNewSessionResponse(url),
    );
});

Deno.test("New Session read failures offer Retry without sending or losing a draft", async () => {
    let projectsFails = true;
    let optionsFails = true;
    await withNewSessionSurface(
        async (surface) => {
            const { mount, choice, composer, act } = surface;
            await mount();
            await act(() => composer().props.onDraftChange("keep me"));
            assertEquals(choice(), undefined);
            assertEquals(composer().props.disabled, true);
            assertStringIncludes(JSON.stringify(surface.renderer.toJSON()), "Projects could not load");
            projectsFails = false;
            const retryProjects = surface.renderer.root.findAllByType("button").find((button) =>
                button.props.children === "Retry" && button.parent?.props.role === "alert"
            );
            await act(() => retryProjects.props.onClick());
            assertEquals(choice().props.disabled, true);
            assertStringIncludes(JSON.stringify(surface.renderer.toJSON()), "Session settings could not load");
            optionsFails = false;
            const retryOptions = surface.renderer.root.findAllByType("button").find((button) =>
                button.props.children === "Retry"
            );
            await act(() => retryOptions.props.onClick());
            assertEquals(composer().props.draft, "keep me");
            assertEquals(composer().props.disabled, false);
        },
        (url) =>
            url === "/api/owner/projects" && projectsFails
                ? Promise.reject(new Error("offline"))
                : url.includes("session-options") && optionsFails
                ? Promise.reject(new Error("offline"))
                : defaultNewSessionResponse(url),
    );
});

Deno.test("New Session pending and network-error retry stay bound to the original Project", async () => {
    const pending = deferredResponse();
    const posts = [];
    await withNewSessionSurface(async ({ mount, choice, composer, act }) => {
        await mount("project-b");
        await act(() => composer().props.onDraftChange("Retry B"));
        let send;
        await act(() => {
            send = composer().props.onSubmit();
        });
        assertEquals(choice().props.disabled, true);
        assertEquals(composer().props.disabled, true);
        await act(async () => {
            pending.reject(new Error("network lost"));
            await send;
        });
        assertEquals(choice().props.disabled, true);
        assertEquals(composer().props.draft, "Retry B");
        await act(() => composer().props.onDraftChange(""));
        assertEquals(choice().props.disabled, true);
        await act(() => composer().props.onDraftChange("Retry B"));
        await act(() => composer().props.onSubmit());
        assertEquals(posts.length, 2);
        assertEquals(posts[0].url, "/api/owner/projects/project-b/sessions");
        assertEquals(posts[1].url, posts[0].url);
        assertEquals(posts[1].body.requestId, posts[0].body.requestId);
        assertEquals(choice(), undefined);
    }, (url, options) => {
        if (options.method !== "POST") return defaultNewSessionResponse(url);
        posts.push({ url, body: JSON.parse(options.body) });
        return posts.length === 1
            ? pending.promise
            : Response.json({ operationId: "accepted-b", status: "running" }, { status: 202 });
    });
});

Deno.test("New Session HTTP 422 preserves the editable draft and Project", async () => {
    await withNewSessionSurface(
        async ({ mount, choice, composer, act }) => {
            await mount("project-b");
            await act(() => composer().props.onDraftChange("Fix this"));
            await act(() => composer().props.onSubmit());
            assertEquals(composer().props.draft, "Fix this");
            assertEquals(choice().props.value, "project-b");
            assertEquals(choice().props.disabled, true);
            await act(() => composer().props.onDraftChange(""));
            assertEquals(choice().props.disabled, false);
        },
        (url, options) =>
            options.method === "POST"
                ? Response.json({ error: "Invalid request" }, { status: 422 })
                : defaultNewSessionResponse(url),
    );
});

Deno.test("New Session ignores late Project choices from an unmounted surface", async () => {
    const oldProjects = deferredResponse();
    let projectReads = 0;
    await withNewSessionSurface(
        async ({ mount, choice, composer, act }) => {
            await mount();
            assertEquals(composer().props.disabled, true);
            await mount("project-b");
            assertEquals(choice().props.value, "project-b");
            await act(() =>
                oldProjects.resolve(Response.json({
                    projects: [
                        { projectId: "project-a", displayName: "A", enabled: true },
                    ],
                }))
            );
            assertEquals(choice().props.value, "project-b");
            assertEquals(composer().props.disabled, false);
        },
        (url) =>
            url === "/api/owner/projects" && ++projectReads === 1
                ? oldProjects.promise
                : defaultNewSessionResponse(url),
    );
});

async function startObservedNewSession(surface) {
    await surface.mount();
    await surface.act(() => surface.composer().props.onDraftChange("Start observation"));
    await surface.act(() => surface.composer().props.onSubmit());
}

Deno.test("New Session fallback does not overlap a slow operation read", async () => {
    const pending = deferredResponse();
    const reads = [];
    let stream;
    await withNewSessionSurface(async (surface) => {
        globalThis.EventSource = class {
            constructor() {
                stream = this;
            }
            close() {}
        };
        await startObservedNewSession(surface);
        // A broken stream switches the mounted surface to the HTTP fallback.
        await surface.act(() => stream.onerror());
        assertEquals(reads.length, 1);
        await new Promise((resolve) => setTimeout(resolve, 1650));
        assertEquals(reads.length, 1);
        await surface.act(() => pending.resolve(Response.json({ status: "running", events: [] })));
        await new Promise((resolve) => setTimeout(resolve, 1650));
        assertEquals(reads.length >= 2, true);
    }, (url, options) => {
        if (options.method === "POST") {
            return Response.json({ operationId: "slow-operation", status: "running" }, { status: 202 });
        }
        if (url === "/api/owner/session-operations/slow-operation") {
            reads.push(options.signal);
            return reads.length === 1 ? pending.promise : Response.json({ status: "running", events: [] });
        }
        return defaultNewSessionResponse(url);
    });
});

Deno.test("New Session abandons an old fallback read on navigation and unmount", async () => {
    const pending = deferredResponse();
    const reads = [];
    let stream;
    await withNewSessionSurface(async (surface) => {
        globalThis.EventSource = class {
            constructor() {
                stream = this;
            }
            close() {}
        };
        await startObservedNewSession(surface);
        await surface.act(() => stream.onerror());
        assertEquals(reads.length, 1);
        await surface.mount("project-b");
        assertEquals(reads[0].aborted, true);
        await surface.act(() => pending.resolve(Response.json({ status: "unknown", events: [] })));
        assertEquals(surface.composer().props.disabled, false);
        assertEquals(JSON.stringify(surface.renderer.toJSON()).includes("interrupted"), false);
    }, (url, options) => {
        if (options.method === "POST") {
            return Response.json({ operationId: "old-operation", status: "running" }, { status: 202 });
        }
        if (url === "/api/owner/session-operations/old-operation") {
            reads.push(options.signal);
            return pending.promise;
        }
        return defaultNewSessionResponse(url);
    });
});

Deno.test("New Session terminal stream message followed by error does not report an interruption", async () => {
    const streams = [];
    const reads = [];
    await withNewSessionSurface(async (surface) => {
        globalThis.EventSource = class {
            constructor() {
                streams.push(this);
            }
            close() {}
        };
        await startObservedNewSession(surface);
        assertEquals(streams.length, 1);
        await surface.act(() => {
            streams[0].onmessage({ data: JSON.stringify({ status: "completed", events: [] }) });
            streams[0].onerror();
        });
        await new Promise((resolve) => setTimeout(resolve, 1650));
        assertEquals(reads, []);
        assertEquals(JSON.stringify(surface.renderer.toJSON()).includes("interrupted"), false);
    }, (url, options) => {
        if (options.method === "POST") {
            return Response.json({ operationId: "finished-operation", status: "running" }, { status: 202 });
        }
        if (url.includes("session-operations")) reads.push(url);
        return defaultNewSessionResponse(url);
    });
});

Deno.test("Session history confirms busy archive before any request and guards duplicate actions", async () => {
    const { SessionList } = await import("./components/SessionList.jsx");
    const { createElement, act } = await import("react");
    const { create } = await import("react-test-renderer");
    const previousFetch = globalThis.fetch;
    const previousConfirm = globalThis.confirm;
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
    let renderer;
    const requests = [];
    let finish;
    try {
        globalThis.IS_REACT_ACT_ENVIRONMENT = true;
        Object.defineProperty(globalThis, "document", {
            configurable: true,
            value: { cookie: "rw_owner_csrf=archive-token" },
        });
        globalThis.confirm = () => false;
        globalThis.fetch = (url, options) => {
            requests.push({ url: String(url), body: JSON.parse(options.body), headers: options.headers });
            return new Promise((resolve) => {
                finish = resolve;
            });
        };
        await act(() => {
            renderer = create(
                createElement(SessionList, {
                    projectId: "project one",
                    data: {
                        sessions: [{ runwieldSessionId: "busy one", displayName: "Busy Session", state: "active" }],
                    },
                }),
            );
        });
        const archive = () =>
            renderer.root.findAllByType("button").find((button) =>
                button.props["aria-label"] === "Archive Busy Session"
            );
        await act(async () => {
            await archive().props.onClick();
        });
        assertEquals(requests.length, 0);
        assertEquals(renderer.root.findAllByProps({ className: "session-list-name" }).length, 1);
        globalThis.confirm = () => true;
        const action = archive().props.onClick;
        let pending;
        await act(() => {
            pending = action();
        });
        assertEquals(archive().props.disabled, true);
        await act(async () => {
            await action();
        });
        assertEquals(requests.length, 1);
        assertEquals(requests[0].url, "/api/owner/projects/project%20one/sessions/busy%20one/archive");
        assertEquals(requests[0].body, { confirmed: true });
        assertEquals(requests[0].headers["x-runwield-csrf"], "archive-token");
        await act(async () => {
            finish(Response.json({}));
            await pending;
        });
        assertEquals(renderer.root.findAllByProps({ className: "session-list-name" }).length, 0);
    } finally {
        if (renderer) await act(() => renderer.unmount());
        globalThis.fetch = previousFetch;
        globalThis.confirm = previousConfirm;
        globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct;
        if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
        else delete globalThis.document;
    }
});

Deno.test("Idle archive failure keeps its open link and supports retry; archived rows unarchive without confirmation", async () => {
    const { SessionList } = await import("./components/SessionList.jsx");
    const { createElement, act } = await import("react");
    const { create } = await import("react-test-renderer");
    const previousFetch = globalThis.fetch;
    const previousConfirm = globalThis.confirm;
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
    let renderer;
    const requests = [];
    try {
        globalThis.IS_REACT_ACT_ENVIRONMENT = true;
        Object.defineProperty(globalThis, "document", { configurable: true, value: { cookie: "" } });
        globalThis.confirm = () => {
            throw new Error("Idle and Unarchive must not confirm");
        };
        globalThis.fetch = (url, options) => {
            requests.push({ url: String(url), body: JSON.parse(options.body) });
            return Promise.resolve(
                requests.length === 1
                    ? Response.json({ error: "Storage is unavailable." }, { status: 503 })
                    : Response.json({}),
            );
        };
        const data = {
            sessions: [{ runwieldSessionId: "saved", displayName: "Saved Session", state: "idle" }],
            total: 1,
        };
        await act(() => {
            renderer = create(createElement(SessionList, { projectId: "p", data }));
        });
        const button = () =>
            renderer.root.findAllByType("button").find((row) => row.props["aria-label"]?.includes("Saved Session"));
        await act(async () => {
            await button().props.onClick();
        });
        assertEquals(requests[0].body, { confirmed: false });
        assertStringIncludes(renderer.root.findByProps({ role: "alert" }).children.join(""), "Try again.");
        assertEquals(
            renderer.root.findAllByType("a").some((link) => link.props.href === "/projects/p/sessions/saved"),
            true,
        );
        assertEquals(button().props.disabled, false);
        await act(async () => {
            await button().props.onClick();
        });
        assertEquals(renderer.root.findAllByProps({ className: "session-list-name" }).length, 0);
        await act(() => renderer.unmount());
        await act(() => {
            renderer = create(
                createElement(SessionList, {
                    projectId: "p",
                    archived: true,
                    data: { ...data, sessions: [{ ...data.sessions[0], archivedAt: "2026-10-02" }] },
                }),
            );
        });
        assertEquals(renderer.root.findByProps({ className: "session-list-status" }).children, ["Archived"]);
        await act(async () => {
            await button().props.onClick();
        });
        assertEquals(requests[2].url, "/api/owner/projects/p/sessions/saved/unarchive");
        assertEquals(renderer.root.findAllByProps({ className: "session-list-name" }).length, 0);
    } finally {
        if (renderer) await act(() => renderer.unmount());
        globalThis.fetch = previousFetch;
        globalThis.confirm = previousConfirm;
        globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct;
        if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
        else delete globalThis.document;
    }
});

Deno.test("Archived Sessions fetches the selected page and keeps saved links when Unarchive fails", async () => {
    const { default: ArchivedSessions } = await import("./islands/ArchivedSessions.tsx");
    const { createElement, act } = await import("react");
    const { create } = await import("react-test-renderer");
    const previousFetch = globalThis.fetch;
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
    let renderer;
    const reads = [];
    try {
        globalThis.IS_REACT_ACT_ENVIRONMENT = true;
        Object.defineProperty(globalThis, "document", { configurable: true, value: { cookie: "" } });
        globalThis.fetch = (url, options) => {
            if (options?.method === "POST") {
                return Promise.resolve(Response.json({ error: "Cannot write archive state." }, { status: 503 }));
            }
            const query = new URL(String(url), "http://localhost").searchParams;
            reads.push({ archiveState: query.get("archiveState"), page: query.get("page") });
            const page = Number(query.get("page"));
            return Promise.resolve(
                Response.json({
                    sessions: [{
                        runwieldSessionId: `saved-${page}`,
                        displayName: `Saved ${page}`,
                        archivedAt: "2026-10-02",
                        state: "idle",
                    }],
                    page,
                    pageSize: 30,
                    total: 31,
                    hasNext: page === 0,
                    hasPrevious: page === 1,
                }),
            );
        };
        await act(() => {
            renderer = create(createElement(ArchivedSessions, { projectId: "p" }));
        });
        assertEquals(reads, [{ archiveState: "archived", page: "0" }]);
        const byText = (text) =>
            renderer.root.findAllByType("button").find((button) => button.children.join("") === text);
        await act(() => byText("Next 30").props.onClick());
        assertEquals(reads[1], { archiveState: "archived", page: "1" });
        assertEquals(byText("Next 30").props.disabled, true);
        await act(async () => {
            await renderer.root.findAllByType("button").find((button) =>
                button.props["aria-label"] === "Unarchive Saved 1"
            ).props.onClick();
        });
        assertEquals(
            renderer.root.findAllByType("a").some((link) => link.props.href === "/projects/p/sessions/saved-1"),
            true,
        );
        assertStringIncludes(
            renderer.root.findByProps({ role: "alert" }).children.join(""),
            "Cannot write archive state.",
        );
        await act(() => byText("Previous").props.onClick());
        assertEquals(reads[2], { archiveState: "archived", page: "0" });
    } finally {
        if (renderer) await act(() => renderer.unmount());
        globalThis.fetch = previousFetch;
        globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct;
        if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
        else delete globalThis.document;
    }
});

Deno.test("fresh Session history restores a previously removed ID and empty later pages keep Previous", async () => {
    const { SessionList } = await import("./components/SessionList.jsx");
    const { createElement, act } = await import("react");
    const { create } = await import("react-test-renderer");
    const previousFetch = globalThis.fetch;
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
    let renderer;
    try {
        globalThis.IS_REACT_ACT_ENVIRONMENT = true;
        Object.defineProperty(globalThis, "document", { configurable: true, value: { cookie: "" } });
        globalThis.fetch = () => Promise.resolve(Response.json({}));
        const data = {
            sessions: [{ runwieldSessionId: "restored", displayName: "Restored", state: "idle" }],
            page: 1,
            hasPrevious: true,
        };
        await act(() => {
            renderer = create(createElement(SessionList, { projectId: "p", data }));
        });
        await act(async () => {
            await renderer.root.findByProps({ "aria-label": "Archive Restored" }).props.onClick();
        });
        assertEquals(renderer.root.findAllByProps({ className: "session-list-name" }).length, 0);
        assertEquals(
            renderer.root.findAllByType("button").find((button) => button.children.includes("Previous")).props.disabled,
            false,
        );
        await act(() =>
            renderer.update(
                createElement(SessionList, { projectId: "p", data: { ...data, sessions: [...data.sessions] } }),
            )
        );
        assertEquals(renderer.root.findAllByProps({ className: "session-list-name" }).length, 1);
    } finally {
        if (renderer) await act(() => renderer.unmount());
        globalThis.fetch = previousFetch;
        globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct;
        if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
        else delete globalThis.document;
    }
});

Deno.test("Plan Session archive keeps the row and switches its action; stale idle busy conflict confirms retry", async () => {
    const { SessionList } = await import("./components/SessionList.jsx");
    const { createElement, act } = await import("react");
    const { create } = await import("react-test-renderer");
    const previousFetch = globalThis.fetch;
    const previousConfirm = globalThis.confirm;
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
    let renderer;
    const requests = [];
    let confirmed = false;
    try {
        globalThis.IS_REACT_ACT_ENVIRONMENT = true;
        Object.defineProperty(globalThis, "document", { configurable: true, value: { cookie: "" } });
        globalThis.confirm = () => confirmed;
        globalThis.fetch = (url, options) => {
            requests.push({ url: String(url), body: JSON.parse(options.body) });
            return Promise.resolve(
                requests.length === 1
                    ? Response.json({ error: "This Session is busy. Confirm to stop its work and archive it." }, {
                        status: 409,
                    })
                    : Response.json({}),
            );
        };
        await act(() => {
            renderer = create(
                createElement(SessionList, {
                    projectId: "p",
                    preserveArchived: true,
                    data: {
                        sessions: [{ runwieldSessionId: "plan-session", displayName: "Plan Session", state: "idle" }],
                    },
                }),
            );
        });
        const action = () =>
            renderer.root.findAllByType("button").find((button) =>
                button.props["aria-label"]?.includes("Plan Session")
            );
        await act(async () => {
            await action().props.onClick();
        });
        await act(async () => {
            await action().props.onClick();
        });
        assertEquals(requests.length, 1);
        confirmed = true;
        await act(async () => {
            await action().props.onClick();
        });
        assertEquals(requests[1].body, { confirmed: true });
        assertEquals(renderer.root.findByProps({ className: "session-list-status" }).children, ["Archived"]);
        assertEquals(action().props["aria-label"], "Unarchive Plan Session");
        confirmed = false;
        await act(async () => {
            await action().props.onClick();
        });
        assertEquals(requests[2].url, "/api/owner/projects/p/sessions/plan-session/unarchive");
        assertEquals(action().props["aria-label"], "Archive Plan Session");
    } finally {
        if (renderer) await act(() => renderer.unmount());
        globalThis.fetch = previousFetch;
        globalThis.confirm = previousConfirm;
        globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct;
        if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
        else delete globalThis.document;
    }
});

for (const surface of ["archived", "history"]) {
    Deno.test(`${surface} Session pagination returns from a page emptied by concurrent row actions`, async () => {
        const { default: ArchivedSessions } = await import("./islands/ArchivedSessions.tsx");
        const { createElement, act } = await import("react");
        const { create } = await import("react-test-renderer");
        const previousFetch = globalThis.fetch;
        const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
        const previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
        const browser = new Window({ url: "http://localhost/projects/p/sessions" });
        const keys = [
            "window",
            "location",
            "localStorage",
            "sessionStorage",
            "HTMLElement",
            "CustomEvent",
            "matchMedia",
            "EventSource",
        ];
        const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
        let renderer;
        const removed = new Set();
        const settle = [];
        try {
            for (const key of keys) {
                Object.defineProperty(globalThis, key, {
                    configurable: true,
                    value: key === "window"
                        ? browser
                        : key === "matchMedia"
                        ? browser.matchMedia.bind(browser)
                        : browser[key],
                });
            }
            globalThis.IS_REACT_ACT_ENVIRONMENT = true;
            Object.defineProperty(globalThis, "document", { configurable: true, value: { cookie: "" } });
            globalThis.fetch = (url, options) => {
                if (options?.method === "POST") {
                    return new Promise((resolve) =>
                        settle.push(() => {
                            removed.add(String(url).split("/").at(-2));
                            resolve(Response.json({}));
                        })
                    );
                }
                const page = Number(new URL(String(url), "http://localhost").searchParams.get("page"));
                const ids = page === 0 ? ["first"] : ["last-one", "last-two"].filter((id) => !removed.has(id));
                return Promise.resolve(
                    Response.json({
                        sessions: ids.map((id) => ({
                            runwieldSessionId: id,
                            displayName: id,
                            state: "idle",
                            archivedAt: surface === "archived" ? "2026-10-02" : null,
                        })),
                        page,
                        pageSize: 30,
                        total: 32 - removed.size,
                        hasNext: page === 0,
                        hasPrevious: page > 0,
                    }),
                );
            };
            await act(() => {
                renderer = create(
                    createElement(surface === "archived" ? ArchivedSessions : SessionSurface, {
                        projectId: "p",
                        mode: "list",
                    }),
                );
            });
            await act(() => {
                renderer.root.findAllByType("button").find((button) => button.children.join("").includes("Next")).props
                    .onClick();
            });
            let one, two;
            await act(() => {
                one = renderer.root.findAllByType("button").find((button) =>
                    button.props["aria-label"]?.endsWith("last-one")
                ).props.onClick();
                two = renderer.root.findAllByType("button").find((button) =>
                    button.props["aria-label"]?.endsWith("last-two")
                ).props.onClick();
            });
            await act(async () => {
                settle.forEach((resolve) => resolve());
                await Promise.all([one, two]);
            });
            assertEquals(
                renderer.root.findAllByProps({ className: "session-list-name" }).map((row) => row.children.join("")),
                ["first"],
            );
        } finally {
            if (renderer) await act(() => renderer.unmount());
            globalThis.fetch = previousFetch;
            globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct;
            if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
            else delete globalThis.document;
            for (const [key, descriptor] of previous) {
                if (descriptor) Object.defineProperty(globalThis, key, descriptor);
                else delete globalThis[key];
            }
            await browser.happyDOM.close();
        }
    });
}

Deno.test("Session composer removes mascot markup and keeps controls when hidden", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const props = {
        id: "mascot-composer",
        draft: "Keep this draft",
        disabled: false,
        canSend: true,
        submitting: false,
        agentValue: "router",
        onDraftChange() {},
        onSubmit() {},
    };
    for (const mascotVisible of [false, true]) {
        const html = renderToStaticMarkup(createElement(SessionComposer, { ...props, mascotVisible }));
        assertEquals(html.includes('data-agent-mascot="base"'), mascotVisible);
        assertStringIncludes(html, "Keep this draft");
        assertStringIncludes(html, 'aria-label="Send"');
    }
});

Deno.test("New Session honors loaded mascot options without flashing while loading", async () => {
    for (const mascot of [false, undefined]) {
        const options = deferredResponse();
        await withNewSessionSurface(async ({ mount, composer, act }) => {
            await mount();
            assertEquals(composer().props.mascotVisible, false);
            await act(() =>
                options.resolve(Response.json({
                    mascot,
                    agents: [],
                    models: [],
                    defaults: { agentName: "router" },
                }))
            );
            assertEquals(composer().props.mascotVisible, mascot !== false);
            assertEquals(
                composer().findAllByType("svg").some((node) => node.props["data-agent-mascot"]),
                mascot !== false,
            );
        }, (url) => url.includes("session-options") ? options.promise : defaultNewSessionResponse(url));
    }
});
