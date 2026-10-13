import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import reAnchorExtension from "./index.ts";
import type { ReAnchorOptions } from "./index.ts";
import { HostedSession } from "../../shared/session/hosted-session.js";
import type { ReviewLedger } from "../../shared/workflow/review-ledger.ts";
import { dirname } from "node:path";
import { getStoredPlanPath } from "../../plan-store.js";

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;

interface Harness {
    compact: (event?: { willRetry?: boolean; reason?: string }) => void;
    /** Drive one provider request and return the messages it would carry. */
    context: (messages?: unknown[]) => unknown[];
    /** Text of the last message a `context` request carried, or "" when nothing was injected. */
    injected: (messages?: unknown[]) => string;
}

function setup(options: ReAnchorOptions): Harness {
    const handlers = new Map<string, Handler>();
    const pi = {
        on(event: string, handler: Handler) {
            handlers.set(event, handler);
        },
    } as unknown as ExtensionAPI;

    reAnchorExtension(pi, options);

    const require = (event: string): Handler => {
        const handler = handlers.get(event);
        if (!handler) throw new Error(`re-anchor did not register a "${event}" handler`);
        return handler;
    };

    const context = (messages: unknown[] = [baseMessage()]): unknown[] => {
        const result = require("context")({ type: "context", messages }, {}) as
            | { messages?: unknown[] }
            | undefined;
        return result?.messages ?? messages;
    };

    return {
        compact: (event = {}) => {
            require("session_compact")({ type: "session_compact", willRetry: false, ...event }, {});
        },
        context,
        injected: (messages = [baseMessage()]) => {
            const returned = context(messages);
            if (returned.length === messages.length) return "";
            const last = returned[returned.length - 1] as { role?: string; content?: string };
            assertEquals(last.role, "user", "the re-anchor must arrive as a user-role message");
            return last.content ?? "";
        },
    };
}

function baseMessage(): { role: string; content: string; timestamp: number } {
    return { role: "user", content: "Original request", timestamp: 1 };
}

const openSessions: HostedSession[] = [];
const tempProjectRoots: string[] = [];

globalThis.addEventListener("unload", () => {
    for (const session of openSessions) {
        try {
            session.dispose();
        } catch {
            // Best effort; a leftover session must not fail a passing run.
        }
    }
    for (const projectRoot of tempProjectRoots) {
        try {
            rmSync(projectRoot, { recursive: true });
        } catch {
            // Best effort test cleanup.
        }
    }
});

/**
 * A real HostedSession carrying real workflow state.
 *
 * The Plan pointer is RunWield's own state, not an external boundary, so these
 * tests store it through `setActiveExecutionWorkflow` and `setWorkflowPlanName`
 * and read it back through the same accessors the extension calls. A stand-in
 * returning literals would happily hand back a `docs/plans/x.md` shape that
 * `setWorkflowPlanName` normalizes away, and the precedence assertions would
 * prove nothing about the object the extension actually gets.
 */
function hostedSession(
    active: { planName: string; reviewLedger?: ReviewLedger } | null,
    recordedPlanName: string | null = null,
): HostedSession {
    const projectRoot = mkdtempSync(join(tmpdir(), "runwield-re-anchor-"));
    tempProjectRoots.push(projectRoot);
    const session = new HostedSession({ id: `re-anchor-${crypto.randomUUID()}`, cwd: projectRoot });
    openSessions.push(session);
    if (recordedPlanName) session.setWorkflowPlanName(recordedPlanName);
    if (active) {
        const planPath = getStoredPlanPath(projectRoot, active.planName);
        mkdirSync(dirname(planPath), { recursive: true });
        writeFileSync(
            planPath,
            `---\nsummary: SECRET FRONT MATTER\nworktreeId: secret-worktree\n---\n# Approved body for ${active.planName}\n\n## Verification Plan\n\nRun tests.`,
        );
        session.setActiveExecutionWorkflow({
            planName: active.planName,
            triageMeta: {},
            executionAgent: "engineer",
            projectRoot,
            ...(active.reviewLedger ? { reviewLedger: active.reviewLedger } : {}),
        });
    }
    return session;
}

test("no compaction means no injection", () => {
    const harness = setup({ agentName: "plan-engineer", hostedSession: hostedSession({ planName: "some-plan" }) });

    assertEquals(harness.injected(), "");
});

test("a settled compaction injects the Plan body without Front Matter", () => {
    const harness = setup({ agentName: "plan-engineer", hostedSession: hostedSession({ planName: "some-plan" }) });
    harness.compact({ reason: "threshold" });

    const text = harness.injected();

    assertStringIncludes(text, "# Approved body for some-plan");
    assertStringIncludes(text, "Verification Plan");
    assert(!text.includes("SECRET FRONT MATTER"));
    assert(!text.includes("worktreeId"));
});

test("the injected message is appended without disturbing existing history", () => {
    const harness = setup({ agentName: "plan-engineer", hostedSession: hostedSession({ planName: "some-plan" }) });
    const messages = [baseMessage(), { role: "assistant", content: "working", timestamp: 2 }];
    harness.compact();

    const returned = harness.context(messages);

    assertEquals(returned.length, messages.length + 1);
    assertEquals(returned.slice(0, messages.length), messages);
});

test("one compaction boundary re-anchors exactly once", () => {
    const harness = setup({ agentName: "plan-engineer", hostedSession: hostedSession({ planName: "some-plan" }) });
    harness.compact();

    assert(harness.injected() !== "", "the first request after compaction must carry the re-anchor");
    assertEquals(harness.injected(), "", "the following request must be left alone");
});

test("an overflow-retried compaction does not arm the re-anchor", () => {
    const harness = setup({ agentName: "plan-engineer", hostedSession: hostedSession({ planName: "some-plan" }) });

    // Overflow recovery compacts, then retries the aborted turn. Only the
    // settled boundary should produce a re-anchor, or one overflow injects twice.
    harness.compact({ reason: "overflow", willRetry: true });
    assertEquals(harness.injected(), "");

    harness.compact({ reason: "overflow", willRetry: false });
    assert(harness.injected() !== "");
});

test("the active execution Plan wins over the planning workflow context", () => {
    const harness = setup({
        agentName: "plan-engineer",
        hostedSession: hostedSession({ planName: "executing-plan" }, "stale-planning-plan"),
    });
    harness.compact();

    const text = harness.injected();

    assertStringIncludes(text, "# Approved body for executing-plan");
    assert(!text.includes("stale-planning-plan"), "the planning context must not override the executing Plan");
});

test("a planning turn re-anchors from the recorded workflow Plan name", () => {
    const harness = setup({
        agentName: "planner",
        hostedSession: hostedSession(null, "docs/plans/drafted-plan.md"),
    });
    harness.compact({ reason: "manual" });

    const text = harness.injected();

    assertStringIncludes(text, "draft Plan");
    assertStringIncludes(text, "docs/plans/drafted-plan.md");
});

test("an Architect re-anchors on its Epic", () => {
    const harness = setup({ agentName: "architect", hostedSession: hostedSession(null, "some-epic") });
    harness.compact();

    const text = harness.injected();

    assertStringIncludes(text, "Epic");
    assertStringIncludes(text, "docs/plans/some-epic.md");
});

test("Reviewer-Feedback Engineer carries the open Review Issue Ledger", () => {
    const ledger: ReviewLedger = {
        sequence: 2,
        items: [
            {
                id: "R1-1",
                openedInRound: 1,
                resolvedInRound: null,
                title: "Seam check never runs",
                requirement: "Verification Plan step 3",
                evidence: "No call site",
            },
            {
                id: "R1-2",
                openedInRound: 1,
                resolvedInRound: 1,
                title: "Already repaired",
                requirement: "",
                evidence: "",
            },
        ],
    };
    const harness = setup({
        agentName: "reviewer-feedback-engineer",
        hostedSession: hostedSession({ planName: "repairing-plan", reviewLedger: ledger }),
    });
    harness.compact();

    const text = harness.injected();

    assertStringIncludes(text, "# Approved body for repairing-plan");
    assertStringIncludes(text, "R1-1");
    assertStringIncludes(text, "Seam check never runs");
    assert(!text.includes("R1-2"), "resolved items must not be reopened by the re-anchor");
});

test("a Delegated Agent Session is never re-anchored", () => {
    const harness = setup({ agentName: "delegated", hostedSession: hostedSession({ planName: "some-plan" }) });
    harness.compact();

    assertEquals(harness.injected(), "");
});

test("agents without a durable Plan artifact are not re-anchored", () => {
    for (const agentName of ["reviewer", "slicer", "router", "guide"]) {
        const harness = setup({ agentName, hostedSession: hostedSession({ planName: "some-plan" }) });
        harness.compact();

        assertEquals(harness.injected(), "", `${agentName} must not receive a Plan pointer`);
    }
});

test("no resolvable Plan name means no injection", () => {
    const harness = setup({ agentName: "plan-engineer", hostedSession: hostedSession(null, null) });
    harness.compact();

    assertEquals(harness.injected(), "");
});

test("a missing hostedSession leaves the request untouched", () => {
    const harness = setup({ agentName: "plan-engineer", hostedSession: null });
    harness.compact();

    assertEquals(harness.injected(), "");
});

test("a throwing workflow lookup leaves the turn unmodified", () => {
    // Containment is about the failure a well-behaved HostedSession cannot
    // produce, so this is the one place a hostile stand-in is the subject under
    // test rather than a shortcut around real state.
    const throwingSession = hostedSession({ planName: "some-plan" });
    throwingSession.getActiveExecutionWorkflow = () => {
        throw new Error("session disposed mid-turn");
    };
    const harness = setup({ agentName: "plan-engineer", hostedSession: throwingSession });
    harness.compact();

    const messages = [baseMessage()];
    const returned = harness.context(messages);

    assertEquals(returned, messages);
});
