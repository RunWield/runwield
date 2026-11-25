import { seedPlan } from "../../shared/testing/plan-state-fixture.ts";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import type { ExtensionAPI, ContextEvent, SessionCompactEvent } from "@earendil-works/pi-coding-agent";
import reAnchorExtension from "./index.ts";
import type { ReAnchorOptions } from "./index.ts";
import { HostedSession } from "../../shared/session/hosted-session.ts";
import type { ReviewLedger } from "@runwield/plans/controller-state";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { approvePlanForExecution } from "../../shared/testing/ready-plan-fixture.ts";
import {
    withLocalPlanWorkflow,
    reservePlanExecution,
    capturePlanExecutionContext,
    savePlanProse,
} from "../../plan-store/index.ts";
import { loadPlan } from "../../shared/testing/plan-query-fixture.ts";

interface ContextResult {
    messages?: AgentMessage[];
}
type Handler = (
    event: ContextEvent | SessionCompactEvent,
    ctx?: { getSystemPrompt: () => string },
) => ContextResult | void | Promise<ContextResult | void>;

interface Harness {
    compact: (event?: { willRetry?: boolean; reason?: string }) => void;
    /** Drive one provider request and return the messages it would carry. */
    context: (messages?: AgentMessage[]) => Promise<AgentMessage[]>;
    /** Text of the last message a `context` request carried, or "" when nothing was injected. */
    injected: (messages?: AgentMessage[]) => Promise<string>;
}

function setup(options: ReAnchorOptions, systemPrompt = ""): Harness {
    const handlers = new Map<string, Handler>();
    const pi = {
        on(event: string, handler: Handler) {
            handlers.set(event, handler);
        },
    } as ExtensionAPI;

    reAnchorExtension(pi, options);

    const require = (event: string): Handler => {
        const handler = handlers.get(event);
        if (!handler) throw new Error(`re-anchor did not register a "${event}" handler`);
        return handler;
    };

    const context = async (messages: AgentMessage[] = [baseMessage()]): Promise<AgentMessage[]> => {
        const result = await require("context")({ type: "context", messages }, { getSystemPrompt: () => systemPrompt });
        return result?.messages ?? messages;
    };

    return {
        compact: (event = {}) => {
            void require("session_compact")({
                type: "session_compact",
                willRetry: false,
                ...event,
            } as SessionCompactEvent);
        },
        context,
        injected: async (messages = [baseMessage()]) => {
            const returned = await context(messages);
            if (returned.length === messages.length) return "";
            const last = returned[returned.length - 1] as { role?: string; content?: string };
            assertEquals(last.role, "user", "the re-anchor must arrive as a user-role message");
            return last.content ?? "";
        },
    };
}

function baseMessage(): Extract<AgentMessage, { role: "user" }> {
    return { role: "user", content: "Original request", timestamp: 1 };
}

test("compacted context gets the active system reminder without changing saved history", async () => {
    const summary = {
        role: "compactionSummary" as const,
        summary: "Keep the task decisions.",
        tokensBefore: 100,
        timestamp: 1,
    };
    const source = [summary, baseMessage()];
    const guide = setup(
        { agentName: "guide" },
        "Guide instructions\n\n## Compaction reminder\n\nGuide reminder.\n\n## Tools\nUnrelated tool instructions.",
    );
    const engineer = setup(
        { agentName: "engineer" },
        "Engineer instructions\n\n## Compaction reminder\n\nEngineer reminder.",
    );
    const expected = [
        { ...summary, summary: "Keep the task decisions.\n\n## Compaction reminder\n\nGuide reminder." },
        source[1],
    ];

    // A restored summary needs no session_compact event to recover the reminder.
    assertEquals(await guide.context(source), expected);
    assertEquals(await guide.context(source), expected);
    guide.compact();
    assertEquals(await guide.context(source), expected);
    assertEquals(await engineer.context(source), [
        { ...summary, summary: "Keep the task decisions.\n\n## Compaction reminder\n\nEngineer reminder." },
        source[1],
    ]);
    assertEquals(summary.summary, "Keep the task decisions.");
    assertEquals(await guide.context([baseMessage()]), [baseMessage()]);
    assertEquals(await setup({ agentName: "guide" }, "Replacement role without a reminder.").context(source), source);
    const overridden = setup(
        { agentName: "guide" },
        "## Compaction reminder\nOld reminder.\n\n## Compaction reminder\nProject reminder.\n\n# Other instructions\nUnrelated.",
    );
    assertEquals(await overridden.context(source), [
        { ...summary, summary: "Keep the task decisions.\n\n## Compaction reminder\n\nProject reminder." },
        source[1],
    ]);
    const disabled = setup(
        { agentName: "guide" },
        "## Compaction reminder\nOld reminder.\n\n## Compaction reminder\n\n## Other instructions\nUnrelated.",
    );
    assertEquals(await disabled.context(source), source);
});

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
async function hostedSession(
    active: { planName: string; reviewLedger?: ReviewLedger } | null,
    recordedPlanName: string | null = null,
): Promise<HostedSession> {
    const projectRoot = mkdtempSync(join(tmpdir(), "runwield-re-anchor-"));
    tempProjectRoots.push(projectRoot);
    const session = new HostedSession({ id: `re-anchor-${crypto.randomUUID()}`, cwd: projectRoot });
    openSessions.push(session);
    if (recordedPlanName) session.setWorkflowPlanName(recordedPlanName);
    if (active) {
        await seedPlan(
            projectRoot,
            active.planName,
            `# Approved body for ${active.planName}\n\n## Verification Plan\n\nRun tests.`,
            { summary: "SECRET FRONT MATTER", classification: "PLANNED_CHANGE" },
        );
        await approvePlanForExecution(projectRoot, active.planName);
        const execution = await withLocalPlanWorkflow(projectRoot, active.planName, async () => {
            await reservePlanExecution(active.planName, { executionMode: "non_git_in_place" });
            return await capturePlanExecutionContext(active.planName);
        });
        session.setActiveExecutionWorkflow({
            ...execution,
            planName: active.planName,
            triageMeta: {},
            executionAgent: "engineer",
            projectRoot,
            ...(active.reviewLedger ? { reviewLedger: active.reviewLedger } : {}),
        });
    }
    return session;
}

test("no compaction means no injection", async () => {
    const harness = setup({
        agentName: "plan-engineer",
        hostedSession: await hostedSession({ planName: "some-plan" }),
    });

    assertEquals(await harness.injected(), "");
});

test("a settled compaction injects the Plan body without Front Matter", async () => {
    const harness = setup({
        agentName: "plan-engineer",
        hostedSession: await hostedSession({ planName: "some-plan" }),
    });
    harness.compact({ reason: "threshold" });

    const text = await harness.injected();

    assertStringIncludes(text, "# Approved body for some-plan");
    assertStringIncludes(text, "Verification Plan");
    assert(!text.includes("SECRET FRONT MATTER"));
    assert(!text.includes("worktreeId"));
});

test("execution re-anchor keeps the reviewed documents after the live Plan changes", async () => {
    const session = await hostedSession({ planName: "frozen-plan" });
    const before = await loadPlan(session.cwd, "frozen-plan");
    assert(before);
    await savePlanProse(session.cwd, "frozen-plan", "# Later unreviewed body", before.revision);
    const harness = setup({ agentName: "plan-engineer", hostedSession: session });
    harness.compact();
    const text = await harness.injected();
    assertStringIncludes(text, "# Approved body for frozen-plan");
    assertStringIncludes(text, "validation.md");
    assert(!text.includes("Later unreviewed body"));
});

test("the injected message is appended without disturbing existing history", async () => {
    const harness = setup({
        agentName: "plan-engineer",
        hostedSession: await hostedSession({ planName: "some-plan" }),
    });
    const messages: AgentMessage[] = [baseMessage(), fauxAssistantMessage("working")];
    harness.compact();

    const returned = await harness.context(messages);

    assertEquals(returned.length, messages.length + 1);
    assertEquals(returned.slice(0, messages.length), messages);
});

test("one compaction boundary re-anchors exactly once", async () => {
    const harness = setup({
        agentName: "plan-engineer",
        hostedSession: await hostedSession({ planName: "some-plan" }),
    });
    harness.compact();

    assert((await harness.injected()) !== "", "the first request after compaction must carry the re-anchor");
    assertEquals(await harness.injected(), "", "the following request must be left alone");
});

test("an overflow-retried compaction does not arm the re-anchor", async () => {
    const harness = setup({
        agentName: "plan-engineer",
        hostedSession: await hostedSession({ planName: "some-plan" }),
    });

    // Overflow recovery compacts, then retries the aborted turn. Only the
    // settled boundary should produce a re-anchor, or one overflow injects twice.
    harness.compact({ reason: "overflow", willRetry: true });
    assertEquals(await harness.injected(), "");

    harness.compact({ reason: "overflow", willRetry: false });
    assert((await harness.injected()) !== "");
});

test("the active execution Plan wins over the planning workflow context", async () => {
    const harness = setup({
        agentName: "plan-engineer",
        hostedSession: await hostedSession({ planName: "executing-plan" }, "stale-planning-plan"),
    });
    harness.compact();

    const text = await harness.injected();

    assertStringIncludes(text, "# Approved body for executing-plan");
    assert(!text.includes("stale-planning-plan"), "the planning context must not override the executing Plan");
});

test("a planning turn re-anchors from the recorded workflow Plan name", async () => {
    const harness = setup({
        agentName: "planner",
        hostedSession: await hostedSession(null, "docs/plans/drafted-plan.md"),
    });
    harness.compact({ reason: "manual" });

    const text = await harness.injected();

    assertStringIncludes(text, "draft Plan");
    assertStringIncludes(text, "docs/plans/drafted-plan.md");
});

test("an Architect re-anchors on its Epic", async () => {
    const harness = setup({ agentName: "architect", hostedSession: await hostedSession(null, "some-epic") });
    harness.compact();

    const text = await harness.injected();

    assertStringIncludes(text, "Epic");
    assertStringIncludes(text, "docs/plans/some-epic.md");
});

test("Reviewer-Feedback Engineer carries the open Review Issue Ledger", async () => {
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
        hostedSession: await hostedSession({ planName: "repairing-plan", reviewLedger: ledger }),
    });
    harness.compact();

    const text = await harness.injected();

    assertStringIncludes(text, "# Approved body for repairing-plan");
    assertStringIncludes(text, "R1-1");
    assertStringIncludes(text, "Seam check never runs");
    assert(!text.includes("R1-2"), "resolved items must not be reopened by the re-anchor");
});

test("a Delegated Agent Session is never re-anchored", async () => {
    const harness = setup({ agentName: "delegated", hostedSession: await hostedSession({ planName: "some-plan" }) });
    harness.compact();

    assertEquals(await harness.injected(), "");
});

test("agents without a durable Plan artifact are not re-anchored", async () => {
    for (const agentName of ["reviewer", "slicer", "router", "guide"]) {
        const harness = setup({ agentName, hostedSession: await hostedSession({ planName: "some-plan" }) });
        harness.compact();

        assertEquals(await harness.injected(), "", `${agentName} must not receive a Plan pointer`);
    }
});

test("no resolvable Plan name means no injection", async () => {
    const harness = setup({ agentName: "plan-engineer", hostedSession: await hostedSession(null, null) });
    harness.compact();

    assertEquals(await harness.injected(), "");
});

test("a missing hostedSession leaves the request untouched", async () => {
    const harness = setup({ agentName: "plan-engineer", hostedSession: null });
    harness.compact();

    assertEquals(await harness.injected(), "");
});
