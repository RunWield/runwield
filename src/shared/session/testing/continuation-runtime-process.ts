/** Real public Runtime process used beside ACP, with TUI ownership and canonical file authority. */
import { createInterface } from "node:readline";
import { createSessionRuntime } from "../session-runtime.ts";
import { openFileSessionStore } from "../file-session-store.ts";
import { readCommittedSessionTimeline } from "../session-history.ts";
import { SessionContinuationService } from "../session-continuation-service.ts";
import { openOwnerCoordinationStore } from "../../owner-coordination/index.ts";

interface Command {
    id: number;
    action:
        "associate" | "interaction" | "open" | "prompt" | "thinking" | "configuration" | "roll" | "close" | "observe";
    sessionId?: string;
    text?: string;
}
const store = openFileSessionStore();
const runtime = createSessionRuntime({ sessionStore: store, ownerProcessKind: "tui" });
let sessionId = "";
let observer: SessionContinuationService | null = null;
const input = createInterface({ input: process.stdin });
const reply = (id: number, value: string) => process.stdout.write(`RUNTIME:${JSON.stringify({ id, value })}\n`);
for await (const line of input) {
    const command: Command = JSON.parse(line);
    try {
        if (command.action === "observe") {
            observer ??= new SessionContinuationService({ store: openOwnerCoordinationStore() });
            const session = observer.store.getSessionById(command.sessionId!);
            if (!session) throw new Error("Missing observed Session");
            const live = await observer.liveSession(command.text!, command.sessionId!);
            reply(
                command.id,
                JSON.stringify({
                    state: live.state,
                    operation: live.operation?.operationId || null,
                    running: [...observer.operations.values()].filter((record) => record.status === "running").length,
                    retained: observer.operations.size,
                }),
            );
        } else if (command.action === "open") {
            const session = store.getSessionById(command.sessionId!);
            if (!session) throw new Error("Missing saved Session");
            const history = await readCommittedSessionTimeline(store, runtime, session.runwieldSessionId, {
                latest: true,
            });
            if (!("ok" in history) || !history.ok) throw new Error("Missing committed history");
            const snapshot = history.snapshot;
            const text = (key: string) => (typeof snapshot[key] === "string" ? String(snapshot[key]) : null);
            const adopted = runtime.adoptManagedSession({
                session,
                generation: history.generation,
                activeAgent: text("activeAgent"),
                model: text("model"),
                provider: text("provider"),
                thinkingLevel: text("thinkingLevel"),
            });
            sessionId = adopted.sessionId;
            // This process has no local input device. The real live connection owns remote answers.
            runtime.setInteractionAdapter(sessionId, {
                requestInteraction: (_request, signal) =>
                    new Promise((resolve) => {
                        signal?.addEventListener("abort", () => resolve({ outcome: "canceled" }), { once: true });
                    }),
            });
            reply(command.id, "opened");
        } else if (command.action === "associate") {
            const result = await runtime.recordPlanAssociation(sessionId, {
                planId: "saved-plan-id",
                planName: "saved-plan",
                purpose: "execution",
            });
            if (!result.ok) throw new Error(result.error || "Association failed");
            reply(command.id, "associated");
        } else if (command.action === "interaction") {
            const result = await runtime.requestInteraction(sessionId, {
                type: command.text === "text" ? "text" : command.text === "approval" ? "approval" : "select",
                prompt: "Exact owner question",
                defaultValue: command.text === "text" ? "Saved text default" : "approve",
                placeholder: "Owner placeholder",
                ...(command.text === "text"
                    ? {}
                    : {
                          options: [
                              { value: "approve", label: "Approve exactly", description: "Owner choice description" },
                              { value: "decline", label: "Decline exactly" },
                              { value: "other", label: "Other" },
                          ],
                          otherOptionValue: "other",
                      }),
            });
            reply(command.id, JSON.stringify(result));
        } else if (command.action === "prompt") {
            await runtime.synchronizeManagedSession(sessionId);
            const result = await runtime.promptUserTurn(sessionId, {
                initialRequest: command.text!,
            });
            if (!result.ok) throw new Error(result.error || "Turn failed");
            reply(command.id, "completed");
        } else if (command.action === "configuration") {
            const agent = await runtime.switchAgent(sessionId, { agentName: "engineer" });
            if (!agent.ok) throw new Error(agent.error || "Agent configuration failed");
            const model = await runtime.reconfigureSessionModel(sessionId, "fixture-alt", "fixture");
            if (!model.ok) throw new Error(model.error || "Model configuration failed");
            reply(command.id, "configured");
        } else if (command.action === "roll") {
            await runtime.synchronizeManagedSession(sessionId);
            await runtime.rollManagedSessionSegment(sessionId, {
                kind: "execution",
                continuation: { next: "engineer" },
            });
            reply(command.id, "rolled");
        } else if (command.action === "thinking") {
            const result = await runtime.setSessionThinkingLevel(sessionId, "off");
            if (!result.ok) throw new Error(result.error || "Configuration failed");
            reply(command.id, "configured");
        } else {
            await runtime.closeAllSessionsWhenIdle();
            reply(command.id, "closed");
            break;
        }
    } catch (error) {
        reply(command.id, `error:${error instanceof Error ? error.message : String(error)}`);
    }
}
await runtime.closeAllSessionsWhenIdle();
if (observer) {
    await observer.close();
    observer.store.close();
}
store.close();
